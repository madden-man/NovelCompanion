import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { entrySchemas, isEntryCollection } from '../../src/shared/schema';
import { fromCollections } from '../../src/shared/domain/timeline';
import type { TimelineData } from '../../src/shared/domain/timeline';
import { createBible } from '../../src/main/db';
import type { Store } from '../../src/main/db';
import { readFixture } from './loadFixture';

type Doc = { _id: string } & Record<string, unknown>;

interface Supplement {
  patches: Record<string, Record<string, Record<string, unknown>>>;
  entries: Record<string, Doc[]>;
}

const STAMP = '2026-01-15T09:00:00.000Z';

export function readSupplement(): Supplement {
  return JSON.parse(
    readFileSync(join(import.meta.dirname, '../../fixtures/brief/supplement.json'), 'utf8'),
  ) as Supplement;
}

/** Parse a fixture document as the write path stores it, so defaults are filled. */
function stored(collection: string, d: Doc): Doc {
  if (!isEntryCollection(collection)) return d;
  return entrySchemas[collection].parse({
    createdAt: STAMP,
    modifiedAt: STAMP,
    ...d,
  }) as unknown as Doc;
}

/**
 * The fixture novel as plain collections, optionally with the M7 brief
 * supplement applied (fixtures/brief/supplement.json).
 */
export function briefCollections(withSupplement: boolean): Record<string, Doc[]> {
  const raw = readFixture();
  const out: Record<string, Doc[]> = {};
  for (const [c, docs] of Object.entries(raw)) out[c] = docs.map((d) => stored(c, { ...d }));
  if (!withSupplement) return out;
  const sup = readSupplement();
  for (const [c, byId] of Object.entries(sup.patches)) {
    out[c] = (out[c] ?? []).map((d) => (byId[d._id] ? stored(c, { ...d, ...byId[d._id] }) : d));
  }
  for (const [c, docs] of Object.entries(sup.entries)) {
    out[c] = [...(out[c] ?? []), ...docs.map((d) => stored(c, d))];
  }
  return out;
}

export function briefData(withSupplement: boolean): TimelineData {
  return fromCollections(briefCollections(withSupplement));
}

/** The fixture novel plus the M7 brief supplement, in a fresh bible on the local server. */
export async function loadBriefFixture(store: Store, slug: string): Promise<{ id: string }> {
  const handle = await createBible(store, slug, 'Brief fixture');
  for (const [collection, docs] of Object.entries(briefCollections(true))) {
    if (!docs.length) continue;
    if (collection === 'lists') {
      for (const doc of docs) {
        await handle.collection<Doc>('lists').replaceOne({ _id: doc._id }, doc, { upsert: true });
      }
    } else {
      await handle.collection<Doc>(collection).insertMany(docs);
    }
  }
  return { id: handle.id };
}
