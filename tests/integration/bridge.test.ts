import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { Document } from 'mongodb';
import type { Store } from '../../src/main/db';
import { openBibleSession } from '../../src/main/db/session';
import type { OpenBible } from '../../src/main/db/session';
import { BridgeStore } from '../../src/main/db/bridge';
import { BridgeService } from '../../src/main/bridge/service';
import { BRIDGE_DOWN, BRIDGE_UP, BRIDGE_WORLDS, worldIdFor } from '../../src/shared/bridge';
import type { NovelPocket, UpRow } from '../../src/shared/bridge';
import { ENTRY_COLLECTIONS, NOTEBOOK_COLLECTION } from '../../src/shared/schema';
import type { NotebookPage } from '../../src/shared/schema';
import { IpcValidationError, parseRequest } from '../../src/shared/ipc';
import { SECTION_IDS } from '../../src/main/claude/proposals';
import { isWriteChannel } from '../../src/shared/ipcApp';
import type { Invoke } from '../helpers/t5';
import { freshSlug, localStore } from '../helpers/db';
import { ipcFor } from '../helpers/ipc';
import { loadFixture } from '../helpers/loadFixture';

let store: Store;

beforeAll(async () => {
  store = await localStore();
});
afterAll(async () => {
  await store.close();
});

/** A fixture bible open as the app opens it, with its bridge (not yet started). */
async function openWithBridge(prefix: string, opts: { pullEveryMs?: number } = {}) {
  const slug = freshSlug(prefix);
  await loadFixture(store, slug);
  const session = await openBibleSession(store, slug);
  const world = worldIdFor(slug)!;
  const changes: { collection: string; id: string; op: string }[] = [];
  session.repo.onChange((e) => changes.push(e));
  const service = new BridgeService({
    store: new BridgeStore(store.db),
    session,
    world,
    name: 'Fixture novel',
    publishAfterMs: 20,
    pullEveryMs: opts.pullEveryMs ?? 60 * 60 * 1000,
  });
  return { slug, session, world, service, changes, invoke: ipcFor(() => session) };
}

const NOV25 = Date.parse('2026-11-25T21:00:00.000Z');

/** Writes rows as FlowState's function stores them (netlify/lib/bridge.ts: newest rev wins). */
async function send(
  world: string,
  table: UpRow['table'],
  id: string,
  rev: number,
  row: Record<string, unknown> | null,
): Promise<void> {
  const _id = `${world}:${table}:${id}`;
  const doc = { world, table, id, rev, deleted: row === null, row, at: rev };
  await store.db.collection(BRIDGE_UP).replaceOne({ _id } as Document, doc, { upsert: true });
}

const keptRow = (id: string, text: string, extra: Record<string, unknown> = {}) => ({
  id,
  at: NOV25 + 1,
  updatedAt: NOV25 + 1,
  text,
  wise: false,
  kept: true,
  kind: 'kept',
  date: NOV25,
  year: 2045,
  chips: { characterIds: [], placeIds: [] },
  ...extra,
});

const until = async (fn: () => Promise<boolean> | boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('Timed out waiting');
};

const page = (s: OpenBible, id: string) => s.repo.notebookPage(id);

