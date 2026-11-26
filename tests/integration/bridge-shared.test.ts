import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { Document } from 'mongodb';
import type { Store } from '../../src/main/db';
import { openBibleSession } from '../../src/main/db/session';
import { BridgeStore } from '../../src/main/db/bridge';
import { BridgeService } from '../../src/main/bridge/service';
import { BRIDGE_DOWN, BRIDGE_UP, BRIDGE_WORLDS, worldIdFor } from '../../src/shared/bridge';
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

async function open(prefix: string, world?: string) {
  const slug = freshSlug(prefix);
  await loadFixture(store, slug);
  const session = await openBibleSession(store, slug);
  const errors: unknown[] = [];
  const service = new BridgeService({
    store: new BridgeStore(store.bridge),
    session,
    world: world ?? worldIdFor(slug)!,
    name: 'Fixture novel',
    publishAfterMs: 20,
    pullEveryMs: 60 * 60 * 1000,
    onError: (e) => errors.push(e),
  });
  return {
    slug,
    session,
    world: world ?? worldIdFor(slug)!,
    service,
    errors,
    invoke: ipcFor(() => session),
  };
}

async function send(
  world: string,
  table: UpRow['table'],
  id: string,
  rev: number,
  row: Record<string, unknown> | null,
): Promise<void> {
  const _id = `${world}:${table}:${id}`;
  const doc = { world, table, id, rev, deleted: row === null, row, at: rev };
  await store.bridge.collection(BRIDGE_UP).replaceOne({ _id } as Document, doc, { upsert: true });
}

const T = Date.parse('2026-11-25T21:00:00.000Z');
const song = (id: string, title: string, characterIds: string[]) => ({
  id,
  createdAt: T,
  updatedAt: T,
  title,
  lyric: 'The grey coat on the hook\nwaits all winter',
  sections: [],
  key: 'D minor',
  bpm: 84,
  characterIds,
});

describe('ARCH-8 A56 the shared bridge database', () => {
  test("ARCH-8 Songbook's registry row survives a publish, and a bible on a world another app holds is not published", async () => {
    const songbook = { _id: 'songbook', name: 'Songbook', kind: 'songs' };
    await store.bridge
      .collection(BRIDGE_WORLDS)
      .replaceOne({ _id: 'songbook' } as Document, songbook, { upsert: true });
    const mine = await open('arch8-pub');
    await mine.service.start();
    mine.service.stop();
    expect(
      await store.bridge.collection(BRIDGE_WORLDS).findOne({ _id: 'songbook' } as Document),
    ).toEqual(songbook);
    // A bible whose world ID is Songbook's leaves the row and writes no pocket.
    await store.bridge.collection(BRIDGE_DOWN).deleteOne({ _id: 'songbook' } as Document);
    const clash = await open('arch8-clash', 'songbook');
    await clash.service.start();
    clash.service.stop();
    expect(
      await store.bridge.collection(BRIDGE_WORLDS).findOne({ _id: 'songbook' } as Document),
    ).toEqual(songbook);
    expect(
      await store.bridge.collection(BRIDGE_DOWN).findOne({ _id: 'songbook' } as Document),
    ).toBeNull();
    expect(String(clash.errors[0])).toMatch(/belongs to another app/);
  });

  test('ARCH-8 the pull reads only its world and never takes: a take row is never read, another world never lands', async () => {
    const ctx = await open('arch8-read');
    await send(ctx.world, 'takes', 'TK1', 1, { id: 'TK1', at: T, seconds: 3, pitch: [] });
    await send('someone-else', 'songs', 'S-other', 1, song('S-other', 'Other world', ['H3']));
    const rows = await new BridgeStore(store.bridge).readUp(ctx.world);
    expect(rows.map((r) => r.table)).not.toContain('takes');
    await ctx.service.pull();
    expect(ctx.session.repo.notebookPage('TK1')).toBeUndefined();
    expect(ctx.session.repo.notebookPage('S-other')).toBeUndefined();
  });
});

describe('FN-10 a song is a stub on each character it names', () => {
  let ctx: Awaited<ReturnType<typeof open>>;
  beforeAll(async () => {
    ctx = await open('fn10');
  });

  test('FN-10 a song lands as a stub: the title, captioned Song in Music Companion, on each character it names, a row that does not open, and no lyric', async () => {
    await send(ctx.world, 'songs', 'S1', 1, song('S1', 'The grey coat', ['H3', 'H4', 'NOBODY']));
    await ctx.service.pull();
    const p = ctx.session.repo.notebookPage('S1')!;
    expect(p).toMatchObject({ kind: 'song', title: 'The grey coat', lines: [] });
    expect(p.characterIds).toEqual(['H3', 'H4']);
    expect(JSON.stringify(p)).not.toMatch(/winter|D minor/);
    const { rows } = await ctx.invoke('notebook.list', { collection: 'characters', id: 'H3' });
    expect(rows.find((r) => r.id === 'S1')).toMatchObject({
      kind: 'song',
      firstLine: 'The grey coat',
      caption: 'Song · in Music Companion',
      opens: false,
    });
  });

  test('FN-10 it follows the phone: renamed, linked again when its characters change, trashed when deleted', async () => {
    await send(ctx.world, 'songs', 'S1', 2, {
      ...song('S1', 'The grey coat, again', ['H4']),
      updatedAt: T + 10,
    });
    await ctx.service.pull();
    expect(ctx.session.repo.notebookPage('S1')).toMatchObject({
      title: 'The grey coat, again',
      characterIds: ['H4'],
    });
    const h3 = await ctx.invoke('notebook.list', { collection: 'characters', id: 'H3' });
    expect(h3.rows.map((r) => r.id)).not.toContain('S1');
    await send(ctx.world, 'songs', 'S1', 3, null);
    await ctx.service.pull();
    expect(ctx.session.repo.notebookPage('S1')?.deletedAt).toBeTruthy();
    const h4 = await ctx.invoke('notebook.list', { collection: 'characters', id: 'H4' });
    expect(h4.rows.map((r) => r.id)).not.toContain('S1');
  });

  test('FN-10 a song moved out of this world and back (deleted here, then live again) brings the stub back', async () => {
    await send(ctx.world, 'songs', 'S1', 4, song('S1', 'The grey coat', ['H3']));
    await ctx.service.pull();
    const p = ctx.session.repo.notebookPage('S1')!;
    expect(p.deletedAt).toBeUndefined();
    expect(p.characterIds).toEqual(['H3']);
    expect(ctx.errors).toEqual([]);
  });
});
