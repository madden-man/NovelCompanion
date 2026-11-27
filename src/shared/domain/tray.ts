/**
 * A56 (FN-1 to FN-5): the From the notebook tray, as pure functions. The
 * lines of kept lines and councils about the story run through the Capture
 * Router, and each fact becomes a card, grouped by the day's kept lines or
 * by council. A fact's key is its line's ID, the text the line had and its
 * place in the line, so a fact dismissed, filed or sent is not offered
 * again until the line changes. No Electron, MongoDB or React
 * (ARCHITECTURE rule 1).
 */
import type { NotebookPage } from '../schema/notebook';
import { YEAR_SOURCES, routeCapture } from './captureRouter';
import type { CaptureFact, CaptureHint, CaptureSection, RouterIndex } from './captureRouter';
import { hashText } from './notebook';

/** A line the tray offers, as the page holds it. */
export interface OfferedLine {
  id: string;
  text: string;
  /** The character who spoke it in a council, or null for his own ink. */
  speakerId: string | null;
}

/** A page the tray reads: a kept line, a council about the story, or a sentence from the phone (A58). */
export interface OfferedPage {
  id: string;
  kind: 'kept' | 'council' | 'phone';
  title: string;
  date: string;
  /** A number is that year, null the whole book, absent no year known. */
  year?: number | null;
  lines: OfferedLine[];
}

/**
 * FN-1: the pages and lines the tray offers. Kept lines, and councils about
 * the story with his ink and the characters' lines; never a council in the
 * story (decision 12), a thread, research, a paper's or another voice's
 * line, an empty line, or a page in the trash.
 */
export function offeredPages(
  pages: readonly NotebookPage[],
): (OfferedPage & { kind: 'kept' | 'council' })[] {
  const out: (OfferedPage & { kind: 'kept' | 'council' })[] = [];
  for (const p of pages) {
    if (p.deletedAt) continue;
    if (p.kind !== 'kept' && !(p.kind === 'council' && p.reading !== 'in')) continue;
    const lines = p.lines
      .filter((l) => (l.voice === 'ink' || l.voice === 'character') && l.text.trim())
      .map((l) => ({ id: l.id, text: l.text, speakerId: l.speakerId }));
    if (!lines.length) continue;
    out.push({
      id: p._id,
      kind: p.kind,
      title: p.title,
      date: p.date,
      ...(p.year !== undefined ? { year: p.year } : {}),
      lines,
    });
  }
  return out;
}

/**
 * A58 U5 (PH-28): the sentences the phone keeps for the desk, as pages of
 * one line each, in the story year each was caught in. The line's ID is the
 * stored one, so the tray's marks for it are the marks `waitingHandled`
 * reads, and the phone sees a handled line leave its list.
 */
export function waitingPages(
  lines: readonly { id: string; text: string; year: number; at: string }[],
): OfferedPage[] {
  return lines
    .filter((l) => l.text.trim())
    .map((l) => ({
      id: `phone:${l.id}`,
      kind: 'phone' as const,
      title: '',
      date: l.at,
      year: l.year,
      lines: [{ id: l.id, text: l.text, speakerId: null }],
    }));
}

/** The key of a line as it is now: its ID and a hash of its text. */
export const lineKey = (lineId: string, text: string): string => `${lineId}:${hashText(text)}`;

/** The key of one fact of a line (FN-4): the line's key and the fact's place in it. */
export const factKey = (lineId: string, text: string, fact: number): string =>
  `${lineKey(lineId, text)}#${fact}`;

/** The marks the tray keeps in `meta` (`notebookTray`). */
export interface TrayMarks {
  dismissed: readonly string[];
  filed: readonly string[];
  sent: readonly string[];
}

export const NO_MARKS: TrayMarks = { dismissed: [], filed: [], sent: [] };

/** The sections whose drafts need a year (FN-2). */
export const YEAR_SECTIONS: ReadonlySet<CaptureSection> = new Set([
  'moments',
  'worldEvents',
  'culturalEntries',
]);

/** The ask the tray adds when it will not guess a year. */
export const YEAR_ASK = 'Year';

/** One fact on a card. */
export interface TrayItem {
  key: string;
  pageId: string;
  lineId: string;
  /** The whole line, as the phone holds it now. */
  lineText: string;
  speakerId: string | null;
  fact: CaptureFact;
  /** The page's year, as the phone sent it. */
  year?: number | null;
  /** FN-2: the fact needs a year its page and words do not give. */
  needsYear: boolean;
}

export interface TrayGroup {
  /**
   * `day:2026-11-25` (the local day) for the day's kept lines, `council:<page ID>` for a
   * council, `phone:2026-11-25` for the day's sentences kept on the phone (A58).
   */
  id: string;
  kind: 'day' | 'council' | 'phone';
  /** The newest page's date in the group. */
  date: string;
  /** A council's title; empty for a day. */
  title: string;
  /** A council's year; a day's lines carry their own. */
  year?: number | null;
  items: TrayItem[];
}

