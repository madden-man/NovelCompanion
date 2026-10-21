import type { Document } from 'mongodb';
import { ENTRY_COLLECTIONS } from '../../../shared/schema';
import { htmlToMarkdown, looksLikeHtml } from '../../../shared/domain/markdown';
import type { BibleHandle } from '../bibles';
import type { Migration } from './types';

export const MIGRATION10_META_ID = 'migration10';

/**
 * Fields left as they are. `manuscriptText` is the read-only copy of a
 * chapter: its line numbers and the finding hashes come from its HTML
 * (CC-3, CC-4). The rest hold IDs or values the app sets, never prose.
 */
const KEEP = new Set([
  '_id',
  'manuscriptText',
  'sourceRef',
  'createdAt',
  'modifiedAt',
  'deletedAt',
]);
const NOT_TEXT_KEY = /^(_?id|kind|type|scope|state|status|.*Ids?)$/;

/** What migration 10 did, kept in `meta`. */
export interface Migration10Summary {
  _id: typeof MIGRATION10_META_ID;
  /** Documents with at least one field converted, per collection. */
  documents: Record<string, number>;
  /** Fields converted, by collection and path (list positions shown as `n`). */
  fields: Record<string, number>;
  takenAt: string;
}

/** The `$set` of every string under `value` that is still HTML, as Markdown. */
function htmlFields(value: unknown, path: string, out: Record<string, string>): void {
  if (typeof value === 'string') {
    if (path && looksLikeHtml(value)) out[path] = htmlToMarkdown(value);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => htmlFields(v, `${path}.${i}`, out));
  } else if (value && typeof value === 'object' && !(value instanceof Date)) {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (KEEP.has(k) || NOT_TEXT_KEY.test(k)) continue;
      htmlFields(v, path ? `${path}.${k}` : k, out);
    }
  }
}

/**
 * A44 (schema version 10): every long text the app stores becomes Markdown.
 * Bodies the importer wrote as HTML (paragraphs, headings, lists, scene
 * breaks, bold, italic) are converted in place; plain text is already
 * Markdown and is left alone. Trashed entries are converted too, so a
 * restore brings back Markdown. Revisions keep the text as it was. The
 * modified time is not touched, so dismissed findings stay dismissed.
 * `openBibleSession` takes a snapshot first. Running it again changes nothing.
 */
export const markdownText: Migration = {
  version: 10,
  name: 'long text as Markdown',
  async up(bible: BibleHandle) {
    const existing = new Set(await bible.collectionNames());
    const documents: Record<string, number> = {};
    const fields: Record<string, number> = {};
    for (const name of ENTRY_COLLECTIONS) {
      if (!existing.has(name)) continue;
      const collection = bible.collection<Document>(name);
      for (const d of await collection.find({}).toArray()) {
        const set: Record<string, string> = {};
        htmlFields(d, '', set);
        const paths = Object.keys(set);
        if (!paths.length) continue;
        await collection.updateOne({ _id: d._id }, { $set: set });
        documents[name] = (documents[name] ?? 0) + 1;
        for (const p of paths) {
          const key = `${name}.${p.replace(/\.\d+(?=\.|$)/g, '.n')}`;
          fields[key] = (fields[key] ?? 0) + 1;
        }
      }
    }
    const summary: Migration10Summary = {
      _id: MIGRATION10_META_ID,
      documents,
      fields,
      takenAt: new Date().toISOString(),
    };
    await bible
      .collection<Document>('meta')
      .updateOne({ _id: MIGRATION10_META_ID } as Document, { $setOnInsert: summary } as Document, {
        upsert: true,
      });
  },
};
