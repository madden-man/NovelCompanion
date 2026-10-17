/**
 * The scene outline (PL-5, A36, A37): one long bulleted text kept per bible
 * in `meta` and versioned in `sceneOutlineVersions`. Each chapter starts at a
 * line of it (`breaks`) and owns the lines up to the next chapter, so the
 * text reads as one flow with the chapters as headings in it. These helpers
 * turn a plain textarea into a bulleted list (Enter continues a bullet, Enter
 * on an empty bullet ends the list, Cmd+] and Cmd+[ indent and outdent),
 * number the scenes, split the text into the chapters' sections and join it
 * back, and move a scene across a chapter's start.
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

/** Chapter ID to the line its section starts on, 0-based (A37). */
export type SceneBreaks = Record<string, number>;

export interface SceneOutlineState {
  text: string;
  ranges: SceneRanges;
  breaks: SceneBreaks;
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

/** Fix a stored document's breaks: only whole, non-negative line numbers survive. */
export function sceneBreaks(doc: Record<string, unknown> | null | undefined): SceneBreaks {
  const raw = doc?.breaks;
  if (!isRecord(raw)) return {};
  const out: SceneBreaks = {};
  for (const [id, line] of Object.entries(raw)) {
    if (typeof line === 'number' && Number.isInteger(line) && line >= 0) out[id] = line;
  }
  return out;
}

export function sameBreaks(a: SceneBreaks, b: SceneBreaks): boolean {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
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

// ---------- the flow: the text split into the chapters' sections (A37) ----------

/** The text as the flow shows it: the lines before the first chapter, and each chapter's own lines. */
export interface Flow {
  lead: string[];
  bodies: Record<string, string[]>;
}

const toLines = (text: string): string[] => (text === '' ? [] : text.split('\n'));

/** A section with nothing but blank lines and empty bullets holds nothing. */
const blankLine = (line: string) => /^\s*([-*•]\s*)?$/.test(line);
const kept = (lines: readonly string[]): string[] => (lines.every(blankLine) ? [] : [...lines]);

/**
 * Split stored text into the flow. Each chapter's section runs from its break
 * to the next break; equal breaks leave the earlier chapters empty, in
 * reading order. An outline saved before breaks existed starts each chapter
 * at the first scene of its range. A section whose chapter is gone (in the
 * trash) joins the section above it, so no line is lost, and a chapter with
 * no break starts empty.
 */
export function splitFlow(
  doc: { text: string; ranges: SceneRanges; breaks: SceneBreaks },
  order: readonly string[],
): Flow {
  const lines = toLines(doc.text);
  let breaks = doc.breaks;
  if (Object.keys(breaks).length === 0 && Object.keys(doc.ranges).length > 0) {
    const firstLine = new Map<number, number>();
    sceneLines(doc.text).forEach((n, i) => {
      if (n !== null && !firstLine.has(n)) firstLine.set(n, i);
    });
    breaks = {};
    for (const [id, r] of Object.entries(doc.ranges)) {
      breaks[id] = firstLine.get(r.from) ?? lines.length;
    }
  }
  const rank = new Map(order.map((id, i) => [id, i]));
  const starts = Object.entries(breaks)
    .map(([id, line]) => ({ id, line: Math.min(Math.max(0, line), lines.length) }))
    .sort(
      (a, b) =>
        a.line - b.line ||
        (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER),
    );
  const lead = lines.slice(0, starts[0]?.line ?? lines.length);
  const bodies: Record<string, string[]> = {};
  let above: string[] = lead;
  starts.forEach((s, i) => {
    const own = lines.slice(s.line, starts[i + 1]?.line ?? lines.length);
    if (rank.has(s.id)) {
      bodies[s.id] = own;
      above = own;
    } else above.push(...own);
  });
  for (const id of order) bodies[id] ??= [];
  return { lead, bodies };
}

/**
 * Join the flow back into one text in the order given (reading order), with
 * each chapter's break and the scene range it covers. Sections holding only
 * blank lines and empty bullets are left out of the text.
 */
export function composeFlow(flow: Flow, order: readonly string[]): SceneOutlineState {
  const lines = kept(flow.lead);
  const breaks: SceneBreaks = {};
  const owner: (string | null)[] = lines.map(() => null);
  for (const id of order) {
    breaks[id] = lines.length;
    for (const line of kept(flow.bodies[id] ?? [])) {
      lines.push(line);
      owner.push(id);
    }
  }
  const text = lines.join('\n');
  const ranges: SceneRanges = {};
  sceneLines(text).forEach((n, i) => {
    const id = owner[i];
    if (n === null || !id) return;
    const r = ranges[id];
    ranges[id] = r ? { from: r.from, to: n } : { from: n, to: n };
  });
  return { text, ranges, breaks };
}

/**
 * Chapters that left the order (moved to the trash, or a new chapter undone)
 * hand their lines to the section that was above them, so the text stays where
 * it was; chapters new to the order start empty.
 */
export function refitFlow(flow: Flow, before: readonly string[], after: readonly string[]): Flow {
  const still = new Set(after);
  const lead = [...flow.lead];
  const bodies: Record<string, string[]> = {};
  let above = lead;
  for (const id of before) {
    const own = flow.bodies[id] ?? [];
    if (still.has(id)) {
      bodies[id] = [...own];
      above = bodies[id];
    } else above.push(...own);
  }
  for (const id of after) bodies[id] ??= [...(flow.bodies[id] ?? [])];
  return { lead, bodies };
}

/** Where each scene of a section starts: the indexes of its top-level bullets with text. */
export function sceneStarts(lines: readonly string[]): number[] {
  const out: number[] = [];
  lines.forEach((line, i) => {
    const m = BULLET.exec(line);
    if (m && m[1] === '' && (m[3] ?? '').trim()) out.push(i);
  });
  return out;
}

/**
 * A chapter starts one scene earlier: the last scene of the section above,
 * with its indented lines, moves to the top of this one. Null when the
 * section above has no scene.
 */
export function takeSceneAbove(
  above: readonly string[],
  own: readonly string[],
): { above: string[]; own: string[] } | null {
  const at = sceneStarts(above).at(-1);
  if (at === undefined) return null;
  return { above: above.slice(0, at), own: [...above.slice(at), ...kept(own)] };
}

/**
 * A chapter starts one scene later: its first scene, with what sits before it
 * and its indented lines, moves to the end of the section above. Null when
 * the chapter has no scene.
 */
export function giveFirstScene(
  above: readonly string[],
  own: readonly string[],
): { above: string[]; own: string[] } | null {
  const starts = sceneStarts(own);
  if (starts.length === 0) return null;
  const cut = starts[1] ?? own.length;
  return { above: [...kept(above), ...own.slice(0, cut)], own: own.slice(cut) };
}

/** The number of scenes in a section. */
export const sectionScenes = (lines: readonly string[]) => sceneStarts(lines).length;
