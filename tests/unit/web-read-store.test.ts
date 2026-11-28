import { describe, expect, test, vi } from 'vitest';
import { ReadStore, answerKey, indexedDbBackend, stableJson } from '../../src/web/readStore';
import type { AnswerMeta, BibleMark, IdbFactory, ReadBackend } from '../../src/web/readStore';
import {
  KEY_REFUSED,
  KEY_STORAGE,
  NOT_STORED,
  NO_CONNECTION,
  OFFLINE_READ_ONLY,
  OFFLINE_WRITE,
  READ_TIMEOUT_MS,
  REFRESH_QUIET_MS,
  WebTransport,
} from '../../src/web/transport';

/** A58 L1 (PH-25): the phone's store of what it read, and the transport serving from it. */

/** The store's records in maps, standing in for IndexedDB. */
function memoryBackend() {
  const metas = new Map<string, AnswerMeta>();
  const values = new Map<string, string>();
  const bibles = new Map<string, BibleMark>();
  const backend: ReadBackend = {
    load: async () => ({ metas: [...metas.values()], bibles: [...bibles.values()] }),
    value: async (k) => values.get(k),
    put: async (m, v) => {
      metas.set(m.key, m);
      values.set(m.key, v);
    },
    remove: async (keys) => {
      for (const k of keys) {
        metas.delete(k);
        values.delete(k);
      }
    },
    mark: async (m) => void bibles.set(m.bible, m),
    clear: async () => {
      metas.clear();
      values.clear();
      bibles.clear();
    },
  };
  return { backend, metas, values, bibles };
}

const Q = (query: string) => ({ query, limit: 20 });

