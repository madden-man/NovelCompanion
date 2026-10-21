/**
 * Word documents (IM-4, MS-1): the HTML mammoth makes from a .docx becomes
 * the body format the editor stores. Headings, italics, bold, lists, and
 * scene breaks survive; everything else is plain text. Since A44 the bodies
 * the editor stores are Markdown (`blocksToMarkdown`); the manuscript text of
 * a chapter stays the HTML of `blocksToBody`, read only, since its line
 * numbers and finding hashes are taken from it (CC-3, CC-4).
 */
import { htmlToMarkdown } from '../markdown';

export interface DocBlock {
  /** The paragraph number in the document, from 1, counting every paragraph, heading, and list item. */
  index: number;
  kind: 'heading' | 'paragraph' | 'item' | 'quote' | 'scene';
  /** Heading level 1 to 4 (deeper headings count as 4). */
  level: number;
  /** The text without markup. */
  text: string;
  /** Allowed inline markup only. */
  inner: string;
  /** For items: the list they belong to. */
  list?: 'ul' | 'ol';
  /** Where in the block list the list this item belongs to starts, so items group. */
  listId?: number;
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': '\xa0',
};

export function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|lt|gt|quot|apos|nbsp|#39);/g, (m) => ENTITIES[m] ?? m)
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)));
}

const escapeText = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A paragraph that only marks a break between scenes: `***`, `* * *`, `#`, dashes, or spaces. */
export function isSceneBreak(rawText: string): boolean {
  const text = decodeEntities(rawText);
  if (/^[\s\xa0]{3,}$/.test(text)) return true;
  const t = text.trim();
  if (t === '') return false;
  return /^(\*\s*){3,}$/.test(t) || /^#+$/.test(t) || /^([-\u2013\u2014]\s*){3,}$/.test(t);
}

type Tok = { tag: string; close: boolean; self: boolean; text?: undefined } | { text: string };

function tokenize(html: string): Tok[] {
  const out: Tok[] = [];
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)([^>]*?)(\/?)>|<!--[\s\S]*?-->|([^<]+)/g;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    if (m[5] !== undefined) out.push({ text: m[5] });
    else if (m[2])
      out.push({
        tag: m[2].toLowerCase(),
        close: m[1] === '/',
        self: m[4] === '/' || /^(br|hr|img)$/i.test(m[2]),
      });
  }
  return out;
}

/** Inline markup kept in a block: emphasis, strength, underline, line breaks. */
function inlineOf(tokens: Tok[]): string {
  let out = '';
  const map: Record<string, string> = { em: 'em', i: 'em', strong: 'strong', b: 'strong', u: 'u' };
  for (const t of tokens) {
    if ('text' in t && t.text !== undefined) out += escapeText(decodeEntities(t.text));
    else if ('tag' in t) {
      if (t.tag === 'br') out += '<br>';
      else if (map[t.tag]) out += t.close ? `</${map[t.tag]}>` : `<${map[t.tag]}>`;
    }
  }
  return out.replace(/<(em|strong|u)><\/\1>/g, '');
}

function plainOf(tokens: Tok[]): string {
  return tokens
    .map((t) => ('text' in t && t.text !== undefined ? decodeEntities(t.text) : ''))
    .join('');
}

const BLOCK_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'blockquote', 'tr']);

/** The top level blocks of mammoth's HTML, numbered as paragraphs. */
export function parseBlocks(html: string): DocBlock[] {
  const tokens = tokenize(html);
  const blocks: DocBlock[] = [];
  const lists: ('ul' | 'ol')[] = [];
  let listCounter = 0;
  const listIds: number[] = [];
  let index = 0;
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (!t) break;
    if ('tag' in t && !t.close && (t.tag === 'ul' || t.tag === 'ol')) {
      lists.push(t.tag);
      listIds.push(++listCounter);
      i++;
      continue;
    }
    if ('tag' in t && t.close && (t.tag === 'ul' || t.tag === 'ol')) {
      lists.pop();
      listIds.pop();
      i++;
      continue;
    }
    if ('tag' in t && !t.close && BLOCK_TAGS.has(t.tag)) {
      const tag = t.tag;
      // Collect to the matching close tag, tolerating nested lists inside an item.
      let depth = 1;
      let j = i + 1;
      let nested = false;
      const inner: Tok[] = [];
      while (j < tokens.length) {
        const u = tokens[j];
        if (!u) break;
        if ('tag' in u && u.tag === tag) depth += u.close ? -1 : 1;
        if (depth === 0) break;
        if ('tag' in u && (u.tag === 'ul' || u.tag === 'ol') && tag === 'li') {
          nested = true;
          break;
        }
        inner.push(u);
        j++;
      }
      const plain = plainOf(inner);
      index += 1;
      const heading = /^h([1-6])$/.exec(tag);
      if (tag === 'tr') {
        // A table row reads as one paragraph; cells are separated by a bar.
        const cells = plain.trim() ? plain.trim() : '';
        if (cells)
          blocks.push({
            index,
            kind: 'paragraph',
            level: 0,
            text: cells,
            inner: escapeText(cells),
          });
        else index -= 1;
      } else if (heading) {
        blocks.push({
          index,
          kind: 'heading',
          level: Math.min(4, Number(heading[1])),
          text: plain.trim(),
          inner: inlineOf(inner),
        });
      } else if (tag === 'li') {
        blocks.push({
          index,
          kind: 'item',
          level: 0,
          text: plain.trim(),
          inner: inlineOf(inner),
          list: lists[lists.length - 1] ?? 'ul',
          listId: listIds[listIds.length - 1] ?? 0,
        });
      } else if (tag === 'blockquote') {
        blocks.push({ index, kind: 'quote', level: 0, text: plain.trim(), inner: inlineOf(inner) });
      } else if (isSceneBreak(plain)) {
        blocks.push({ index, kind: 'scene', level: 0, text: '', inner: '' });
      } else if (plain.trim() === '') {
        // An empty paragraph still counts in the numbering but adds nothing.
      } else {
        blocks.push({
          index,
          kind: 'paragraph',
          level: 0,
          text: plain.trim(),
          inner: inlineOf(inner),
        });
      }
      i = nested ? j : j + 1;
      continue;
    }
    i++;
  }
  return blocks;
}