describe('NB-1 NB-2 the registry row and the pocket', () => {
  let ctx: Awaited<ReturnType<typeof openWithBridge>>;
  beforeAll(async () => {
    ctx = await openWithBridge('nb-pub');
    await ctx.service.start();
  });
  afterAll(() => ctx.service.stop());

  test('NB-1 opening writes the registry row in novel_companion outside the bible prefix, exactly { _id, name, kind }', async () => {
    expect(store.db.databaseName).toBe('novel_companion');
    const row = await store.db.collection(BRIDGE_WORLDS).findOne({ _id: ctx.world as never });
    expect(row).toEqual({ _id: ctx.world, name: 'Fixture novel', kind: 'novel' });
    const names = (await store.db.listCollections({}, { nameOnly: true }).toArray()).map(
      (c) => c.name,
    );
    expect(names).toEqual(expect.arrayContaining([BRIDGE_WORLDS, BRIDGE_DOWN]));
    expect(names.filter((n) => n.startsWith(`${ctx.slug}.bridge`))).toEqual([]);
    expect(await ctx.session.handle.collectionNames()).not.toContain(BRIDGE_WORLDS);
  });

  test("NB-2 opening writes the pocket { _id, stamp, pocket } with the bible's characters, places, chapters, events, span and questions", async () => {
    const row = await store.db.collection(BRIDGE_DOWN).findOne({ _id: ctx.world as never });
    expect(Object.keys(row!).sort()).toEqual(['_id', 'pocket', 'stamp']);
    const pocket = row!.pocket as NovelPocket;
    expect(pocket.kind).toBe('novel');
    expect(pocket.characters).toHaveLength(13);
    expect(pocket.characters.find((c) => c.id === 'Z1')).toEqual({
      id: 'Z1',
      fullName: 'Zhou Meiling',
      firstName: 'Meiling',
      chineseName: '周美玲',
      familyColour: '#1baf7a',
      born: 1962,
      died: 2050,
    });
    expect(pocket.places).toHaveLength(4);
    expect(pocket.chapters.map((c) => c.id)).toEqual([
      'CH1',
      'CH2',
      'CH3',
      'CH4',
      'CH5',
      'CH6',
      'CH7',
      'CH8',
    ]);
    expect(pocket.events).toHaveLength(11);
    expect(pocket.span).toEqual({ from: 2025, to: 2100 });
    expect(pocket.questions).toEqual([]);
  });

  test('NB-2 the stamp moves only when the pocket content moves: no change keeps it and writes nothing', async () => {
    const coll = store.db.collection(BRIDGE_DOWN);
    const stamp0 = (await coll.findOne({ _id: ctx.world as never }))!.stamp;
    expect(await ctx.service.publish()).toBe(false);
    // A moment is not in the pocket: its change publishes nothing new.
    await ctx.session.repo.update('moments', ctx.session.repo.list('moments')[0]!._id, {
      title: 'A new title',
    });
    await new Promise((r) => setTimeout(r, 120));
    expect((await coll.findOne({ _id: ctx.world as never }))!.stamp).toBe(stamp0);

    // A character renamed moves it, on its own, once the write settles.
    await ctx.session.repo.update('characters', 'H2', {
      names: { full: 'Pete Hale' },
      title: 'Pete Hale',
    });
    await until(async () => (await coll.findOne({ _id: ctx.world as never }))!.stamp !== stamp0);
    const row = await coll.findOne({ _id: ctx.world as never });
    expect((row!.pocket as NovelPocket).characters.find((c) => c.id === 'H2')!.fullName).toBe(
      'Pete Hale',
    );
  });

  test('NB-2 an open question is in the pocket; a decided one only when it changed after the bible was first given to the phone', async () => {
    const since = ctx.session.repo.bridgeSince();
    expect(since).not.toBeNull();
    const q = await ctx.session.repo.create('openQuestions', {
      title: 'Letter',
      question: 'Who wrote the letter?',
      state: 'open',
    } as never);
    await until(async () => {
      const row = await store.db.collection(BRIDGE_DOWN).findOne({ _id: ctx.world as never });
      return (row!.pocket as NovelPocket).questions.some((x) => x.id === q._id);
    });
    await ctx.session.repo.update('openQuestions', q._id, {
      state: 'decided',
      decision: 'Ruth',
    } as never);
    await until(async () => {
      const row = await store.db.collection(BRIDGE_DOWN).findOne({ _id: ctx.world as never });
      const got = (row!.pocket as NovelPocket).questions.find((x) => x.id === q._id);
      return got?.state === 'decided' && got.decision === 'Ruth';
    });
    // Marking the first time twice keeps the first.
    expect(await ctx.session.repo.markBridgeSince(Date.now() + 1e6)).toBe(since);
  });
});

