import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, inject, test } from 'vitest';
import { connect, createBible } from '../../src/main/db';
import type { Store } from '../../src/main/db';
import { openBibleForApp, openBibleSession } from '../../src/main/db/session';
import type { OpenBible } from '../../src/main/db/session';
import { ReadOnlyError, latestSnapshot, openSnapshotReadOnly } from '../../src/main/db/readOnly';
import { exportBibleJson, importBibleJson } from '../../src/main/backup/json';
import { bibleHandlers } from '../../src/main/ipc/bibleHandlers';
import type { BibleChannel } from '../../src/main/ipc/bibleHandlers';
import { guardHandler } from '../../src/main/ipc/offline';
import { runHandler } from '../../src/main/ipc/validate';
import type { Handler } from '../../src/main/ipc/validate';
import { ConnectionManager, UNREACHABLE } from '../../src/main/connection';
import { MemoryMongoUriStore, maskMongoUri } from '../../src/main/secrets';
import { FileAppSettingsStore } from '../../src/main/appSettings';
import { FileSettingsStore } from '../../src/main/claude/settings';
import {
  CONNECTION_LOST_MESSAGE,
  READ_ONLY_REASON,
  WRITE_CHANNELS,
  isWriteChannel,
} from '../../src/shared/ipcApp';
import type { Channel, Request, Response } from '../../src/shared/ipc';
import { freshSlug, localStore } from '../helpers/db';
import { loadFixture } from '../helpers/loadFixture';

let store: Store;
let root: string;
const uri = () => inject('mongoUri');

beforeAll(async () => {
  store = await localStore();
  root = await mkdtemp(join(tmpdir(), 'nc-offline-'));
});
afterAll(async () => {
  await store.close();
});

/** A port nothing listens on: bound once, then released. */
async function closedPort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

/** The bible channels as main registers them: guarded, validated both ways, JSON on the wire. */
function guardedIpc(bible: () => OpenBible | null, guard: { readOnly(): boolean; lost(): void }) {
  const handlers = bibleHandlers(bible, {});
  return async <C extends Channel>(channel: C, request: Request<C>): Promise<Response<C>> => {
    const handler = handlers[channel as BibleChannel] as Handler<C> | undefined;
    if (!handler) throw new Error(`No bible handler for ${channel}`);
    const wire = JSON.parse(JSON.stringify(request)) as unknown;
    const response = await runHandler(channel, guardHandler(channel, handler, guard), wire);
    return JSON.parse(JSON.stringify(response)) as Response<C>;
  };
}

