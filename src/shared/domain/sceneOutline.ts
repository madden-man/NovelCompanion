/**
 * The scene outline (PL-5, SM-5, SM-7): one long bulleted text kept per bible
 * in `meta` and versioned in `sceneOutlineVersions`. Each chapter starts at a
 * line of it (`breaks`) and owns the lines up to the next chapter; a scene may
 * carry its own story year (`years`, by the line of its bullet). These helpers
 * turn a plain textarea into a bulleted list (Enter continues a bullet, Enter
 * on an empty bullet ends the list, Cmd+] and Cmd+[ indent and outdent),
 * number the scenes, split the text into the chapters' sections and join it
 * back, keep the years on their scenes through every edit, and do the
 * arithmetic of the chapter bars beside the text.
 */

export const SCENE_OUTLINE_ID = 'sceneOutline';
export const SCENE_VERSIONS_COLLECTION = 'sceneOutlineVersions';

/** Edits closer together than this land in the same version. */
export const VERSION_GAP_MS = 10 * 60 * 1000;

/** Lines starting with a bullet; group 1 is the indent, 3 the text. */
export const BULLET = /^(\s*)([-*•])\s?(.*)$/;

/** Chapter ID to the line its section starts on, 0-based (A37). */
export type SceneBreaks = Record<string, number>;

/** SM-5: the line of a scene's bullet (0-based, as a string key) to its own story year. */
export type SceneYears = Record<string, number>;

