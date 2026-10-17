/**
 * The scene outline (PL-5, A36): one long bulleted text, free of the chapter
 * structure, kept per bible in `meta` with the chapters' scene ranges, and
 * versioned in `sceneOutlineVersions`. These helpers turn a plain textarea
 * into a bulleted list (Enter continues a bullet, Enter on an empty bullet
 * ends the list, Cmd+] and Cmd+[ indent and outdent), number the scenes, and
 * check the ranges.
 */

export const SCENE_OUTLINE_ID = 'sceneOutline';
export const SCENE_VERSIONS_COLLECTION = 'sceneOutlineVersions';

/** Edits closer together than this land in the same version. */
export const VERSION_GAP_MS = 10 * 60 * 1000;

/** Lines starting with a bullet; group 1 is the indent, 3 the text. */
export const BULLET = /^(\s*)([-*•])\s?(.*)$/;

export interface SceneRange {
  from: number;
  to: number;
}
/** Chapter ID to the scenes it covers, 1-based and inclusive. */
export type SceneRanges = Record<string, SceneRange>;

export interface SceneOutlineState {
  text: string;
  ranges: SceneRanges;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const whole = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1;

/** Fix a stored meta or version document into the text it holds. */
export function sceneOutlineText(doc: Record<string, unknown> | null | undefined): string {
  return doc && typeof doc.text === 'string' ? doc.text : '';
}

/** Fix a stored document's ranges: only whole, ordered, 1-based pairs survive. */
export function sceneRanges(doc: Record<string, unknown> | null | undefined): SceneRanges {
  const raw = doc?.ranges;
  if (!isRecord(raw)) return {};
  const out: SceneRanges = {};
  for (const [id, r] of Object.entries(raw)) {
    if (!isRecord(r) || !whole(r.from) || !whole(r.to) || r.to < r.from) continue;
    out[id] = { from: r.from, to: r.to };
  }
  return out;
}

export function sameRanges(a: SceneRanges, b: SceneRanges): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => {
    const x = a[k];
    const y = b[k];
    return x !== undefined && y !== undefined && x.from === y.from && x.to === y.to;
  });
}

/**
 * The scene number of every line: top-level bullets with text are scenes,
 * numbered from 1 in order; indented bullets, headings and blank lines are
 * null (an indented bullet belongs to the scene above it).
 */
export function sceneLines(text: string): (number | null)[] {
  let n = 0;
  return text.split('\n').map((line) => {
    const m = BULLET.exec(line);
    if (!m || m[1] !== '' || !(m[3] ?? '').trim()) return null;
    n += 1;
    return n;
  });
}

/** The number of scenes. */
export function sceneCount(text: string): number {
  let n = 0;
  for (const s of sceneLines(text)) if (s !== null) n = s;
  return n;
}

export interface RangeIssue {
  chapterId: string;
  /** Plain words, such as "overlaps chapter 4" or "past the last scene". */
  message: string;
}

/**
 * Ranges that run past the last scene, or that share a scene with another
 * chapter. Overlaps are reported on both chapters. `number` gives a chapter's
 * reading-order number for the message.
 */
export function rangeIssues(
  ranges: SceneRanges,
  scenes: number,
  number: (chapterId: string) => number | string,
): RangeIssue[] {
  const out: RangeIssue[] = [];
  const pairs = Object.entries(ranges);
  for (const [id, r] of pairs) {
    const notes: string[] = [];
    if (r.to > scenes) notes.push(scenes === 0 ? 'no scenes yet' : 'past the last scene');
    const overlaps = pairs
      .filter(([o, q]) => o !== id && q.from <= r.to && q.to >= r.from)
      .map(([o]) => `chapter ${number(o)}`);
    if (overlaps.length) notes.push(`overlaps ${overlaps.join(', ')}`);
    if (notes.length) out.push({ chapterId: id, message: notes.join('; ') });
  }
  return out;
}

/** The chapters whose range covers a scene, in the order given. */
export function chaptersAtScene(ranges: SceneRanges, order: readonly string[], scene: number) {
  return order.filter((id) => {
    const r = ranges[id];
    return r !== undefined && r.from <= scene && scene <= r.to;
  });
}

/**
 * Whether a save opens a new version or lands in the latest one: a new one
 * when there is none, when asked, or when the latest was last touched more
 * than `VERSION_GAP_MS` ago.
 */
export function startsNewVersion(lastUntil: string | null, now: Date, force = false): boolean {
  if (force || lastUntil === null) return true;
  const then = Date.parse(lastUntil);
  return !Number.isFinite(then) || now.getTime() - then > VERSION_GAP_MS;
}

export interface TextEdit {
  text: string;
  selectionStart: number;
  selectionEnd: number;
}

function lineStartAt(text: string, pos: number): number {
  return text.lastIndexOf('\n', pos - 1) + 1;
}

function lineEndAt(text: string, pos: number): number {
  const i = text.indexOf('\n', pos);
  return i === -1 ? text.length : i;
}

/**
 * Enter inside a bulleted line: a new line with the same indent and bullet.
 * Enter on a bullet with no text: the bullet is removed and the list ends.
 * Returns null when the default newline is right (a plain line).
 */
