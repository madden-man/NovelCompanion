import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  BibleError,
  DATABASE_NAME,
  REGISTRY,
  createBible,
  dropBible,
  listBibles,
  migrate,
  openBible,
  schemaVersion,
} from '../../src/main/db';
import type { Store } from '../../src/main/db';
import { LATEST_SCHEMA_VERSION } from '../../src/main/db/migrations';
import type { Migration } from '../../src/main/db/migrations';
import { openBibleSession } from '../../src/main/db/session';
import { CONFIG_LIST_IDS, ENTRY_COLLECTIONS, LIST_IDS, ListDoc } from '../../src/shared/schema';
import { freshSlug, localStore } from '../helpers/db';

let store: Store;
beforeAll(async () => {
  store = await localStore();
});
afterAll(async () => {
  await store.close();
});

const allCollections = async () =>
  (await store.db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name);

describe('ARCH-8 multiple bibles in the one novel_companion database', () => {
  test('ARCH-8 connect selects the novel_companion database', () => {
    expect(store.db.databaseName).toBe('novel_companion');
    expect(DATABASE_NAME).toBe('novel_companion');
  });

  test('ARCH-8 createBible registers the bible, creates prefixed collections, and seeds the default lists', async () => {
    const slug = freshSlug('create');
    const bible = await createBible(store, slug, 'Created bible');
    const record = await store.db.collection(REGISTRY).findOne({ _id: slug as never });
    expect(record).toEqual({
      _id: slug,
      name: 'Created bible',
      createdAt: expect.any(String),
      schemaVersion: LATEST_SCHEMA_VERSION,
    });
    const names = await allCollections();
    for (const c of [...ENTRY_COLLECTIONS, 'lists', 'revisions', 'customSections']) {
      expect(names).toContain(`${slug}.${c}`);
    }
    const indexes = await bible.collection('revisions').indexes();
    expect(indexes.map((i) => i.key)).toContainEqual({ entryId: 1, at: 1 });

    const lists = await bible.collection<ListDoc>('lists').find({}).toArray();
    expect(lists.map((l) => l._id).sort()).toEqual([...LIST_IDS, ...CONFIG_LIST_IDS].sort());
    for (const l of lists) expect(ListDoc.safeParse(l).success).toBe(true);
    const items = (id: string) => lists.find((l) => l._id === id)!.items.map((i) => i.id);
    expect(items('unionTypes')).toEqual(['married', 'partnered', 'other']);
    expect(items('parentLinkTypes')).toEqual(['biological', 'adoptive', 'step', 'guardian']);
    expect(items('statuses')).toEqual(['canon', 'planned', 'idea']);
    expect(items('provenance')).toEqual(['researched', 'invented']);
    expect(items('eventCategories').length).toBeGreaterThan(0);
    // A16: no book-specific communities in code.
    expect(items('communities')).toEqual([]);
  });

  test('ARCH-8 listBibles shows only registered bibles', async () => {
    const slug = freshSlug('listed');
    await createBible(store, slug, 'Listed bible');
    // A prefixed collection with no registry row is not a bible.
    const stray = freshSlug('stray');
    await store.db.collection(`${stray}.characters`).insertOne({ _id: 'x' as never });
    const listed = await listBibles(store);
    expect(listed.map((b) => b._id)).toContain(slug);
    expect(listed.find((b) => b._id === slug)?.name).toBe('Listed bible');
    expect(listed.map((b) => b._id)).not.toContain(stray);
    await expect(openBible(store, stray)).rejects.toThrow(BibleError);
  });

  test('ARCH-8 creating a bible that exists, or with an unsafe ID or no name, fails plainly', async () => {
    const slug = freshSlug('dupe');
    await createBible(store, slug, 'First');
    await expect(createBible(store, slug, 'Second')).rejects.toThrow(/already exists/);
    for (const bad of [
      'Has-Caps',
      'has space',
      'dot.name',
      '',
      'x'.repeat(41),
      'bibles',
      '-lead',
    ]) {
      await expect(createBible(store, bad, 'Name')).rejects.toThrow(BibleError);
    }
    await expect(createBible(store, freshSlug('noname'), '  ')).rejects.toThrow(/needs a name/);
  });

  test('ARCH-8 two bibles in the same database do not see each other data', async () => {
    const aSlug = freshSlug('a');
    const bSlug = freshSlug('b');
    await createBible(store, aSlug, 'A');
    await createBible(store, bSlug, 'B');
    const a = await openBibleSession(store, aSlug);
    const b = await openBibleSession(store, bSlug);
    const created = await a.repo.create('characters', {
      title: 'Only in A',
      status: 'canon',
      names: { full: 'Only in A' },
      birth: { year: 2000 },
    });
    expect(a.repo.get('characters', created._id)?.title).toBe('Only in A');
    expect(await a.handle.collection('characters').countDocuments()).toBe(1);
    expect(b.repo.get('characters', created._id)).toBeUndefined();
    expect(b.repo.list('characters')).toEqual([]);
    expect(await b.handle.collection('characters').countDocuments()).toBe(0);
    expect(await b.handle.collection('revisions').countDocuments()).toBe(0);
    expect(b.search.search('Only')).toEqual([]);
    const reopened = await openBibleSession(store, bSlug);
    expect(reopened.repo.list('characters')).toEqual([]);
  });

  test('ARCH-8 dropping a bible drops only its prefixed collections and registry row', async () => {
    // "east" is a prefix of "eastwinds" on purpose: dropping one must not touch the other.
    const tail = freshSlug('x').slice(2, 20);
    const short = `east${tail}`;
    const long = `east${tail}winds`;
    await createBible(store, short, 'Short');
    const keep = await createBible(store, long, 'Long');
    await keep.collection('characters').insertOne({ _id: 'kept' as never });
    await dropBible(store, short);
    const names = await allCollections();
    expect(names.filter((n) => n.startsWith(`${short}.`))).toEqual([]);
    expect(names).toContain(`${long}.characters`);
    expect(await keep.collection('characters').countDocuments()).toBe(1);
    const ids = (await listBibles(store)).map((b) => b._id);
    expect(ids).not.toContain(short);
    expect(ids).toContain(long);
    expect(names).toContain(REGISTRY);
  });
});

