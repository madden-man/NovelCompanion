/**
 * A55 (NB-4 to NB-8): the notebook pages from the phone, as pure functions.
 * `assembleNotebook` turns the rows FlowState's function stored in
 * `bridge_up` for one world into notebook pages; `linkNotebook` reads what
 * a page names through the Capture Router's free stages; `planNotebook` says
 * what a pull writes; `notebookRows` is the Notebook list of one entry. No
 * Electron, MongoDB or React (ARCHITECTURE rule 1).
 */
import type { UpRow } from '../bridge';
import type { NotebookKind, NotebookLine, NotebookPage, NotebookPaper } from '../schema/notebook';
import { parseYears } from './captureRouter/parse';
import { routeCapture } from './captureRouter/route';
import type { RouterIndex } from './captureRouter/types';

/** A council voice that is a character: `c:<characterId>` (FlowState `characterVoiceId`). */
export const CHARACTER_VOICE = /^c:(.+)$/;

/** What a pull builds for one page before its links are read. */
export type NotebookDraft = Omit<
  NotebookPage,
  'characterIds' | 'placeIds' | 'chapterIds' | 'years' | 'createdAt' | 'modifiedAt' | 'deletedAt'
>;

export interface NotebookLinks {
  characterIds: string[];
  placeIds: string[];
  chapterIds: string[];
  years: number[];
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const int = (v: unknown): number | null =>
  typeof v === 'number' && Number.isInteger(v) && v >= -10000 && v <= 10000 ? v : null;
const ids = (v: unknown): string[] =>
  Array.isArray(v)
    ? [...new Set(v.filter((x): x is string => typeof x === 'string' && x.length > 0))]
    : [];

/** A phone time (milliseconds) as an ISO time; null when it is not one. */
export function isoOf(ms: unknown): string | null {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return null;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** The character a council voice is, or null for plain ink and every other voice. */
export function speakerOf(voiceId: unknown): string | null {
  const m = typeof voiceId === 'string' ? CHARACTER_VOICE.exec(voiceId) : null;
  return m?.[1] ?? null;
}

/** A page's year: its own (null is the whole book), else its chips' year, else none. */
function yearOf(row: Record<string, unknown>): number | null {
  if (row.year === null) return null;
  const own = int(row.year);
  if (own !== null) return own;
  const chips = isObj(row.chips) ? row.chips : {};
  return int(chips.year);
}

function chipsOf(row: Record<string, unknown>): NotebookDraft['chips'] {
  const chips = isObj(row.chips) ? row.chips : {};
  return { characterIds: ids(chips.characterIds), placeIds: ids(chips.placeIds) };
}

/** A row that holds a row (not a delete). */
type LiveRow = Omit<UpRow, 'row'> & { row: Record<string, unknown> };

const sigOf = (rows: readonly UpRow[]): string =>
  rows
    .map((r) => `${r.table}:${r.id}:${r.rev}`)
    .sort()
    .join(' ');

/** The signature a page is trashed with: the delete that took it, so a second pull changes nothing. */
export const deletedSig = (r: UpRow): string => `deleted ${r.table}:${r.id}:${r.rev}`;

function lineOf(row: Record<string, unknown>, fallbackAt: string | null): NotebookLine {
  return {
    id: str(row.id),
    speakerId: speakerOf(row.voiceId),
    text: str(row.text),
    wise: row.wise === true,
    kept: row.kept === true,
    at: isoOf(row.at) ?? fallbackAt,
  };
}

const byAt = (a: Record<string, unknown>, b: Record<string, unknown>) =>
  (typeof a.at === 'number' ? a.at : 0) - (typeof b.at === 'number' ? b.at : 0) ||
  str(a.id).localeCompare(str(b.id));

function paperOf(p: unknown): NotebookPaper | null {
  if (!isObj(p) || typeof p.title !== 'string') return null;
  return {
    id: str(p.id).slice(0, 200),
    title: p.title,
    journal: strOrNull(p.journal),
    year: int(p.year),
    doi: strOrNull(p.doi),
    side: strOrNull(p.side),
  };
}

export interface AssembleContext {
  /** The bible's live open questions by ID, their text, so a thread on one is named for it. */
  questions: ReadonlyMap<string, string>;
}

export interface Assembled {
  /** Every page the rows hold now. */
  pages: NotebookDraft[];
  /** Page IDs the phone deleted (or stopped keeping), with the signature to trash them under. */
  deleted: Map<string, string>;
}

/**
 * NB-4: the pages one world's rows hold. A council or question page arrives
 * whole: its page row and every line row that names it, in the order they were
 * written. A kept journal line arrives alone and is a page of one line, its
 * ID the line's. A question researched is a research page. A deleted council
 * or thread, and a line no longer kept (it arrives as a delete), is listed in
 * `deleted`. Lines whose page has not arrived wait, unless their page is one
 * of the bible's open questions (a question the bible sent down that he wrote
 * in): then the thread is named for the question. Songs and takes are not
 * notebook pages.
 */
export function assembleNotebook(
  rows: readonly UpRow[],
  world: string,
  ctx: AssembleContext,
): Assembled {
  const mine = rows.filter((r) => r.world === world);
  const pageRows = new Map<string, LiveRow>();
  const lineRows = new Map<string, LiveRow[]>();
  const kept: LiveRow[] = [];
  const inquiries: LiveRow[] = [];
  const deleted = new Map<string, string>();
  for (const r of mine) {
    if (r.deleted || !isObj(r.row)) {
      if (r.table === 'pages' || r.table === 'messages' || r.table === 'inquiries') {
        deleted.set(r.id, deletedSig(r));
      }
      continue;
    }
    const row = r.row;
    const live: LiveRow = { ...r, row };
    if (r.table === 'pages') {
      if (row.kind === 'council' || row.kind === 'question') pageRows.set(r.id, live);
    } else if (r.table === 'messages') {
      if (row.kind === 'kept') {
        if (row.kept === true) kept.push(live);
        else deleted.set(r.id, deletedSig(r));
      } else if (typeof row.pageId === 'string' && row.pageId) {
        const list = lineRows.get(row.pageId) ?? [];
        list.push(live);
        lineRows.set(row.pageId, list);
      }
    } else if (r.table === 'inquiries') inquiries.push(live);
  }

  const pages: NotebookDraft[] = [];
  const linesFor = (pageId: string, fallbackAt: string | null) =>
    (lineRows.get(pageId) ?? [])
      .slice()
      .sort((a, b) => byAt(a.row, b.row))
      .map((r) => lineOf(r.row, fallbackAt));

  for (const [id, r] of pageRows) {
    const row = r.row;
    const date = isoOf(row.createdAt) ?? isoOf(r.at) ?? new Date(0).toISOString();
    const council = row.kind === 'council';
    const seated = ids(row.seats)
      .map(speakerOf)
      .filter((x): x is string => !!x);
    const chips = chipsOf(row);
    pages.push({
      _id: id,
      world,
      kind: council ? 'council' : 'thread',
      reading: council ? (row.reading === 'in' ? 'in' : 'about') : null,
      title: str(row.title),
      date,
      year: yearOf(row),
      lines: linesFor(id, date),
      chips: {
        characterIds: [...new Set([...chips.characterIds, ...seated])],
        placeIds: chips.placeIds,
      },
      research: null,
      questionId: !council && ctx.questions.has(id) ? id : null,
      sig: sigOf([r, ...(lineRows.get(id) ?? [])]),
    });
    deleted.delete(id);
  }

  // Lines on one of the bible's questions whose page row has not come up: the thread is the question's.
  for (const [pageId, list] of lineRows) {
    if (pageRows.has(pageId) || !ctx.questions.has(pageId)) continue;
    const [first] = list.slice().sort((a, b) => byAt(a.row, b.row));
    if (!first) continue;
    const date = isoOf(first.row.at) ?? isoOf(first.at) ?? new Date(0).toISOString();
    pages.push({
      _id: pageId,
      world,
      kind: 'thread',
      reading: null,
      title: ctx.questions.get(pageId) ?? '',
      date,
      year: null,
      lines: linesFor(pageId, date),
      chips: { characterIds: [], placeIds: [] },
      research: null,
      questionId: pageId,
      sig: sigOf(list),
    });
    deleted.delete(pageId);
  }

  for (const r of kept) {
    const row = r.row;
    const date = isoOf(row.date) ?? isoOf(row.at) ?? isoOf(r.at) ?? new Date(0).toISOString();
    pages.push({
      _id: r.id,
      world,
      kind: 'kept',
      reading: null,
      title: '',
      date,
      year: yearOf(row),
      lines: [{ ...lineOf(row, date), speakerId: null, kept: true }],
      chips: chipsOf(row),
      research: null,
      questionId: null,
      sig: sigOf([r]),
    });
    deleted.delete(r.id);
  }

  const byId = new Map(pages.map((p) => [p._id, p]));
  for (const r of inquiries) {
    const row = r.row;
    const pageId = strOrNull(row.pageId);
    const asked = pageId ? byId.get(pageId) : undefined;
    const date = isoOf(row.askedAt) ?? isoOf(r.at) ?? new Date(0).toISOString();
    const papers = Array.isArray(row.papers)
      ? row.papers.map(paperOf).filter((p): p is NotebookPaper => !!p)
      : [];
    pages.push({
      _id: r.id,
      world,
      kind: 'research',
      reading: null,
      title: str(row.question),
      date,
      year: asked?.year ?? null,
      lines: [],
      chips: { characterIds: [], placeIds: [] },
      research: { question: str(row.question), papers },
      questionId: pageId && ctx.questions.has(pageId) ? pageId : (asked?.questionId ?? null),
      sig: sigOf([r]),
    });
    deleted.delete(r.id);
  }
  return { pages, deleted };
}

/** A chapter as the links read it: its title and the number it is shown by (A54). */
export interface LinkChapter {
  id: string;
  title: string;
  number: number | null;
}

export interface LinkContext {
  index: RouterIndex;
  chapters: readonly LinkChapter[];
  /** Every character, place and chapter ID the bible holds, so a chip for one it lacks is dropped. */
  known: ReadonlySet<string>;
  /** The year a line with none of its own is read in: the page's year, else this. */
  storyYear: number;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Chapters a text names: by title as written (whole words, the title's own capitals), or "chapter 6". */
export function chaptersNamed(text: string, chapters: readonly LinkChapter[]): string[] {
  const out: string[] = [];
  for (const c of chapters) {
    const title = c.title.trim();
    const byTitle =
      title.length >= 3 && new RegExp(`(?<![\\p{L}\\p{N}])${escape(title)}(?![\\p{L}\\p{N}])`, 'u');
    const byNumber =
      c.number !== null && new RegExp(`(?<![\\p{L}])chapter\\s+${c.number}(?!\\p{N})`, 'iu');
    if ((byTitle && byTitle.test(text)) || (byNumber && byNumber.test(text))) out.push(c.id);
  }
  return out;
}

/**
 * NB-5: what a page is about. Its chips and seats, its speakers, and every
 * character, place, chapter and year its title and lines name, found by the
 * Capture Router's free stages (parse, resolve names, score; CR-1 to CR-4)
 * run on each line against the bible's index. Nothing is sent anywhere and
 * nothing is filed: these are the page's links, not drafts. A chip that
 * names an entry the bible lacks is dropped.
 */
export function linkNotebook(page: NotebookDraft, ctx: LinkContext): NotebookLinks {
  const characters = new Set<string>([...page.chips.characterIds]);
  const places = new Set<string>(page.chips.placeIds);
  const chapters = new Set<string>();
  const years = new Set<number>();
  if (page.year !== null) years.add(page.year);
  for (const l of page.lines) if (l.speakerId) characters.add(l.speakerId);
  const texts = [page.title, ...page.lines.map((l) => l.text)];
  if (page.research) texts.push(...page.research.papers.map((p) => p.title));
  const storyYear = page.year ?? ctx.storyYear;
  for (const text of texts) {
    if (!text.trim()) continue;
    const routed = routeCapture(text, ctx.index, { storyYear });
    for (const fact of routed.facts) {
      for (const c of fact.candidates) {
        if (!c.id) continue;
        if (c.kind === 'character') characters.add(c.id);
        else if (c.kind === 'place') places.add(c.id);
      }
      const own = parseYears(fact.text);
      if (own) {
        for (const y of own.years) years.add(y);
        if (own.start !== null) years.add(own.start);
        if (own.end !== null) years.add(own.end);
      }
    }
    for (const id of chaptersNamed(text, ctx.chapters)) chapters.add(id);
  }
  const keep = (s: Set<string>) => [...s].filter((id) => ctx.known.has(id)).sort();
  return {
    characterIds: keep(characters),
    placeIds: keep(places),
    chapterIds: keep(chapters),
    years: [...years].filter((y) => y >= -10000 && y <= 10000).sort((a, b) => a - b),
  };
}

/** A write a pull makes. */
export type NotebookOp =
  { op: 'put'; page: NotebookDraft & NotebookLinks } | { op: 'trash'; id: string; sig: string };

/**
 * NB-6: what a pull writes. A page whose rows and revisions are the ones
 * stored is left alone (a re-pull changes nothing), so its links are read
 * again only when a newer revision arrives; a changed or new page is put,
 * with its links read again; a page the phone deleted goes to the trash once.
 * A page whose trash came from the same delete is left there.
 */
export function planNotebook(
  assembled: Assembled,
  stored: readonly Pick<NotebookPage, '_id' | 'sig' | 'deletedAt' | 'world'>[],
  link: (page: NotebookDraft) => NotebookLinks,
): NotebookOp[] {
  const byId = new Map(stored.map((p) => [p._id, p]));
  const ops: NotebookOp[] = [];
  for (const page of assembled.pages) {
    const have = byId.get(page._id);
    if (have && have.sig === page.sig && !have.deletedAt) continue;
    ops.push({ op: 'put', page: { ...page, ...link(page) } });
  }
  for (const [id, sig] of assembled.deleted) {
    const have = byId.get(id);
    if (!have || have.deletedAt) continue;
    ops.push({ op: 'trash', id, sig });
  }
  return ops;
}

/** The first words of a page: a kept line's text, else the title, else its first line. */
export function firstLine(page: Pick<NotebookPage, 'kind' | 'title' | 'lines'>): string {
  if (page.kind === 'kept') return page.lines[0]?.text ?? '';
  if (page.title.trim()) return page.title.trim();
  return page.lines.find((l) => l.text.trim())?.text.trim() ?? '';
}

/** How a page is captioned: by kind, and for a council its reading. */
export function kindLabel(kind: NotebookKind, reading: NotebookPage['reading']): string {
  switch (kind) {
    case 'kept':
      return 'Kept line';
    case 'council':
      return reading === 'in' ? 'Council, in the story' : 'Council, about the story';
    case 'thread':
      return 'Question thread';
    case 'research':
      return 'Research';
  }
}

/** "story year 2071", or "the whole book". */
export function yearLabel(year: number | null): string {
  return year === null ? 'the whole book' : `story year ${year}`;
}

/** The caption under a row: "Kept line · story year 2071". */
export function notebookCaption(page: Pick<NotebookPage, 'kind' | 'reading' | 'year'>): string {
  return `${kindLabel(page.kind, page.reading)} · ${yearLabel(page.year)}`;
}

export interface NotebookRow {
  id: string;
  kind: NotebookKind;
  reading: NotebookPage['reading'];
  date: string;
  year: number | null;
  firstLine: string;
  caption: string;
  /** A kept line is all there is to read; the rest open across the screen. */
  opens: boolean;
}

export type NotebookAbout = 'characters' | 'places' | 'chapters';

const FIELD: Record<NotebookAbout, 'characterIds' | 'placeIds' | 'chapterIds'> = {
  characters: 'characterIds',
  places: 'placeIds',
  chapters: 'chapterIds',
};

/** NB-7: the Notebook list of one character, place or chapter: live pages that name it, newest first. */
export function notebookRows(
  pages: readonly NotebookPage[],
  about: NotebookAbout,
  id: string,
): NotebookRow[] {
  const field = FIELD[about];
  return pages
    .filter((p) => !p.deletedAt && p[field].includes(id))
    .sort((a, b) => b.date.localeCompare(a.date) || a._id.localeCompare(b._id))
    .map((p) => ({
      id: p._id,
      kind: p.kind,
      reading: p.reading,
      date: p.date,
      year: p.year,
      firstLine: firstLine(p),
      caption: notebookCaption(p),
      opens: p.kind !== 'kept',
    }));
}

/** The words search indexes for a page (SR-1). */
export function notebookText(page: Pick<NotebookPage, 'title' | 'lines' | 'research'>): string {
  const parts = [page.title, ...page.lines.map((l) => l.text)];
  if (page.research) {
    parts.push(page.research.question);
    for (const p of page.research.papers) parts.push(p.title, p.journal ?? '');
  }
  return parts.filter(Boolean).join('\n');
}