export function continueBullet(edit: TextEdit): TextEdit | null {
  const { text, selectionStart, selectionEnd } = edit;
  const start = lineStartAt(text, selectionStart);
  const end = lineEndAt(text, selectionStart);
  const line = text.slice(start, end);
  const m = BULLET.exec(line);
  if (!m) return null;
  const indent = m[1] ?? '';
  const bullet = m[2] ?? '-';
  const rest = m[3] ?? '';
  if (!rest.trim() && selectionStart === selectionEnd) {
    // An empty bullet ends the list: the line becomes blank.
    const next = text.slice(0, start) + text.slice(end);
    return { text: next, selectionStart: start, selectionEnd: start };
  }
  const insert = `\n${indent}${bullet} `;
  const next = text.slice(0, selectionStart) + insert + text.slice(selectionEnd);
  const caret = selectionStart + insert.length;
  return { text: next, selectionStart: caret, selectionEnd: caret };
}

/** Indent every line the selection touches by two spaces, or outdent them. */
export function indentLines(edit: TextEdit, outdent: boolean): TextEdit {
  const { text, selectionStart, selectionEnd } = edit;
  const start = lineStartAt(text, selectionStart);
  const end = lineEndAt(
    text,
    Math.max(selectionStart, selectionEnd - (selectionEnd > selectionStart ? 1 : 0)),
  );
  const block = text.slice(start, end);
  let firstDelta = 0;
  let total = 0;
  const lines = block.split('\n').map((line, i) => {
    let delta: number;
    let out: string;
    if (outdent) {
      const removed = line.startsWith('  ') ? 2 : line.startsWith(' ') ? 1 : 0;
      out = line.slice(removed);
      delta = -removed;
    } else {
      out = `  ${line}`;
      delta = 2;
    }
    if (i === 0) firstDelta = delta;
    total += delta;
    return out;
  });
  const next = text.slice(0, start) + lines.join('\n') + text.slice(end);
  const s = Math.max(start, selectionStart + firstDelta);
  const e = Math.max(s, selectionEnd + total);
  return { text: next, selectionStart: s, selectionEnd: e };
}

/** Text a fresh outline starts with, so the first keystroke lands in a bullet. */
export const EMPTY_OUTLINE = '- ';

/** Keep a range inside the scenes there are; a range on no scenes stays as it is. */
export function clampRange(range: SceneRange, scenes: number): SceneRange {
  if (scenes < 1) return range;
  const from = Math.min(Math.max(1, range.from), scenes);
  const to = Math.min(Math.max(from, range.to), scenes);
  return { from, to };
}

/** Shift a whole range by `by` scenes, keeping its length, inside the scenes there are. */
export function moveRange(range: SceneRange, by: number, scenes: number): SceneRange {
  const len = range.to - range.from;
  const from = Math.min(Math.max(1, range.from + by), Math.max(1, scenes - len));
  return clampRange({ from, to: from + len }, scenes);
}

/** Change one end of a range by `by` scenes; the ends never cross. */
export function resizeRange(
  range: SceneRange,
  end: 'from' | 'to',
  by: number,
  scenes: number,
): SceneRange {
  if (end === 'from') {
    const from = Math.min(Math.max(1, range.from + by), range.to);
    return clampRange({ from, to: range.to }, scenes);
  }
  const to = Math.max(Math.min(range.to + by, Math.max(scenes, 1)), range.from);
  return clampRange({ from: range.from, to }, scenes);
}

/** The first scene after every placed chapter, for placing a new one; null when none is free. */
export function nextFreeScene(ranges: SceneRanges, scenes: number): number | null {
  if (scenes < 1) return null;
  const last = Math.max(0, ...Object.values(ranges).map((r) => r.to));
  return last < scenes ? last + 1 : null;
}

export interface Lane {
  lane: number;
  lanes: number;
}

/**
 * Side-by-side lanes for ranges that overlap, so every block stays visible:
 * in the order given, a range takes the first lane whose last range ends
 * before it starts. `lanes` is the total so widths can be shared out.
 */
export function laneLayout(order: readonly string[], ranges: SceneRanges): Map<string, Lane> {
  const ends: number[] = [];
  const picked = new Map<string, number>();
  const placed = order
    .flatMap((id) => {
      const r = ranges[id];
      return r ? [{ id, r }] : [];
    })
    .sort((a, b) => a.r.from - b.r.from || a.r.to - b.r.to);
  for (const { id, r } of placed) {
    let lane = ends.findIndex((end) => end < r.from);
    if (lane === -1) {
      lane = ends.length;
      ends.push(r.to);
    } else ends[lane] = r.to;
    picked.set(id, lane);
  }
  const lanes = Math.max(1, ends.length);
  return new Map([...picked].map(([id, lane]) => [id, { lane, lanes }]));
}

export interface LineBox {
  scene: number;
  top: number;
  bottom: number;
}

/** The scene whose line box holds `y`; above the first is the first, below the last is the last. */
export function sceneAtY(boxes: readonly LineBox[], y: number): number | null {
  if (boxes.length === 0) return null;
  for (const b of boxes) if (y < b.bottom) return b.scene;
  return boxes[boxes.length - 1]?.scene ?? null;
}
