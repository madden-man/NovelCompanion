import { join } from 'node:path';
import { build } from 'esbuild';
import { describe, expect, test, vi } from 'vitest';
import { ELSEWHERE_MESSAGE } from '../../src/shared/freshness';
import { RELOADED_FOR, watchBuild } from '../../src/web/buildWatch';
import {
  KEEPALIVE_BUDGET,
  KEY_REFUSED,
  KEY_STORAGE,
  NO_CONNECTION,
  RpcCallError,
  WebTransport,
} from '../../src/web/transport';
import { readBuildId, writeBuildId } from '../../scripts/build-id';

const ROOT = join(import.meta.dirname, '../..');

type Sent = { body: Record<string, unknown>; init: RequestInit };
type Answer = { status?: number; body: unknown; headers?: Record<string, string> } | 'network-down';

function memoryStorage(seed: Record<string, string> = {}) {
  const m = new Map(Object.entries(seed));
  return {
    map: m,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

/** A transport over a fake `/rpc` that answers from `reply`, recording every request. */
function rig(
  reply: (b: Record<string, unknown>) => Answer,
  seed: Record<string, string> = { [KEY_STORAGE]: 'k-1' },
) {
  const sent: Sent[] = [];
  const storage = memoryStorage(seed);
  let clock = 1_000_000;
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    sent.push({ body, init: init ?? {} });
    const a = reply(body);
    if (a === 'network-down') throw new TypeError('Load failed');
    return new Response(JSON.stringify(a.body), {
      status: a.status ?? 200,
      headers: { 'Content-Type': 'application/json', 'X-NC-Build': 'b-1', ...a.headers },
    });
  });
  const t = new WebTransport({
    fetch: fetch as unknown as typeof globalThis.fetch,
    storage,
    buildId: 'b-1',
    now: () => clock,
  });
  return { t, sent, storage, tick: (ms: number) => (clock += ms) };
}

const ok = (result: unknown, events: unknown[] = [], headers?: Record<string, string>) => ({
  body: { result, events },
  headers,
});
const revs = (bible: string, before: number, after: number) => ({
  'X-NC-Rev-Bible': bible,
  'X-NC-Rev-Before': String(before),
  'X-NC-Rev': String(after),
});
const H1 = { collection: 'characters' as const, id: 'H1' };

