/**
 * A44: every long text field stores one Markdown string. This module is the
 * one Markdown dialect the app reads and writes: paragraphs, `##` and `###`
 * headings, bold, italic, strikethrough, bullet and numbered lists, quotes,
 * and `---` scene breaks. A single line break is a line break (as a writer
 * expects), so plain text written before A44 reads the same. Code, links,
 * images, tables, raw HTML and entities are off: their characters stay text.
 */
import MarkdownIt from 'markdown-it';

type Token = ReturnType<MarkdownIt['parse']>[number];
export type { Token as MarkdownToken };

/** The shared parser. Never renders HTML itself; readers walk its tokens. */
export const markdown = new MarkdownIt('default', {
  html: false,
  linkify: false,
  typographer: false,
  breaks: true,
}).disable([
  'table',
  'code',
  'fence',
  'reference',
  'html_block',
  'lheading',
  'backticks',
  'link',
  'image',
  'autolink',
  'html_inline',
  'entity',
]);

/** The tokens of a Markdown string, for readers that draw it. */
export function markdownTokens(text: string): Token[] {
  return markdown.parse(text, {});
}

/** A heading's level in the app: `#` and `##` are the upper level, the rest the lower. */
export function headingLevel(tag: string): 2 | 3 {
  const n = Number(tag.replace(/\D/g, '')) || 2;
  return n <= 2 ? 2 : 3;
}

const BLOCK_END = new Set([
  'paragraph_close',
  'heading_close',
  'blockquote_close',
  'bullet_list_close',
  'ordered_list_close',
  'list_item_close',
]);

/**
 * Plain text of a Markdown string: one line per paragraph, heading, list item,
 * or line break, and a scene break as `* * *`. No formatting marks survive.
 */
export function markdownToText(text: string): string {
  const out: string[] = [];
  for (const t of markdownTokens(text)) {
    if (t.type === 'inline') {
      for (const c of t.children ?? []) {
        if (c.type === 'text') out.push(c.content);
        else if (c.type === 'softbreak' || c.type === 'hardbreak') out.push('\n');
      }
    } else if (t.type === 'hr') out.push('\n* * *\n');
    else if (BLOCK_END.has(t.type)) out.push('\n');
  }
  return out
    .join('')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/**
 * True when a stored string is HTML from before A44 (the importer wrote
 * simple HTML). A tag the writer escaped with a backslash does not count.
 */
export function looksLikeHtml(text: string): boolean {
  return /(^|[^\\])<\/?(p|em|strong|i|b|u|s|del|strike|ul|ol|li|h[1-6]|br|hr|blockquote|div|span)\b[^>]*>/i.test(
    text,
  );
}

/**
 * Escape text so Markdown reads it back as the same characters. Inside a
 * word an underscore stays as it is. At the start of a line, what would open
 * a heading, list, quote or scene break is escaped too.
 */
export function escapeMarkdown(text: string, startOfLine: boolean): string {
  const s = text.replace(/[\\*~]|_|<(?=[A-Za-z/])/g, (m, i: number) => {
    if (m === '_') {
      const before = text[i - 1] ?? '';
      const after = text[i + 1] ?? '';
      return /\w/.test(before) && /\w/.test(after) ? m : '\\_';
    }
    return `\\${m}`;
  });
  return startOfLine ? escapeLineStart(s) : s;
}

/** Escape what would open a heading, list, quote or scene break at the start of a line. */
export function escapeLineStart(line: string): string {
  return line
    .replace(/^(\s*)([-+])(?=\s|$|(?:\s*-){2,}\s*$)/, '$1\\$2')
    .replace(/^(\s*)>/, '$1\\>')
    .replace(/^(\s*)(#{1,6})(?=\s|$)/, '$1\\$2')
    .replace(/^(\s*\d+)([.)])(?=\s|$)/, '$1\\$2');
}
