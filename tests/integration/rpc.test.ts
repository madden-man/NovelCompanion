import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Binary } from 'mongodb';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { inject } from 'vitest';
import { listBibles, openBible } from '../../src/main/db';
import type { Store } from '../../src/main/db';
import { LATEST_SCHEMA_VERSION } from '../../src/main/db/migrations';
import { ALLOW_TEST_URI_ENV, TEST_DB_NAME_ENV, TEST_URI_ENV } from '../../src/main/host/uri';
import { openSession } from '../../src/main/ipc/handlers';
import { reloadSession } from '../../src/main/backup/restore';
import {
  BIBLE_FREE_CHANNELS,
  DESK_ONLY_MESSAGE,
  NO_BIBLE_MESSAGE,
  PHONE_CHANNELS,
} from '../../src/shared/ipcPhone';
import type { Channel, CallContext, Request as ChannelRequest } from '../../src/shared/ipc';
import { BUILD_HEADER, createRpc } from '../../src/server/rpc';
import type { Rpc, RpcEnvelope, RpcError } from '../../src/server/rpc';
import type { ServerEnv } from '../../src/server/host';
import { webServer } from '../../src/server/node';
import {
  PHONE_SNAPSHOTS,
  PHONE_SNAPSHOT_KEEP,
  listPhoneSnapshots,
  restorePhoneSnapshot,
} from '../../src/server/phoneSnapshots';
import { freshSlug, localStore } from '../helpers/db';
import { loadFixture } from '../helpers/loadFixture';

const KEY = 'phone-key-for-the-tests';
const env: ServerEnv = { NC_PHONE_KEY: KEY, NC_BUILD_ID: 'build-p3-test' };
let clock = new Date('2026-11-27T10:00:00.000Z');
/** What the fake `freshen` does; P2's `freshenOpenBible` stands here after the merge. */
let freshenImpl: () => Promise<{ moved: boolean }> = async () => ({ moved: false });
const freshenSaw: (string | null)[] = [];

let store: Store;
let rpc: Rpc;

beforeAll(async () => {
  // The function counts as packaged: it reaches the local replica set only through the test seam.
  process.env[TEST_URI_ENV] = inject('mongoUri');
  process.env[ALLOW_TEST_URI_ENV] = '1';
  Reflect.deleteProperty(process.env, TEST_DB_NAME_ENV);
  store = await localStore();
  rpc = createRpc({
    env,
    now: () => clock,
    freshen: () => {
      freshenSaw.push(openSession()?.handle.id ?? null);
      return freshenImpl();
    },
  });
});
afterAll(async () => {
  await store.close();
});

async function fixture(prefix: string) {
  return (await loadFixture(store, freshSlug(prefix))).id;
}

function post(body: unknown, key: string | null = KEY, method = 'POST'): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (key !== null) headers.Authorization = `Bearer ${key}`;
  return rpc(
    new Request('http://localhost/rpc', {
      method,
      headers,
      ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
    }),
  );
}

function call<C extends Channel>(
  channel: C,
  request: ChannelRequest<C>,
  bible: string | null,
  context?: CallContext,
): Promise<Response> {
  return post({ channel, request, bible, ...(context ? { context } : {}) });
}

async function ok(res: Response): Promise<RpcEnvelope> {
  const body = (await res.json()) as RpcEnvelope | RpcError;
  if (res.status !== 200) throw new Error(`${res.status}: ${JSON.stringify(body)}`);
  return body as RpcEnvelope;
}

const phoneSnapshotCount = (bible: string) =>
  store.db.collection(PHONE_SNAPSHOTS).countDocuments({ bible });

const backstory = async (bible: string, id = 'H1') =>
  (await (await openBible(store, bible)).collection('characters').findOne({ _id: id } as never))
    ?.backstory as string | undefined;

function expectHeaders(res: Response) {
  expect(res.headers.get('cache-control')).toBe('no-store');
  expect(res.headers.get('x-robots-tag')).toBe('noindex');
  expect(res.headers.get(BUILD_HEADER)).toBe('build-p3-test');
}

