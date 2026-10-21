/**
 * A44: HTML to the app's Markdown, without a DOM, so the main process can
 * convert imported documents and the migration can convert stored bodies.
 * It keeps what the editor keeps (paragraphs, headings, bold, italic,
 * strikethrough, lists, quotes, scene breaks, line breaks) and drops every
 * other tag, keeping its text.
 */
import { escapeLineStart, escapeMarkdown } from './markdown';

interface El {
  tag: string;
  attrs: string;
  children: Child[];
}
type Child = El | string;

const VOID = new Set(['br', 'hr', 'img', 'meta', 'link', 'input', 'col', 'wbr', 'area', 'source']);
const SKIP = new Set(['script', 'style', 'head', 'title', 'template']);
const BLOCK = new Set([
  'p',
  'div',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'blockquote',
  'hr',
  'pre',
  'section',
  'article',
  'header',
  'footer',
  'main',
  'aside',
  'body',
  'html',
  'table',
  'thead',
  'tbody',
  'tr',
  'td',
  'th',
  'dl',
  'dt',
  'dd',
  'figure',
  'figcaption',
]);

/** Named entities by code point, written as numbers so the source holds no typographic marks. */
const NAMED: Record<string, string> = Object.fromEntries(
  Object.entries({
    amp: 0x26,
    lt: 0x3c,
    gt: 0x3e,
    quot: 0x22,
    apos: 0x27,
    nbsp: 0x20,
    ndash: 0x2013,
    mdash: 0x2014,
    hellip: 0x2026,
    lsquo: 0x2018,
    rsquo: 0x2019,
    ldquo: 0x201c,
    rdquo: 0x201d,
  }).map(([name, code]) => [name, String.fromCodePoint(code)]),
);

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
    if (code[0] === '#') {
      const n =
        code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    return NAMED[code.toLowerCase()] ?? m;
  });
}

/** A forgiving parse into a tree: unclosed tags close at their parent's end. */
function parse(html: string): El {
  const root: El = { tag: '#root', attrs: '', children: [] };
  const stack: El[] = [root];
  const re = /<!--[\s\S]*?-->|<!\w[^>]*>|<(\/?)([a-zA-Z][\w:-]*)([^>]*)>|[^<]+|</g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const top = stack[stack.length - 1] as El;
    const [whole, close, rawTag, attrs] = m;
    if (rawTag === undefined) {
      if (whole.startsWith('<!')) continue;
      top.children.push(decode(whole));
      continue;
    }
    const tag = rawTag.toLowerCase();
    if (close) {
      const at = stack.map((e) => e.tag).lastIndexOf(tag);
      if (at > 0) stack.length = at;
      continue;
    }
    if (SKIP.has(tag)) {
      const end = html.toLowerCase().indexOf(`</${tag}`, re.lastIndex);
      re.lastIndex = end < 0 ? html.length : end;
      continue;
    }
    const el: El = { tag, attrs: attrs ?? '', children: [] };
    top.children.push(el);
    if (!VOID.has(tag) && !(attrs ?? '').trim().endsWith('/')) stack.push(el);
  }
  return root;
}

type Mark = 'bold' | 'italic' | 'strike';
const MARK_OF: Record<string, Mark> = {
  strong: 'bold',
  b: 'bold',
  em: 'italic',
  i: 'italic',
  cite: 'italic',
  s: 'strike',
  del: 'strike',
  strike: 'strike',
};
const DELIM: Record<Mark, string> = { bold: '**', italic: '*', strike: '~~' };

/** Bold that a style turns off (Google Docs wraps a whole paste in one). */
function styleOff(el: El): boolean {
  return /font-weight\s*:\s*(normal|400)/i.test(el.attrs);
}

function inline(nodes: Child[], marks: ReadonlySet<Mark>): string {
  let out = '';
  for (const n of nodes) {
    if (typeof n === 'string') {
      out += escapeMarkdown(n.replace(/\s+/g, ' '), false);
      continue;
    }
    if (n.tag === 'br') {
      out += '\n';
      continue;
    }
    if (n.tag === 'img' || n.tag === 'hr') continue;
    const mark = MARK_OF[n.tag];
    if (!mark || marks.has(mark) || (mark === 'bold' && styleOff(n))) {
      out += inline(n.children, marks);
      continue;
    }
    const inner = inline(n.children, new Set([...marks, mark]));
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner) as RegExpExecArray;
    const [, lead, core, trail] = m as unknown as [string, string, string, string];
    out += core ? `${lead}${DELIM[mark]}${core}${DELIM[mark]}${trail}` : inner;
  }
  return out;
}

/** One block's inline text: trimmed lines, each escaped at its start. */
function inlineBlock(nodes: Child[]): string {
  return inline(nodes, new Set())
    .split('\n')
    .map((l) => escapeLineStart(l.replace(/ {2,}/g, ' ').trim()))
    .join('\n')
    .replace(/^\n+|\n+$/g, '');
}

const isBlock = (c: Child) => typeof c !== 'string' && BLOCK.has(c.tag);

function indent(text: string, by: string): string {
  return text
    .split('\n')
    .map((l, i) => (i === 0 || !l ? l : `${by}${l}`))
    .join('\n');
}

function listBlock(el: El): string {
  const items = el.children.filter((c): c is El => typeof c !== 'string' && c.tag === 'li');
  const startAttr = /\bstart\s*=\s*["']?(\d+)/i.exec(el.attrs);
  const start = startAttr ? Number(startAttr[1]) : 1;
  const ordered = el.tag === 'ol';
  const width = String(start + items.length - 1).length;
  const lines: string[] = [];
  items.forEach((li, i) => {
    const marker = ordered ? `${String(start + i).padStart(width, ' ')}. ` : '- ';
    const body = blocks(li.children).join('\n');
    if (body) lines.push(`${marker}${indent(body, ' '.repeat(marker.length))}`);
  });
  return lines.join('\n');
}

function blocks(nodes: Child[]): string[] {
  const out: string[] = [];
  let run: Child[] = [];
  const flush = () => {
    const text = inlineBlock(run);
    if (text) out.push(text);
    run = [];
  };
  for (const n of nodes) {
    if (!isBlock(n)) {
      run.push(n);
      continue;
    }
    flush();
    const el = n as El;
    const heading = /^h([1-6])$/.exec(el.tag);
    if (heading) {
      const text = inlineBlock(el.children).replace(/\n/g, ' ');
      if (text) out.push(`${Number(heading[1]) <= 2 ? '##' : '###'} ${text}`);
    } else if (el.tag === 'hr') {
      if (out.length && out[out.length - 1] !== '---') out.push('---');
    } else if (el.tag === 'ul' || el.tag === 'ol') {
      const list = listBlock(el);
      if (list) out.push(list);
    } else if (el.tag === 'blockquote') {
      const inner = blocks(el.children).join('\n\n');
      if (inner) {
        out.push(
          inner
            .split('\n')
            .map((l) => (l ? `> ${l}` : '>'))
            .join('\n'),
        );
      }
    } else if (el.children.some(isBlock)) {
      out.push(...blocks(el.children));
    } else {
      const text = inlineBlock(el.children);
      if (text) out.push(text);
    }
  }
  flush();
  while (out[out.length - 1] === '---') out.pop();
  return out;
}

/** The Markdown for an HTML string. */
export function htmlToMarkdown(html: string): string {
  return blocks(parse(html).children).join('\n\n');
}
