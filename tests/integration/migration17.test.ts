import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { REGISTRY, createBible, schemaVersion } from '../../src/main/db';
import type { Store } from '../../src/main/db';
import { LATEST_SCHEMA_VERSION, migrations } from '../../src/main/db/migrations';
import { openBibleSession } from '../../src/main/db/session';
import { PHONE_WAITS_META_ID } from '../../src/shared/phoneWaits';
import { freshSlug, localStore } from '../helpers/db';

let store: Store;
beforeAll(async () => {
  store = await localStore();
});
afterAll(async () => {
  await store.close();
});

describe('PH-20 PH-28 migration 17 marks the phone waits shape', () => {
  test('PH-20 the schema version is 17, the phone waits migration last', () => {
    expect(LATEST_SCHEMA_VERSION).toBe(17);
    expect(migrations.at(-1)!.version).toBe(17);
  });

  test('PH-20 opening a version 16 bible writes nothing, and the first kept sentence makes the document', async () => {
    const slug = freshSlug('m17-old');
    const bible = await createBible(store, slug, 'Old');
    await store.db
      .collection(REGISTRY)
      .updateOne({ _id: slug as never }, { $set: { schemaVersion: 16 } });
    const metaBefore = await bible.collection('meta').find({}).sort({ _id: 1 }).toArray();
    const open = await openBibleSession(store, slug);
    expect(await schemaVersion(open.handle)).toBe(17);
    expect(await bible.collection('meta').find({}).sort({ _id: 1 }).toArray()).toEqual(metaBefore);
    expect(open.repo.phoneWaits()).toEqual([]);
    await open.repo.setPhoneWaits([
      { text: 'The tram to the coast was free on Sundays.', year: 2034 },
    ]);
    const doc = await bible.collection('meta').findOne({ _id: PHONE_WAITS_META_ID as never });
    expect(doc?.lines).toHaveLength(1);
  });
});
