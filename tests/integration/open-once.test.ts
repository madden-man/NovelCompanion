import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { REGISTRY, migrate, openBible, schemaVersion } from '../../src/main/db';
import type { Store } from '../../src/main/db';
import { LATEST_SCHEMA_VERSION, migrations } from '../../src/main/db/migrations';
import { MIGRATION12_META_ID } from '../../src/main/db/migrations/012-moment-kinds';
import { MIGRATION13_META_ID } from '../../src/main/db/migrations/013-cuts';
import { openBibleSession } from '../../src/main/db/session';
import { freshSlug, localStore } from '../helpers/db';

let store: Store;
let root: string;

beforeAll(async () => {
  store = await localStore();
  root = await mkdtemp(join(tmpdir(), 'nc-open-once-'));
});
afterAll(async () => {
  await store.close();
});

/** A bible as a version 11 app left it, with the collections migration 13 drops. */
async function v11Bible(label: string) {
  const slug = freshSlug(label);
  await store.db.collection(REGISTRY).insertOne({
    _id: slug as never,
    name: 'Before A53',
    createdAt: '2026-01-15T09:00:00.000Z',
    schemaVersion: 0,
  });
  const bible = await openBible(store, slug);
  await migrate(bible, migrations.slice(0, 11));
  await bible.collection('lists').deleteOne({ _id: 'momentKinds' as never });
  for (const c of ['revisions', 'importSources', 'briefs', 'sessionLogs', 'books']) {
    await bible.collection(c).insertOne({ _id: `${c}-1` as never, createdAt: '2026-01-15' });
  }
  expect(await schemaVersion(bible)).toBe(11);
  return bible;
}

describe('ARCH-8 A53 one open at a time', () => {
  test('ARCH-8 A53 two opens of the same bible at once share one session and migrate it once', async () => {
    const bible = await v11Bible('open-once');
    // The first open on this build takes a migration snapshot then runs 12 and 13; a
    // second click on Open during that window used to start a second run.
    const [a, b] = await Promise.all([
      openBibleSession(store, bible.id, { snapshotRoot: root }),
      openBibleSession(store, bible.id, { snapshotRoot: root }),
    ]);
    expect(b).toBe(a);
    expect(await schemaVersion(a.handle)).toBe(LATEST_SCHEMA_VERSION);
    const meta = a.handle.collection('meta');
    expect(
      await meta.countDocuments({
        _id: { $in: [MIGRATION12_META_ID, MIGRATION13_META_ID] } as never,
      }),
    ).toBe(2);
    // One migration snapshot, not two.
    expect((await readdir(join(root, bible.id))).length).toBe(1);
    // Once the open has settled, the next open is a fresh session of the migrated bible.
    const again = await openBibleSession(store, bible.id, { snapshotRoot: root });
    expect(again).not.toBe(a);
    expect(await schemaVersion(again.handle)).toBe(LATEST_SCHEMA_VERSION);
  });

  test('ARCH-8 A53 a failed open does not pin the bible: the next open runs again', async () => {
    const slug = freshSlug('open-once-missing');
    const first = openBibleSession(store, slug, { snapshotRoot: root });
    await expect(first).rejects.toThrow();
    await expect(openBibleSession(store, slug, { snapshotRoot: root })).rejects.toThrow();
  });
});