describe('PH-25 the read store', () => {
  test('PH-25 an answer is keyed by bible, channel and the request in a stable order', async () => {
    expect(stableJson({ b: 1, a: { d: 2, c: [3, { f: 1, e: 0 }] } })).toBe(
      '{"a":{"c":[3,{"e":0,"f":1}],"d":2},"b":1}',
    );
    expect(answerKey('east', 'search.query', { limit: 20, query: 'x' })).toBe(
      answerKey('east', 'search.query', { query: 'x', limit: 20 }),
    );
    const { backend } = memoryBackend();
    const store = new ReadStore(backend);
    await store.put('east', 'search.query', Q('ruth'), { hits: [1] }, 4);
    await store.put('west', 'search.query', Q('ruth'), { hits: [2] }, 9);
    expect((await store.get('east', 'search.query', { limit: 20, query: 'ruth' }))?.value).toEqual({
      hits: [1],
    });
    // Each bible keeps its own answers.
    expect((await store.get('west', 'search.query', Q('ruth')))?.value).toEqual({ hits: [2] });
    expect(await store.get('east', 'search.query', Q('hale'))).toBeNull();
    expect(await store.get('east', 'entry.list', Q('ruth'))).toBeNull();
  });

  test('PH-25 a live answer replaces the stored one, and the store reopens with what it kept', async () => {
    const mem = memoryBackend();
    let clock = 10;
    const store = new ReadStore(mem.backend, undefined, () => clock);
    await store.put('east', 'tree.get', {}, { v: 1 }, 3);
    clock = 20;
    await store.put('east', 'tree.get', {}, { v: 2 }, 3);
    expect(await store.get('east', 'tree.get', {})).toEqual({
      value: { v: 2 },
      rev: 3,
      at: 20,
      stale: false,
      current: 3,
    });
    expect(store.size.answers).toBe(1);
    expect(store.size.chars).toBe(JSON.stringify({ v: 2 }).length);
    const again = new ReadStore(mem.backend);
    expect(await again.ready()).toBe(true);
    expect((await again.get('east', 'tree.get', {}))?.value).toEqual({ v: 2 });
    expect(again.size.answers).toBe(1);
  });

  test('PH-25 an answer over the limit is not kept, and a full store lets the oldest go first', async () => {
    const mem = memoryBackend();
    let clock = 0;
    const store = new ReadStore(mem.backend, { answer: 30, store: 60 }, () => (clock += 1));
    await store.put('east', 'entry.get', { id: 'big' }, { text: 'x' }, 1);
    // Grown past the limit: the stored answer goes rather than stay stale.
    await store.put('east', 'entry.get', { id: 'big' }, { text: 'x'.repeat(40) }, 1);
    expect(await store.get('east', 'entry.get', { id: 'big' })).toBeNull();
    for (const id of ['a', 'b', 'c', 'd']) {
      await store.put('east', 'entry.get', { id }, { text: 'y'.repeat(10) }, 1);
    }
    // Each answer is 21 characters, so only two fit in 60.
    expect(await store.get('east', 'entry.get', { id: 'a' })).toBeNull();
    expect(await store.get('east', 'entry.get', { id: 'b' })).toBeNull();
    expect(await store.get('east', 'entry.get', { id: 'c' })).not.toBeNull();
    expect(await store.get('east', 'entry.get', { id: 'd' })).not.toBeNull();
    expect(store.size).toEqual({ answers: 2, chars: 42 });
    expect(mem.values.size).toBe(2);
  });

  test('PH-25 a change made elsewhere flags what was read before it and keeps it; the phone`s own write flags nothing there', async () => {
    const mem = memoryBackend();
    const store = new ReadStore(mem.backend);
    await store.observe('east', 5, 5);
    await store.put('east', 'tree.get', {}, { v: 'tree' }, 5);
    await store.put('east', 'outline.get', {}, { v: 'outline' }, 5);
    await store.put('west', 'tree.get', {}, { v: 'west' }, 2);
    await store.put('', 'bible.list', {}, { v: 'list' }, null);
    // The phone's own write: 5 to 6.
    await store.observe('east', 5, 6);
    expect((await store.get('east', 'tree.get', {}))?.stale).toBe(false);
    await store.observe('east', 6, 6);
    expect((await store.get('east', 'tree.get', {}))?.stale).toBe(false);
    // The desk wrote twice meanwhile: the phone sees 8 before its read.
    await store.observe('east', 8, 8);
    // Kept, flagged, and shown as read at 5, so back online the change is told apart.
    expect(await store.get('east', 'tree.get', {})).toMatchObject({
      value: { v: 'tree' },
      stale: true,
      current: 5,
    });
    expect((await store.get('east', 'outline.get', {}))?.stale).toBe(true);
    expect((await store.flagged('east')).map((r) => r.channel).sort()).toEqual([
      'outline.get',
      'tree.get',
    ]);
    // Other bibles and the bible list are not flagged.
    expect((await store.get('west', 'tree.get', {}))?.stale).toBe(false);
    expect((await store.get('', 'bible.list', {}))?.stale).toBe(false);
    // A read answered before the change, arriving late, never replaces a newer answer.
    await store.put('east', 'tree.get', {}, { v: 'fresh' }, 8);
    await store.put('east', 'tree.get', {}, { v: 'late' }, 6);
    expect(await store.get('east', 'tree.get', {})).toMatchObject({
      value: { v: 'fresh' },
      stale: false,
    });
    expect(mem.bibles.get('east')).toEqual({ bible: 'east', rev: 8, floor: 8, stale: 8 });
    expect(store.size.answers).toBe(4);
  });

  test("PH-25 the phone's own write keeps every answer, flags those read before it, and keeps what its own answer holds at once", async () => {
    const mem = memoryBackend();
    let clock = 0;
    const store = new ReadStore(mem.backend, undefined, () => (clock += 1));
    await store.observe('east', 3, 3);
    await store.put('east', 'bible.current', {}, { bible: EAST }, 3);
    await store.put('east', 'outline.get', {}, { v: 'outline' }, 3);
    await store.put('east', 'settings.get', {}, { v: 'settings' }, 3);
    for (let i = 0; i < 69; i++) {
      await store.put('east', 'entry.get', { collection: 'characters', id: `H${i}` }, { i }, 3);
    }
    await store.put('west', 'outline.get', {}, { v: 'west' }, 3);
    expect(store.size.answers).toBe(73);
    const h4 = { collection: 'characters', id: 'H4' };
    await store.wrote('east', 4, [{ channel: 'entry.get', request: h4, value: { i: 'edited' } }]);
    // The transport hands over the write's own `rev` headers once it answered.
    await store.observe('east', 3, 4);
    // Nothing went: 72 of East Winds and one of West.
    expect(store.size.answers).toBe(73);
    expect(await store.get('east', 'entry.get', h4)).toMatchObject({
      value: { i: 'edited' },
      rev: 4,
      stale: false,
    });
    for (const channel of ['bible.current', 'outline.get', 'settings.get']) {
      // Read before the write: kept, flagged, and as good as current (only the phone wrote since).
      expect(await store.get('east', channel, {})).toMatchObject({ stale: true, current: 4 });
    }
    const flagged = await store.flagged('east');
    expect(flagged).toHaveLength(71);
    // The most recently stored first.
    expect(flagged[0]).toMatchObject({
      channel: 'entry.get',
      request: { collection: 'characters', id: 'H68' },
    });
    expect(flagged.at(-1)?.channel).toBe('bible.current');
    expect(await store.flagged('west')).toEqual([]);
    // An entry read before the write, answered late, does not replace the write's own answer.
    await store.put('east', 'entry.get', h4, { i: 'late' }, 3);
    expect((await store.get('east', 'entry.get', h4))?.value).toEqual({ i: 'edited' });
    // Read again after the write: no longer flagged.
    await store.put('east', 'outline.get', {}, { v: 'outline 2' }, 4);
    expect(await store.get('east', 'outline.get', {})).toMatchObject({ stale: false });
    expect(await store.flagged('east')).toHaveLength(70);
  });

  test('PH-25 the flags live in the store: they survive a reopen, and a store written before them opens with its answers', async () => {
    const mem = memoryBackend();
    const store = new ReadStore(mem.backend);
    await store.observe('east', 3, 3);
    await store.put('east', 'outline.get', {}, { v: 'outline' }, 3);
    await store.wrote('east', 4);
    await store.observe('east', 3, 4);
    const again = new ReadStore(mem.backend);
    expect((await again.flagged('east')).map((r) => r.channel)).toEqual(['outline.get']);
    expect(await again.get('east', 'outline.get', {})).toMatchObject({ stale: true, current: 4 });

    // The layout as the last build wrote it: a mark with no `stale`.
    const old = memoryBackend();
    const key = answerKey('east', 'outline.get', {});
    await old.backend.put(
      { key, bible: 'east', channel: 'outline.get', rev: 5, at: 1, size: 14 },
      JSON.stringify({ v: 'outline' }),
    );
    const key2 = answerKey('east', 'tree.get', {});
    await old.backend.put(
      { key: key2, bible: 'east', channel: 'tree.get', rev: 7, at: 2, size: 11 },
      JSON.stringify({ v: 'tree' }),
    );
    old.bibles.set('east', { bible: 'east', rev: 7, floor: 6 } as BibleMark);
    const opened = new ReadStore(old.backend);
    expect(await opened.ready()).toBe(true);
    expect(await opened.get('east', 'outline.get', {})).toMatchObject({
      value: { v: 'outline' },
      stale: true,
      current: 5,
    });
    expect(await opened.get('east', 'tree.get', {})).toMatchObject({ stale: false, current: 7 });
  });

  test('PH-25 clear empties every part of the store', async () => {
    const mem = memoryBackend();
    const store = new ReadStore(mem.backend);
    await store.observe('east', 1, 1);
    await store.put('east', 'tree.get', {}, { v: 1 }, 1);
    await store.clear();
    expect(await store.get('east', 'tree.get', {})).toBeNull();
    expect(store.size).toEqual({ answers: 0, chars: 0 });
    expect([mem.metas.size, mem.values.size, mem.bibles.size]).toEqual([0, 0, 0]);
  });

  test('PH-25 a store that throws, or IndexedDB that will not open, never throws: it keeps nothing', async () => {
    const broken: ReadBackend = {
      load: () => Promise.reject(new Error('SecurityError')),
      value: () => Promise.reject(new Error('no')),
      put: () => Promise.reject(new Error('no')),
      remove: () => Promise.reject(new Error('no')),
      mark: () => Promise.reject(new Error('no')),
      clear: () => Promise.reject(new Error('no')),
    };
    const store = new ReadStore(broken);
    expect(await store.ready()).toBe(false);
    await store.put('east', 'tree.get', {}, { v: 1 }, 1);
    await store.observe('east', 1, 1);
    expect(await store.get('east', 'tree.get', {})).toBeNull();
    await store.clear();

    // Opened, but every later call fails: nothing reaches the caller.
    const mem = memoryBackend();
    const flaky = new ReadStore({
      ...mem.backend,
      put: () => Promise.reject(new Error('QuotaExceededError')),
      value: () => Promise.reject(new Error('gone')),
    });
    expect(await flaky.ready()).toBe(true);
    await expect(flaky.put('east', 'tree.get', {}, { v: 1 }, 1)).resolves.toBeUndefined();
    expect(await flaky.get('east', 'tree.get', {})).toBeNull();

    // Private browsing: `open` throws, or its request fails.
    const throwing: IdbFactory = {
      open: () => {
        throw new DOMException('The operation is insecure.', 'SecurityError');
      },
      deleteDatabase: () => {
        throw new Error('no');
      },
    };
    expect(await new ReadStore(indexedDbBackend(throwing)).ready()).toBe(false);
    const failing: IdbFactory = {
      open: () => {
        const req = {
          result: undefined as never,
          error: new DOMException('Blocked', 'InvalidStateError'),
          onsuccess: null,
          onerror: null as null | (() => void),
          onupgradeneeded: null,
          onblocked: null,
        };
        queueMicrotask(() => req.onerror?.());
        return req;
      },
      deleteDatabase: () => {
        throw new Error('no');
      },
    };
    expect(await new ReadStore(indexedDbBackend(failing)).ready()).toBe(false);
    expect(indexedDbBackend(null)).toBeNull();
  });
});

