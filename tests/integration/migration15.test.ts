import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { REGISTRY, createBible, migrate, schemaVersion } from '../../src/main/db';
import type { Store } from '../../src/main/db';
import { LATEST_SCHEMA_VERSION, migrations } from '../../src/main/db/migrations';
import { NOTEBOOK_INDEXES, NOTEBOOK_PAGES } from '../../src/main/db/migrations/015-notebook-pages';
import { openBibleSession } from '../../src/main/db/session';
import { freshSlug, localStore } from '../helpers/db';

let store: Store;
beforeAll(async () => {
  store = await localStore();
});
afterAll(async () => {
  await store.close();
});

const indexNames = async (slug: string) =>
  (await store.db.collection(`${slug}.${NOTEBOOK_PAGES}`).indexes()).map((i) => i.name).sort();

describe('NB-4 migration 15 makes the notebook pages collection', () => {
  test('NB-4 the notebook pages migration is version 15', () => {
    expect(LATEST_SCHEMA_VERSION).toBe(16);
    expect(migrations[14]!.version).toBe(15);
  });

  test('NB-4 a new bible has notebookPages with its indexes', async () => {
    const slug = freshSlug('m15-new');
    const bible = await createBible(store, slug, 'New');
    expect(await bible.collectionNames()).toContain(NOTEBOOK_PAGES);
    expect(await indexNames(slug)).toEqual(['_id_', ...NOTEBOOK_INDEXES.map((i) => i.name)].sort());
  });

  test('NB-4 opening a version 14 bible adds the collection and indexes, writes nothing else, and running it again changes nothing', async () => {
    const slug = freshSlug('m15-old');
    const bible = await createBible(store, slug, 'Old');
    await store.db.dropCollection(`${slug}.${NOTEBOOK_PAGES}`);
    await store.db
      .collection(REGISTRY)
      .updateOne({ _id: slug as never }, { $set: { schemaVersion: 14 } });
    const before = await bible.collectionNames();
    expect(before).not.toContain(NOTEBOOK_PAGES);

    const open = await openBibleSession(store, slug);
    expect(await schemaVersion(open.handle)).toBe(16);
    expect(await open.handle.collectionNames()).toEqual([...before, NOTEBOOK_PAGES].sort());
    expect(await open.handle.collection(NOTEBOOK_PAGES).countDocuments()).toBe(0);
    expect(await indexNames(slug)).toEqual(['_id_', ...NOTEBOOK_INDEXES.map((i) => i.name)].sort());
    expect(open.repo.notebookPages()).toEqual([]);

    await migrations[14]!.up(open.handle);
    await migrate(open.handle);
    expect(await indexNames(slug)).toEqual(['_id_', ...NOTEBOOK_INDEXES.map((i) => i.name)].sort());
  });
});
