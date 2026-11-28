import {
  BULLET,
  indentLines,
  joinSections,
  retext,
  sectionOf,
  sliceSection,
  withSection,
} from '../../../../shared/domain/sceneOutline';
import type { Flow } from '../../../../shared/domain/sceneOutline';

/**
 * A58 U2: the phone's outline works on one line at a time, in page order:
 * the lines before the first chapter, then each chapter's lines. Pure, so the
 * unit tests read it without a screen. Years go with their lines throughout.
 */
export interface LineRef {
  key: string;
  line: number;
}

const indentOf = (line: string): number => (/^\s*/.exec(line)?.[0] ?? '').length;

/** A line's prefix (indent and bullet) and the words after it, which are what the phone edits. */
export function splitLine(line: string): { prefix: string; body: string } {
  const m = BULLET.exec(line);
  if (!m) {
    const prefix = /^\s*/.exec(line)?.[0] ?? '';
    return { prefix, body: line.slice(prefix.length) };
  }
  const body = m[3] ?? '';
  return { prefix: line.slice(0, line.length - body.length), body };
}

/** A new line under `line` takes its indent and bullet; a plain line gives a top-level bullet. */
export function nextPrefix(line: string | undefined): string {
  if (line === undefined) return '- ';
  const m = BULLET.exec(line);
  return m ? `${m[1] ?? ''}${m[2] ?? '-'} ` : '- ';
}

/** How many lines move with line `i`: itself and the more deeply indented lines right under it. */
export function blockLength(lines: readonly string[], i: number): number {
  const own = indentOf(lines[i] ?? '');
  let n = 1;
  while (i + n < lines.length && indentOf(lines[i + n] as string) > own) n++;
  return n;
}

/** The words of one line changed; its indent and bullet stay. */
export function setLineBody(flow: Flow, at: LineRef, body: string): Flow {
  const sec = sectionOf(flow, at.key);
  const old = sec.lines[at.line];
  if (old === undefined) return flow;
  const next = [...sec.lines];
  next[at.line] = splitLine(old).prefix + body;
  return withSection(flow, at.key, retext(sec, next));
}

/** A line put in before line `at.line` of its section (at the end when it is past the last). */
export function insertLine(flow: Flow, at: LineRef, line: string): Flow {
  const sec = sectionOf(flow, at.key);
  const i = Math.max(0, Math.min(at.line, sec.lines.length));
  const next = [...sec.lines.slice(0, i), line, ...sec.lines.slice(i)];
  return withSection(flow, at.key, retext(sec, next));
}

/** One line split at `caret` of its words: the rest goes to a new line under it, with the same bullet. */
export function splitLineAt(flow: Flow, at: LineRef, caret: number): Flow {
  const sec = sectionOf(flow, at.key);
  const old = sec.lines[at.line];
  if (old === undefined) return flow;
  const { prefix, body } = splitLine(old);
  const next = [...sec.lines];
  next.splice(at.line, 1, prefix + body.slice(0, caret), nextPrefix(old) + body.slice(caret));
  return withSection(flow, at.key, retext(sec, next));
}

/** One line taken out; the lines under it stay. */
export function deleteLine(flow: Flow, at: LineRef): Flow {
  const sec = sectionOf(flow, at.key);
  if (at.line < 0 || at.line >= sec.lines.length) return flow;
  const next = sec.lines.filter((_, i) => i !== at.line);
  return withSection(flow, at.key, retext(sec, next));
}

/**
 * Indent or outdent one line, as Tab and Shift+Tab do on the desk: no deeper
 * than one level past the line above it in page order.
 */
export function indentLine(
  flow: Flow,
  keys: readonly string[],
  at: LineRef,
  outdent: boolean,
): Flow | null {
  const sec = sectionOf(flow, at.key);
  if (sec.lines[at.line] === undefined) return null;
  const text = sec.lines.join('\n');
  const start = sec.lines.slice(0, at.line).reduce((n, l) => n + l.length + 1, 0);
  const next = indentLines(
    { text, selectionStart: start, selectionEnd: start },
    outdent,
    lineAbove(flow, keys, at.key),
  );
  if (next.text === text) return null;
  return withSection(flow, at.key, retext(sec, next.text.split('\n')));
}

/** The last line of the text above section `key`, in page order. */
export function lineAbove(flow: Flow, keys: readonly string[], key: string): string | null {
  const i = keys.indexOf(key);
  for (let k = i - 1; k >= 0; k--) {
    const last = sectionOf(flow, keys[k] as string).lines.at(-1);
    if (last !== undefined) return last;
  }
  return null;
}

/**
 * `len` lines from `from` go to before line `to.line` of `to.key`, counted in
 * that section as it is before the move. Null when nothing would change.
 */
export function moveLines(flow: Flow, from: LineRef, len: number, to: LineRef): Flow | null {
  const src = sectionOf(flow, from.key);
  if (from.line < 0 || from.line + len > src.lines.length || len < 1) return null;
  const same = from.key === to.key;
  if (same && to.line >= from.line && to.line <= from.line + len) return null;
  const block = sliceSection(src, from.line, from.line + len);
  const rest = joinSections(sliceSection(src, 0, from.line), sliceSection(src, from.line + len));
  const afterRemoval = withSection(flow, from.key, rest);
  const dst = sectionOf(afterRemoval, to.key);
  const at = Math.max(
    0,
    Math.min(dst.lines.length, same && to.line > from.line ? to.line - len : to.line),
  );
  const placed = joinSections(joinSections(sliceSection(dst, 0, at), block), sliceSection(dst, at));
  return withSection(afterRemoval, to.key, placed);
}

/**
 * Move up or down: a line and the lines under it step past the line or block
 * next to it; at the top or foot of a chapter they cross into the chapter
 * above or below. Returns the flow and where the line went.
 */
export function stepLine(
  flow: Flow,
  keys: readonly string[],
  at: LineRef,
  by: -1 | 1,
): { flow: Flow; at: LineRef } | null {
  const lines = sectionOf(flow, at.key).lines;
  if (lines[at.line] === undefined) return null;
  const len = blockLength(lines, at.line);
  const k = keys.indexOf(at.key);
  if (by < 0) {
    if (at.line === 0) {
      const prev = keys[k - 1];
      if (prev === undefined) return null;
      const end = sectionOf(flow, prev).lines.length;
      const next = moveLines(flow, at, len, { key: prev, line: end });
      return next && { flow: next, at: { key: prev, line: end } };
    }
    const own = indentOf(lines[at.line] as string);
    let p = at.line - 1;
    while (p > 0 && indentOf(lines[p] as string) > own) p--;
    const next = moveLines(flow, at, len, { key: at.key, line: p });
    return next && { flow: next, at: { key: at.key, line: p } };
  }
  const j = at.line + len;
  if (j >= lines.length) {
    const nextKey = keys[k + 1];
    if (nextKey === undefined) return null;
    const next = moveLines(flow, at, len, { key: nextKey, line: 0 });
    return next && { flow: next, at: { key: nextKey, line: 0 } };
  }
  const target = j + blockLength(lines, j);
  const next = moveLines(flow, at, len, { key: at.key, line: target });
  return next && { flow: next, at: { key: at.key, line: target - len } };
}