describe('PH-14 the phone key gate', () => {
  test('PH-14 no key, a wrong key, or no key set on the server answers 401, with no-store, noindex and the build id', async () => {
    const bible = await fixture('ph14');
    const read = { channel: 'entry.get', request: { collection: 'characters', id: 'H1' }, bible };
    for (const res of [await post(read, null), await post(read, 'wrong-key')]) {
      expect(res.status).toBe(401);
      expect(((await res.json()) as RpcError).code).toBe('key');
      expectHeaders(res);
    }
    delete env.NC_PHONE_KEY;
    try {
      const res = await post(read, KEY);
      expect(res.status).toBe(401);
      expectHeaders(res);
      expect(await post(read, '')).toHaveProperty('status', 401);
    } finally {
      env.NC_PHONE_KEY = KEY;
    }
    // PH-17: a changed key refuses the old one at once.
    env.NC_PHONE_KEY = 'a-new-key';
    try {
      expect((await post(read, KEY)).status).toBe(401);
    } finally {
      env.NC_PHONE_KEY = KEY;
    }
  });

  test('PH-14 with the key, every answer is no-store and noindex and carries the build id (PH-21)', async () => {
    const res = await call('bible.list', {}, null);
    expectHeaders(res);
    const body = await ok(res);
    expect(body.events).toEqual([]);
    const wrongMethod = await post(null, KEY, 'GET');
    expect(wrongMethod.status).toBe(405);
    expectHeaders(wrongMethod);
    const garbled = await post({ nope: true });
    expect(garbled.status).toBe(400);
    expectHeaders(garbled);
  });
});

describe('PH-12 PH-18 a phone channel runs through the handler table', () => {
  test('PH-18 a phone read answers from the asked bible', async () => {
    const bible = await fixture('ph18-read');
    const body = await ok(await call('entry.get', { collection: 'characters', id: 'H1' }, bible));
    expect((body.result as { entry: { title: string } }).entry.title).toBe('Margaret Hale');
    expect(body.events).toEqual([]);
    expect(openSession()?.handle.id).toBe(bible);
  });

  test('PH-12 a phone write lands in MongoDB through the one write path and its events come back in the envelope', async () => {
    const bible = await fixture('ph12-write');
    const res = await call(
      'entry.update',
      { collection: 'characters', id: 'H1', patch: { backstory: 'Written on the phone.' } },
      bible,
      { bible },
    );
    const body = await ok(res);
    expect((body.result as { entry: { backstory: string } }).entry.backstory).toBe(
      'Written on the phone.',
    );
    expect(body.events).toContainEqual({
      event: 'bible.changed',
      payload: { bible, collection: 'characters', id: 'H1', op: 'update' },
    });
    // Opening the bible before the request is not the request's event.
    expect(body.events.map((e) => e.event)).not.toContain('bibles.changed');
    expect(await backstory(bible)).toBe('Written on the phone.');
  });

  test('PH-18 a write carrying another bible than the one asked is refused in plain words', async () => {
    const bible = await fixture('ph18-other');
    const res = await call(
      'entry.update',
      { collection: 'characters', id: 'H1', patch: { backstory: 'Lost.' } },
      bible,
      { bible: 'some-other-bible' },
    );
    expect(res.status).toBe(422);
    expect(((await res.json()) as RpcError).error).toMatch(/no longer open/);
    expect(await backstory(bible)).not.toBe('Lost.');
  });
});

describe('PH-3 PH-4 desk channels are refused', () => {
  test('PH-4 a desk channel is refused in plain words and nothing is written', async () => {
    const bible = await fixture('ph4');
    const slug = freshSlug('ph4-made');
    const before = await backstory(bible);
    const refusals = [
      await call('bible.create', { slug, name: 'Made on the phone' }, bible),
      await call('snapshot.take', {}, bible, { bible }),
      await call('backup.export', {}, bible),
      await call('connection.status', {}, bible),
      await call('mongo.replace', { uri: 'mongodb://127.0.0.1:1' }, bible),
      await call('claude.status', {}, bible),
      await call('tree.export', { fileName: 'tree', png: 'data:image/png;base64,AA==' }, bible),
    ];
    for (const res of refusals) {
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: DESK_ONLY_MESSAGE, code: 'desk' });
      expectHeaders(res);
    }
    expect((await listBibles(store)).some((b) => b._id === slug)).toBe(false);
    expect(await phoneSnapshotCount(bible)).toBe(0);
    expect(await backstory(bible)).toBe(before);
  });

  test('PH-3 test.* is never registered on the server, and the function serves exactly the phone channels', async () => {
    expect(rpc.channels.filter((c) => c.startsWith('test.'))).toEqual([]);
    expect([...rpc.channels].sort()).toEqual([...PHONE_CHANNELS].sort());
    const res = await call('test.seed', { collection: 'characters', count: 1 } as never, null);
    expect(res.status).toBe(403);
  });
});

