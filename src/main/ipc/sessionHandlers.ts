/**
 * Handlers for sessions, briefs, the dashboard, and the manuscript (M7).
 * Independent of Electron: the host passes dialogs, the PDF printer, and the
 * Claude services in `SessionDeps`, so the integration suite drives the same
 * code through the same zod contract.
 */
import { writeFile } from 'node:fs/promises';
import { monotonicFactory } from 'ulid';
import type { Channel, Response } from '../../shared/ipc';
import type { OpenBible } from '../db/session';
import type { StoredDoc } from '../readmodel';
import type { Handler } from './validate';
import { selectForSession } from '../../shared/domain/brief/selection';
import type { BriefInput, Selection } from '../../shared/domain/brief/selection';
import {
  briefFileName,
  briefMaterial,
  briefPrintPage,
  citationProblems,
  structuredBrief,
} from '../../shared/domain/brief/render';
import {
  establishedPlanned,
  manuscriptChange,
  manuscriptLines,
} from '../../shared/domain/manuscript';
import { latestLog, localDateString, logsNewestFirst } from '../../shared/domain/sessionLog';
import { chapterYear, currentPositionChapter } from '../../shared/domain/position';
import { questionCounts } from '../../shared/domain/questions';
import { entryTitle } from '../../shared/schema';
import type { StoryTimeValue } from '../../shared/storyTime';
import { SUMMARY_MODEL_SETTING, briefModel, sessionClaude } from '../session/claude';
import type { SessionClaude } from '../session/claude';
import { parseLocator, registeredSources, wordSource } from '../session/sources';
import type { ManuscriptSource } from '../session/sources';

export type SessionChannel =
  | 'session.relevant'
  | 'brief.settings.get'
  | 'brief.settings.set'
  | 'session.start'
  | 'brief.regenerate'
  | 'brief.export'
  | 'manuscript.sources'
  | 'manuscript.read'
  | 'manuscript.apply'
  | 'chapter.establishes'
  | 'chapter.summarize'
  | 'dashboard.get';

export type SessionHandlers = { [C in SessionChannel]: Handler<C & Channel> };

/** What the session channels need from the host. */
export interface SessionDeps {
  /** The Claude services (M6). Defaults to whatever M6 registered, which starts as none. */
  claude?: () => SessionClaude;
  /** Manuscript sources (MS-1). Defaults to Word plus any registered (Google Docs, M9). */
  sources?: ManuscriptSource[];
  /** Ask for a Word document; used by the default Word source. */
  pickFile?: (kind: 'workbook' | 'document') => Promise<string | null>;
  /** Ask where to save an exported brief. Null when cancelled. */
  pickExportPath?: (defaultName: string, format: 'markdown' | 'pdf') => Promise<string | null>;
  /** Print a standalone HTML page to PDF bytes (SB-8). */
  printPdf?: (html: string) => Promise<Buffer>;
  now?: () => Date;
}

const NO_BIBLE = 'Open a bible first.';
const newId = monotonicFactory();

const UNAVAILABLE =
  'Claude is not available, so this is the structured brief: the selected entries with no synthesis.';

const str = (v: unknown) => (typeof v === 'string' ? v : '');

function storyTimeFor(sel: Selection): StoryTimeValue {
  const s = sel.strands[0];
  if (sel.input.kind === 'pov' || !s?.chapterId) return { year: sel.year };
  return s.strandId
    ? { year: sel.year, chapterId: s.chapterId, strandId: s.strandId }
    : { year: sel.year, chapterId: s.chapterId };
}

