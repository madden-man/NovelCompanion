/**
 * The chapter text as numbered lines (CC-3): one paragraph per line, a scene
 * break as `* * *`, numbered from 1. The numbering is a pure function of the
 * manuscript text stored with the chapter (MS-1), so the same text always
 * has the same line numbers, on every run and on every screen. Each finding
 * also stores a hash of the text it was found in, so a later change to the
 * text is detected (CC-4, Dismiss).
 */
import { manuscriptLines } from '../manuscript';

export interface NumberedLine {
  n: number;
  text: string;
}

export function numberedLines(manuscriptText: unknown): NumberedLine[] {
  const text = typeof manuscriptText === 'string' ? manuscriptText : '';
  return manuscriptLines(text).map((t, i) => ({ n: i + 1, text: t }));
}

/** The lines as Claude reads them: `12: text`. */
export function numberedText(lines: readonly NumberedLine[]): string {
  return lines.map((l) => `${l.n}: ${l.text}`).join('\n');
}

const squash = (s: string) =>
  s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Where a quoted passage sits: the first run of lines that contains it, or
 * null. Quotes are compared ignoring case, spacing, and curly quotes, and an
 * ellipsis splits a quote into pieces that must appear in order.
 */
export function locateQuote(
  lines: readonly NumberedLine[],
  quote: string,
): { start: number; end: number } | null {
  const pieces = quote
    .split(/\.\.\.|…/)
    .map(squash)
    .filter(Boolean);
  if (!pieces.length) return null;
  // The shortest run of lines wins, earliest first.
  for (let len = 1; len <= Math.min(12, lines.length); len++) {
    for (let s = 0; s + len <= lines.length; s++) {
      const joined = lines
        .slice(s, s + len)
        .map((l) => squash(l.text))
        .join(' ');
      let at = 0;
      const ok = pieces.every((p) => {
        const i = joined.indexOf(p, at);
        if (i < 0) return false;
        at = i + p.length;
        return true;
      });
      if (ok) return { start: s + 1, end: s + len };
    }
  }
  return null;
}

/**
 * A short, stable hash of a string (53-bit cyrb53, as hex). Used to notice
 * that a chapter's text or a cited entry changed since a finding was dismissed.
 * Not for security.
 */
export function textHash(s: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}