// ---------- the transport over the store ----------

type Answer =
  { status?: number; body: unknown; headers?: Record<string, string> } | 'network-down' | 'hang';

const revs = (bible: string, before: number, after: number) => ({
  'X-NC-Rev-Bible': bible,
  'X-NC-Rev-Before': String(before),
  'X-NC-Rev': String(after),
});
const ok = (result: unknown, headers?: Record<string, string>) => ({
  body: { result, events: [] },
  headers,
});
const EAST = { id: 'east', name: 'East Winds' };
const hits = (title: string) => ({
  hits: [{ collection: 'characters', id: 'H4', title, score: 1, snippet: '' }],
  total: 1,
});

/** A transport over a fake `/rpc` and a store in maps, with the phone on East Winds. */
function rig(reply: (b: Record<string, unknown>) => Answer | Promise<Answer>, store = true) {
  const sent: Record<string, unknown>[] = [];
  const m = new Map<string, string>([
    [KEY_STORAGE, 'k-1'],
    ['nc.phone.bible', 'east'],
  ]);
  const storage = {
    map: m,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    sent.push(body);
    const a = await reply(body);
    if (a === 'network-down') throw new TypeError('Load failed');
    if (a === 'hang') {
      return await new Promise<Response>((_res, rej) => {
        init?.signal?.addEventListener('abort', () => rej(new DOMException('', 'AbortError')));
      });
    }
    return new Response(JSON.stringify(a.body), {
      status: a.status ?? 200,
      headers: { 'Content-Type': 'application/json', 'X-NC-Build': 'b-1', ...a.headers },
    });
  });
  const mem = memoryBackend();
  const reads = store ? new ReadStore(mem.backend) : undefined;
  const t = new WebTransport({
    fetch: fetch as unknown as typeof globalThis.fetch,
    storage,
    buildId: 'b-1',
    ...(reads ? { reads } : {}),
  });
  const states: string[] = [];
  t.on('connection.changed', (s) => states.push(s.state));
  return { t, sent, mem, reads, states, storage };
}

