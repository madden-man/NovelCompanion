import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { REGISTRY, createBible, migrate, schemaVersion } from '../../src/main/db';
import type { Store } from '../../src/main/db';
import { LATEST_SCHEMA_VERSION, migrations } from '../../src/main/db/migrations';
import { openBibleSession } from '../../src/main/db/session';
import { readRev } from '../../src/main/db/rev';
import { restoreSnapshot } from '../../src/main/backup/restore';
import { REV_META_ID } from '../../src/shared/freshness';
import { freshSlug, localStore } from '../helpers/db';
import { loadFixture } from '../helpers/loadFixture';

let store: Store;
let root: string;
beforeAll(async () => {
  store = await localStore();
  root = await mkdtemp(join(tmpdir(), 'nc-m16-'));
});
afterAll(async () => {
  await store.close();
  await rm(root, { recursive: true, force: true });
});

const revDoc = (slug: string) =>
  store.db.collection(`${slug}.meta`).findOne({ _id: REV_META_ID as never });

describe('PH-6 PH-20 migration 16 adds the rev counter', () => {
  test('PH-20 the schema version is 16, the rev migration last', () => {
    expect(LATEST_SCHEMA_VERSION).toBe(16);
    expect(migrations.at(-1)!.version).toBe(16);
  });

  test('PH-6 a new bible starts with rev in meta', async () => {
    const slug = freshSlug('m16-new');
    await createBible(store, slug, 'New');
    expect(await revDoc(slug)).toEqual({ _id: REV_META_ID, rev: 0 });
  });

  test('PH-20 opening a version 15 bible adds rev at 0, changes nothing else, and running it again keeps the number', async () => {
    const slug = freshSlug('m16-old');
    const bible = await createBible(store, slug, 'Old');
    await store.db.collection(`${slug}.meta`).deleteOne({ _id: REV_META_ID as never });
    await store.db
      .collection(REGISTRY)
      .updateOne({ _id: slug as never }, { $set: { schemaVersion: 15 } });
    const metaBefore = await bible.collection('meta').find({}).sort({ _id: 1 }).toArray();

    const open = await openBibleSession(store, slug);
    expect(await schemaVersion(open.handle)).toBe(16);
    expect(await revDoc(slug)).toEqual({ _id: REV_META_ID, rev: 0 });
    const metaAfter = await bible
      .collection('meta')
      .find({ _id: { $ne: REV_META_ID as never } })
      .sort({ _id: 1 })
      .toArray();
    expect(metaAfter).toEqual(metaBefore);

    await open.repo.setStoryTime({ year: 2040 });
    expect(await readRev(open.handle)).toBe(1);
    await migrations.at(-1)!.up(open.handle);
    await migrate(open.handle);
    expect(await readRev(open.handle)).toBe(1);
  });

  test('PH-6 restoring a snapshot moves rev forward, never back to a number already seen', async () => {
    const slug = freshSlug('m16-restore');
    await loadFixture(store, slug);
    const open = await openBibleSession(store, slug, { snapshotRoot: root });
    const snap = await open.snapshots!.take('manual');
    for (let i = 0; i < 3; i++) await open.repo.setStoryTime({ year: 2040 + i });
    const before = await readRev(open.handle);
    expect(before).toBeGreaterThanOrEqual(3);
    await restoreSnapshot(open, snap.id);
    const after = await readRev(open.handle);
    expect(after).toBeGreaterThan(before);
    // The restore was this process's own write: nothing to reload.
    expect(open.repo.rev).toBe(after);
    expect(await open.repo.freshen()).toBe(false);
  });
});