export interface TrayOptions {
  /** The year a line is read in when its page has none: only a stand-in, never filed (FN-2). */
  storyYear: number;
  /** The writer's chips, by fact key. */
  hints?: Readonly<Record<string, Omit<CaptureHint, 'fact'>>>;
  marks?: TrayMarks;
  /** The time zone the days are read in; the computer's own when absent. */
  timeZone?: string;
}

/** FN-2: whether each fact of a line knows its year, and the line's facts with the Year ask added. */
function withYears(facts: CaptureFact[], pageYear: number | null | undefined): CaptureFact[] {
  if (typeof pageYear === 'number') return facts;
  let prevKnown = false;
  return facts.map((f) => {
    const src = f.years.source;
    const known =
      src === YEAR_SOURCES.story ? false : src === YEAR_SOURCES.before ? prevKnown : true;
    prevKnown = known;
    if (known || !YEAR_SECTIONS.has(f.section) || f.asks.includes(YEAR_ASK)) return f;
    return { ...f, asks: [...f.asks, YEAR_ASK], missing: [...f.missing, YEAR_ASK] };
  });
}

/**
 * The local day of an ISO time, `2026-11-25`: the day the group's heading
 * shows (in `timeZone`, else the computer's own). A line kept at 08:30 in
 * Japan is that morning's, not the UTC day before.
 */
export function localDay(iso: string, timeZone?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  const parts = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    ...(timeZone ? { timeZone } : {}),
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/**
 * FN-1 to FN-5: the tray's groups, newest first. Each offered line is routed
 * on its own in its page's year (or the stand-in year, with the Year ask
 * where a draft needs one), with the writer's chips; each fact not
 * dismissed, filed or sent is an item. Kept lines group by the day they
 * were written; each council is its own group. Empty groups are left out.
 */
export function trayGroups(
  pages: readonly OfferedPage[],
  index: RouterIndex,
  opts: TrayOptions,
): TrayGroup[] {
  const marks = opts.marks ?? NO_MARKS;
  const gone = new Set([...marks.dismissed, ...marks.filed, ...marks.sent]);
  const groups = new Map<string, TrayGroup>();
  const sorted = [...pages].sort(
    (a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id),
  );
  for (const page of sorted) {
    const year = typeof page.year === 'number' ? page.year : opts.storyYear;
    const items: TrayItem[] = [];
    for (const line of page.lines) {
      const lk = lineKey(line.id, line.text);
      const hints: CaptureHint[] = [];
      for (const [key, hint] of Object.entries(opts.hints ?? {})) {
        if (!key.startsWith(`${lk}#`)) continue;
        const fact = Number(key.slice(lk.length + 1));
        if (Number.isInteger(fact) && fact >= 0) hints.push({ ...hint, fact });
      }
      const facts = withYears(
        routeCapture(line.text, index, { storyYear: year, hints }).facts,
        page.year,
      );
      for (const fact of facts) {
        const key = `${lk}#${fact.index}`;
        if (gone.has(key)) continue;
        items.push({
          key,
          pageId: page.id,
          lineId: line.id,
          lineText: line.text,
          speakerId: line.speakerId,
          fact,
          ...(page.year !== undefined ? { year: page.year } : {}),
          needsYear: fact.asks.includes(YEAR_ASK),
        });
      }
    }
    if (!items.length) continue;
    const id =
      page.kind === 'council'
        ? `council:${page.id}`
        : `${page.kind === 'kept' ? 'day' : 'phone'}:${localDay(page.date, opts.timeZone)}`;
    const have = groups.get(id);
    if (have) {
      have.items.push(...items);
      continue;
    }
    groups.set(id, {
      id,
      kind: page.kind === 'kept' ? 'day' : page.kind,
      date: page.date,
      title: page.kind === 'council' ? page.title : '',
      ...(page.kind === 'council' && page.year !== undefined ? { year: page.year } : {}),
      items,
    });
  }
  return [...groups.values()].sort(
    (a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id),
  );
}

/**
 * FN-4: the marks with `keys` set to `mark`, or cleared with null (undo).
 * A key holds one mark at a time.
 */
export function withMarks(
  marks: TrayMarks,
  keys: readonly string[],
  mark: keyof TrayMarks | null,
): TrayMarks {
  const drop = new Set(keys);
  const next = {
    dismissed: marks.dismissed.filter((k) => !drop.has(k)),
    filed: marks.filed.filter((k) => !drop.has(k)),
    sent: marks.sent.filter((k) => !drop.has(k)),
  };
  if (mark) next[mark] = [...next[mark], ...new Set(keys)];
  return next;
}
