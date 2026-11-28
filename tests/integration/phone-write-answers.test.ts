import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { inject } from 'vitest';
import type { Store } from '../../src/main/db';
import { ALLOW_TEST_URI_ENV, TEST_DB_NAME_ENV, TEST_URI_ENV } from '../../src/main/host/uri';
import { freshenOpenBible } from '../../src/main/ipc/handlers';
import { parseResponse } from '../../src/shared/ipc';
import type { Channel } from '../../src/shared/ipc';
import { createRpc } from '../../src/server/rpc';
import type { Rpc, RpcEnvelope, RpcError } from '../../src/server/rpc';
import { WRITTEN_READ_CHANNELS, writtenReads } from '../../src/web/writeAnswers';
import { freshSlug, localStore } from '../helpers/db';
import { loadFixture } from '../helpers/loadFixture';

/**
 * A58 L1 (PH-25): every write channel whose answer the phone keeps as a
 * read's answer (`writeAnswers.ts`), run through the real handlers on the
 * memory replica set: the write's answer, as the phone stores it, deep-equals
 * what the matching read answers right after.
 */
const KEY = 'phone-key-for-the-write-answer-tests';
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

async function call(bible: string, channel: string, request: unknown, write = false) {
  const res = await rpc(
    new Request('http://localhost/rpc', {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel, request, bible, ...(write ? { context: { bible } } : {}) }),
    }),
  );
  const body = (await res.json()) as RpcEnvelope | RpcError;
  if (res.status !== 200) throw new Error(`${channel} ${res.status}: ${JSON.stringify(body)}`);
  // What the phone's transport keeps: the answer as the contract reads it.
  return parseResponse(channel as Channel, (body as RpcEnvelope).result);
}

/** A request for each write channel, against the fixture bible as the steps before left it. */
type Step = (bible: string) => Promise<unknown> | unknown;
const REQUESTS: Record<string, Step> = {
  'entry.create': () => ({
    collection: 'families',
    data: { title: 'Okafor', name: 'Okafor' },
  }),
  'entry.update': () => ({
    collection: 'characters',
    id: 'H1',
    patch: { role: 'Keeps the letters' },
  }),
  'entry.delete': () => ({ collection: 'characters', id: 'H2' }),
  'entry.restore': () => ({ collection: 'characters', id: 'H2' }),
  'entry.createMany': () => ({
    items: [
      { collection: 'families', data: { title: 'Zhou', name: 'Zhou' } },
      { collection: 'families', data: { title: 'Lan', name: 'Lan' } },
    ],
  }),
  'entry.batch': () => ({
    ops: [
      { op: 'update', collection: 'characters', id: 'H1', patch: { role: 'Sails' } },
      { op: 'delete', collection: 'places', id: 'PLC1' },
      { op: 'delete', collection: 'families', id: 'FAM-HALE' },
    ],
  }),
  'storyTime.set': () => ({ time: { year: 1912 } }),
  'sceneOutline.set': () => ({ text: '- The harbour\n- The letters', breaks: {}, years: {} }),
  'sceneOutline.restore': async (bible) => {
    const { versions } = (await call(bible, 'sceneOutline.versions', {})) as {
      versions: { id: string }[];
    };
    return { id: versions.at(-1)!.id };
  },
  'romanization.set': async (bible) => {
    const { languages, systems } = (await call(bible, 'romanization.get', {})) as {
      languages: { id: string }[];
      systems: { id: string }[];
    };
    return { languageId: languages[0]!.id, systemId: systems[0]!.id };
  },
  'community.notes.set': () => ({ communityId: 'portland', text: 'Boat builders' }),
  'settings.set': () => ({ cultureUnit: 'five' }),
  'eraDefaults.set': () => ({ rows: [{ name: 'Republic', startYear: 1912, endYear: 1949 }] }),
  'brief.settings.set': () => ({ window: 5 }),
};

describe('PH-25 a write keeps its own answer as the read it repeats', () => {
  test('PH-25 the request table names every mapped write channel', () => {
    expect(Object.keys(REQUESTS).sort()).toEqual(Object.keys(WRITTEN_READ_CHANNELS).sort());
  });

  test('PH-25 for every mapped write channel, the write`s kept answer deep-equals the matching read`s answer right after', async () => {
    const bible = (await loadFixture(store, freshSlug('ph25-write-answers'))).id;
    const checked: string[] = [];
    for (const [channel, read] of Object.entries(WRITTEN_READ_CHANNELS)) {
      const request = await REQUESTS[channel]!(bible);
      const result = await call(bible, channel, request, true);
      const kept = writtenReads(channel, request, result);
      expect(kept.length, channel).toBeGreaterThan(0);
      for (const w of kept) {
        expect(w.channel, channel).toBe(read);
        expect(await call(bible, w.channel, w.request), `${channel} then ${w.channel}`).toEqual(
          w.value,
        );
        checked.push(`${channel} ${w.channel} ${JSON.stringify(w.request)}`);
      }
    }
    // A trashed entry too: `entry.delete` then `entry.get` answers the entry in the trash.
    expect(checked).toContain('entry.delete entry.get {"collection":"characters","id":"H2"}');
    expect(checked.length).toBe(Object.keys(WRITTEN_READ_CHANNELS).length + 1 + 2);
  });
});