describe('NB-3 to NB-6 the pull', () => {
  let ctx: Awaited<ReturnType<typeof openWithBridge>>;
  beforeAll(async () => {
    ctx = await openWithBridge('nb-pull');
    // Something the phone sent before the bible opened.
    await send(
      ctx.world,
      'messages',
      'K1',
      10,
      keptRow('K1', 'Iris meets Zhou Lan in Guangzhou in 2047.'),
    );
    await ctx.service.start();
  });
  afterAll(() => ctx.service.stop());

  test('NB-3 opening pulls what the phone already sent', () => {
    expect(page(ctx.session, 'K1')).toMatchObject({ kind: 'kept', world: ctx.world });
  });

  test('NB-4 a page is written through the repository: validated, in the read model, the search index and a change event; not an entry', async () => {
    const stored = await ctx.session.handle
      .collection<NotebookPage>(NOTEBOOK_COLLECTION)
      .findOne({ _id: 'K1' });
    expect(stored).toMatchObject({
      _id: 'K1',
      kind: 'kept',
      year: 2045,
      lines: [
        {
          id: 'K1',
          text: 'Iris meets Zhou Lan in Guangzhou in 2047.',
          kept: true,
          speakerId: null,
        },
      ],
    });
    expect(
      ctx.session.search
        .search('Guangzhou')
        .some((h) => h.collection === NOTEBOOK_COLLECTION && h.id === 'K1'),
    ).toBe(true);
    expect(ctx.changes).toContainEqual(
      expect.objectContaining({ collection: NOTEBOOK_COLLECTION, id: 'K1', op: 'create' }),
    );
    // Read-only on the desktop: not an entry, so no entry channel, proposal or undo step reaches it.
    expect(ENTRY_COLLECTIONS).not.toContain(NOTEBOOK_COLLECTION as never);
    expect(SECTION_IDS).not.toContain(NOTEBOOK_COLLECTION as never);
    expect(() =>
      parseRequest('entry.update', {
        collection: NOTEBOOK_COLLECTION,
        id: 'K1',
        patch: { title: 'x' },
      }),
    ).toThrow(IpcValidationError);
    expect(isWriteChannel('notebook.list')).toBe(false);
    expect(isWriteChannel('notebook.get')).toBe(false);
    // A page that fails the schema is skipped and named; the others in the same pull land.
    const skipped: string[] = [];
    const n = await ctx.session.repo.applyNotebook(
      [
        {
          op: 'put',
          page: { ...(page(ctx.session, 'K1') as NotebookPage), kind: 'diary' as never },
        },
        {
          op: 'put',
          page: {
            ...(page(ctx.session, 'K1') as NotebookPage),
            _id: 'K-other',
            sig: 'x',
            world: 'elsewhere',
          },
        },
      ],
      (id) => skipped.push(id),
    );
    expect(skipped).toEqual(['K1']);
    expect(n).toBe(1);
    expect(page(ctx.session, 'K1')!.kind).toBe('kept');
    expect(page(ctx.session, 'K-other')).toBeDefined();
  });

  test('NB-5 the line is linked to the characters, places, chapters and years it names, through the router against the bible', () => {
    expect(page(ctx.session, 'K1')).toMatchObject({
      characterIds: ['H5', 'Z3'],
      placeIds: ['PLC3'],
      chapterIds: [],
      years: [2045, 2047],
    });
  });

  test('NB-3 a re-pull with nothing new writes nothing', async () => {
    const before = page(ctx.session, 'K1')!.modifiedAt;
    const n = ctx.changes.length;
    expect(await ctx.service.pull()).toBe(0);
    expect(page(ctx.session, 'K1')!.modifiedAt).toBe(before);
    expect(ctx.changes.length).toBe(n);
  });

  test('NB-4 NB-5 a council lands whole with its reading, speakers from c: voices and seats, ink as nobody, and links to a chapter it names', async () => {
    await send(ctx.world, 'pages', 'C1', 20, {
      id: 'C1',
      kind: 'council',
      title: 'Does Rain in Guangzhou need Ruth?',
      state: 'open',
      createdAt: NOV25,
      updatedAt: NOV25,
      seats: ['c:H4', 'c:Z3'],
      reading: 'in',
      chips: { characterIds: [], placeIds: [], year: 2060 },
      year: 2060,
    });
    await send(ctx.world, 'messages', 'C1-a', 21, {
      id: 'C1-a',
      pageId: 'C1',
      at: NOV25 + 1,
      voiceId: 'c:Z3',
      text: 'Not yet.',
      kept: false,
    });
    await send(ctx.world, 'messages', 'C1-b', 22, {
      id: 'C1-b',
      pageId: 'C1',
      at: NOV25 + 2,
      text: 'Then chapter 4.',
      kept: false,
      wise: true,
    });
    expect(await ctx.service.focus()).toBe(1);
    const c = page(ctx.session, 'C1')!;
    expect(c).toMatchObject({ kind: 'council', reading: 'in', year: 2060 });
    expect(c.lines.map((l) => [l.id, l.speakerId, l.wise])).toEqual([
      ['C1-a', 'Z3', false],
      ['C1-b', null, true],
    ]);
    expect(c.characterIds).toEqual(['H4', 'Z3']);
    expect(c.chapterIds).toEqual(['CH4', 'CH7']);
    expect(c.placeIds).toEqual(['PLC3']);
  });

  test('NB-6 a newer rev replaces the page and its links are read again', async () => {
    await send(
      ctx.world,
      'messages',
      'K1',
      30,
      keptRow('K1', 'Ruth Hale keeps the Portland flat.'),
    );
    expect(await ctx.service.pull()).toBe(1);
    expect(page(ctx.session, 'K1')).toMatchObject({
      lines: [{ text: 'Ruth Hale keeps the Portland flat.' }],
      characterIds: ['H4'],
      placeIds: ['PLC1'],
      years: [2045],
    });
    // An older rev never arrives (the function drops it), and the stored one stays.
    expect(ctx.session.search.search('Guangzhou').some((h) => h.id === 'K1')).toBe(false);
  });

  test('NB-6 a line no longer kept goes to the trash: out of the lists and search, in the trash, once', async () => {
    const invoke: Invoke = ctx.invoke;
    expect(
      (await invoke('notebook.list', { collection: 'characters', id: 'H4' })).rows.map((r) => r.id),
    ).toContain('K1');
    await send(ctx.world, 'messages', 'K1', 40, null);
    expect(await ctx.service.pull()).toBe(1);
    expect(page(ctx.session, 'K1')!.deletedAt).toEqual(expect.any(String));
    expect(ctx.changes).toContainEqual(expect.objectContaining({ id: 'K1', op: 'softDelete' }));
    expect(
      (await invoke('notebook.list', { collection: 'characters', id: 'H4' })).rows.map((r) => r.id),
    ).not.toContain('K1');
    expect(ctx.session.search.search('Portland flat').some((h) => h.id === 'K1')).toBe(false);
    const trash = await invoke('trash.list', {});
    expect(trash.notebookPages.map((p) => p.id)).toContain('K1');
    expect(await ctx.service.pull()).toBe(0);
  });

  test('NB-6 a deleted council goes to the trash; kept again on the phone, a line comes back', async () => {
    await send(ctx.world, 'pages', 'C1', 50, null);
    await ctx.service.pull();
    expect(page(ctx.session, 'C1')!.deletedAt).toEqual(expect.any(String));
    await send(
      ctx.world,
      'messages',
      'K1',
      60,
      keptRow('K1', 'Ruth Hale keeps the flat after all.'),
    );
    await ctx.service.pull();
    expect(page(ctx.session, 'K1')!.deletedAt).toBeUndefined();
    expect(ctx.changes).toContainEqual(expect.objectContaining({ id: 'K1', op: 'restore' }));
  });

  test('NB-6 Empty trash deletes the trashed notebook pages forever', async () => {
    const r = await ctx.session.repo.emptyTrash();
    expect(r.entries).toBeGreaterThanOrEqual(1);
    expect(page(ctx.session, 'C1')).toBeUndefined();
    expect(
      await ctx.session.handle.collection(NOTEBOOK_COLLECTION).findOne({ _id: 'C1' as never }),
    ).toBeNull();
    // The delete is still in bridge_up; a pull does not bring the page back.
    expect(await ctx.service.pull()).toBe(0);
    expect(page(ctx.session, 'C1')).toBeUndefined();
  });

  test('NB-3 another world never lands here', async () => {
    await send('someone-else', 'messages', 'X1', 1, keptRow('X1', 'Not mine.'));
    expect(await ctx.service.pull()).toBe(0);
    expect(page(ctx.session, 'X1')).toBeUndefined();
  });
});

