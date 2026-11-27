import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createBible } from '../src/main/db';
import type { Store } from '../src/main/db';
import { configSchemas, entrySchemas, isEntryCollection } from '../src/shared/schema';

/** A58 P4: what `scripts/web-local.ts` needs, bundled in one go by `importSource`. */
export { startTestMongo } from '../tests/helpers/testMongo';
export { connect } from '../src/main/db';

type Doc = { _id: string } & Record<string, unknown>;

/**
 * The fixture novel into a new bible, as `tests/helpers/loadFixture.ts` does,
 * from the folder given (a bundled copy cannot find it from its own place).
 */
export async function seedFixture(store: Store, slug: string, root: string): Promise<void> {
  const dir = join(root, 'fixtures/novel');
  const handle = await createBible(store, slug, 'Fixture novel');
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const collection = file.replace(/\.json$/, '');
    const schema = isEntryCollection(collection)
      ? entrySchemas[collection]
      : configSchemas[collection as keyof typeof configSchemas];
    const docs = (JSON.parse(readFileSync(join(dir, file), 'utf8')) as Doc[]).map(
      (d) => schema.parse(d) as Doc,
    );
    if (docs.length === 0) continue;
    if (collection === 'lists') {
      for (const doc of docs) {
        await handle.collection<Doc>('lists').replaceOne({ _id: doc._id }, doc, { upsert: true });
      }
    } else await handle.collection<Doc>(collection).insertMany(docs);
  }
}