describe('ARCH-6 the connection drops mid-session', () => {
  test('ARCH-6 with the client closed, a write fails plainly, says nothing was saved, and changes nothing', async () => {
    const own = await connect(uri());
    const handle = await loadFixture(own, freshSlug('arch6-drop'));
    const session = await openBibleSession(own, handle.id);
    let lost = 0;
    const ipc = guardedIpc(() => session, { readOnly: () => false, lost: () => void lost++ });

    const before = (await ipc('entry.get', { collection: 'characters', id: 'H1' })).entry;
    const settingsBefore = session.repo.briefSettings();
    await own.close();

    await expect(
      ipc('entry.update', {
        collection: 'characters',
        id: 'H1',
        patch: { birthplace: 'Never saved' },
      }),
    ).rejects.toThrow(CONNECTION_LOST_MESSAGE);
    await expect(ipc('brief.settings.set', { window: 3 })).rejects.toThrow(CONNECTION_LOST_MESSAGE);
    await expect(ipc('lists.addItem', { listId: 'tags', label: 'Ghost' })).rejects.toThrow(
      CONNECTION_LOST_MESSAGE,
    );
    expect(lost).toBe(3);
    expect(CONNECTION_LOST_MESSAGE).toMatch(/not saved/);

    // The read model still answers, and shows what is really stored.
    const after = (await ipc('entry.get', { collection: 'characters', id: 'H1' })).entry;
    expect(after).toEqual(before);
    expect(session.repo.briefSettings()).toEqual(settingsBefore);
    const tags = (await ipc('lists.get', {})).lists.find((l) => l._id === 'tags');
    expect(tags?.items.some((i) => i.label === 'Ghost') ?? false).toBe(false);

    // And MongoDB holds nothing of it.
    const doc = await store.db
      .collection<{ _id: string; [k: string]: unknown }>(`${handle.id}.characters`)
      .findOne({ _id: 'H1' });
    expect(doc?.birthplace).toEqual(before.birthplace);
    const stored = await store.db
      .collection<{ _id: string; [k: string]: unknown }>(`${handle.id}.lists`)
      .findOne({ _id: 'tags' });
    expect(JSON.stringify(stored ?? {})).not.toContain('Ghost');
  });

  test('ARCH-6 a lost connection offers the latest snapshot, and Try again reconnects', async () => {
    const snaps = await mkdtemp(join(tmpdir(), 'nc-arch6-snaps-'));
    const own = await connect(uri());
    const handle = await loadFixture(own, freshSlug('arch6-retry'));
    const opened = await openBibleForApp(own, handle.id, { snapshotRoot: snaps });
    await opened.dailySnapshot; // taken in the background after the open (NF-1)
    expect((await opened.snapshots!.list()).length).toBe(1); // the daily snapshot
    const uris = new MemoryMongoUriStore(uri());
    const events: string[] = [];
    const conn = new ConnectionManager({
      uris,
      localOnly: true,
      missingMessage: 'none',
      snapshotRoot: snaps,
      onStatus: (s) => events.push(s.state),
    });
    expect((await conn.getStore()).ok).toBe(true);
    conn.lastBible = handle.id;
    conn.lost();
    const status = await conn.status();
    expect(status.state).toBe('unavailable');
    expect(status.message).toMatch(/lost its connection to MongoDB/);
    expect(status.message).toMatch(/open the most recent local snapshot read-only/);
    expect(status.snapshot?.bible).toBe(handle.id);

    const r = await conn.retry();
    expect(r.ok).toBe(true);
    expect((await conn.status()).state).toBe('connected');
    await new Promise((res) => setTimeout(res, 20));
    expect(events).toContain('unavailable');
    expect(events.at(-1)).toBe('connected');
    await conn.close();
    await own.close();
  });

  test('ARCH-6 at launch with MongoDB unreachable the message is plain, and says when there is no snapshot', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'nc-arch6-empty-'));
    const port = await closedPort();
    const conn = new ConnectionManager({
      uris: new MemoryMongoUriStore(`mongodb://127.0.0.1:${port}/?directConnection=true`),
      localOnly: true,
      missingMessage: 'none',
      snapshotRoot: empty,
      connect: (u) => connect(u, { serverSelectionTimeoutMS: 500 }),
    });
    const r = await conn.getStore();
    expect(r).toEqual({ ok: false, message: UNREACHABLE });
    const st = await conn.status();
    expect(st.state).toBe('unavailable');
    expect(st.snapshot).toBeNull();
    expect(st.message).toMatch(/Check your network connection/);
    expect(st.message).toMatch(/no local snapshot on this Mac yet/);
    expect(st.message).not.toMatch(/ECONNREFUSED|Mongo[A-Z]\w*Error|—/);
  });
});