/** The body format the editor stores: simple HTML, scene breaks as a rule. */
export function blocksToBody(blocks: DocBlock[]): string {
  const out: string[] = [];
  let openList: { tag: 'ul' | 'ol'; id: number } | null = null;
  let lastWasScene = true;
  const closeList = () => {
    if (openList) out.push(`</${openList.tag}>`);
    openList = null;
  };
  for (const b of blocks) {
    if (b.kind !== 'item') closeList();
    if (b.kind === 'scene') {
      // A scene break at the start, or two in a row, adds nothing.
      if (!lastWasScene) out.push('<hr>');
      lastWasScene = true;
      continue;
    }
    lastWasScene = false;
    if (b.kind === 'item') {
      const list = b.list ?? 'ul';
      if (!openList || openList.id !== b.listId) {
        closeList();
        out.push(`<${list}>`);
        openList = { tag: list, id: b.listId ?? 0 };
      }
      out.push(`<li>${b.inner}</li>`);
    } else if (b.kind === 'heading') out.push(`<h${b.level}>${b.inner}</h${b.level}>`);
    else if (b.kind === 'quote') out.push(`<blockquote>${b.inner}</blockquote>`);
    else out.push(`<p>${b.inner}</p>`);
  }
  closeList();
  while (out[out.length - 1] === '<hr>') out.pop();
  return out.join('');
}

/** A44: the body as an editable field stores it, Markdown: `##` and `###` headings, lists, `---` scene breaks. */
export function blocksToMarkdown(blocks: DocBlock[]): string {
  return htmlToMarkdown(blocksToBody(blocks));
}

/** Body HTML for mammoth's output (IM-4). */
export function htmlToBody(html: string): string {
  return blocksToBody(parseBlocks(html));
}

/** The first and last paragraph numbers of a run of blocks. */
export function spanOf(blocks: DocBlock[]): { first: number; last: number } {
  return { first: blocks[0]?.index ?? 1, last: blocks[blocks.length - 1]?.index ?? 1 };
}

/** A document's own title: its first heading, or its file name without the extension. */
export function documentTitle(blocks: DocBlock[], fileName: string): string {
  const heading = blocks.find((b) => b.kind === 'heading' && b.text);
  if (heading) return heading.text;
  return (
    fileName
      .replace(/\.[^.]+$/, '')
      .replace(/[_]+/g, ' ')
      .trim() || fileName
  );
}

export interface DocSection {
  /** The heading that opens the section, or null for text before the first heading. */
  heading: DocBlock | null;
  blocks: DocBlock[];
}

/** Split a document at every heading of the given level or higher (a smaller number is higher). */
export function sectionsAt(blocks: DocBlock[], maxLevel: number): DocSection[] {
  const out: DocSection[] = [];
  let cur: DocSection = { heading: null, blocks: [] };
  for (const b of blocks) {
    if (b.kind === 'heading' && b.level <= maxLevel) {
      if (cur.heading || cur.blocks.length) out.push(cur);
      cur = { heading: b, blocks: [] };
    } else cur.blocks.push(b);
  }
  if (cur.heading || cur.blocks.length) out.push(cur);
  return out;
}

/** Plain text of blocks, for reports and searching. */
export function textOf(blocks: DocBlock[]): string {
  return blocks
    .filter((b) => b.kind !== 'scene')
    .map((b) => b.text)
    .join('\n');
}
