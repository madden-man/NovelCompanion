import type { Document } from 'mongodb';
import type { BibleHandle } from '../bibles';
import type { Migration } from './types';

export const MIGRATION14_META_ID = 'migration14';

/** What migration 14 did, kept in `meta`. */
export interface Migration14Summary {
  _id: typeof MIGRATION14_META_ID;
  /** The parts whose number changed. */
  partsRenumbered: number;
  /** Every part in its new order: id, title and number. */
  order: { id: string; title: string; number: number }[];
  takenAt: string;
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown) => (typeof v === 'string' ? v : '');

/**
 * The order the parts are read in, as a sort key per part: the reading order
 * of the first chapter in the part (live or trashed). A part with no chapter
 * yet keeps its place after the part made just before it (creation order),
 * half a step on, so an empty part made between two full ones stays between them.
 */
export function partOrderKeys(
  parts: readonly Document[],
  chapters: readonly Document[],
): Map<string, number> {
  const first = new Map<string, number>();
  for (const c of chapters) {
    const partId = str(c.partId);
    const order = num(c.readingOrder);
    if (!partId || order === null) continue;
    const have = first.get(partId);
    if (have === undefined || order < have) first.set(partId, order);
  }
  const byCreation = [...parts].sort(
    (a, b) =>
      str(a.createdAt).localeCompare(str(b.createdAt)) || str(a._id).localeCompare(str(b._id)),
  );
  const keys = new Map<string, number>();
  let last = 0;
  for (const p of byCreation) {
    const own = first.get(str(p._id));
    const key = own ?? last + 0.5;
    keys.set(str(p._id), key);
    last = key;
  }
  return keys;
}

/**
 * A54 (schema version 14): parts are numbered 1 to n in reading order.
 * Migration 13 took the books away but left each part the number it had
 * within its book, so a bible with two books had two parts numbered 1, two
 * numbered 2, and so on, and the outline sorted the second book's parts among
 * the first's. This numbers every part from 1 in the order its chapters are
 * read (`partOrderKeys`), live parts first and trashed parts after them.
 * Modified times are not touched. Running it again changes nothing.
 */
export const partOrder: Migration = {
  version: 14,
  name: 'part order: parts numbered from 1 in reading order',
  async up(bible: BibleHandle) {
    const existing = new Set(await bible.collectionNames());
    const order: Migration14Summary['order'] = [];
    let partsRenumbered = 0;
    if (existing.has('parts')) {
      const partsCol = bible.collection<Document>('parts');
      const parts = await partsCol.find({}).toArray();
      const chapters = existing.has('chapters')
        ? await bible
            .collection<Document>('chapters')
            .find({}, { projection: { partId: 1, readingOrder: 1 } })
            .toArray()
        : [];
      const keys = partOrderKeys(parts, chapters);
      const sorted = [...parts].sort(
        (a, b) =>
          Number(Boolean(a.deletedAt)) - Number(Boolean(b.deletedAt)) ||
          (keys.get(str(a._id)) ?? 0) - (keys.get(str(b._id)) ?? 0) ||
          (num(a.number) ?? 0) - (num(b.number) ?? 0) ||
          str(a._id).localeCompare(str(b._id)),
      );
      for (const [i, p] of sorted.entries()) {
        const number = i + 1;
        order.push({ id: str(p._id), title: str(p.title), number });
        if (num(p.number) === number) continue;
        await partsCol.updateOne({ _id: p._id }, { $set: { number } });
        partsRenumbered++;
      }
    }
    const summary: Migration14Summary = {
      _id: MIGRATION14_META_ID,
      partsRenumbered,
      order,
      takenAt: new Date().toISOString(),
    };
    await bible
      .collection<Document>('meta')
      .updateOne({ _id: MIGRATION14_META_ID } as Document, { $setOnInsert: summary } as Document, {
        upsert: true,
      });
  },
};