describe('PH-7 one request at a time, fresh before each', () => {
  test('PH-7 two requests at once run one after the other, in order', async () => {
    const bible = await fixture('ph7-queue');
    await ok(await call('bible.current', {}, bible));
    const steps: string[] = [];
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    freshenImpl = async () => {
      steps.push('start');
      if (steps.length === 1) await gate;
      steps.push('end');
      return { moved: false };
    };
    try {
      const done: number[] = [];
      const first = call('entry.get', { collection: 'characters', id: 'H1' }, bible).then((r) => {
        done.push(1);
        return r;
      });
      const second = call('entry.get', { collection: 'characters', id: 'H2' }, bible).then((r) => {
        done.push(2);
        return r;
      });
      await vi.waitFor(() => expect(steps).toEqual(['start']));
      await new Promise((r) => setTimeout(r, 100));
      expect(steps).toEqual(['start']);
      open();
      const [a, b] = await Promise.all([first, second]);
      expect(steps).toEqual(['start', 'end', 'start', 'end']);
      expect(done).toEqual([1, 2]);
      expect(((await ok(a)).result as { entry: { _id: string } }).entry._id).toBe('H1');
      expect(((await ok(b)).result as { entry: { _id: string } }).entry._id).toBe('H2');
    } finally {
      freshenImpl = async () => ({ moved: false });
    }
  });

  test('PH-7 freshen runs after the asked bible is open and before the handler, so a desk write is seen', async () => {
    const first = await fixture('ph7-a');
    const second = await fixture('ph7-b');
    freshenSaw.length = 0;
    await ok(await call('bible.current', {}, first));
    await ok(await call('bible.current', {}, second));
    expect(freshenSaw).toEqual([first, second]);
    // A write from the desk lands behind the function's read model; the fake freshen reloads it.
    freshenImpl = async () => {
      const session = openSession()!;
      await session.handle
        .collection('characters')
        .updateOne({ _id: 'H1' } as never, { $set: { backstory: 'Written on the Mac.' } });
      await reloadSession(session, 'Changed on the Mac.');
      return { moved: true };
    };
    try {
      const body = await ok(
        await call('entry.get', { collection: 'characters', id: 'H1' }, second),
      );
      expect((body.result as { entry: { backstory: string } }).entry.backstory).toBe(
        'Written on the Mac.',
      );
      // The function's own reload is not this request's event; the phone follows `rev` (PH-9).
      expect(body.events).toEqual([]);
    } finally {
      freshenImpl = async () => ({ moved: false });
    }
  });
});

