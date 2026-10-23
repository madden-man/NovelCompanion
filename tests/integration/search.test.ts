import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createBible } from '../../src/main/db';
import { openBibleSession } from '../../src/main/db/session';
import type { OpenBible } from '../../src/main/db/session';
import type { Store } from '../../src/main/db';
import { freshSlug, localStore } from '../helpers/db';

let store: Store;
let bible: OpenBible;

beforeAll(async () => {
  store = await localStore();
  bible = await openBibleSession(
    store,
    (await createBible(store, freshSlug('search'), 'search')).id,
  );
});
afterAll(async () => {
  await store.close();
});

const person = (title: string, full = title) => ({
  title,
  names: { full },
  birth: { year: 2031 },
});

describe('ARCH-2 search is patched on every write', () => {
  test('ARCH-2 a Chinese title "晓曦" is found by "晓曦" and by "曦" right after the write', async () => {
    const { repo, search } = bible;
    const rebuilds = search.documentCount;
    const c = await repo.create('characters', person('晓曦', 'Iris Hale-Zhou'));
    expect(search.documentCount).toBe(rebuilds + 1);
    expect(search.search('晓曦').map((h) => h.id)).toContain(c._id);
    expect(search.search('曦').map((h) => h.id)).toContain(c._id);
    expect(search.search('iris').map((h) => h.id)).toContain(c._id);
  });

  test('ARCH-2 an English title is found by a word right after the write, and updates and trash are reflected', async () => {
    const { repo, search } = bible;
    const c = await repo.create('characters', person('Tomas Reyes'));
    expect(search.search('reyes').map((h) => h.id)).toEqual([c._id]);
    await repo.update('characters', c._id, {
      title: 'Tomas Okafor',
      names: { full: 'Tomas Okafor' },
    });
    expect(search.search('reyes')).toEqual([]);
    expect(search.search('okafor').map((h) => h.id)).toEqual([c._id]);
    await repo.softDelete('characters', c._id);
    expect(search.search('okafor')).toEqual([]);
    await repo.restore('characters', c._id);
    expect(search.search('okafor').map((h) => h.id)).toEqual([c._id]);
  });

  test('ARCH-2 a rebuilt index from a fresh open finds the same entries', async () => {
    const reopened = await openBibleSession(store, bible.handle.id);
    expect(reopened.search.search('曦')).toHaveLength(1);
    expect(reopened.search.search('okafor')).toHaveLength(1);
  });
});
