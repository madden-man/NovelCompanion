import { needsSettings } from '../../shared/claude';
import { plainErrorMessage } from '../../shared/errors';
import { RunEnded } from '../claude/session';
/**
 * Handlers for the session selection and the manuscript (M7). Independent of
 * Electron: the host passes dialogs and the Claude services in `SessionDeps`,
 * so the integration suite drives the same code through the same zod
 * contract.
 */
import { monotonicFactory } from 'ulid';
import type { Channel, Response } from '../../shared/ipc';
import type { OpenBible } from '../db/session';
import type { Handler } from './validate';
import { selectForSession } from '../../shared/domain/brief/selection';
import type { BriefInput } from '../../shared/domain/brief/selection';
import {
  establishedPlanned,
  manuscriptChange,
  manuscriptLines,
} from '../../shared/domain/manuscript';
import { entryTitle } from '../../shared/schema';
import { SUMMARY_MODEL_SETTING, sessionClaude } from '../session/claude';
import type { SessionClaude } from '../session/claude';
import { parseLocator, wordSource } from '../session/sources';
import type { ManuscriptSource } from '../session/sources';

export type SessionChannel =
  | 'session.relevant'
  | 'brief.settings.get'
  | 'brief.settings.set'
  | 'manuscript.sources'
  | 'manuscript.read'
  | 'manuscript.apply'
  | 'chapter.establishes'
  | 'chapter.summarize';

export type SessionHandlers = { [C in SessionChannel]: Handler<C & Channel> };

/** What the session channels need from the host. */
export interface SessionDeps {
  /** The Claude services (M6). Defaults to whatever M6 registered, which starts as none. */
  claude?: () => SessionClaude;
  /** Manuscript sources (MS-1). Defaults to Word. */
  sources?: ManuscriptSource[];
  /** Ask for a Word document; used by the default Word source. */
  pickFile?: (kind: 'document') => Promise<string | null>;
}

const NO_BIBLE = 'Open a bible first.';
const newId = monotonicFactory();

const NO_KEY_SUMMARY =
  'No Anthropic API key is stored, so write the summary yourself, or add a key in Settings. Nothing is saved until you approve it.';

/** ARCH-4: a missing or rejected key (or model) is fixed in Settings, so the screen links there. */
const needsSettingsFor = (e: unknown) =>
  e instanceof RunEnded && e.kind !== undefined && needsSettings(e.kind);

const str = (v: unknown) => (typeof v === 'string' ? v : '');

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
  const sources = (): ManuscriptSource[] => {
    if (deps.sources) return deps.sources;
    return [wordSource(async () => (deps.pickFile ? deps.pickFile('document') : null))];
  };
  const pending = new Map<
    string,
    { chapterId: string; body: string; name: string; source: string; outOfDate: boolean }
  >();

  const settings = () => session().repo.briefSettings();

  const select = (input: BriefInput, add: string[], remove: string[]) => {
    const { model, repo } = session();
    return selectForSession(model, input, repo.selectionSettings(), { add, remove });
  };

  return {
    'session.relevant': ({ input, add, remove }) => ({ selection: select(input, add, remove) }),
    'brief.settings.get': () => settings(),
    'brief.settings.set': async (req) => {
      await session().repo.setBriefSettings(req);
      return settings();
    },
    'manuscript.sources': () => ({
      sources: sources().map((s) => ({ id: s.id, label: s.label, picker: 'dialog' as const })),
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
      // IP-18: the importer is the one writer of the manuscript fields.
      const entry = await repo.update('chapters', p.chapterId, patch, { importer: true });
      pending.delete(token);
      return { entry: entry as unknown as Response<'manuscript.apply'>['entry'], before };
    },
    'chapter.establishes': ({ chapterId }) => ({
      items: establishedPlanned(session().model, chapterId),
    }),
    'chapter.summarize': async ({ chapterId, runId }) => {
      const chapter = session().model.get('chapters', chapterId);
      if (!chapter || chapter.deletedAt) throw new Error('That chapter is not in the bible.');
      const c = claude();
      if (!c.summaries) {
        return {
          available: false,
          draft: '',
          model: null,
          message: NO_KEY_SUMMARY,
          needsSettings: true,
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
          needsSettings: false,
        };
      }
      const modelName = c.modelFor?.(SUMMARY_MODEL_SETTING) ?? 'claude-sonnet-5-5';
      try {
        const r = await c.summaries.summarize({
          model: modelName,
          ...(runId ? { runId } : {}),
          chapterId,
          title: entryTitle(chapter),
          text,
        });
        return {
          available: true,
          draft: r.summary,
          model: r.model,
          message: null,
          needsSettings: false,
        };
      } catch (e) {
        return {
          available: true,
          draft: '',
          model: null,
          message: `Claude could not write a summary (${plainErrorMessage(e).replace(/\.$/, '')}). Write it yourself, or try again.`,
          needsSettings: needsSettingsFor(e),
        };
      }
    },
  };
}
