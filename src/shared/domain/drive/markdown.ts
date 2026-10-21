/**
 * GD-4: the whole bible as Markdown, one file per entry, one folder per
 * section. Pure: it takes plain documents and returns file names and text.
 * The JSON file written beside it (BK-3) is the lossless copy; Markdown is
 * for reading.
 */
import { collectionInfo, entryTitle, manifests } from '../../schema';
import type { EntryCollection, FieldSpec } from '../../schema';

type Doc = Record<string, unknown> & { _id: string };

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'",
};

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, name: string) => {
    if (name.startsWith('#x') || name.startsWith('#X')) {
      return String.fromCodePoint(parseInt(name.slice(2), 16));
    }
    if (name.startsWith('#') && name !== '#39') return String.fromCodePoint(Number(name.slice(1)));
    return ENTITIES[name.toLowerCase()] ?? m;
  });
}

/**
 * The sanitized HTML the editor stores, as Markdown: headings, paragraphs,
 * italics, bold, lists, links, scene breaks (`<hr>` to `***`), line breaks.
 * Anything else keeps its text and loses its tag.
 */
export function htmlToMarkdown(html: string): string {
  if (!html.trim()) return '';
  if (!/<[a-z!/]/i.test(html)) return decode(html).trim();
  let s = html.replace(/\r\n?/g, '\n');
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/\n/g, ' ');
  s = s.replace(/<br\s*\/?>/gi, '  \n');
  s = s.replace(/<hr\s*\/?>/gi, '\n\n***\n\n');
  s = s.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, level: string, inner: string) => {
    return `\n\n${'#'.repeat(Number(level))} ${inner.trim()}\n\n`;
  });
  s = s.replace(/<(em|i)(\s[^>]*)?>([\s\S]*?)<\/\1>/gi, (_m, _t, _a, inner: string) =>
    inner.trim() ? `*${inner}*` : inner,
  );
  s = s.replace(/<(strong|b)(\s[^>]*)?>([\s\S]*?)<\/\1>/gi, (_m, _t, _a, inner: string) =>
    inner.trim() ? `**${inner}**` : inner,
  );
  s = s.replace(
    /<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi,
    (_m, href: string, inner: string) => `[${inner}](${href})`,
  );
  // Lists: number ordered items, bullet the rest.
  s = s.replace(/<(ol|ul)[^>]*>([\s\S]*?)<\/\1>/gi, (_m, tag: string, inner: string) => {
    let n = 0;
    const items = [...inner.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].map((li) => {
      n += 1;
      return `${tag.toLowerCase() === 'ol' ? `${n}.` : '-'} ${(li[1] ?? '').trim()}`;
    });
    return `\n\n${items.join('\n')}\n\n`;
  });
  s = s.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, (_m, inner: string) => `\n\n${inner.trim()}\n\n`);
  s = s.replace(/<\/?(div|blockquote|section)[^>]*>/gi, '\n\n');
  s = s.replace(/<[^>]+>/g, '');
  s = decode(s);
  return s
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, (t) => (t === '  ' ? t : '')))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** A file or folder name Drive and every desktop system accept. */
export function safeName(text: string, max = 80): string {
  const printable = [...text].map((ch) => (ch.charCodeAt(0) < 32 ? ' ' : ch)).join('');
  const cleaned = printable
    .replace(/[/\\:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '');
  return (cleaned || 'Untitled').slice(0, max).trim();
}

export interface MarkdownInput {
  bibleName: string;
  /** Live entries (not in the trash), by collection. */
  collections: Partial<Record<EntryCollection, Doc[]>>;
  /** List documents, for showing list items by their labels. */
  lists: { _id: string; items?: { id: string; label: string }[] }[];
}

export interface MarkdownFolder {
  /** The section name, used as the folder name. */
  folder: string;
  files: { name: string; content: string }[];
}

const SKIP = new Set(['_id', 'title', 'body', 'createdAt', 'modifiedAt', 'deletedAt', 'links']);

function isEmpty(v: unknown): boolean {
  return (
    v === undefined ||
    v === null ||
    v === '' ||
    (Array.isArray(v) && v.length === 0) ||
    (typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length === 0)
  );
}

function storyDate(v: unknown): string {
  if (!v || typeof v !== 'object') return String(v);
  const d = v as { year?: number; month?: number; day?: number; unknown?: boolean };
  if (d.unknown) return 'unknown';
  const pad = (n: number) => String(n).padStart(2, '0');
  if (d.year === undefined) return JSON.stringify(v);
  if (d.month === undefined) return String(d.year);
  return d.day === undefined
    ? `${d.year}-${pad(d.month)}`
    : `${d.year}-${pad(d.month)}-${pad(d.day)}`;
}

/** Build the Markdown export. Folders are sections in rail order; files are sorted by title. */
export function bibleMarkdown(input: MarkdownInput): MarkdownFolder[] {
  const titles = new Map<string, string>();
  const where = new Map<string, string>();
  for (const [c, docs] of Object.entries(input.collections) as [EntryCollection, Doc[]][]) {
    for (const d of docs) {
      titles.set(d._id, entryTitle(d));
      where.set(d._id, collectionInfo[c].singular);
    }
  }
  const listLabel = new Map<string, Map<string, string>>(
    input.lists.map((l) => [l._id, new Map((l.items ?? []).map((i) => [i.id, i.label]))]),
  );
  const refText = (id: unknown) =>
    typeof id === 'string' ? (titles.get(id) ?? `${id} (missing)`) : String(id);

  const value = (spec: FieldSpec | undefined, v: unknown): string => {
    switch (spec?.kind) {
      case 'storyDate':
        return storyDate(v);
      case 'ref':
        return refText(v);
      case 'refs':
      case 'refPair':
        return Array.isArray(v) ? v.map(refText).join(', ') : refText(v);
      case 'listItem':
        return listLabel.get(spec.listId ?? '')?.get(String(v)) ?? String(v);
      case 'enum':
        return spec.options?.find((o) => o.value === v)?.label ?? String(v);
      case 'longText':
        return String(v).includes('\n') ? `\n\n${String(v).trim()}\n` : String(v);
      case 'boolean':
        return v ? 'yes' : 'no';
      default:
        if (Array.isArray(v) && v.every((x) => typeof x !== 'object')) return v.join(', ');
        if (typeof v === 'object' && v !== null) return `\`${JSON.stringify(v)}\``;
        return String(v);
    }
  };

  const entryFile = (c: EntryCollection, d: Doc): { name: string; content: string } => {
    const manifest = manifests[c];
    const lines = [`# ${entryTitle(d)}`, ''];
    for (const spec of manifest) {
      if (SKIP.has(spec.name) || spec.kind === 'system') continue;
      const v = d[spec.name];
      if (isEmpty(v)) continue;
      lines.push(`- **${spec.label}**: ${value(spec, v)}`);
    }
    lines.push(`- **ID**: ${d._id}`);
    const body = htmlToMarkdown(typeof d.body === 'string' ? d.body : '');
    if (body) lines.push('', body);
    const links = Array.isArray(d.links) ? (d.links as { targetId: string; kind: string }[]) : [];
    if (links.length) {
      lines.push('', '## Links', '');
      for (const l of links) {
        lines.push(`- ${l.kind}: ${refText(l.targetId)} (${where.get(l.targetId) ?? 'entry'})`);
      }
    }
    return {
      name: `${safeName(entryTitle(d), 70)} (${safeName(d._id, 40)}).md`,
      content: `${lines.join('\n')}\n`,
    };
  };

  const folders: MarkdownFolder[] = [];
  for (const c of Object.keys(collectionInfo) as EntryCollection[]) {
    const docs = (input.collections[c] ?? []).filter((d) => !d.deletedAt);
    if (!docs.length) continue;
    folders.push({
      folder: safeName(collectionInfo[c].plural),
      files: sorted(docs).map((d) => entryFile(c, d)),
    });
  }
  return folders;
}

function sorted(docs: Doc[]): Doc[] {
  return [...docs].sort(
    (a, b) => entryTitle(a).localeCompare(entryTitle(b)) || a._id.localeCompare(b._id),
  );
}

/** The export folder's name: the bible and the moment, so exports never overwrite each other. */
export function exportFolderName(bibleName: string, at: Date): string {
  const stamp = at
    .toISOString()
    .replace(/\.\d+Z$/, 'Z')
    .replace(/:/g, '-')
    .replace('T', ' ');
  return safeName(`${bibleName} ${stamp}`, 120);
}
