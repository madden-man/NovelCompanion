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
    expect(await store.get('east', 'tree.get', {})).toEqual({ value: { v: 2 }, rev: 3, at: 20 });
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

  test('PH-25 a change made elsewhere drops what was read before it; the phone`s own write drops nothing', async () => {
    const mem = memoryBackend();
    const store = new ReadStore(mem.backend);
    await store.observe('east', 5, 5);
    await store.put('east', 'tree.get', {}, { v: 'tree' }, 5);
    await store.put('east', 'outline.get', {}, { v: 'outline' }, 5);
    await store.put('west', 'tree.get', {}, { v: 'west' }, 2);
    await store.put('', 'bible.list', {}, { v: 'list' }, null);
    // The phone's own write: 5 to 6.
    await store.observe('east', 5, 6);
    expect(await store.get('east', 'tree.get', {})).not.toBeNull();
    await store.observe('east', 6, 6);
    expect(await store.get('east', 'tree.get', {})).not.toBeNull();
    // The desk wrote twice meanwhile: the phone sees 8 before its read.
    await store.observe('east', 8, 8);
    expect(await store.get('east', 'tree.get', {})).toBeNull();
    expect(await store.get('east', 'outline.get', {})).toBeNull();
    // Other bibles and the bible list stay.
    expect(await store.get('west', 'tree.get', {})).not.toBeNull();
    expect(await store.get('', 'bible.list', {})).not.toBeNull();
    // A read answered before the change, arriving late, is not kept.
    await store.put('east', 'tree.get', {}, { v: 'late' }, 6);
    expect(await store.get('east', 'tree.get', {})).toBeNull();
    await store.put('east', 'tree.get', {}, { v: 'fresh' }, 8);
    expect((await store.get('east', 'tree.get', {}))?.value).toEqual({ v: 'fresh' });
    expect(mem.bibles.get('east')).toEqual({ bible: 'east', rev: 8, floor: 8 });
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
function rig(reply: (b: Record<string, unknown>) => Answer, store = true) {
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
    const a = reply(body);
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
  test("PH-25 the phone's own write drops the answers read before it and asks them again, so offline shows the edit", async () => {
    let down = false;
    let rev = 3;
    let title = 'Ruth Hale';
    const { t, sent, reads } = rig((b) => {
      if (down) return 'network-down';
      if (b.channel === 'search.query') {
        const { query } = b.request as { query: string };
        return ok(hits(`${title} ${query}`), revs('east', rev, rev));
      }
      title = 'Ruth Hale-Okafor';
      return ok(
        { entry: { _id: 'H4', modifiedAt: '2026-11-27T00:00:00Z' }, warnings: [] },
        revs('east', rev, ++rev),
      );
    });
    await t.invoke('search.query', { query: 'ruth' });
    await t.invoke('search.query', { query: 'hale' });
    await t.readsSettled();
    await t.invoke(
      'entry.update',
      { collection: 'characters', id: 'H4', patch: { title: 'Ruth Hale-Okafor' } },
      { bible: 'east' },
    );
    await t.readsSettled();
    // Both answers were read again after the write.
    expect(
      sent
        .slice(-2)
        .map((b) => (b.request as { query: string }).query)
        .sort(),
    ).toEqual(['hale', 'ruth']);
    down = true;
    expect(await t.invoke('search.query', { query: 'ruth' })).toEqual(
      hits('Ruth Hale-Okafor ruth'),
    );
    expect(await reads!.has('east', 'search.query', Q('hale'))).toBe(true);
  });

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

  test('PH-25 an answer the phone could not read again after its own write reads as not stored, never as before', async () => {
    const { backend } = memoryBackend();
    const store = new ReadStore(backend);
    await store.put('east', 'search.query', Q('ruth'), hits('Ruth Hale'), 3);
    await store.put('west', 'search.query', Q('ruth'), hits('Ruth Hale'), 3);
    expect(await store.wrote('east', 4)).toEqual([{ channel: 'search.query', request: Q('ruth') }]);
    expect(await store.get('east', 'search.query', Q('ruth'))).toBeNull();
    expect(await store.get('west', 'search.query', Q('ruth'))).not.toBeNull();
    // An answer read before the write and arriving after it is never kept.
    await store.put('east', 'search.query', Q('ruth'), hits('Ruth Hale'), 3);
    expect(await store.has('east', 'search.query', Q('ruth'))).toBe(false);
    await store.put('east', 'search.query', Q('ruth'), hits('Ruth Hale-Okafor'), 4);
    expect((await store.get('east', 'search.query', Q('ruth')))?.value).toEqual(
      hits('Ruth Hale-Okafor'),
    );
    // A write that changed nothing drops nothing.
    expect(await store.wrote('east', 4)).toEqual([]);

    let down = false;
    const { t, reads } = rig((b) => {
      if (down) return 'network-down';
      if (b.channel === 'search.query') return ok(hits('Ruth Hale'), revs('east', 3, 3));
      down = true;
      return ok(
        { entry: { _id: 'H4', modifiedAt: '2026-11-27T00:00:00Z' }, warnings: [] },
        revs('east', 3, 4),
      );
    });
    await t.invoke('search.query', { query: 'ruth' });
    await reads!.settled();
    await t.invoke(
      'entry.update',
      { collection: 'characters', id: 'H4', patch: { title: 'x' } },
      { bible: 'east' },
    );
    await t.readsSettled();
    await expect(t.invoke('search.query', { query: 'ruth' })).rejects.toMatchObject({
      message: NOT_STORED,
    });
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
    // The stale answer did not outlive the reload.
    expect(await reads!.get('east', 'search.query', Q('ruth'))).toBeNull();
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