describe('NB-4 one page never stops a pull', () => {
  test('NB-4 NB-3 a 420-line council and a kept line in one pull both land, and nothing is reported', async () => {
    const ctx = await openWithBridge('nb-long');
    const errors: unknown[] = [];
    const service = new BridgeService({
      store: new BridgeStore(store.db),
      session: ctx.session,
      world: ctx.world,
      name: 'F',
      onError: (e) => errors.push(e),
    });
    await send(ctx.world, 'pages', 'LONG', 10, {
      id: 'LONG',
      kind: 'council',
      title: 'A long night',
      state: 'open',
      createdAt: NOV25,
      updatedAt: NOV25,
      reading: 'about',
      year: 2045,
    });
    for (let i = 0; i < 420; i++) {
      const id = `0f7c3b1e-5a2d-4c3e-9f1a-${String(i).padStart(12, '0')}`;
      await send(ctx.world, 'messages', id, 100 + i, {
        id,
        pageId: 'LONG',
        at: NOV25 + i,
        text: `Line ${i}`,
        kept: false,
      });
    }
    await send(ctx.world, 'messages', 'K-short', 9, keptRow('K-short', 'Daniel Hale stays.'));
    expect(await service.pull()).toBe(2);
    expect(errors).toEqual([]);
    expect(page(ctx.session, 'LONG')!.lines).toHaveLength(420);
    expect(page(ctx.session, 'K-short')).toBeDefined();
    service.stop();
  });

  test('NB-4 a page that cannot be stored is skipped and reported; the rest of the pull lands', async () => {
    const ctx = await openWithBridge('nb-bad');
    const errors: Error[] = [];
    const service = new BridgeService({
      store: new BridgeStore(store.db),
      session: ctx.session,
      world: ctx.world,
      name: 'F',
      onError: (e) => errors.push(e as Error),
    });
    // A chip ID longer than any phone row ID is dropped on arrival; a speaker voice that long cannot be.
    await send(ctx.world, 'pages', 'BAD', 10, {
      id: 'BAD',
      kind: 'council',
      title: 'Bad',
      createdAt: NOV25,
      seats: [],
      year: 2045,
    });
    await send(ctx.world, 'messages', 'BAD-1', 11, {
      id: 'BAD-1',
      pageId: 'BAD',
      at: NOV25,
      voiceId: `c:${'x'.repeat(300)}`,
      text: 'x',
      kept: false,
    });
    await send(ctx.world, 'messages', 'K-ok', 12, keptRow('K-ok', 'Sam Hale is fine.'));
    expect(await service.pull()).toBe(1);
    expect(page(ctx.session, 'K-ok')).toBeDefined();
    expect(page(ctx.session, 'BAD')).toBeUndefined();
    expect(errors.map((e) => e.message)).toEqual([
      expect.stringMatching(/notebook page BAD .*skipped/),
    ]);
    service.stop();
  });

  test('NB-5 a chip or a name for a character, place or chapter in the trash is not linked', async () => {
    const ctx = await openWithBridge('nb-trashed');
    await ctx.session.repo.softDelete('characters', 'H6');
    await ctx.session.repo.softDelete('places', 'PLC4');
    await send(
      ctx.world,
      'messages',
      'K-t',
      5,
      keptRow('K-t', 'Noor keeps a key.', {
        chips: { characterIds: ['H6', 'Z5'], placeIds: ['PLC4'] },
      }),
    );
    await ctx.service.pull();
    expect(page(ctx.session, 'K-t')).toMatchObject({ characterIds: ['Z5'], placeIds: [] });
  });
});

