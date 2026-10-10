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

const BODY_FIELDS = [
  'body',
  'summary',
  'manuscriptText',
  'backstory',
  'meaning',
  'usageNote',
  'generationNotes',
  'notes',
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

function toIndexed(collection: string, doc: StoredDoc): IndexedDoc {
  const body: string[] = [];
  for (const f of BODY_FIELDS) {
    const v = doc[f];
    if (typeof v === 'string') body.push(stripTags(v));
  }
  const names: string[] = [];
  collectStrings(doc.names, names);
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

  search(query: string): SearchHit[] {
    if (!query.trim()) return [];
    return this.mini.search(query).map((r) => ({
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
