export {
  escapeLineStart,
  escapeMarkdown,
  headingLevel,
  looksLikeHtml,
  markdown,
  markdownToText,
  markdownTokens,
} from './markdown';
export type { MarkdownToken } from './markdown';
export { htmlToMarkdown } from './fromHtml';
import { looksLikeHtml, markdownToText } from './markdown';
import { htmlToMarkdown } from './fromHtml';

/** A stored long text as Markdown: HTML from before A44 is converted, anything else is as it is. */
export function asMarkdown(text: string): string {
  return looksLikeHtml(text) ? htmlToMarkdown(text) : text;
}

/** Text from before A44 that is still HTML, as lines: one per block, a scene break as `* * *`. */
function htmlText(html: string): string {
  return html
    .replace(/<hr\s*\/?>/gi, '\n* * *\n')
    .replace(/<\/(p|h[1-6]|li|blockquote|div)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

/** Anything Markdown would read as more than characters. */
const MARKUP = /[*_~\\#>]|^\s*(?:[-+]|\d+[.)])(?:\s|$)|^\s*-{3,}\s*$/m;

/**
 * A stored long text as plain text, for search and the selection budget: one
 * line per paragraph, heading, list item or line break, a scene break as
 * `* * *`, and no formatting marks. HTML from before A44 reads the same way.
 */
export function plainText(stored: unknown): string {
  const text = typeof stored === 'string' ? stored : '';
  if (!text) return '';
  if (looksLikeHtml(text)) return htmlText(text);
  if (!MARKUP.test(text)) {
    return text
      .replace(/[ \t]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .replace(/\n{2,}/g, '\n')
      .trim();
  }
  return markdownToText(text);
}
