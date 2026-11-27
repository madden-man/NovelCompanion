import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { inject } from 'vitest';
import type { Store } from '../../src/main/db';
import { openBibleSession } from '../../src/main/db/session';
import { ALLOW_TEST_URI_ENV, TEST_DB_NAME_ENV, TEST_URI_ENV } from '../../src/main/host/uri';
import { freshenOpenBible } from '../../src/main/ipc/handlers';
import type { Channel, CallContext, Request as ChannelRequest } from '../../src/shared/ipc';
import { REV_HEADERS, createRpc } from '../../src/server/rpc';
import type { Rpc, RpcEnvelope, RpcError } from '../../src/server/rpc';
import { freshSlug, localStore } from '../helpers/db';
import { loadFixture } from '../helpers/loadFixture';

/**
 * A58 P4: the function as `netlify/functions/rpc.mts` and `scripts/serve-web.ts`
 * build it, with P2's real `freshenOpenBible`, not a fake. A second repository
 * in this process stands for the desk, writing to the same database.
 */
const KEY = 'phone-key-for-the-freshen-tests';
let store: Store;
let rpc: Rpc;

beforeAll(async () => {
  process.env[TEST_URI_ENV] = inject('mongoUri');
  process.env[ALLOW_TEST_URI_ENV] = '1';
  Reflect.deleteProperty(process.env, TEST_DB_NAME_ENV);
  store = await localStore();
  rpc = createRpc({ env: { NC_PHONE_KEY: KEY }, freshen: freshenOpenBible, buildId: 'b-1' });
});
afterAll(async () => {
  await store.close();
});

function call<C extends Channel>(
  channel: C,
  request: ChannelRequest<C>,
  bible: string | null,
  context?: CallContext,
): Promise<Response> {
  return rpc(
    new Request('http://localhost/rpc', {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel, request, bible, ...(context ? { context } : {}) }),
    }),
  );
}

async function ok(res: Response): Promise<RpcEnvelope> {
  const body = (await res.json()) as RpcEnvelope | RpcError;
  if (res.status !== 200) throw new Error(`${res.status}: ${JSON.stringify(body)}`);
  return body as RpcEnvelope;
}

const revs = (res: Response) => ({
  bible: res.headers.get(REV_HEADERS.bible),
  before: Number(res.headers.get(REV_HEADERS.before)),
  after: Number(res.headers.get(REV_HEADERS.after)),
});

describe('PH-7 the function with the real freshen', () => {
  test('PH-7 a desk-side repository write is seen by the next rpc read', async () => {
    const bible = (await loadFixture(store, freshSlug('p4-fresh'))).id;
    const first = await ok(await call('entry.get', { collection: 'characters', id: 'H1' }, bible));
    expect((first.result as { entry: { role?: string } }).entry.role).not.toBe('Desk wrote this');

    const desk = await openBibleSession(store, bible);
    await desk.repo.update('characters', 'H1', {
      role: 'Desk wrote this',
      names: { full: 'Margaret Zephyrine' },
    });

    const res = await call('entry.get', { collection: 'characters', id: 'H1' }, bible);
    const body = await ok(res);
    expect((body.result as { entry: { role: string } }).entry.role).toBe('Desk wrote this');
    // The search index was rebuilt too.
    const found = await ok(await call('search.query', { query: 'Zephyrine' }, bible));
    expect(JSON.stringify(found.result)).toContain('H1');
  });

  test('PH-9 the rev headers tell a write made elsewhere from the phone’s own', async () => {
    const bible = (await loadFixture(store, freshSlug('p4-revs'))).id;
    const a = revs(await call('bible.current', {}, bible));
    expect(a.bible).toBe(bible);
    expect(a.after).toBe(a.before);

    // The phone's own write moves `rev` between before and after, and only there.
    const own = await call(
      'entry.update',
      { collection: 'characters', id: 'H2', patch: { role: 'Phone wrote this' } },
      bible,
      { bible },
    );
    await ok(own);
    const b = revs(own);
    expect(b.before).toBe(a.after);
    expect(b.after).toBeGreaterThan(b.before);
    const c = revs(await call('bible.current', {}, bible));
    expect(c.before).toBe(b.after);

    // A write on the desk shows as a `before` the phone did not see.
    const desk = await openBibleSession(store, bible);
    await desk.repo.update('characters', 'H3', { role: 'Desk again' });
    const d = revs(await call('bible.current', {}, bible));
    expect(d.before).toBeGreaterThan(c.after);
    expect(d.after).toBe(d.before);

    // What changed since then, for the phone's views (PH-9, PH-12).
    const since = new Date(Date.now() - 60_000).toISOString();
    const changes = await ok(await call('bible.changes', { since }, bible));
    const list = (changes.result as { changes: { collection: string; id: string }[] }).changes;
    expect(list).toContainEqual(expect.objectContaining({ collection: 'characters', id: 'H3' }));
    expect(list).toContainEqual(expect.objectContaining({ collection: 'characters', id: 'H2' }));
    expect(list.some((c) => c.id === 'H5')).toBe(false);
  });

  test('PH-9 no rev headers on a request with no bible', async () => {
    const res = await call('bible.list', {}, null);
    await ok(res);
    expect(res.headers.get(REV_HEADERS.before)).toBeNull();
  });
});
