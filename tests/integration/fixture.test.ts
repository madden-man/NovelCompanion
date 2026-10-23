import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { openBibleSession } from '../../src/main/db/session';
import { ENTRY_COLLECTIONS } from '../../src/shared/schema';
import type { Store } from '../../src/main/db';
import { freshSlug, localStore } from '../helpers/db';
import { loadFixture, readFixture } from '../helpers/loadFixture';

let store: Store;
beforeAll(async () => {
  store = await localStore();
});
afterAll(async () => {
  await store.close();
});

describe('Section 7 fixture loader', () => {
  test('Section 7 the loader inserts every fixture collection into a fresh local database', async () => {
    const handle = await loadFixture(store, freshSlug('fixture'));
    const fixture = readFixture();
    for (const [collection, docs] of Object.entries(fixture)) {
      if (collection === 'lists') continue;
      expect(await handle.collection(collection).countDocuments(), collection).toBe(docs.length);
    }
    const communities = await handle.collection('lists').findOne({ _id: 'communities' as never });
    expect((communities?.items as { id: string }[]).map((i) => i.id)).toEqual([
      'portland',
      'guangzhou',
    ]);
    // Seeded lists the fixture does not override are still there.
    expect(await handle.collection('lists').findOne({ _id: 'unionTypes' as never })).not.toBeNull();

    const bible = await openBibleSession(store, handle.id);
    for (const c of ENTRY_COLLECTIONS) {
      expect(bible.repo.list(c).length, c).toBe(fixture[c]?.length ?? 0);
    }
    expect(bible.repo.get('characters', 'H5')?.names.chinese).toBe('晓曦');
    expect(bible.search.search('周美玲').map((h) => h.id)).toContain('Z1');
    expect(bible.search.search('Shanghai').map((h) => h.id)).toContain('CH7');
  });

  test('Section 7 the fixture can be edited through the write path', async () => {
    const handle = await loadFixture(store, freshSlug('fixture-edit'));
    const bible = await openBibleSession(store, handle.id);
    const z3 = await bible.repo.update('characters', 'Z3', { backstory: 'Edited.' });
    expect(z3.backstory).toBe('Edited.');
    expect(bible.model.get('characters', 'Z3')!.backstory).toBe('Edited.');
  });
});