describe('PH-25 the transport reads from the store without a connection', () => {
  test('PH-25 a bible opened from the chooser is read once under its own name, so a launch with no connection reopens it', async () => {
    let down = false;
    const { t, storage } = rig((b) => {
      if (down) return 'network-down';
      if (b.channel === 'bible.open') return ok({ bible: EAST });
      return ok({ bible: b.bible === 'east' ? EAST : null }, revs('east', 3, 3));
    });
    storage.map.delete('nc.phone.bible');
    await t.invoke('bible.open', { slug: 'east' });
    await t.readsSettled();
    down = true;
    expect(await t.invoke('bible.current', {})).toEqual({ bible: EAST });
  });

  test('PH-25 a read visited before is served read-only, an unvisited one fails in plain words, and writes are refused here', async () => {
    let down = false;
    let rev = 3;
    const { t, sent, reads, states } = rig((b) => {
      if (down) return 'network-down';
      if (b.channel === 'search.query') {
        const { query } = b.request as { query: string };
        return ok(hits(`Hit for ${query}`), revs('east', rev, rev));
      }
      if (b.channel === 'bible.current') return ok({ bible: EAST }, revs('east', rev, rev));
      return ok({ entry: {}, warnings: [] }, revs('east', rev, ++rev));
    });
    await t.invoke('search.query', { query: 'ruth' });
    await t.invoke('bible.current', {});
    await reads!.settled();

    down = true;
    expect(await t.invoke('search.query', { query: 'ruth' })).toEqual(hits('Hit for ruth'));
    expect(await t.invoke('connection.status', {})).toEqual({
      state: 'readOnly',
      message: OFFLINE_READ_ONLY,
      snapshot: null,
    });
    await expect(t.invoke('search.query', { query: 'hale' })).rejects.toMatchObject({
      message: NOT_STORED,
    });
    const before = sent.length;
    await expect(
      t.invoke(
        'entry.update',
        { collection: 'characters', id: 'H4', patch: { role: 'x' } },
        { bible: 'east' },
      ),
    ).rejects.toMatchObject({ message: OFFLINE_WRITE });
    // Refused on the phone: nothing went out.
    expect(sent.length).toBe(before);
    expect(states).toEqual(['readOnly']);
  });

  test('PH-25 back online the banner clears, the freshness check runs, and a change made meanwhile reloads every view', async () => {
    let down = false;
    let rev = 3;
    const { t, sent, reads, states } = rig((b) => {
      if (down) return 'network-down';
      if (b.channel === 'bible.changes') return ok({ changes: [] });
      if (b.channel === 'bible.list') return ok({ connection: 'connected', bibles: [EAST] });
      if (b.channel === 'bible.current') return ok({ bible: EAST }, revs('east', rev, rev));
      return ok(hits(`rev ${rev}`), revs('east', rev, rev));
    });
    await t.invoke('search.query', { query: 'ruth' });
    await reads!.settled();
    down = true;
    await t.invoke('search.query', { query: 'ruth' });
    // The desk writes while the phone is away.
    rev = 7;
    down = false;
    const reloaded = vi.fn();
    t.on('bible.reloaded', reloaded);
    const status = await t.invoke('connection.retry', {});
    expect(status.state).toBe('connected');
    expect(states).toEqual(['readOnly', 'connected']);
    await vi.waitFor(() => expect(reloaded).toHaveBeenCalled());
    expect(sent.map((b) => b.channel)).toContain('bible.current');
    await reads!.settled();
    // The answer read before the change is kept, flagged, for reading offline until it is read again.
    expect(await reads!.get('east', 'search.query', Q('ruth'))).toMatchObject({
      value: hits('rev 3'),
      stale: true,
    });
    expect(await t.invoke('search.query', { query: 'ruth' })).toEqual(hits('rev 7'));
    await reads!.settled();
    expect((await reads!.get('east', 'search.query', Q('ruth')))?.value).toEqual(hits('rev 7'));
  });

  test('PH-25 a launch with no connection serves the bible used last, and a change made meanwhile still reloads views', async () => {
    let down = false;
    let rev = 2;
    const first = rig((b) => {
      if (down) return 'network-down';
      if (b.channel === 'bible.current') return ok({ bible: EAST }, revs('east', rev, rev));
      if (b.channel === 'bible.changes') return ok({ changes: [] });
      return ok(hits('x'), revs('east', rev, rev));
    });
    await first.t.invoke('bible.current', {});
    await first.t.invoke('search.query', { query: 'ruth' });
    await first.reads!.settled();
    // A new launch of the app on the same store, offline.
    down = true;
    const t = new WebTransport({
      fetch: first.t['deps'].fetch,
      storage: first.storage,
      buildId: 'b-1',
      reads: new ReadStore(first.mem.backend),
    });
    expect(await t.invoke('bible.current', {})).toEqual({ bible: EAST });
    expect(await t.invoke('search.query', { query: 'ruth' })).toEqual(hits('x'));
    const reloaded = vi.fn();
    t.on('bible.reloaded', reloaded);
    rev = 5;
    down = false;
    await t.invoke('connection.retry', {});
    await vi.waitFor(() => expect(reloaded).toHaveBeenCalled());
  });

  test('PH-25 a read that hangs counts as no connection; an answer from the function is never replaced by the store', async () => {
    vi.useFakeTimers();
    try {
      let answer: Answer = ok(hits('live'), revs('east', 1, 1));
      const { t, reads } = rig(() => answer);
      await t.invoke('search.query', { query: 'ruth' });
      await reads!.settled();
      answer = { status: 500, body: { error: 'Something broke.', code: 'refused' } };
      await expect(t.invoke('search.query', { query: 'ruth' })).rejects.toMatchObject({
        message: 'Something broke.',
      });
      expect((await t.invoke('connection.status', {})).state).toBe('connected');
      answer = 'hang';
      const served = t.invoke('search.query', { query: 'ruth' });
      await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS);
      expect(await served).toEqual(hits('live'));
      expect((await t.invoke('connection.status', {})).state).toBe('readOnly');
    } finally {
      vi.useRealTimers();
    }
  });

  test('PH-25 with no store (private browsing) a lost connection is the banner as before L1', async () => {
    const { t, states } = rig(() => 'network-down', false);
    await expect(t.invoke('search.query', { query: 'ruth' })).rejects.toMatchObject({
      message: NO_CONNECTION,
    });
    expect(await t.invoke('connection.status', {})).toEqual({
      state: 'unavailable',
      message: NO_CONNECTION,
      snapshot: null,
    });
    expect(states).toEqual(['unavailable']);
  });

  test('PH-25 PH-17 a refused key, sign-out or another key clears the store', async () => {
    let answer: Answer = ok(hits('x'), revs('east', 1, 1));
    const { t, reads, mem } = rig((b) =>
      b.channel === 'bible.list' ? ok({ connection: 'connected', bibles: [EAST] }) : answer,
    );
    await t.invoke('search.query', { query: 'ruth' });
    await reads!.settled();
    expect(mem.values.size).toBe(1);
    answer = { status: 401, body: { error: KEY_REFUSED, code: 'key' } };
    await expect(t.invoke('search.query', { query: 'ruth' })).rejects.toMatchObject({
      code: 'key',
    });
    await reads!.settled();
    expect([mem.metas.size, mem.values.size, mem.bibles.size]).toEqual([0, 0, 0]);

    // Signed in again with the same key: kept again. Another key: cleared first.
    answer = ok(hits('x'), revs('east', 1, 1));
    await t.signIn('k-1');
    await t.invoke('search.query', { query: 'ruth' });
    await reads!.settled();
    expect(mem.values.size).toBe(1);
    await t.signIn('k-1');
    await reads!.settled();
    // The same key: the search stays, beside the bible list it read.
    expect(mem.values.size).toBe(2);
    await t.signIn('k-2');
    await reads!.settled();
    expect(mem.values.size).toBe(0);
    await t.invoke('search.query', { query: 'ruth' });
    t.signOut();
    await reads!.settled();
    expect(mem.values.size).toBe(0);
  });
});

