import MiniSearch from 'minisearch';
import { ENTRY_COLLECTIONS, NOTEBOOK_COLLECTION } from '../../shared/schema';
import type { NotebookPage } from '../../shared/schema';
import { firstLine, notebookText } from '../../shared/domain/notebook';
import { plainText } from '../../shared/domain/markdown';
import type { ReadModel, StoredDoc } from '../readmodel';
import { tokenizeForIndex, tokenizeForQuery } from './tokenize';

interface IndexedDoc {
  key: string;
  collection: string;
  id: string;
  title: string;
  body: string;
  names: string;
}

export interface SearchHit {
  collection: string;
  id: string;
  title: string;
  score: number;
}

export type HitFilter = (hit: { collection: string; id: string }) => boolean;

const BODY_FIELDS = [
  'body',
  'summary',
  'manuscriptText',
  'backstory',
  'meaning',
  'usageNote',
  'notes',
  'worldContext',
  'question',
  'decision',
  'text',
  'quote',
  'sceneNote',
];

/** A44: the words of a stored long text, without Markdown marks or older HTML tags. */
function bodyText(text: string): string {
  return plainText(text);
}

function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => collectStrings(v, out));
  else if (value && typeof value === 'object') {
    Object.values(value as Record<string, unknown>).forEach((v) => collectStrings(v, out));
  }
}

/** Keys that hold IDs or system values, never words a person typed. */
const NOT_TEXT_KEY = /^(_?id|kind|type|scope|state|.*Ids?)$/;
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** Text inside nested fields: place descriptions and strand labels. */
function collectText(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    if (!ULID.test(value)) out.push(bodyText(value));
  } else if (Array.isArray(value)) value.forEach((v) => collectText(v, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (!NOT_TEXT_KEY.test(k)) collectText(v, out);
    }
  }
}

const NESTED_TEXT_FIELDS = ['descriptions', 'strands'];

/** The first words of an entry's text, for a result row. */
export function entrySnippet(doc: StoredDoc, max = 140): string {
  for (const f of BODY_FIELDS) {
    const v = doc[f];
    if (typeof v !== 'string') continue;
    const text = bodyText(v).replace(/\s+/g, ' ').trim();
    if (text) return text.length > max ? `${text.slice(0, max).trimEnd()}...` : text;
  }
  return '';
}

/** A55 (SR-1): a notebook page's words, its first line as its title. */
function notebookIndexed(doc: StoredDoc): IndexedDoc {
  const page = doc as unknown as NotebookPage;
  return {
    key: `${NOTEBOOK_COLLECTION}:${doc._id}`,
    collection: NOTEBOOK_COLLECTION,
    id: doc._id,
    title: firstLine(page),
    body: notebookText(page),
    names: '',
  };
}

/** A55: the first words of a notebook page for a result row. */
export function notebookSnippet(doc: StoredDoc, max = 140): string {
  const page = doc as unknown as NotebookPage;
  const lines = page.kind === 'kept' ? [] : page.lines.map((l) => l.text);
  const text = (lines.find((t) => t.trim() && t.trim() !== firstLine(page)) ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max).trimEnd()}...` : text;
}

function toIndexed(collection: string, doc: StoredDoc): IndexedDoc {
  if (collection === NOTEBOOK_COLLECTION) return notebookIndexed(doc);
  const body: string[] = [];
  for (const f of BODY_FIELDS) {
    const v = doc[f];
    if (typeof v === 'string') body.push(bodyText(v));
  }
  const names: string[] = [];
  collectStrings(doc.names, names);
  for (const f of NESTED_TEXT_FIELDS) collectText(doc[f], body);
  for (const f of ['name', 'characters', 'romanization']) {
    const v = doc[f];
    if (typeof v === 'string') names.push(v);
  }
  return {
    key: `${collection}:${doc._id}`,
    collection,
    id: doc._id,
    title: typeof doc.title === 'string' ? doc.title : '',
    body: body.join('\n'),
    names: names.join('\n'),
  };
}

/**
 * The full-text index over every live entry. Built from the read model on
 * open, and patched by the repository on every write.
 */
export class SearchIndex {
  private mini = SearchIndex.create();

  private static create() {
    return new MiniSearch<IndexedDoc>({
      idField: 'key',
      fields: ['title', 'body', 'names'],
      storeFields: ['collection', 'id', 'title'],
      tokenize: tokenizeForIndex,
      processTerm: (term) => term,
      searchOptions: {
        tokenize: tokenizeForQuery,
        processTerm: (term) => term,
        boost: { title: 3, names: 2 },
        prefix: (term) => term.length > 2,
      },
    });
  }

  rebuild(model: ReadModel): void {
    this.mini = SearchIndex.create();
    for (const collection of ENTRY_COLLECTIONS) {
      const docs = model.all(collection).filter((d) => !d.deletedAt);
      this.mini.addAll(docs.map((d) => toIndexed(collection, d)));
    }
    // A55 (SR-1): the notebook pages from the phone are searched with the entries.
    const pages = model.all(NOTEBOOK_COLLECTION).filter((d) => !d.deletedAt);
    this.mini.addAll(pages.map((d) => toIndexed(NOTEBOOK_COLLECTION, d)));
  }

  /** Add or replace one entry. Entries in the trash are removed instead. */
  upsert(collection: string, doc: StoredDoc): void {
    this.remove(collection, doc._id);
    if (!doc.deletedAt) this.mini.add(toIndexed(collection, doc));
  }

  remove(collection: string, id: string): void {
    const key = `${collection}:${id}`;
    if (this.mini.has(key)) this.mini.discard(key);
  }

  /**
   * Entries that match every word, best first; when none match every word,
   * those that match any word. `accept` drops hits before they are ranked
   * into the result (SR-2 filters).
   */
  search(query: string, accept?: HitFilter): SearchHit[] {
    if (!query.trim()) return [];
    const filter = accept
      ? (r: { collection?: unknown; id?: unknown }) =>
          accept({ collection: String(r.collection), id: String(r.id) })
      : undefined;
    let results = this.mini.search(query, { combineWith: 'AND', filter });
    if (results.length === 0) results = this.mini.search(query, { combineWith: 'OR', filter });
    return results.map((r) => ({
      collection: String(r.collection),
      id: String(r.id),
      title: String(r.title),
      score: r.score,
    }));
  }

  get documentCount(): number {
    return this.mini.documentCount;
  }
}
