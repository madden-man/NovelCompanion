import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createBible } from '../../src/main/db';
import type { BibleHandle, Store } from '../../src/main/db';
import { configSchemas, entrySchemas, isEntryCollection } from '../../src/shared/schema';

export const FIXTURE_DIR = join(import.meta.dirname, '../../fixtures/novel');

type Doc = { _id: string } & Record<string, unknown>;

/** Read every fixture collection: file name without `.json` is the collection. */
export function readFixture(): Record<string, Doc[]> {
  const out: Record<string, Doc[]> = {};
  for (const file of readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()) {
    out[file.replace(/\.json$/, '')] = JSON.parse(
      readFileSync(join(FIXTURE_DIR, file), 'utf8'),
    ) as Doc[];
  }
  return out;
}

function schemaFor(collection: string) {
  if (isEntryCollection(collection)) return entrySchemas[collection];
  if (Object.hasOwn(configSchemas, collection)) {
    return configSchemas[collection as keyof typeof configSchemas];
  }
  throw new Error(`The fixture has a collection with no schema: ${collection}`);
}

/**
 * Create a fresh bible on the local server and insert every fixture
 * collection, stored as its zod schema accepts it. The fixture's lists
 * replace the seeded defaults.
 */
export async function loadFixture(store: Store, slug: string): Promise<BibleHandle> {
  const handle = await createBible(store, slug, 'Fixture novel');
  for (const [collection, raw] of Object.entries(readFixture())) {
    const schema = schemaFor(collection);
    const docs = raw.map((d) => schema.parse(d) as Doc);
    if (docs.length === 0) continue;
    if (collection === 'lists') {
      for (const doc of docs) {
        await handle.collection<Doc>('lists').replaceOne({ _id: doc._id }, doc, { upsert: true });
      }
    } else {
      await handle.collection<Doc>(collection).insertMany(docs);
    }
  }
  return handle;
}