// ---------- the phone's own writes and the background refresh ----------

/**
 * The function as the phone sees it while visiting East Winds: 72 reads to
 * keep (the bible, the Outline, the community notes, 60 people, 9 searches),
 * `entry.update` and `community.notes.set` answering with what they wrote, and
 * a hook to hold any one answer back.
 */
function visitRig() {
  const fn = {
    rev: 3,
    down: false,
    roles: {} as Record<string, string>,
    notes: { c1: 'Fishing families' } as Record<string, string>,
    /** Answers held back until `release` (for the requests `hold` picks). */
    hold: null as ((b: Record<string, unknown>) => boolean) | null,
    held: [] as {
      body: Record<string, unknown>;
      /** Run the request on the function now and answer it. */
      release: () => void;
      /** Run it on the function now; its answer arrives when `deliver` is called. */
      commit: () => { deliver: () => void };
    }[],
    onRead: null as ((b: Record<string, unknown>, n: number) => void) | null,
    reads: 0,
  };
  const entry = (id: string) => ({
    entry: { _id: id, modifiedAt: '2026-11-27T00:00:00Z', role: fn.roles[id] ?? '' },
    warnings: [],
  });
  const answer = (b: Record<string, unknown>): Answer => {
    if (fn.down) return 'network-down';
    const r = b.request as Record<string, unknown>;
    const at = revs('east', fn.rev, fn.rev);
    switch (b.channel) {
      case 'entry.update': {
        fn.roles[r.id as string] = (r.patch as { role: string }).role;
        return ok(entry(r.id as string), revs('east', fn.rev, ++fn.rev));
      }
      case 'community.notes.set':
        fn.notes[r.communityId as string] = r.text as string;
        return ok({ notes: { ...fn.notes } }, revs('east', fn.rev, ++fn.rev));
      case 'bible.list':
        return ok({ connection: 'connected', bibles: [EAST] });
      case 'bible.changes':
        return ok({ changes: [] });
      case 'bible.current':
        return ok({ bible: EAST }, at);
      case 'outline.get':
        return ok({ order: 'reading', years: [], cursorYear: fn.rev, rows: [] }, at);
      case 'community.notes.get':
        return ok({ notes: { ...fn.notes } }, at);
      case 'entry.get':
        return ok(entry(r.id as string), at);
      default:
        return ok(hits(`rev ${fn.rev} ${String(r.query)}`), at);
    }
  };
  const r = rig((b) => {
    if (!String(b.channel).match(/\.(update|set)$/) && b.channel !== 'bible.list') {
      fn.reads++;
      fn.onRead?.(b, fn.reads);
    }
    if (fn.hold?.(b)) {
      return new Promise<Answer>((resolve) => {
        fn.held.push({
          body: b,
          release: () => resolve(answer(b)),
          commit: () => {
            const a = answer(b);
            return { deliver: () => resolve(a) };
          },
        });
      });
    }
    return answer(b);
  });
  const people = Array.from({ length: 60 }, (_v, i) => ({
    collection: 'characters' as const,
    id: `H${i}`,
  }));
  const queries = ['ruth', 'hale', 'peter', 'zhou', 'lan', 'margaret', 'daniel', 'okafor', 'sea'];
  async function visitAll() {
    await r.t.invoke('bible.current', {});
    await r.t.invoke('outline.get', {});
    await r.t.invoke('community.notes.get', {});
    for (const p of people) await r.t.invoke('entry.get', p);
    for (const q of queries) await r.t.invoke('search.query', { query: q });
    await r.t.readsSettled();
  }
  const write = (id: string, role: string) =>
    r.t.invoke(
      'entry.update',
      { collection: 'characters', id, patch: { role } },
      { bible: 'east' },
    );
  /** Requests sent from `from` on that read (not writes, not Try again). */
  const readsSince = (from: number) =>
    r.sent
      .slice(from)
      .filter((b) => !String(b.channel).match(/\.(update|set)$/) && b.channel !== 'bible.list');
  return { ...r, fn, people, queries, visitAll, write, readsSince };
}