describe('NB-3 when the pull runs', () => {
  test('NB-3 the clock pulls on its own while the bible is open, and nothing after it is stopped', async () => {
    const ctx = await openWithBridge('nb-clock', { pullEveryMs: 60 });
    await ctx.service.start();
    await send(ctx.world, 'messages', 'T1', 5, keptRow('T1', 'Sam Hale learns to swim.'));
    await until(() => page(ctx.session, 'T1') !== undefined);
    ctx.service.stop();
    await send(ctx.world, 'messages', 'T2', 6, keptRow('T2', 'Sam Hale learns to drive.'));
    await new Promise((r) => setTimeout(r, 200));
    expect(page(ctx.session, 'T2')).toBeUndefined();
  });

  test('NB-3 a failure is quiet: the error goes to the handler and the next pull tries again', async () => {
    const ctx = await openWithBridge('nb-fail');
    const errors: unknown[] = [];
    let fail = true;
    const store2 = new BridgeStore(store.db);
    const flaky = Object.assign(Object.create(BridgeStore.prototype) as BridgeStore, store2, {
      readUp: async (w: string) => {
        if (fail) throw new Error('offline');
        return store2.readUp(w);
      },
    });
    const service = new BridgeService({
      store: flaky,
      session: ctx.session,
      world: ctx.world,
      name: 'F',
      onError: (e) => errors.push(e),
    });
    await send(ctx.world, 'messages', 'F1', 5, keptRow('F1', 'Daniel Hale writes.'));
    expect(await service.pull()).toBe(0);
    expect(errors).toHaveLength(1);
    fail = false;
    expect(await service.pull()).toBe(1);
    service.stop();
  });

  test('NB-1 a bible with no world ID is never published', async () => {
    const ctx = await openWithBridge('nb-none');
    const service = new BridgeService({
      store: new BridgeStore(store.db),
      session: ctx.session,
      world: null,
      name: 'F',
    });
    await service.start();
    expect(
      await store.db.collection(BRIDGE_WORLDS).findOne({ _id: ctx.world as never }),
    ).toBeNull();
    service.stop();
  });
});