describe('ARCH-6 a snapshot opens read-only', () => {
  let session: OpenBible;
  let slug: string;
  let snaps: string;
  let snapshotFiles: Record<string, string>;

  beforeAll(async () => {
    snaps = await mkdtemp(join(tmpdir(), 'nc-arch6-ro-'));
    const handle = await loadFixture(store, freshSlug('arch6-ro'));
    slug = handle.id;
    const live = await openBibleSession(store, slug, { snapshotRoot: snaps });
    await live.repo.update('characters', 'H1', { birthplace: 'Before the snapshot' } as never);
    await live.snapshots!.take('manual');
    const latest = await latestSnapshot(snaps, slug);
    expect(latest?.bible).toBe(slug);
    const dir = join(snaps, slug, latest!.id);
    snapshotFiles = {};
    for (const f of await readdir(dir)) snapshotFiles[f] = await readFile(join(dir, f), 'utf8');
    session = (await openSnapshotReadOnly(snaps, latest!)).session;
  });

  test('ARCH-6 search, entries, history, and the deterministic views answer from the snapshot', async () => {
    const ipc = guardedIpc(() => session, { readOnly: () => true, lost: () => undefined });
    const h1 = await ipc('entry.get', { collection: 'characters', id: 'H1' });
    expect(h1.entry.title).toBe('Margaret Hale');
    expect(h1.entry.birthplace).toBe('Before the snapshot');
    const found = await ipc('search.query', { query: 'Margaret', limit: 20 });
    expect(found.hits.map((h) => h.id)).toContain('H1');
    const year = await ipc('timeline.year', { at: { year: 2030 } });
    expect(year.alive.length + year.dead.length + year.unborn.length).toBeGreaterThan(0);
    const tree = await ipc('tree.get', {});
    expect(tree).toBeTruthy();
    const history = await ipc('revisions.list', { collection: 'characters', id: 'H1' });
    expect(history.revisions.length).toBeGreaterThan(0);
    expect(
      (await ipc('entry.list', { collection: 'characters', trash: 'exclude' })).entries.length,
    ).toBeGreaterThan(0);
    expect((await ipc('romanization.get', {})).languages.length).toBeGreaterThanOrEqual(0);
  });

  test('ARCH-6 every write is refused with the reason, and nothing changes in memory, on disk, or in MongoDB', async () => {
    const ipc = guardedIpc(() => session, { readOnly: () => true, lost: () => undefined });
    await expect(
      ipc('entry.update', { collection: 'characters', id: 'H1', patch: { birthplace: 'Changed' } }),
    ).rejects.toThrow(READ_ONLY_REASON);
    await expect(ipc('brief.settings.set', { window: 4 })).rejects.toThrow(READ_ONLY_REASON);
    await expect(ipc('lists.addItem', { listId: 'tags', label: 'New tag' })).rejects.toThrow(
      READ_ONLY_REASON,
    );
    // Below the IPC guard, the write path itself refuses: the handle has no way to write.
    await expect(
      session.repo.update('characters', 'H1', { birthplace: 'Changed' } as never),
    ).rejects.toBeInstanceOf(ReadOnlyError);
    await expect(session.repo.setBriefSettings({ window: 4 })).rejects.toBeInstanceOf(
      ReadOnlyError,
    );
    await expect(session.repo.setStoryTime({ year: 2040 })).rejects.toBeInstanceOf(ReadOnlyError);
    expect(session.model.get('characters', 'H1')?.birthplace).toBe('Before the snapshot');
    expect(session.repo.briefSettings().window).toBe(10);

    const latest = await latestSnapshot(snaps, slug);
    const dir = join(snaps, slug, latest!.id);
    for (const [f, text] of Object.entries(snapshotFiles)) {
      expect(await readFile(join(dir, f), 'utf8')).toBe(text);
    }
    const live = await store.db
      .collection<{ _id: string; [k: string]: unknown }>(`${slug}.characters`)
      .findOne({ _id: 'H1' });
    expect(live?.birthplace).toBe('Before the snapshot');
  });

  test('ARCH-6 every write channel is a channel of the contract and is refused before it runs', async () => {
    let ran = 0;
    for (const channel of WRITE_CHANNELS) {
      expect(isWriteChannel(channel)).toBe(true);
      const h = guardHandler(
        channel as Channel,
        (() => {
          ran++;
          return {};
        }) as never,
        { readOnly: () => true, lost: () => undefined },
      );
      await expect(Promise.resolve().then(() => h({} as never))).rejects.toThrow(READ_ONLY_REASON);
    }
    expect(ran).toBe(0);
    // Reads run as usual.
    const read = guardHandler('search.query', (() => ({ hits: [] })) as never, {
      readOnly: () => true,
      lost: () => undefined,
    });
    await expect(read({} as never)).resolves.toEqual({ hits: [] });
  });
});