describe('PH-19 the function never migrates', () => {
  async function atVersion(prefix: string, version: number) {
    const bible = await fixture(prefix);
    await store.db.collection('bibles').updateOne({ _id: bible } as never, {
      $set: { schemaVersion: version },
    });
    return bible;
  }

  async function unchanged(bible: string, version: number, story: string | undefined) {
    const record = (await listBibles(store)).find((b) => b._id === bible);
    expect(record?.schemaVersion).toBe(version);
    expect(await backstory(bible)).toBe(story);
    expect(await phoneSnapshotCount(bible)).toBe(0);
  }

  test('PH-19 a bible older than the function answers "Open <name> on the Mac once." and nothing is written', async () => {
    const bible = await atVersion('ph19-old', LATEST_SCHEMA_VERSION - 1);
    const story = await backstory(bible);
    const res = await call(
      'entry.update',
      { collection: 'characters', id: 'H1', patch: { backstory: 'Never.' } },
      bible,
      { bible },
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'Open Fixture novel on the Mac once.',
      code: 'older',
    });
    expectHeaders(res);
    expect(openSession()?.handle.id).not.toBe(bible);
    await unchanged(bible, LATEST_SCHEMA_VERSION - 1, story);
  });

  test('PH-19 a bible newer than the function answers "The phone app is updating." and nothing is written', async () => {
    const bible = await atVersion('ph19-new', LATEST_SCHEMA_VERSION + 1);
    const story = await backstory(bible);
    const res = await call(
      'entry.update',
      { collection: 'characters', id: 'H1', patch: { backstory: 'Never.' } },
      bible,
      { bible },
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'The phone app is updating.', code: 'newer' });
    await unchanged(bible, LATEST_SCHEMA_VERSION + 1, story);
  });

  test('PH-19 a bible the desk migrated after the function opened it is refused on the next request', async () => {
    const bible = await fixture('ph19-later');
    await ok(await call('entry.get', { collection: 'characters', id: 'H1' }, bible));
    await store.db.collection('bibles').updateOne({ _id: bible } as never, {
      $set: { schemaVersion: LATEST_SCHEMA_VERSION + 1 },
    });
    const story = await backstory(bible);
    const res = await call(
      'entry.update',
      { collection: 'characters', id: 'H1', patch: { backstory: 'Never.' } },
      bible,
      { bible },
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as RpcError).code).toBe('newer');
    await unchanged(bible, LATEST_SCHEMA_VERSION + 1, story);
  });

  test('PH-19 a write with no bible named is refused, so a bible the desk migrated is never written through an earlier open', async () => {
    const bible = await fixture('ph19-null');
    await ok(await call('entry.get', { collection: 'characters', id: 'H1' }, bible));
    await store.db.collection('bibles').updateOne({ _id: bible } as never, {
      $set: { schemaVersion: LATEST_SCHEMA_VERSION + 1 },
    });
    const story = await backstory(bible);
    const patch = { collection: 'characters', id: 'H1', patch: { backstory: 'Never.' } } as const;
    for (const res of [
      await call('entry.update', patch, null),
      await call('entry.update', patch, null, { bible }),
    ]) {
      expect(res.status).toBe(422);
      expect(((await res.json()) as RpcError).error).toBe(NO_BIBLE_MESSAGE);
    }
    // A read with no bible named is refused too: nothing from an earlier open is reachable.
    const read = await call('entry.get', { collection: 'characters', id: 'H1' }, null);
    expect(read.status).toBe(422);
    expect(((await read.json()) as RpcError).error).toBe(NO_BIBLE_MESSAGE);
    await unchanged(bible, LATEST_SCHEMA_VERSION + 1, story);
  });
});

describe('PH-18 the chooser needs no bible; everything else names one', () => {
  test('PH-18 the bible-free channels answer with bible null and take no snapshot or freshen', async () => {
    const bible = await fixture('ph18-free');
    await ok(await call('entry.get', { collection: 'characters', id: 'H1' }, bible));
    freshenSaw.length = 0;
    const list = await ok(await call('bible.list', {}, null));
    expect((list.result as { bibles: { id: string }[] }).bibles.map((b) => b.id)).toContain(bible);
    await ok(await call('app.ping', { message: 'hi' }, null));
    expect(freshenSaw).toEqual([]);
    for (const channel of BIBLE_FREE_CHANNELS) {
      expect(PHONE_CHANNELS as readonly string[]).toContain(channel);
    }
  });

  test('PH-18 a write must carry the bible it was made in, the same one the request names', async () => {
    const bible = await fixture('ph18-ctx');
    const story = await backstory(bible);
    const res = await call(
      'entry.update',
      { collection: 'characters', id: 'H1', patch: { backstory: 'No context.' } },
      bible,
    );
    expect(res.status).toBe(422);
    expect(((await res.json()) as RpcError).error).toMatch(/no longer open/);
    expect(await backstory(bible)).toBe(story);
    expect(await phoneSnapshotCount(bible)).toBe(0);
  });
});