describe('NB-9 search finds notebook pages', () => {
  let ctx: Awaited<ReturnType<typeof openWithBridge>>;
  beforeAll(async () => {
    ctx = await openWithBridge('nb-search');
    await send(
      ctx.world,
      'messages',
      'S1',
      5,
      keptRow('S1', 'Zhou Lan hides the kumquat in Guangzhou.'),
    );
    await ctx.service.start();
  });
  afterAll(() => ctx.service.stop());

  test('NB-9 SR-1 the Search screen finds a notebook page by its words, with its first line as the title', async () => {
    const r = await ctx.invoke('search.query', { query: 'kumquat', notebook: true });
    expect(r.hits).toEqual([
      expect.objectContaining({
        collection: NOTEBOOK_COLLECTION,
        id: 'S1',
        title: 'Zhou Lan hides the kumquat in Guangzhou.',
      }),
    ]);
  });

  test('NB-9 pickers never see notebook pages: not without the flag, not with a section asked for', async () => {
    expect((await ctx.invoke('search.query', { query: 'kumquat' })).hits).toEqual([]);
    expect(
      (
        await ctx.invoke('search.query', {
          query: 'kumquat',
          notebook: true,
          collections: ['characters'],
        })
      ).hits,
    ).toEqual([]);
  });

  test('NB-9 SR-2 the filters narrow notebook pages by place, family and year', async () => {
    const q = (filters: Record<string, unknown>) =>
      ctx.invoke('search.query', { query: 'kumquat', notebook: true, filters: filters as never });
    expect((await q({ placeId: 'PLC3' })).hits).toHaveLength(1);
    expect((await q({ placeId: 'PLC1' })).hits).toHaveLength(0);
    expect((await q({ familyId: 'FAM-ZHOU' })).hits).toHaveLength(1);
    expect((await q({ familyId: 'FAM-HALE' })).hits).toHaveLength(0);
    expect((await q({ yearFrom: 2040, yearTo: 2050 })).hits).toHaveLength(1);
    expect((await q({ yearFrom: 2060 })).hits).toHaveLength(0);
    expect((await q({ sections: ['characters'] })).hits).toHaveLength(0);
  });

  test('NB-8 notebook.get names the speakers and what the page names, from the bible', async () => {
    const r = await ctx.invoke('notebook.get', { id: 'S1' });
    expect(r.page).toMatchObject({
      id: 'S1',
      kind: 'kept',
      caption: 'Kept line · story year 2045',
      firstLine: 'Zhou Lan hides the kumquat in Guangzhou.',
      inTrash: false,
      links: [
        { collection: 'characters', id: 'Z3', title: 'Zhou Lan' },
        { collection: 'places', id: 'PLC3', title: 'Guangzhou' },
      ],
    });
    await expect(ctx.invoke('notebook.get', { id: 'nope' })).rejects.toThrow(/not in this bible/);
  });
});
