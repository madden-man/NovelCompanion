import { createBible } from '../../src/main/db';
import type { BibleHandle, Store } from '../../src/main/db';
import { bigBibleDocs } from './bigBible';

/**
 * Register a new bible on a local MongoDB (migrated, with its default lists)
 * and insert the generated NF-1 volume. Seed data goes straight to the
 * collections, as the fixture loader does; the app reads it back through
 * its normal open path, which is what NF-1 measures.
 */
export async function loadBigBible(store: Store, slug: string, name = 'Five thousand entries') {
  const handle: BibleHandle = await createBible(store, slug, name);
  const docs = bigBibleDocs();
  for (const [collection, list] of Object.entries(docs)) {
    if (list.length) await handle.collection(collection).insertMany(list as never[]);
  }
  return { handle, docs };
}
