import MiniSearch from 'minisearch';
import { ENTRY_COLLECTIONS } from '../../shared/schema';
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
  'sourceNote',
  'worldContext',
  'question',
  'decision',
  'stoppedAt',
  'content',
  'text',
  'quote',
  'sceneNote',
];

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, ' ');
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
    if (!ULID.test(value)) out.push(stripTags(value));
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
    const text = stripTags(v).replace(/\s+/g, ' ').trim();
    if (text) return text.length > max ? `${text.slice(0, max).trimEnd()}...` : text;
  }
  return '';
}

function toIndexed(collection: string, doc: StoredDoc): IndexedDoc {
  const body: string[] = [];
  for (const f of BODY_FIELDS) {
    const v = doc[f];
    if (typeof v === 'string') body.push(stripTags(v));
  }
  const names: string[] = [];
  collectStrings(doc.names, names);
  collectStrings(doc.tags, names);
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
