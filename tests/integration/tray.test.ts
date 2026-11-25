import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { Document } from 'mongodb';
import type { Store } from '../../src/main/db';
import { openBibleSession } from '../../src/main/db/session';
import { BridgeStore } from '../../src/main/db/bridge';
import { BridgeService } from '../../src/main/bridge/service';
import { BRIDGE_UP, worldIdFor } from '../../src/shared/bridge';
import type { UpRow } from '../../src/shared/bridge';
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

const NOV24 = Date.parse('2026-11-24T21:00:00.000Z');
const NOV25 = Date.parse('2026-11-25T21:00:00.000Z');

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

const councilPage = (id: string, reading: 'in' | 'about', year: number | null, at: number) => ({
  id,
  kind: 'council',
  title: `Council ${id}`,
  state: 'open',
  createdAt: at,
  updatedAt: at,
  seats: ['c:H3'],
  reading,
  year,
});
const councilLine = (id: string, pageId: string, text: string, at: number, voiceId?: string) => ({
  id,
  pageId,
  at,
  updatedAt: at,
  text,
  kept: false,
  ...(voiceId ? { voiceId } : {}),
});

describe('A56 the tray, Voice and Relevant channels over the pages the phone sent', () => {
  let slug: string;
  let world: string;
  let session: Awaited<ReturnType<typeof openBibleSession>>;
  let service: BridgeService;
  let invoke: ReturnType<typeof ipcFor>;

  beforeAll(async () => {
    slug = freshSlug('fn-tray');
    await loadFixture(store, slug);
    session = await openBibleSession(store, slug);
    world = worldIdFor(slug)!;
    service = new BridgeService({
      store: new BridgeStore(store.db),
      session,
      world,
      name: 'Fixture novel',
      publishAfterMs: 20,
      pullEveryMs: 60 * 60 * 1000,
    });
    invoke = ipcFor(() => session);
    // A kept line, a council about the story, a council in the story, and a thread.
    await send(world, 'messages', 'K1', 1, {
      id: 'K1',
      at: NOV25,
      updatedAt: NOV25,
      text: 'Daniel moves to Guangzhou in 2033.',
      wise: false,
      kept: true,
      kind: 'kept',
      date: NOV25,
      year: 2033,
      chips: { characterIds: [], placeIds: [] },
    });
    await send(world, 'pages', 'CA', 1, councilPage('CA', 'about', 2040, NOV24));
    await send(
      world,
      'messages',
      'ca1',
      1,
      councilLine('ca1', 'CA', 'Ruth leaves Portland.', NOV24 + 1),
    );
    await send(world, 'messages', 'ca2', 1, {
      ...councilLine('ca2', 'CA', 'A paper line.', NOV24 + 2),
      paper: { side: 'for' },
    });
    await send(world, 'pages', 'CI', 1, councilPage('CI', 'in', 2045, NOV24));
    await send(
      world,
      'messages',
      'ci1',
      1,
      councilLine('ci1', 'CI', 'Keep this for me.', NOV24 + 1, 'c:H3'),
    );
    await send(world, 'messages', 'ci2', 1, councilLine('ci2', 'CI', 'Only ink.', NOV24 + 2));
    await send(world, 'pages', 'CW', 1, councilPage('CW', 'in', null, NOV25));
    await send(
      world,
      'messages',
      'cw1',
      1,
      councilLine('cw1', 'CW', 'Across the whole book.', NOV25 + 1, 'c:H3'),
    );
    await service.pull();
  });
  afterAll(() => service.stop());

  test('FN-1 notebook.offered gives the kept line and the council about the story, his ink and the characters only', async () => {
    const { pages } = await invoke('notebook.offered', {});
    expect(pages.map((p) => [p.id, p.kind, p.year])).toEqual(
      expect.arrayContaining([
        ['K1', 'kept', 2033],
        ['CA', 'council', 2040],
      ]),
    );
    expect(pages).toHaveLength(2);
    expect(pages.find((p) => p.id === 'CA')?.lines.map((l) => l.id)).toEqual(['ca1']);
  });

  test('FN-4 tray.mark keeps a mark in meta across a reopen, one mark a key, and null clears it', async () => {
    expect(await invoke('tray.state', {})).toEqual({ dismissed: [], filed: [], sent: [] });
    await invoke('tray.mark', { keys: ['K1:abc#0'], mark: 'dismissed' });
    await invoke('tray.mark', { keys: ['ca1:def#0'], mark: 'filed' });
    const again = await openBibleSession(store, slug);
    expect(again.repo.trayMarks()).toEqual({
      dismissed: ['K1:abc#0'],
      filed: ['ca1:def#0'],
      sent: [],
    });
    const moved = await invoke('tray.mark', { keys: ['K1:abc#0'], mark: 'sent' });
    expect(moved).toEqual({ dismissed: [], filed: ['ca1:def#0'], sent: ['K1:abc#0'] });
    const cleared = await invoke('tray.mark', { keys: ['K1:abc#0', 'ca1:def#0'], mark: null });
    expect(cleared).toEqual({ dismissed: [], filed: [], sent: [] });
  });

  test('FN-8 notebook.voice lists the lines a character speaks in councils in the story, a year first, then the whole book', async () => {
    const { rows } = await invoke('notebook.voice', { id: 'H3' });
    expect(rows.map((r) => [r.pageId, r.lineId, r.year, r.text])).toEqual([
      ['CI', 'ci1', 2045, 'Keep this for me.'],
      ['CW', 'cw1', null, 'Across the whole book.'],
    ]);
    expect((await invoke('notebook.voice', { id: 'H4' })).rows).toEqual([]);
  });

  test('FN-9 notebook.relevant finds pages by the cast, by a place or one inside it, and by the story year', async () => {
    const byYear = await invoke('notebook.relevant', {
      characterIds: [],
      placeIds: [],
      year: 2033,
    });
    expect(byYear.rows.map((r) => r.id)).toEqual(['K1']);
    const byCast = await invoke('notebook.relevant', {
      characterIds: ['H3'],
      placeIds: [],
      year: null,
    });
    expect(byCast.rows.map((r) => r.id)).toEqual(expect.arrayContaining(['CI', 'CW']));
    // The council about the story names Portland (PLC1); The Hale house (PLC2) is inside it.
    const page = session.repo.notebookPage('CA')!;
    expect(page.placeIds).toContain('PLC1');
    const byPlace = await invoke('notebook.relevant', {
      characterIds: [],
      placeIds: ['PLC1'],
      year: null,
    });
    expect(byPlace.rows.map((r) => r.id)).toContain('CA');
    const inside = await invoke('notebook.relevant', {
      characterIds: [],
      placeIds: ['PLC2'],
      year: null,
    });
    expect(inside.rows.map((r) => r.id)).not.toContain('CA');
    const none = await invoke('notebook.relevant', {
      characterIds: ['U1'],
      placeIds: [],
      year: 1999,
    });
    expect(none.rows.map((r) => r.id)).toEqual([]);
  });
});