export function sessionHandlers(
  current: () => OpenBible | null,
  deps: SessionDeps = {},
): SessionHandlers {
  const session = (): OpenBible => {
    const s = current();
    if (!s) throw new Error(NO_BIBLE);
    return s;
  };
  const claude = () => (deps.claude ?? sessionClaude)();
  const now = () => (deps.now ?? (() => new Date()))();
  const sources = (): ManuscriptSource[] => {
    if (deps.sources) return deps.sources;
    const word = wordSource(async () => (deps.pickFile ? deps.pickFile('document') : null));
    return [word, ...registeredSources().filter((s) => s.id !== 'word')];
  };
  const pending = new Map<
    string,
    { chapterId: string; body: string; name: string; source: string; outOfDate: boolean }
  >();

  const settings = () => {
    const { repo } = session();
    const c = claude();
    return { ...repo.briefSettings(), model: briefModel(c), claudeAvailable: c.briefs !== null };
  };

  const select = (input: BriefInput, add: string[], remove: string[]) => {
    const { model, repo } = session();
    return selectForSession(model, input, repo.briefSettings(), { add, remove });
  };

  /** SB-4, SB-7, DB-4: write the brief's text from the selection. */
  const write = async (sel: Selection) => {
    const structured = structuredBrief(sel);
    const c = claude();
    if (!c.briefs) {
      return { content: structured, synthesized: false, model: '', note: UNAVAILABLE };
    }
    try {
      const r = await c.briefs.synthesize({
        model: briefModel(c),
        selection: sel,
        material: briefMaterial(sel),
        structured,
      });
      return { content: r.content, synthesized: true, model: r.model, note: null };
    } catch (e) {
      const why = e instanceof Error ? e.message : 'it failed';
      return {
        content: structured,
        synthesized: false,
        model: '',
        note: `Claude could not write the brief (${why}). This is the structured brief: the selected entries with no synthesis.`,
      };
    }
  };

  const briefData = (sel: Selection, text: Awaited<ReturnType<typeof write>>) => {
    const input = sel.input;
    const first = sel.strands[0];
    return {
      title: `Brief: ${sel.label}`,
      status: 'planned',
      chapterId: sel.chapterIds[0] ?? null,
      storyYear: sel.year,
      povCharacterId: first?.povCharacterId ?? null,
      entryIds: sel.ids,
      content: text.content,
      sectionKind: input.kind,
      strandId: input.kind === 'strand' ? input.strandId : null,
      partId: input.kind === 'part' ? input.partId : null,
      placeIds: input.kind === 'pov' ? (input.placeIds ?? []) : [],
      characterIds: input.kind === 'pov' ? (input.characterIds ?? []) : [],
      added: sel.added,
      removed: sel.removed,
      model: text.model,
      synthesized: text.synthesized,
      selection: JSON.parse(JSON.stringify(sel)) as Record<string, unknown>,
    };
  };

  const inputOf = (brief: StoredDoc): BriefInput => {
    const sel = brief.selection as { input?: BriefInput } | null;
    if (sel?.input) return sel.input;
    // A brief made by hand: rebuild the input from its fields.
    if (str(brief.partId)) return { kind: 'part', partId: str(brief.partId) };
    if (str(brief.chapterId) && str(brief.strandId)) {
      return { kind: 'strand', chapterId: str(brief.chapterId), strandId: str(brief.strandId) };
    }
    if (str(brief.chapterId)) return { kind: 'chapter', chapterId: str(brief.chapterId) };
    if (typeof brief.storyYear === 'number' && str(brief.povCharacterId)) {
      return {
        kind: 'pov',
        year: brief.storyYear,
        povCharacterId: str(brief.povCharacterId),
        placeIds: Array.isArray(brief.placeIds) ? (brief.placeIds as string[]) : [],
        characterIds: Array.isArray(brief.characterIds) ? (brief.characterIds as string[]) : [],
      };
    }
    throw new Error('This brief has no chapter, part, or year and point of view to select for.');
  };

  return {
    'session.relevant': ({ input, add, remove }) => {
      const selection = select(input, add, remove);
      return { selection, structured: structuredBrief(selection) };
    },
    'brief.settings.get': () => settings(),
    'brief.settings.set': async (req) => {
      await session().repo.setBriefSettings(req);
      return settings();
    },
    'session.start': async ({ input, add, remove }) => {
      const { repo } = session();
      const sel = select(input, add, remove);
      const text = await write(sel);
      const briefId = newId();
      const date = localDateString(now());
      const first = sel.strands[0];
      const [brief, log] = await repo.createMany([
        { collection: 'briefs', data: { _id: briefId, ...briefData(sel, text) } },
        {
          collection: 'sessionLogs',
          data: {
            title: `Session ${date}`,
            status: 'canon',
            date,
            chapterId: sel.chapterIds[0] ?? null,
            partId: input.kind === 'part' ? input.partId : null,
            strandId: input.kind === 'strand' ? input.strandId : null,
            storyYear: sel.year,
            povCharacterId: first?.povCharacterId ?? null,
            briefId,
            stoppedAt: '',
            notes: `Started a session for ${sel.label}.`,
          },
        },
      ]);
      const time = await repo.setStoryTime(storyTimeFor(sel));
      return {
        brief: brief as Response<'session.start'>['brief'],
        log: log as Response<'session.start'>['log'],
        synthesized: text.synthesized,
        note: text.note,
        problems: citationProblems(text.content, sel.ids),
        time,
      };
    },
    'brief.regenerate': async ({ id, add, remove }) => {
      const { repo, model } = session();
      const brief = model.get('briefs', id);
      if (!brief || brief.deletedAt) throw new Error('That brief is not in the bible.');
      const sel = select(inputOf(brief), add, remove);
      const text = await write(sel);
      const next = await repo.update('briefs', id, briefData(sel, text) as never);
      return {
        brief: next as unknown as Response<'brief.regenerate'>['brief'],
        synthesized: text.synthesized,
        note: text.note,
        problems: citationProblems(text.content, sel.ids),
      };
    },
    'brief.export': async ({ id, format }) => {
      const brief = session().model.get('briefs', id);
      if (!brief || brief.deletedAt) throw new Error('That brief is not in the bible.');
      const name = briefFileName(entryTitle(brief));
      const ext = format === 'pdf' ? 'pdf' : 'md';
      const path = deps.pickExportPath ? await deps.pickExportPath(`${name}.${ext}`, format) : null;
      if (!path) return { saved: false, path: null };
      const content = str(brief.content);
      if (format === 'markdown') {
        await writeFile(path, content, 'utf8');
      } else {
        if (!deps.printPdf) throw new Error('PDF export is not available here.');
        await writeFile(path, await deps.printPdf(briefPrintPage(entryTitle(brief), content)));
      }
      return { saved: true, path };
    },
    'manuscript.sources': () => ({
      sources: sources().map((s) => ({ id: s.id, label: s.label })),
    }),
    'manuscript.read': async ({ chapterId, sourceId }) => {
      const { model } = session();
      const chapter = model.get('chapters', chapterId);
      if (!chapter || chapter.deletedAt) throw new Error('That chapter is not in the bible.');
      const list = sources();
      let source: ManuscriptSource | undefined;
      let locator: string | null;
      if (sourceId) {
        source = list.find((s) => s.id === sourceId);
        if (!source) throw new Error('That manuscript source is not available.');
        locator = await source.pick();
      } else {
        const linked = parseLocator(str(chapter.manuscriptSource));
        if (!linked) {
          throw new Error(
            'This chapter has no linked manuscript yet. Import it from a file first.',
          );
        }
        source = list.find((s) => s.id === linked.sourceId);
        if (!source) throw new Error('The source this chapter is linked to is not available.');
        locator = linked.locator;
      }
      const empty = {
        token: null,
        name: '',
        source: '',
        modifiedAt: '',
        body: '',
        changed: false,
        added: 0,
        removed: 0,
        summaryOutOfDate: false,
        diff: [],
      };
      if (!locator) return empty;
      const text = await source.read(locator);
      const change = manuscriptChange(chapter, text.body);
      const token = newId();
      pending.set(token, {
        chapterId,
        body: text.body,
        name: text.name,
        source: `${source.id}:${locator}`,
        outOfDate: change.summaryOutOfDate,
      });
      return {
        token,
        name: text.name,
        source: `${source.id}:${locator}`,
        modifiedAt: text.modifiedAt,
        body: text.body,
        changed: change.changed,
        added: change.added,
        removed: change.removed,
        summaryOutOfDate: change.summaryOutOfDate,
        diff: change.diff,
      };
    },
    'manuscript.apply': async ({ token, baseModifiedAt }) => {
      const { model, repo } = session();
      const p = pending.get(token);
      if (!p) throw new Error('That import has expired. Read the manuscript again.');
      const chapter = model.get('chapters', p.chapterId);
      if (!chapter || chapter.deletedAt) throw new Error('That chapter is not in the bible.');
      if (chapter.modifiedAt !== baseModifiedAt) {
        throw new Error(
          'This chapter changed after you saw the comparison, so nothing was written. Read the manuscript again.',
        );
      }
      const patch = {
        manuscriptText: p.body,
        sourceFile: p.name,
        manuscriptSource: p.source,
        summaryOutOfDate: p.outOfDate,
      };
      const before = Object.fromEntries(
        Object.keys(patch).map((k) => [k, chapter[k] ?? (k === 'summaryOutOfDate' ? false : null)]),
      );
      const entry = await repo.update('chapters', p.chapterId, patch);
      pending.delete(token);
      return { entry: entry as unknown as Response<'manuscript.apply'>['entry'], before };
    },
    'chapter.establishes': ({ chapterId }) => ({
      items: establishedPlanned(session().model, chapterId),
    }),
    'chapter.summarize': async ({ chapterId }) => {
      const chapter = session().model.get('chapters', chapterId);
      if (!chapter || chapter.deletedAt) throw new Error('That chapter is not in the bible.');
      const c = claude();
      if (!c.summaries) {
        return {
          available: false,
          draft: '',
          model: null,
          message:
            'Claude is not available, so write the summary yourself. Nothing is saved until you approve it.',
        };
      }
      const text = manuscriptLines(str(chapter.manuscriptText)).join('\n');
      if (!text) {
        return {
          available: true,
          draft: '',
          model: null,
          message:
            'This chapter has no manuscript text to summarize. Import it first, or write the summary yourself.',
        };
      }
      const modelName = c.modelFor?.(SUMMARY_MODEL_SETTING) ?? 'claude-sonnet-5-5';
      try {
        const r = await c.summaries.summarize({
          model: modelName,
          chapterId,
          title: entryTitle(chapter),
          text,
        });
        return { available: true, draft: r.summary, model: r.model, message: null };
      } catch (e) {
        return {
          available: true,
          draft: '',
          model: null,
          message: `Claude could not write a summary (${e instanceof Error ? e.message : 'it failed'}). Write it yourself, or try again.`,
        };
      }
    },
    'dashboard.get': () => {
      const { model } = session();
      const chapters = model.all('chapters').filter((c) => !c.deletedAt);
      const chapterTitle = (id: unknown) => {
        const c = typeof id === 'string' && id ? model.get('chapters', id) : undefined;
        return c && !c.deletedAt ? entryTitle(c) : null;
      };
      const logs = model.all('sessionLogs').filter((l) => !l.deletedAt);
      const last = latestLog(logs);
      const pos = currentPositionChapter(chapters);
      return {
        lastLog: last
          ? {
              id: str(last._id),
              date: str(last.date),
              chapter: chapterTitle(last.chapterId),
              stoppedAt: str(last.stoppedAt),
              notes: str(last.notes),
              briefId: str(last.briefId) || null,
            }
          : null,
        position: pos
          ? {
              chapterId: str(pos._id),
              title: entryTitle(pos),
              readingOrder: Number(pos.readingOrder ?? 0),
              year: chapterYear(pos),
            }
          : null,
        openQuestions: questionCounts(model.all('openQuestions').filter((q) => !q.deletedAt)).open,
        rewriteTasks: model
          .all('findings')
          .filter((f) => !f.deletedAt && f.state === 'rewrite')
          .sort((a, b) => str(a.createdAt).localeCompare(str(b.createdAt)))
          .map((f) => ({
            id: str(f._id),
            chapterId: str(f.chapterId) || null,
            chapter: chapterTitle(f.chapterId),
            text: str(f.text),
            quote: str(f.quote),
            lines:
              typeof f.lineStart === 'number'
                ? typeof f.lineEnd === 'number' && f.lineEnd !== f.lineStart
                  ? `lines ${f.lineStart} to ${f.lineEnd}`
                  : `line ${f.lineStart}`
                : '',
          })),
        recentLogs: logsNewestFirst(logs)
          .slice(0, 8)
          .map((l) => ({
            id: str(l._id),
            date: str(l.date),
            chapter: chapterTitle(l.chapterId),
            text: str(l.stoppedAt) || str(l.notes),
            briefId: str(l.briefId) || null,
          })),
      };
    },
  };
}