export interface SceneOutlineState {
  text: string;
  breaks: SceneBreaks;
  years: SceneYears;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Fix a stored meta or version document into the text it holds. */
export function sceneOutlineText(doc: Record<string, unknown> | null | undefined): string {
  return doc && typeof doc.text === 'string' ? doc.text : '';
}

/**
 * Fix a stored document's breaks: only whole, non-negative line numbers
 * survive. An outline (or a version) saved before A37 holds scene ranges and
 * no breaks; its breaks are derived from them once, each chapter starting at
 * the first line of its range's first scene (past the end when the scene is
 * gone). The next save writes the breaks and drops the ranges.
 */
export function sceneBreaks(doc: Record<string, unknown> | null | undefined): SceneBreaks {
  const raw = doc?.breaks;
  const out: SceneBreaks = {};
  if (isRecord(raw)) {
    for (const [id, line] of Object.entries(raw)) {
      if (typeof line === 'number' && Number.isInteger(line) && line >= 0) out[id] = line;
    }
  }
  if (Object.keys(out).length > 0 || !isRecord(doc?.ranges)) return out;
  const text = sceneOutlineText(doc);
  const firstLine = new Map<number, number>();
  sceneLines(text).forEach((n, i) => {
    if (n !== null && !firstLine.has(n)) firstLine.set(n, i);
  });
  const count = text === '' ? 0 : text.split('\n').length;
  for (const [id, r] of Object.entries(doc.ranges)) {
    if (!isRecord(r) || typeof r.from !== 'number' || !Number.isInteger(r.from) || r.from < 1) {
      continue;
    }
    out[id] = firstLine.get(r.from) ?? count;
  }
  return out;
}

export function sameBreaks(a: SceneBreaks, b: SceneBreaks): boolean {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
}

/** The earliest and latest story year a scene can hold, as for every year in the bible. */
export const MIN_YEAR = -10000;
export const MAX_YEAR = 10000;
const isYear = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= MIN_YEAR && v <= MAX_YEAR;

/** Fix a stored document's years: whole line numbers to whole years only. */
export function sceneYears(doc: Record<string, unknown> | null | undefined): SceneYears {
  const raw = doc?.years;
  if (!isRecord(raw)) return {};
  const out: SceneYears = {};
  for (const [line, year] of Object.entries(raw)) {
    if (/^(0|[1-9]\d*)$/.test(line) && isYear(year)) out[line] = year;
  }
  return out;
}

export function sameYears(a: SceneYears, b: SceneYears): boolean {
  return sameBreaks(a, b);
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

// ---------- the flow: the text split into the chapters' sections ----------

/** A scene is a top-level bullet with text. */
export function isSceneLine(line: string): boolean {
  const m = BULLET.exec(line);
  return m !== null && m[1] === '' && (m[3] ?? '').trim() !== '';
}

/**
 * One section of the flow: its lines, and the years set on its scenes by the
 * line of the scene within the section (SM-5).
 */
export interface Section {
  lines: string[];
  years: Record<number, number>;
}

/** The text as the screen holds it: the lines before the first chapter, and each chapter's own lines. */
export interface Flow {
  lead: Section;
  bodies: Record<string, Section>;
}

export const section = (lines: readonly string[] = [], years: Record<number, number> = {}) => ({
  lines: [...lines],
  years: { ...years },
});

const toLines = (text: string): string[] => (text === '' ? [] : text.split('\n'));

/** A section with nothing but blank lines and empty bullets holds nothing. */
const blankLine = (line: string) => /^\s*([-*•]\s*)?$/.test(line);
const isBlank = (sec: Section) => sec.lines.every(blankLine);

/** Lines `from` to `to` of a section, with the years on them. */
export function sliceSection(sec: Section, from: number, to = sec.lines.length): Section {
  const years: Record<number, number> = {};
  for (const [k, y] of Object.entries(sec.years)) {
    const i = Number(k);
    if (i >= from && i < to) years[i - from] = y;
  }
  return { lines: sec.lines.slice(from, to), years };
}

/** Two sections one after the other. */
export function joinSections(a: Section, b: Section): Section {
  const years: Record<number, number> = { ...a.years };
  for (const [k, y] of Object.entries(b.years)) years[Number(k) + a.lines.length] = y;
  return { lines: [...a.lines, ...b.lines], years };
}

/** A section that holds nothing is stored as nothing. */
const kept = (sec: Section): Section => (isBlank(sec) ? section() : sec);

/**
 * Split stored text into the flow. Each chapter's section runs from its break
 * to the next break; equal breaks leave the earlier chapters empty, in
 * reading order. A section whose chapter is gone (in the trash) joins the
 * section above it, so no line is lost, and a chapter with no break starts
 * empty. Years go with the lines they sit on.
 */
export function splitFlow(
  doc: { text: string; breaks: SceneBreaks; years?: SceneYears },
  order: readonly string[],
): Flow {
  const whole: Section = { lines: toLines(doc.text), years: {} };
  for (const [k, y] of Object.entries(doc.years ?? {})) whole.years[Number(k)] = y;
  const count = whole.lines.length;
  const rank = new Map(order.map((id, i) => [id, i]));
  const starts = Object.entries(doc.breaks)
    .map(([id, line]) => ({ id, line: Math.min(Math.max(0, line), count) }))
    .sort(
      (a, b) =>
        a.line - b.line ||
        (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER),
    );
  let lead = sliceSection(whole, 0, starts[0]?.line ?? count);
  const bodies: Record<string, Section> = {};
  let above: string | null = null;
  starts.forEach((s, i) => {
    const own = sliceSection(whole, s.line, starts[i + 1]?.line ?? count);
    if (rank.has(s.id)) {
      bodies[s.id] = own;
      above = s.id;
    } else if (above === null) lead = joinSections(lead, own);
    else bodies[above] = joinSections(bodies[above] as Section, own);
  });
  for (const id of order) bodies[id] ??= section();
  return { lead, bodies };
}

/**
 * Join the flow back into one text in the order given (reading order), with
 * each chapter's break and the years of its scenes by their line in the whole
 * text. Sections holding only blank lines and empty bullets are left out of
 * the text; a year is kept only on a line that is a scene.
 */
export function composeFlow(flow: Flow, order: readonly string[]): SceneOutlineState {
  let all = kept(flow.lead);
  const breaks: SceneBreaks = {};
  for (const id of order) {
    breaks[id] = all.lines.length;
    all = joinSections(all, kept(flow.bodies[id] ?? section()));
  }
  const years: SceneYears = {};
  for (const [k, y] of Object.entries(all.years)) {
    const line = all.lines[Number(k)];
    if (line !== undefined && isSceneLine(line)) years[k] = y;
  }
  return { text: all.lines.join('\n'), breaks, years };
}

/**
 * Chapters that left the order (moved to the trash, or a new chapter undone)
 * hand their lines to the section that was above them, so the text stays where
 * it was; chapters new to the order start empty.
 */
export function refitFlow(flow: Flow, before: readonly string[], after: readonly string[]): Flow {
  const still = new Set(after);
  let lead = flow.lead;
  const bodies: Record<string, Section> = {};
  let above: string | null = null;
  for (const id of before) {
    const own = flow.bodies[id] ?? section();
    if (still.has(id)) {
      bodies[id] = own;
      above = id;
    } else if (above === null) lead = joinSections(lead, own);
    else bodies[above] = joinSections(bodies[above] as Section, own);
  }
  for (const id of after) bodies[id] ??= flow.bodies[id] ?? section();
  return { lead, bodies };
}

/** The section of a key: the lead, or a chapter's. */
export const LEAD = 'lead';
export const sectionOf = (flow: Flow, key: string): Section =>
  key === LEAD ? flow.lead : (flow.bodies[key] ?? section());
export const withSection = (flow: Flow, key: string, sec: Section): Flow =>
  key === LEAD ? { ...flow, lead: sec } : { ...flow, bodies: { ...flow.bodies, [key]: sec } };

/** Where each scene of a section starts: the indexes of its top-level bullets with text. */
export function sceneStarts(lines: readonly string[]): number[] {
  const out: number[] = [];
  lines.forEach((line, i) => {
    if (isSceneLine(line)) out.push(i);
  });
  return out;
}

/** The number of scenes in a section. */
export const sectionScenes = (lines: readonly string[]) => sceneStarts(lines).length;

// ---------- SM-5: years kept on their scenes through every edit ----------

/**
 * The section after its text changed to `next`. The lines before and after
 * the change keep their years (shifted by the lines put in or taken out); in
 * the changed lines the years go to the scenes there in order, so a typed
 * scene keeps its year, a split scene keeps it on its first half, a deleted
 * scene loses it, and scenes joined into one keep the first year among them.
 */
export function retext(sec: Section, next: readonly string[]): Section {
  const old = sec.lines;
  let p = 0;
  while (p < old.length && p < next.length && old[p] === next[p]) p++;
  let s = 0;
  while (
    s < old.length - p &&
    s < next.length - p &&
    old[old.length - 1 - s] === next[next.length - 1 - s]
  ) {
    s++;
  }
  const shift = next.length - old.length;
  const years: Record<number, number> = {};
  for (const [k, y] of Object.entries(sec.years)) {
    const i = Number(k);
    if (i < p) years[i] = y;
    else if (i >= old.length - s) years[i + shift] = y;
  }
  const was: (number | null)[] = [];
  for (let i = p; i < old.length - s; i++) {
    if (isSceneLine(old[i] as string)) was.push(sec.years[i] ?? null);
  }
  const now: number[] = [];
  for (let i = p; i < next.length - s; i++) if (isSceneLine(next[i] as string)) now.push(i);
  now.forEach((line, k) => {
    const last = k === now.length - 1;
    const pool = last && now.length < was.length ? was.slice(k) : [was[k] ?? null];
    const year = pool.find((y) => y !== null) ?? null;
    if (year !== null) years[line] = year;
  });
  return { lines: [...next], years };
}

/** A scene's own year set, or cleared with null so it inherits again. */
export function setSceneYear(sec: Section, line: number, year: number | null): Section {
  const years: Record<number, number> = {};
  for (const [k, y] of Object.entries(sec.years)) if (Number(k) !== line) years[Number(k)] = y;
  if (year !== null && isSceneLine(sec.lines[line] ?? '')) years[line] = year;
  return { lines: sec.lines, years };
}

/** The year a scene shows: its own, or inherited (SM-5). */
export interface ShownYear {
  year: number | null;
  own: boolean;
}

/**
 * The year beside every line of a section: null for a line that is not a
 * scene; a scene's own year; else the nearest scene above in the section with
 * one; else the chapter's year (its primary strand's). Inheritance never
 * crosses into the chapter above: it stops at the chapter's year.
 */
export function shownYears(sec: Section, chapterYear: number | null): (ShownYear | null)[] {
  let carry = chapterYear;
  return sec.lines.map((line, i) => {
    if (!isSceneLine(line)) return null;
    const own = sec.years[i];
    if (own !== undefined) {
      carry = own;
      return { year: own, own: true };
    }
    return { year: carry, own: false };
  });
}

/**
 * The year of the scene on a line of the whole text, own or inherited, given
 * the reading order and each chapter's year. Null when the line is not a
 * scene or nothing gives it a year.
 */
export function yearOf(
  doc: SceneOutlineState,
  order: readonly string[],
  chapterYears: Readonly<Record<string, number | null>>,
  line: number,
): ShownYear | null {
  const flow = splitFlow(doc, order);
  let at = line;
  for (const key of [LEAD, ...order]) {
    const sec = sectionOf(flow, key);
    if (at < sec.lines.length) {
      return shownYears(sec, key === LEAD ? null : (chapterYears[key] ?? null))[at] ?? null;
    }
    at -= sec.lines.length;
  }
  return null;
}

// ---------- SM-7: the chapter bars beside the text ----------

/** One chapter's bar: the lines of its section in the whole text, and its scenes. */
export interface Bar {
  id: string;
  /** First line of the section, 0-based. */
  from: number;
  /** The line after the section's last. */
  to: number;
  scenes: number;
  /** The number of its first scene in the whole outline (the next one when it has none). */
  firstScene: number;
}

/**
 * The bars in reading order from the stored breaks and the line count: each
 * runs from its break to the next chapter's break, or to the end.
 */
export function chapterBars(
  doc: { text: string; breaks: SceneBreaks },
  order: readonly string[],
): Bar[] {
  const lines = toLines(doc.text);
  const numbers = sceneLines(doc.text);
  const starts = order.map((id) =>
    Math.min(Math.max(0, doc.breaks[id] ?? lines.length), lines.length),
  );
  return order.map((id, i) => {
    const from = starts[i] as number;
    const to = Math.max(from, starts[i + 1] ?? lines.length);
    let scenes = 0;
    let before = 0;
    numbers.forEach((n, j) => {
      if (n === null) return;
      if (j < from) before = n;
      else if (j < to) scenes++;
    });
    return { id, from, to, scenes, firstScene: before + 1 };
  });
}

/** How far each edge of a chapter's bar can move, in scenes. */
export interface EdgeLimits {
  /** The start edge: up takes scenes from the section above, down gives them to it. */
  start: { up: number; down: number };
  /** The end edge: up gives scenes to the next chapter, down takes them from it. */
  end: { up: number; down: number };
}

/**
 * The limits of a chapter's edges: a chapter never gives away its last scene,
 * nor takes the last scene of the chapter next to it; the lines before the
 * first chapter may give all theirs. The last chapter has no end edge to move.
 */
export function edgeLimits(flow: Flow, order: readonly string[], id: string): EdgeLimits {
  const i = order.indexOf(id);
  const none = { start: { up: 0, down: 0 }, end: { up: 0, down: 0 } };
  if (i < 0) return none;
  const n = (key: string) => sectionScenes(sectionOf(flow, key).lines);
  const own = n(id);
  const aboveKey = i === 0 ? LEAD : (order[i - 1] as string);
  const above = n(aboveKey);
  const next = order[i + 1];
  return {
    start: {
      up: aboveKey === LEAD ? above : Math.max(0, above - 1),
      down: Math.max(0, own - 1),
    },
    end:
      next === undefined
        ? { up: 0, down: 0 }
        : { up: Math.max(0, own - 1), down: Math.max(0, n(next) - 1) },
  };
}

/**
 * The last scene of `above`, with its indented lines and years, moves to the
 * top of `own`. Null when `above` has no scene.
 */
export function takeSceneAbove(
  above: Section,
  own: Section,
): { above: Section; own: Section } | null {
  const at = sceneStarts(above.lines).at(-1);
  if (at === undefined) return null;
  return {
    above: sliceSection(above, 0, at),
    own: joinSections(sliceSection(above, at), kept(own)),
  };
}

/**
 * The first scene of `own`, with what sits before it and its indented lines,
 * moves to the end of `above`. Null when `own` has no scene.
 */
export function giveFirstScene(
  above: Section,
  own: Section,
): { above: Section; own: Section } | null {
  const starts = sceneStarts(own.lines);
  if (starts.length === 0) return null;
  const cut = starts[1] ?? own.lines.length;
  return {
    above: joinSections(kept(above), sliceSection(own, 0, cut)),
    own: sliceSection(own, cut),
  };
}

/**
 * Pull one edge of a chapter's bar `by` scenes (negative is up), within its
 * limits: the start edge moves the boundary with the section above, the end
 * edge the boundary with the next chapter, whose section grows or shrinks to
 * match. Returns the new flow, or null when the edge cannot move that way.
 */
export function moveEdge(
  flow: Flow,
  order: readonly string[],
  id: string,
  edge: 'start' | 'end',
  by: number,
): Flow | null {
  const i = order.indexOf(id);
  if (i < 0 || by === 0) return null;
  const limits = edgeLimits(flow, order, id)[edge];
  const steps = Math.min(Math.abs(by), by < 0 ? limits.up : limits.down);
  if (steps === 0) return null;
  const upper = edge === 'start' ? (i === 0 ? LEAD : (order[i - 1] as string)) : id;
  const lower = edge === 'start' ? id : (order[i + 1] as string);
  let a = sectionOf(flow, upper);
  let b = sectionOf(flow, lower);
  for (let k = 0; k < steps; k++) {
    const r = by < 0 ? takeSceneAbove(a, b) : giveFirstScene(a, b);
    if (!r) break;
    a = r.above;
    b = r.own;
  }
  return withSection(withSection(flow, upper, a), lower, b);
}

/** A chapter in reading order, with the part it is in. */
export interface PlacedChapter {
  id: string;
  partId: string;
}

/**
 * SM-7: the `plot.reorder` request that puts a chapter where `targetId` is,
 * just past it: after it when the target is below, before it when above. Next
 * to each other that swaps the two. Across a part the chapter joins the
 * target's part. Null when there is nothing to move.
 */
export function moveOnto(
  chapters: readonly PlacedChapter[],
  movedId: string,
  targetId: string,
): { kind: 'chapters'; groupId: string; movedId: string; toIndex: number } | null {
  const from = chapters.findIndex((c) => c.id === movedId);
  const to = chapters.findIndex((c) => c.id === targetId);
  if (from < 0 || to < 0 || from === to) return null;
  const target = chapters[to] as PlacedChapter;
  const moved = chapters[from] as PlacedChapter;
  const inPart = chapters.filter((c) => c.partId === target.partId);
  const at = inPart.findIndex((c) => c.id === targetId);
  const toIndex = moved.partId === target.partId ? at : to > from ? at + 1 : at;
  return { kind: 'chapters', groupId: target.partId, movedId, toIndex };
}

/** The neighbour a chapter swaps with: the one above (-1) or below (1), or null at the ends. */
export function neighbourOf(
  chapters: readonly PlacedChapter[],
  id: string,
  by: -1 | 1,
): string | null {
  const i = chapters.findIndex((c) => c.id === id);
  return i < 0 ? null : (chapters[i + by]?.id ?? null);
}