describe('ARCH-2 versioned migrations per bible', () => {
  test('ARCH-2 migrate runs pending migrations in order and records the version on the registry', async () => {
    const slug = freshSlug('migrate');
    await store.db.collection(REGISTRY).insertOne({
      _id: slug as never,
      name: 'M',
      createdAt: new Date().toISOString(),
      schemaVersion: 0,
    });
    const bible = await openBible(store, slug);
    const ran: number[] = [];
    const steps: Migration[] = [1, 2, 3].map((version) => ({
      version,
      name: `step ${version}`,
      up: async (b) => {
        ran.push(version);
        await b.collection('steps').insertOne({ version });
      },
    }));
    expect(await schemaVersion(bible)).toBe(0);
    expect(await migrate(bible, steps.slice(0, 2))).toEqual({ from: 0, to: 2 });
    expect(ran).toEqual([1, 2]);
    expect(await schemaVersion(bible)).toBe(2);
    expect(await migrate(bible, steps)).toEqual({ from: 2, to: 3 });
    expect(await migrate(bible, steps)).toEqual({ from: 3, to: 3 });
    expect(ran).toEqual([1, 2, 3]);
    expect(await store.db.collection(`${slug}.steps`).countDocuments()).toBe(3);
  });

  test('ARCH-2 migrate refuses a bible from a newer app and migrations out of order', async () => {
    const slug = freshSlug('newer');
    const bible = await createBible(store, slug, 'Newer');
    await store.db
      .collection(REGISTRY)
      .updateOne({ _id: slug as never }, { $set: { schemaVersion: 99 } });
    await expect(migrate(bible)).rejects.toThrow(/newer than this app/);
    const bad: Migration[] = [{ version: 2, name: 'two', up: async () => undefined }];
    await expect(migrate(bible, bad)).rejects.toThrow(/out of order/);
  });

  test('ARCH-2 the real migrations bring a new bible to the latest version and are idempotent', async () => {
    const bible = await createBible(store, freshSlug('latest'), 'Latest');
    expect(await schemaVersion(bible)).toBe(LATEST_SCHEMA_VERSION);
    expect(await migrate(bible)).toEqual({
      from: LATEST_SCHEMA_VERSION,
      to: LATEST_SCHEMA_VERSION,
    });
  });
});

describe('PL-3 TH-1 migrations carry old data forward', () => {
  test('PL-3 a beat with one order number becomes one position in each of its arcs', async () => {
    const bible = await createBible(store, freshSlug('beat-orders'), 'Beats');
    const at = '2026-01-15T09:00:00.000Z';
    await bible.collection('plotBeats').insertMany([
      {
        _id: 'b1',
        title: 'one',
        status: 'planned',
        arcIds: ['A', 'B'],
        order: 4,
        createdAt: at,
        modifiedAt: at,
      },
      {
        _id: 'b2',
        title: 'two',
        status: 'planned',
        arcIds: [],
        order: 2,
        createdAt: at,
        modifiedAt: at,
      },
    ] as never);
    await store.db
      .collection(REGISTRY)
      .updateOne({ _id: bible.id as never }, { $set: { schemaVersion: 3 } });
    expect(await migrate(bible)).toEqual({ from: 3, to: LATEST_SCHEMA_VERSION });
    const b1 = await bible.collection('plotBeats').findOne({ _id: 'b1' as never });
    expect(b1).toMatchObject({
      arcOrders: [
        { arcId: 'A', order: 4 },
        { arcId: 'B', order: 4 },
      ],
    });
    expect(b1).not.toHaveProperty('order');
    expect(await bible.collection('plotBeats').findOne({ _id: 'b2' as never })).toMatchObject({
      arcOrders: [],
    });
  });

  test('TH-1 a chapter theme list becomes theme appearances with empty notes, keeping notes that exist', async () => {
    const bible = await createBible(store, freshSlug('theme-apps'), 'Themes');
    const at = '2026-01-15T09:00:00.000Z';
    const base = { status: 'planned', createdAt: at, modifiedAt: at };
    await bible.collection('themes').insertMany([
      { _id: 'T1', title: 'Water', appearances: [], ...base },
      { _id: 'T2', title: 'Fire', appearances: [{ chapterId: 'C1', note: 'kept' }], ...base },
    ] as never);
    await bible.collection('chapters').insertMany([
      { _id: 'C1', title: 'One', themeIds: ['T1', 'T2', 'gone'], ...base },
      { _id: 'C2', title: 'Two', ...base },
    ] as never);
    await store.db
      .collection(REGISTRY)
      .updateOne({ _id: bible.id as never }, { $set: { schemaVersion: 4 } });
    await migrate(bible);
    expect(await bible.collection('themes').findOne({ _id: 'T1' as never })).toMatchObject({
      appearances: [{ chapterId: 'C1', note: '' }],
    });
    expect(await bible.collection('themes').findOne({ _id: 'T2' as never })).toMatchObject({
      appearances: [{ chapterId: 'C1', note: 'kept' }],
    });
    expect(await bible.collection('chapters').findOne({ _id: 'C1' as never })).not.toHaveProperty(
      'themeIds',
    );
  });
});
