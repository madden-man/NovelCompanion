/**
 * The scene outline (PL-5, A24): one long bulleted text, free of the chapter
 * structure, kept per bible in `meta`. These helpers turn a plain textarea
 * into a bulleted list: Enter continues a bullet, Enter on an empty bullet
 * ends the list, Tab and Shift+Tab indent and outdent the current lines.
 */

export const SCENE_OUTLINE_ID = 'sceneOutline';

/** Lines starting with a bullet are scenes; headings and blank lines are not. */
export const BULLET = /^(\s*)([-*•])\s?(.*)$/;

/** Fix a stored meta document into the text it holds. */
export function sceneOutlineText(doc: Record<string, unknown> | null | undefined): string {
  return doc && typeof doc.text === 'string' ? doc.text : '';
}

/** The number of bullet lines with any text after the bullet. */
export function sceneCount(text: string): number {
  let n = 0;
  for (const line of text.split('\n')) {
    const m = BULLET.exec(line);
    if (m && (m[3] ?? '').trim()) n++;
  }
  return n;
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

/** Tab indents every line the selection touches by two spaces; Shift+Tab outdents. */
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