describe('PH-25 the phone`s own writes keep what it read, and the refresh reads it again when quiet', () => {
  test('PH-25 after one write every screen visited before still reads offline, the edited page shows the edit at once, and a launch offline reopens the bible', async () => {
    vi.useFakeTimers();
    try {
      const v = visitRig();
      await v.visitAll();
      expect(v.reads!.size.answers).toBe(72);
      await v.write('H4', 'Keeps the letters');
      // The connection goes inside the quiet window, before any refresh.
      v.fn.down = true;
      await v.reads!.settled();
      expect(v.reads!.size.answers).toBe(72);
      // The page just edited reads as it did online.
      expect(await v.t.invoke('entry.get', { collection: 'characters', id: 'H4' })).toMatchObject({
        entry: { role: 'Keeps the letters' },
      });
      // Everything else reads as it was read, the Outline and the notes included: never "not stored".
      expect(await v.t.invoke('outline.get', {})).toMatchObject({ cursorYear: 3 });
      expect(await v.t.invoke('community.notes.get', {})).toEqual({
        notes: { c1: 'Fishing families' },
      });
      for (const p of v.people) await expect(v.t.invoke('entry.get', p)).resolves.toBeTruthy();
      for (const q of v.queries) {
        expect(await v.t.invoke('search.query', { query: q })).toEqual(hits(`rev 3 ${q}`));
      }
      expect(await v.t.invoke('bible.current', {})).toEqual({ bible: EAST });

      // The app is opened again, still offline: the bible used last and the edit are there.
      const again = new WebTransport({
        fetch: v.t['deps'].fetch,
        storage: v.storage,
        buildId: 'b-1',
        reads: new ReadStore(v.mem.backend),
      });
      expect(await again.invoke('bible.current', {})).toEqual({ bible: EAST });
      expect(await again.invoke('entry.get', { collection: 'characters', id: 'H4' })).toMatchObject(
        { entry: { role: 'Keeps the letters' } },
      );
      expect(await again.invoke('outline.get', {})).toMatchObject({ cursorYear: 3 });
    } finally {
      vi.useRealTimers();
    }
  });

  test('PH-25 every write channel that answers with what it wrote keeps that as its read at once', async () => {
    vi.useFakeTimers();
    try {
      const v = visitRig();
      await v.visitAll();
      await v.t.invoke(
        'community.notes.set',
        { communityId: 'c1', text: 'Boat builders' },
        { bible: 'east' },
      );
      v.fn.down = true;
      expect(await v.t.invoke('community.notes.get', {})).toEqual({
        notes: { c1: 'Boat builders' },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  test('PH-25 the refresh waits for quiet: one write, ten writes 700 ms apart, and a minute of typing each cost one pass after the last write, one request at a time', async () => {
    vi.useFakeTimers();
    try {
      const v = visitRig();
      await v.visitAll();
      let inFlight = 0;
      let most = 0;
      v.fn.hold = (b) => {
        if (b.channel === 'entry.update') return false;
        // Count reads out at once: each is answered on the next tick.
        inFlight++;
        most = Math.max(most, inFlight);
        return true;
      };
      const pump = setInterval(() => {
        for (const h of v.fn.held.splice(0)) {
          inFlight--;
          h.release();
        }
      }, 1);
      const pass = async (writes: number) => {
        const from = v.sent.length;
        for (let i = 0; i < writes; i++) {
          await v.write('H4', `role ${i}`);
          await vi.advanceTimersByTimeAsync(i === writes - 1 ? REFRESH_QUIET_MS - 1 : 700);
        }
        // Nothing read while typing, nor in the quiet window after it.
        expect(v.readsSince(from)).toEqual([]);
        await vi.advanceTimersByTimeAsync(1);
        for (let i = 0; i < 200 && v.t.refreshPending; i++) await vi.advanceTimersByTimeAsync(5);
        await v.t.readsSettled();
        const read = v.readsSince(from).map((b) => JSON.stringify([b.channel, b.request]));
        // Each kept answer once, the page just written not at all: 71 of 72.
        expect(new Set(read).size).toBe(read.length);
        expect(read).not.toContain(
          JSON.stringify(['entry.get', { collection: 'characters', id: 'H4' }]),
        );
        expect(await v.reads!.flagged('east')).toEqual([]);
        expect(v.reads!.size.answers).toBe(72);
        return read.length;
      };
      expect(await pass(1)).toBe(71);
      expect(await pass(10)).toBe(71);
      // A minute of typing: an autosave every 700 ms.
      expect(await pass(86)).toBe(71);
      expect(most).toBe(1);
      clearInterval(pump);
    } finally {
      vi.useRealTimers();
    }
  }, 30_000);

  test('PH-25 the refresh reads the most recently stored first, stops at once when the app is hidden or the connection drops, and carries on from the flags on reconnect', async () => {
    vi.useFakeTimers();
    try {
      const v = visitRig();
      await v.visitAll();
      await v.write('H4', 'x');
      const from = v.sent.length;
      v.fn.onRead = (_b, n) => {
        if (n === v.fn.reads && v.readsSince(from).length === 3) v.t.hidden();
      };
      await vi.advanceTimersByTimeAsync(REFRESH_QUIET_MS);
      await v.t.readsSettled();
      await vi.advanceTimersByTimeAsync(10 * REFRESH_QUIET_MS);
      // Hidden after the third: nothing more went out.
      const first = v.readsSince(from);
      expect(first).toHaveLength(3);
      // The newest kept first: the last searches.
      expect(first.map((b) => (b.request as { query: string }).query)).toEqual([
        'sea',
        'okafor',
        'daniel',
      ]);
      expect(await v.reads!.flagged('east')).toHaveLength(68);

      // Shown again: it carries on; the connection drops after three more.
      v.fn.onRead = () => {
        if (v.readsSince(from).length === 6) v.fn.down = true;
      };
      v.t.shown();
      await vi.advanceTimersByTimeAsync(REFRESH_QUIET_MS);
      await v.t.readsSettled();
      await vi.advanceTimersByTimeAsync(10 * REFRESH_QUIET_MS);
      // The sixth found no connection: that one failed, nothing went out after it.
      expect(v.readsSince(from)).toHaveLength(6);
      expect((await v.t.invoke('connection.status', {})).state).toBe('readOnly');
      expect(await v.reads!.flagged('east')).toHaveLength(66);
      // Offline, a flagged answer is still served.
      expect(await v.t.invoke('outline.get', {})).toMatchObject({ cursorYear: 3 });

      // Back: Try again, and the rest are read again, once each.
      v.fn.onRead = null;
      v.fn.down = false;
      await v.t.invoke('connection.retry', {});
      await vi.advanceTimersByTimeAsync(REFRESH_QUIET_MS);
      await v.t.readsSettled();
      expect(await v.reads!.flagged('east')).toEqual([]);
      expect(await v.t.invoke('outline.get', {})).toMatchObject({ cursorYear: 4 });
    } finally {
      vi.useRealTimers();
    }
  });

  test('PH-25 the flags survive a launch: a launch offline serves them, and the refresh carries on once the connection is back', async () => {
    vi.useFakeTimers();
    try {
      const v = visitRig();
      await v.visitAll();
      await v.write('H4', 'x');
      v.fn.down = true;
      await v.reads!.settled();
      // iOS ends the app inside the quiet window; it is opened again offline.
      const launch = () =>
        new WebTransport({
          fetch: v.t['deps'].fetch,
          storage: v.storage,
          buildId: 'b-1',
          reads: new ReadStore(v.mem.backend),
        });
      const t = launch();
      expect(await t.invoke('bible.current', {})).toEqual({ bible: EAST });
      expect(await t.invoke('outline.get', {})).toMatchObject({ cursorYear: 3 });
      const from = v.sent.length;
      await vi.advanceTimersByTimeAsync(REFRESH_QUIET_MS);
      await t.readsSettled();
      // Still offline: the pass stops at its first request.
      expect(v.sent.length - from).toBeLessThanOrEqual(1);
      expect((await new ReadStore(v.mem.backend).flagged('east')).length).toBe(71);
      v.fn.down = false;
      await t.invoke('connection.retry', {});
      await vi.advanceTimersByTimeAsync(REFRESH_QUIET_MS);
      for (let i = 0; i < 50 && t.refreshPending; i++) await vi.advanceTimersByTimeAsync(10);
      await t.readsSettled();
      expect(await new ReadStore(v.mem.backend).flagged('east')).toEqual([]);

      // And a launch online carries on by itself.
      const w = visitRig();
      await w.visitAll();
      await w.write('H4', 'x');
      const t2 = new WebTransport({
        fetch: w.t['deps'].fetch,
        storage: w.storage,
        buildId: 'b-1',
        reads: new ReadStore(w.mem.backend),
      });
      await vi.advanceTimersByTimeAsync(REFRESH_QUIET_MS);
      for (let i = 0; i < 50 && t2.refreshPending; i++) await vi.advanceTimersByTimeAsync(10);
      await t2.readsSettled();
      expect(await new ReadStore(w.mem.backend).flagged('east')).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  test('PH-9 PH-25 a refresh or a read answered across the phone`s own write never reloads; a change made elsewhere meanwhile still does', async () => {
    vi.useFakeTimers();
    try {
      for (const kind of ['read', 'refresh'] as const) {
        const v = visitRig();
        await v.visitAll();
        const reloaded = vi.fn();
        v.t.on('bible.reloaded', reloaded);
        // For a refresh: something flagged, so one runs.
        if (kind === 'refresh') {
          await v.write('H4', 'a');
          await vi.advanceTimersByTimeAsync(REFRESH_QUIET_MS - 50);
        }
        v.fn.hold = (b) => b.channel === 'search.query' || b.channel === 'entry.update';
        let read: Promise<unknown> | null = null;
        if (kind === 'refresh') await vi.advanceTimersByTimeAsync(50);
        else read = v.t.invoke('search.query', { query: 'ruth' });
        await vi.waitFor(() => expect(v.fn.held).toHaveLength(1));
        // The phone writes while that read is out.
        const write = v.write('H5', 'b');
        await vi.waitFor(() => expect(v.fn.held).toHaveLength(2));
        const [r, w] = v.fn.held.splice(0);
        // The write commits on the function first, then the read is answered counting it,
        // and only then does the write's own answer arrive.
        const late = w!.commit();
        r!.release();
        if (read) await read;
        await vi.advanceTimersByTimeAsync(0);
        await v.reads!.settled();
        late.deliver();
        await write;
        v.fn.hold = null;
        await v.reads!.settled();
        await vi.advanceTimersByTimeAsync(0);
        expect(reloaded).not.toHaveBeenCalled();
        expect(v.sent.map((b) => b.channel)).not.toContain('bible.changes');
        // Nothing was flagged as changed elsewhere: the Outline is as good as current.
        const top = kind === 'refresh' ? 5 : 4;
        expect(
          await v.reads!.get('east', 'outline.get', { order: 'reading', cursorYear: null }),
        ).toMatchObject({ stale: true, current: top });
      }

      // The desk writes while the phone's write and a read are out: still told apart.
      const v = visitRig();
      await v.visitAll();
      const reloaded = vi.fn();
      v.t.on('bible.reloaded', reloaded);
      v.fn.hold = (b) => b.channel === 'search.query' || b.channel === 'entry.update';
      const read = v.t.invoke('search.query', { query: 'ruth' });
      await vi.waitFor(() => expect(v.fn.held).toHaveLength(1));
      const write = v.write('H5', 'b');
      await vi.waitFor(() => expect(v.fn.held).toHaveLength(2));
      const [r, w] = v.fn.held.splice(0);
      const late = w!.commit(); // 3 to 4, the phone's
      v.fn.rev = 5; // the desk's
      r!.release(); // read at 5
      await read;
      late.deliver();
      await write;
      v.fn.hold = null;
      await vi.waitFor(() => expect(reloaded).toHaveBeenCalledTimes(1));
    } finally {
      vi.useRealTimers();
    }
  });

  test('PH-25 PH-17 a refresh answer landing after sign-out is not kept, and no refresh goes out without a store', async () => {
    vi.useFakeTimers();
    try {
      const v = visitRig();
      await v.visitAll();
      await v.write('H4', 'a');
      v.fn.hold = (b) => b.channel === 'search.query';
      await vi.advanceTimersByTimeAsync(REFRESH_QUIET_MS);
      await vi.waitFor(() => expect(v.fn.held).toHaveLength(1));
      v.t.signOut();
      v.fn.held.splice(0)[0]!.release();
      await v.t.readsSettled();
      await v.reads!.settled();
      expect([v.mem.metas.size, v.mem.values.size, v.mem.bibles.size]).toEqual([0, 0, 0]);
      const before = v.sent.length;
      await vi.advanceTimersByTimeAsync(10 * REFRESH_QUIET_MS);
      expect(v.sent.length).toBe(before);

      // Private browsing: a write is a write, nothing is read again after it.
      const { t, sent } = rig(
        (b) =>
          b.channel === 'entry.update'
            ? ok({ entry: { _id: 'H4', modifiedAt: 'x' }, warnings: [] }, revs('east', 3, 4))
            : ok(hits('x'), revs('east', 4, 4)),
        false,
      );
      await t.invoke('search.query', { query: 'ruth' });
      await t.invoke(
        'entry.update',
        { collection: 'characters', id: 'H4', patch: { role: 'a' } },
        { bible: 'east' },
      );
      await vi.advanceTimersByTimeAsync(10 * REFRESH_QUIET_MS);
      expect(sent.map((b) => b.channel)).toEqual(['search.query', 'entry.update']);
    } finally {
      vi.useRealTimers();
    }
  });
});