describe('ST-1 the MongoDB connection is tested, masked, and switched only after a passing test', () => {
  test('ST-1 Test connection reports success, and a plain failure for a closed port, saving nothing', async () => {
    const uris = new MemoryMongoUriStore(uri());
    const conn = new ConnectionManager({
      uris,
      localOnly: true,
      missingMessage: 'none',
      snapshotRoot: root,
      connect: (u) => connect(u, { serverSelectionTimeoutMS: 1000 }),
    });
    const ok = await conn.test();
    expect(ok.ok).toBe(true);
    expect(ok.message).toMatch(/^Connected/);
    const port = await closedPort();
    const bad = await conn.test(`mongodb://127.0.0.1:${port}/?directConnection=true`);
    expect(bad.ok).toBe(false);
    expect(bad.message).toMatch(/Nothing answered|did not answer/);
    expect(bad.message).not.toMatch(/ECONNREFUSED|Error/);
    expect(uris.get()).toBe(uri());
    const shape = await conn.test('https://cluster0.example.mongodb.net');
    expect(shape).toEqual({
      ok: false,
      message: expect.stringMatching(/starts with "mongodb\+srv:\/\/"/),
    });
    const atlas = await conn.test('mongodb+srv://user:secret@cluster0.example.mongodb.net/');
    expect(atlas).toEqual({
      ok: false,
      message: 'The test database address must be a local MongoDB.',
    });
  });

  test('ST-1 Replace keeps the old string and connection when the new one fails, and switches only when it connects', async () => {
    const uris = new MemoryMongoUriStore(uri());
    const conn = new ConnectionManager({
      uris,
      localOnly: true,
      missingMessage: 'none',
      snapshotRoot: root,
      connect: (u) => connect(u, { serverSelectionTimeoutMS: 1000 }),
    });
    const first = await conn.getStore();
    expect(first.ok).toBe(true);
    const oldStore = conn.current;
    const port = await closedPort();
    // A string with a user and password: refused under test (not a bare local address), and
    // refused by a real app when nothing answers; neither message carries the password.
    const secret = `mongodb://reader:hunter2-secret@127.0.0.1:${port}/?directConnection=true`;
    const refused = await conn.replace(secret);
    expect(refused.ok).toBe(false);
    expect(refused.message).not.toContain('hunter2');
    const real = new ConnectionManager({
      uris: new MemoryMongoUriStore(uri()),
      localOnly: false,
      missingMessage: 'none',
      snapshotRoot: root,
      connect: (u) => connect(u, { serverSelectionTimeoutMS: 1000 }),
    });
    const unreachable = await real.replace(secret);
    expect(unreachable.ok).toBe(false);
    expect(unreachable.message).toMatch(/was not changed/);
    expect(unreachable.message).not.toContain('hunter2');
    expect(real.mongoSettings().masked).toBe(maskMongoUri(uri()));
    const failed = await conn.replace(`mongodb://127.0.0.1:${port}/?directConnection=true`);
    expect(failed.ok).toBe(false);
    expect(failed.message).toMatch(/was not changed/);
    expect(failed.message).not.toContain('hunter2');
    expect(uris.get()).toBe(uri());
    expect(conn.current).toBe(oldStore);

    const next = uri().includes('?') ? `${uri()}&appName=switched` : `${uri()}?appName=switched`;
    const done = await conn.replace(next);
    expect(done.ok).toBe(true);
    expect(uris.get()).toBe(next);
    expect(conn.current).not.toBe(oldStore);
    expect(conn.current).toBe(done.switched);
    // The old client is closed; the new one works.
    await expect(oldStore!.db.command({ ping: 1 })).rejects.toThrow();
    expect((await conn.current!.db.command({ ping: 1 })).ok).toBe(1);

    const masked = conn.mongoSettings();
    expect(masked.set).toBe(true);
    expect(masked.masked).toMatch(/^mongodb:\/\/…/);
    expect(masked.masked).not.toContain(next);
    expect(masked.masked).not.toContain('appName');
    expect(JSON.stringify(masked)).not.toContain('127.0.0.1:');
    await conn.close();
  });
});