describe('PH-23 a daily phone snapshot', () => {
  const edit = (bible: string, text: string) =>
    call(
      'entry.update',
      { collection: 'characters', id: 'H1', patch: { backstory: text } },
      bible,
      { bible },
    );

  test('PH-23 the first phone write of a UTC day takes one snapshot; reads and later writes that day take none', async () => {
    const bible = await fixture('ph23-day');
    clock = new Date('2026-11-27T00:00:05.000Z');
    await ok(await call('entry.list', { collection: 'characters' }, bible));
    expect(await phoneSnapshotCount(bible)).toBe(0);
    await ok(await edit(bible, 'First of the day.'));
    expect(await phoneSnapshotCount(bible)).toBe(1);
    clock = new Date('2026-11-27T23:59:00.000Z');
    await ok(await edit(bible, 'Second of the day.'));
    await ok(await call('entry.get', { collection: 'characters', id: 'H1' }, bible));
    expect(await phoneSnapshotCount(bible)).toBe(1);
    clock = new Date('2026-11-28T00:01:00.000Z');
    await ok(await edit(bible, 'Next day.'));
    const list = await listPhoneSnapshots(await openBible(store, bible));
    expect(list.map((s) => [s.day, s.reason])).toEqual([
      ['2026-11-28', 'daily'],
      ['2026-11-27', 'daily'],
    ]);
    expect(list[1]!.counts.characters).toBeGreaterThan(5);
    expect(list[1]!.schemaVersion).toBe(LATEST_SCHEMA_VERSION);

    // The restore script's path (BK-2): the snapshot from before the first write comes back.
    const handle = await openBible(store, bible);
    const { safety } = await restorePhoneSnapshot(handle, list[1]!._id, clock);
    expect(await backstory(bible)).toBe(
      'A schoolteacher who kept every letter the family ever sent.',
    );
    expect(safety.reason).toBe('restore');
    expect((await listPhoneSnapshots(handle)).map((s) => s._id)).toContain(safety._id);
  });

  test('PH-23 the newest 14 phone snapshots of a bible are kept', async () => {
    const bible = await fixture('ph23-keep');
    const other = await fixture('ph23-keep-other');
    const old = Array.from({ length: PHONE_SNAPSHOT_KEEP }, (_, i) => {
      const day = `2026-10-${String(i + 1).padStart(2, '0')}`;
      return {
        _id: `01OLD${String(i).padStart(21, '0')}`,
        bible,
        name: 'Fixture novel',
        day,
        takenAt: `${day}T08:00:00.000Z`,
        reason: 'daily',
        schemaVersion: LATEST_SCHEMA_VERSION,
        counts: {},
        data: new Binary(Buffer.from('')),
      };
    });
    await store.db.collection(PHONE_SNAPSHOTS).insertMany(old as never[]);
    await store.db
      .collection(PHONE_SNAPSHOTS)
      .insertOne({ ...old[0]!, _id: '01OTHERBIBLE0000000000000', bible: other } as never);
    clock = new Date('2026-11-27T12:00:00.000Z');
    await ok(await edit(bible, 'Fifteenth.'));
    const list = await listPhoneSnapshots(await openBible(store, bible));
    expect(list).toHaveLength(PHONE_SNAPSHOT_KEEP);
    expect(list[0]!.day).toBe('2026-11-27');
    expect(list.map((s) => s.day)).not.toContain('2026-10-01');
    expect(list.at(-1)!.day).toBe('2026-10-02');
    // Another bible's snapshots are its own.
    expect(await phoneSnapshotCount(other)).toBe(1);
  });
});

describe('A58 serve-web mounts the same handler', () => {
  test('PH-7 PH-14 the local server serves /rpc through the same queue and the web build with noindex', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nc-web-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Novel Companion</title>');
    const server = webServer({ rpc, staticDir: dir });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const bible = await fixture('serve-web');
      const res = await fetch(`${base}/rpc`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channel: 'entry.get',
          request: { collection: 'characters', id: 'H1' },
          bible,
        }),
      });
      expectHeaders(res);
      expect(((await ok(res)).result as { entry: { title: string } }).entry.title).toBe(
        'Margaret Hale',
      );
      expect((await fetch(`${base}/rpc`, { method: 'POST', body: '{}' })).status).toBe(401);
      const shell = await fetch(`${base}/people/H1`);
      expect(shell.status).toBe(200);
      expect(shell.headers.get('x-robots-tag')).toBe('noindex');
      expect(await shell.text()).toContain('Novel Companion');
    } finally {
      await new Promise((r) => server.close(r));
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