describe('PH-12 the web transport implements the Api over /rpc', () => {
  test('PH-12 a request is checked against the contract before it is sent, and the answer after', async () => {
    const { t, sent } = rig(() => ok({ message: 'hi', receivedAt: 'not a date' }));
    await expect(t.invoke('app.ping', { message: '' })).rejects.toThrow();
    expect(sent).toHaveLength(0);
    await expect(t.invoke('app.ping', { message: 'hi' })).rejects.toThrow();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toEqual({ channel: 'app.ping', request: { message: 'hi' }, bible: null });
    expect((sent[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer k-1');
  });

  test('PH-12 the events in the answer go to the listeners, checked against the contract', async () => {
    const { t } = rig(() =>
      ok({ entry: {}, warnings: [] }, [
        { event: 'bible.changed', payload: { bible: 'b', ...H1, op: 'update' } },
        { event: 'bible.changed', payload: { nonsense: true } },
        { event: 'no.such.event', payload: {} },
      ]),
    );
    const heard: unknown[] = [];
    const off = t.on('bible.changed', (e) => heard.push(e));
    await t.invoke('entry.update', { ...H1, patch: { role: 'x' } }, { bible: 'b' }).catch(() => {});
    expect(heard).toEqual([{ bible: 'b', ...H1, op: 'update' }]);
    off();
  });

  test('PH-12 a write carries its bible, and the bible the phone opened is sent with every later request', async () => {
    const { t, sent, storage } = rig((b) =>
      b.channel === 'bible.open'
        ? ok({ bible: { id: 'east', name: 'East' } })
        : ok({ bible: { id: 'east', name: 'East' } }),
    );
    await t.invoke('bible.open', { slug: 'east' });
    expect(storage.map.get('nc.phone.bible')).toBe('east');
    await t.invoke('bible.current', {});
    expect(sent[1]!.body.bible).toBe('east');
  });
});

describe('the web transport maps refusals by code', () => {
  test('PH-4 a desk channel is a plain refusal with its code', async () => {
    const { t } = rig(() => ({
      status: 403,
      body: { error: 'This works in the desktop app on the Mac.', code: 'desk' },
    }));
    const e = await t.invoke('snapshot.list', {}).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(RpcCallError);
    expect((e as RpcCallError).code).toBe('desk');
    expect((e as RpcCallError).status).toBe(403);
    expect((e as Error).message).toBe('This works in the desktop app on the Mac.');
  });

  test('PH-19 an older or newer bible says so in plain words', async () => {
    const { t } = rig(() => ({
      status: 409,
      body: { error: 'Open East Winds on the Mac once.', code: 'older' },
    }));
    await expect(t.invoke('bible.current', {})).rejects.toMatchObject({
      code: 'older',
      message: 'Open East Winds on the Mac once.',
    });
  });

  test('PH-24 a lost connection, or a database out of reach, shows the ARCH-6 banner, and an answer clears it', async () => {
    let down: Answer | null = 'network-down';
    const { t } = rig(() => down ?? ok({ bibles: [], connection: 'connected' }));
    const states: string[] = [];
    t.on('connection.changed', (s) => states.push(s.state));
    await expect(t.invoke('bible.list', {})).rejects.toMatchObject({ message: NO_CONNECTION });
    expect(await t.invoke('connection.status', {})).toEqual({
      state: 'unavailable',
      message: NO_CONNECTION,
      snapshot: null,
    });
    down = { status: 503, body: { error: 'MongoDB cannot be reached.', code: 'unreachable' } };
    await expect(t.invoke('bible.list', {})).rejects.toMatchObject({ code: 'unreachable' });
    down = null;
    const status = await t.invoke('connection.retry', {});
    expect(status.state).toBe('connected');
    expect(states).toEqual(['unavailable', 'unavailable', 'connected']);
  });

  test('PH-24 the phone answers its connection, close flow and appearance itself, offering no snapshot', async () => {
    const { t, sent, storage } = rig(() => ok({}));
    expect(await t.invoke('connection.status', {})).toEqual({
      state: 'connected',
      message: null,
      snapshot: null,
    });
    expect(await t.invoke('app.flushed', {})).toEqual({ ok: true });
    expect(await t.invoke('appearance.get', {})).toEqual({ appearance: 'system' });
    await t.invoke('appearance.set', { appearance: 'dark' });
    expect(storage.map.get('nc.phone.appearance')).toBe('dark');
    expect(await t.invoke('appearance.get', {})).toEqual({ appearance: 'dark' });
    expect(sent).toHaveLength(0);
  });
});

describe('PH-16 PH-17 the phone key', () => {
  test('PH-16 a refused key is not kept; an accepted one is', async () => {
    let good = 'right-key';
    const { t, storage, sent } = rig(
      (b) => (b ? ok({ bibles: [], connection: 'connected' }) : ok({})),
      {},
    );
    // The fake server accepts only `good`.
    const realFetch = t['deps'].fetch;
    t['deps'].fetch = (async (u: unknown, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string>).Authorization;
      if (auth !== `Bearer ${good}`) {
        return new Response(JSON.stringify({ error: KEY_REFUSED, code: 'key' }), { status: 401 });
      }
      return realFetch(u as never, init);
    }) as typeof fetch;
    expect(t.hasKey()).toBe(false);
    await expect(t.signIn('wrong-key')).rejects.toMatchObject({ message: KEY_REFUSED });
    expect(storage.map.has(KEY_STORAGE)).toBe(false);
    await expect(t.signIn('two words')).rejects.toMatchObject({ code: 'key' });
    await t.signIn('  right-key\n');
    expect(storage.map.get(KEY_STORAGE)).toBe('right-key');
    expect(t.hasKey()).toBe(true);
    expect(sent.at(-1)!.body.channel).toBe('bible.list');
    good = 'changed';
  });

  test('PH-17 any 401 later forgets the key and the bible, and tells the gate', async () => {
    const { t, storage } = rig(() => ({ status: 401, body: { error: KEY_REFUSED, code: 'key' } }), {
      [KEY_STORAGE]: 'old',
      'nc.phone.bible': 'east',
    });
    const out = vi.fn();
    t.onSignedOut(out);
    await expect(t.invoke('entry.get', H1)).rejects.toMatchObject({ status: 401 });
    expect(out).toHaveBeenCalledTimes(1);
    expect(storage.map.has(KEY_STORAGE)).toBe(false);
    expect(storage.map.has('nc.phone.bible')).toBe(false);
    expect(t.hasKey()).toBe(false);
  });
});

describe('PH-9 the phone follows the desk through rev', () => {
  test('PH-9 the phone’s own writes never reload; a move made elsewhere asks what changed and fires bible.reloaded', async () => {
    let before = 5;
    let after = 5;
    const { t, sent, tick } = rig((b) => {
      if (b.channel === 'bible.changes') {
        return ok(
          { bible: 'east', at: new Date().toISOString(), changes: [{ ...H1, op: 'update' }] },
          [],
          revs('east', after, after),
        );
      }
      return ok({ bible: { id: 'east', name: 'East' } }, [], revs('east', before, after));
    });
    const reloads: unknown[] = [];
    const changed: unknown[] = [];
    const lists: unknown[] = [];
    t.on('bible.reloaded', (e) => reloads.push(e));
    t.on('bible.changed', (e) => changed.push(e));
    t.on('lists.changed', (e) => lists.push(e));
    await t.invoke('bible.current', {});
    // Its own write: before is what it knew, after counts the write.
    after = 6;
    tick(1000);
    await t.invoke('bible.current', {});
    before = 6;
    tick(1000);
    await t.checkFreshness();
    expect(reloads).toEqual([]);
    expect(sent.some((s) => s.body.channel === 'bible.changes')).toBe(false);

    // The desk wrote: the function's fresh `rev` is one the phone never saw.
    before = 8;
    after = 8;
    tick(20_000);
    await t.checkFreshness();
    expect(reloads).toEqual([{ bible: 'east', message: ELSEWHERE_MESSAGE, elsewhere: true }]);
    expect(changed).toEqual([{ bible: 'east', ...H1, op: 'update' }]);
    expect(lists).toEqual([{ bible: 'east' }]);
    const ask = sent.find((s) => s.body.channel === 'bible.changes')!;
    // Since the last time the views were known to be current, less the clock margin.
    expect(Date.parse((ask.body.request as { since: string }).since)).toBeLessThan(
      1_000_000 + 2000,
    );
  });

  test('PH-9 no check without a bible or a key', async () => {
    const { t, sent } = rig(() => ok({ bible: null }), {});
    await t.checkFreshness();
    expect(sent).toEqual([]);
  });
});

describe('PH-13 a flush on hide', () => {
  test('PH-13 once hidden, the page is asked to flush and its writes go out as keepalive requests under 64 KiB', async () => {
    const { t, sent, tick } = rig(() => ok({ bible: { id: 'east', name: 'East' } }));
    await t.invoke('bible.current', {});
    const asked = vi.fn();
    t.on('app.closeRequested', asked);
    t.hidden();
    expect(asked).toHaveBeenCalledWith({ hasBible: true, quitting: false });
    await t
      .invoke('entry.update', { ...H1, patch: { role: 'short' } }, { bible: 'east' })
      .catch(() => {});
    expect(sent.at(-1)!.init.keepalive).toBe(true);
    // Too large for one keepalive body: sent as a normal request, pending until answered.
    const big = 'x'.repeat(KEEPALIVE_BUDGET);
    await t
      .invoke('entry.update', { ...H1, patch: { backstory: big } }, { bible: 'east' })
      .catch(() => {});
    expect(sent.at(-1)!.init.keepalive).toBeUndefined();
    expect(String(sent.at(-2)!.init.body).length).toBeLessThan(KEEPALIVE_BUDGET);
    // Visible again, or long after: normal requests.
    t.shown();
    await t
      .invoke('entry.update', { ...H1, patch: { role: 'later' } }, { bible: 'east' })
      .catch(() => {});
    expect(sent.at(-1)!.init.keepalive).toBeUndefined();
    t.hidden();
    tick(10_000);
    await t
      .invoke('entry.update', { ...H1, patch: { role: 'late' } }, { bible: 'east' })
      .catch(() => {});
    expect(sent.at(-1)!.init.keepalive).toBeUndefined();
  });
});

describe('PH-21 a stale installed app', () => {
  test('PH-21 an answer with another build id is reported', async () => {
    const { t } = rig(() =>
      ok({ bibles: [], connection: 'connected' }, [], { 'X-NC-Build': 'b-2' }),
    );
    const seen = vi.fn();
    t.onBuildChanged(seen);
    await t.invoke('bible.list', {});
    expect(seen).toHaveBeenCalledWith('b-2');
  });

  test('PH-21 the reload waits while a field holds typing, then saves and reloads once per id', async () => {
    let typing = true;
    const timers: (() => void)[] = [];
    const session = memoryStorage();
    const reload = vi.fn();
    const save = vi.fn(async () => undefined);
    const updateWorker = vi.fn(async () => undefined);
    const changed = watchBuild({
      isTyping: () => typing,
      save,
      reload,
      updateWorker,
      session,
      setTimer: (fn) => timers.push(fn),
    });
    changed('b-2');
    await Promise.resolve();
    expect(updateWorker).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    typing = false;
    timers.shift()!();
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(save).toHaveBeenCalledTimes(1);
    expect(session.map.get(RELOADED_FOR)).toBe('b-2');
    // The same id again in this session never reloads again.
    const again = watchBuild({ isTyping: () => false, save, reload, updateWorker, session });
    again('b-2');
    await Promise.resolve();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test('PH-21 a save that fails keeps the page and tries again', async () => {
    const timers: (() => void)[] = [];
    const reload = vi.fn();
    let fail = true;
    const changed = watchBuild({
      isTyping: () => false,
      save: async () => {
        if (fail) throw new Error('Not saved');
      },
      reload,
      updateWorker: async () => undefined,
      session: memoryStorage(),
      setTimer: (fn) => timers.push(fn),
    });
    changed('b-3');
    await vi.waitFor(() => expect(timers).toHaveLength(1));
    expect(reload).not.toHaveBeenCalled();
    fail = false;
    timers.shift()!();
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  });
});

describe('PH-2 what the web bundle holds', () => {
  test('PH-2 the web bundle holds no MongoDB, Electron, keyring or Agent SDK, and nothing from main', async () => {
    if (!readBuildId(ROOT)) writeBuildId(ROOT);
    const result = await build({
      entryPoints: [join(ROOT, 'src/web/main.tsx')],
      bundle: true,
      write: false,
      metafile: true,
      platform: 'browser',
      format: 'esm',
      loader: { '.css': 'empty', '.png': 'empty' },
      logLevel: 'silent',
    });
    const files = Object.keys(result.metafile.inputs);
    expect(files.some((f) => f.endsWith('src/renderer/src/App.tsx'))).toBe(true);
    expect(files.some((f) => f.endsWith('src/web/transport.ts'))).toBe(true);
    const banned = files.filter((f) =>
      /node_modules\/(mongodb|bson|electron|@napi-rs\/keyring|@anthropic-ai\/claude-agent-sdk)\//.test(
        f,
      ),
    );
    expect(banned).toEqual([]);
    expect(files.filter((f) => f.startsWith('src/main/') || f.includes('/src/main/'))).toEqual([]);
    expect(files.filter((f) => f.includes('src/preload/'))).toEqual([]);
  });
});