describe('ST-1 every setting persists, and the per-bible ones travel in the JSON export (BK-3)', () => {
  test('ST-1 BK-3 brief window, size budget, romanization, and snapshot count are saved in the bible and exported', async () => {
    const slug = freshSlug('st1-bible');
    const handle = await createBible(store, slug, 'Settings');
    void handle;
    const snaps = await mkdtemp(join(tmpdir(), 'nc-st1-'));
    const session = await openBibleSession(store, slug, { snapshotRoot: snaps });
    const ipc = guardedIpc(() => session, { readOnly: () => false, lost: () => undefined });
    await ipc('brief.settings.set', { window: 7, budget: 12_345 });
    const roman = await ipc('romanization.get', {});
    expect(roman.languages.map((l) => l.id)).toContain('cantonese');
    await ipc('romanization.set', { languageId: 'cantonese', systemId: null });
    await ipc('snapshot.keep', { keep: 12 });

    // A fresh session reads them back from MongoDB, as after a relaunch.
    const again = await openBibleSession(store, slug, { snapshotRoot: snaps });
    expect(again.repo.briefSettings()).toEqual({ window: 7, budget: 12_345 });
    expect(again.repo.snapshotKeep()).toBe(12);
    const ipc2 = guardedIpc(() => again, { readOnly: () => false, lost: () => undefined });
    const cantonese = (await ipc2('romanization.get', {})).languages.find(
      (l) => l.id === 'cantonese',
    );
    expect(cantonese?.systemId).toBeNull();

    // BK-3: the export carries them, and an import into an empty bible has them identically.
    const { text } = await exportBibleJson(again.handle);
    const target = await createBible(store, freshSlug('st1-import'), 'Imported');
    await importBibleJson(target, text);
    const imported = await openBibleSession(store, target.id);
    expect(imported.repo.briefSettings()).toEqual({ window: 7, budget: 12_345 });
    expect(imported.repo.snapshotKeep()).toBe(12);
    expect(imported.repo.romanizationSettings()).toEqual(again.repo.romanizationSettings());
    expect(text).not.toMatch(/mongodb(\+srv)?:\/\//);
  });

  test('ST-1 two quick changes to the brief window and the size budget both land', async () => {
    const slug = freshSlug('st1-race');
    await createBible(store, slug, 'Race');
    const session = await openBibleSession(store, slug);
    const [a, b] = await Promise.all([
      session.repo.setBriefSettings({ window: 7 }),
      session.repo.setBriefSettings({ budget: 12_345 }),
    ]);
    expect(a.window).toBe(7);
    expect(b).toEqual({ window: 7, budget: 12_345 });
    const again = await openBibleSession(store, slug);
    expect(again.repo.briefSettings()).toEqual({ window: 7, budget: 12_345 });
    // A refused value does not block the next change.
    await expect(session.repo.setBriefSettings({ window: 999 })).rejects.toThrow(/0 to 200/);
    expect((await session.repo.setBriefSettings({ window: 8 })).window).toBe(8);
  });

  test('ST-1 appearance and the model per feature are kept in the app data folder across a restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nc-st1-app-'));
    const app1 = new FileAppSettingsStore(join(dir, 'app-settings.json'));
    expect(app1.read().appearance).toBe('system');
    app1.write({ appearance: 'dark' });
    expect(new FileAppSettingsStore(join(dir, 'app-settings.json')).read().appearance).toBe('dark');
    const claude = new FileSettingsStore(join(dir, 'claude-settings.json'));
    claude.write({ ...claude.read(), models: { summaries: 'claude-haiku-4-5-20251001' } });
    expect(new FileSettingsStore(join(dir, 'claude-settings.json')).read().models.summaries).toBe(
      'claude-haiku-4-5-20251001',
    );
    const files = await readdir(dir);
    for (const f of files)
      expect(await readFile(join(dir, f), 'utf8')).not.toMatch(/sk-ant-|mongodb/);
  });
});
