import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { Document } from 'mongodb';
import { REGISTRY, migrate, openBible, schemaVersion } from '../../src/main/db';
import type { BibleHandle, Store } from '../../src/main/db';
import { LATEST_SCHEMA_VERSION, migrations } from '../../src/main/db/migrations';
import {
  MIGRATION12_META_ID,
  MOMENT_KIND_SEED,
} from '../../src/main/db/migrations/012-moment-kinds';
import type { Migration12Summary } from '../../src/main/db/migrations/012-moment-kinds';
import { openBibleSession } from '../../src/main/db/session';
import type { OpenBible } from '../../src/main/db/session';
import { MIGRATION12_SNAPSHOT_LABEL } from '../../src/shared/domain/snapshots';
import { entrySchemas, isEntryCollection } from '../../src/shared/schema';
import { freshSlug, localStore } from '../helpers/db';
import { loadFixture, readFixture } from '../helpers/loadFixture';

let store: Store;
let root: string;

beforeAll(async () => {
  store = await localStore();
  root = await mkdtemp(join(tmpdir(), 'nc-mig12-'));
});
afterAll(async () => {
  await store.close();
});

const fixture = readFixture();
const TRASHED = '2026-02-01T00:00:00.000Z';
const at = '2026-01-15T09:00:00.000Z';
const moment = (id: string, title: string, extra: Document = {}) => ({
  _id: id,
  title,
  characterId: 'H1',
  year: 2030,
  createdAt: at,
  modifiedAt: at,
  ...extra,
});
/** Moments beside the fixture's: near misses that stay with no kind, and a trashed move. */
const EXTRA_MOMENTS = [
  moment('M-near-voice', 'Voice lessons'),
  moment('M-lower-voice', 'voice'),
  moment('M-moves', 'Moves to Portland'),
  moment('M-trashed-move', 'Lives in Hong Kong', { deletedAt: TRASHED }),
  // A kind already set is never overwritten, whatever the title says.
  moment('M-kept', 'Lives in Macau', { kind: 'life' }),
];

/**
 * The fixture as a version 11 bible stored it: moments with no `kind` field
 * and no `momentKinds` list. `ownList` puts a list of the writer's own in
 * place instead, to show migration 12 does not touch it.
 */
async function v11Bible(label: string, ownList?: Document): Promise<BibleHandle> {
  const slug = freshSlug(label);
  await store.db.collection(REGISTRY).insertOne({
    _id: slug as never,
    name: 'Before A51',
    createdAt: '2026-01-15T09:00:00.000Z',
    schemaVersion: 0,
  });
  const bible = await openBible(store, slug);
  await migrate(bible, migrations.slice(0, 11));
  // Migration 1 seeds today's default lists; a bible made before A51 has no kinds list.
  await bible.collection('lists').deleteOne({ _id: 'momentKinds' as never });
  if (ownList) await bible.collection('lists').insertOne({ ...ownList });
  for (const [c, raw] of Object.entries(fixture)) {
    if (!isEntryCollection(c) || raw.length === 0) continue;
    const docs = raw.map((d) => entrySchemas[c].parse(d) as Document);
    if (c === 'moments') {
      docs.push(...EXTRA_MOMENTS.map((m) => entrySchemas.moments.parse(m) as Document));
      for (const d of docs) if (d._id !== 'M-kept') delete d.kind;
    }
    await bible.collection(c).insertMany(docs);
  }
  for (const l of fixture.lists!.filter((x) => x._id !== 'momentKinds')) {
    await bible.collection('lists').replaceOne({ _id: l._id as never }, l, { upsert: true });
  }
  return bible;
}

/** Each moment's stored kind. */
const kinds = async (handle: BibleHandle) =>
  Object.fromEntries(
    (await handle.collection('moments').find({}).sort({ _id: 1 }).toArray()).map((m) => [
      String(m._id),
      m.kind,
    ]),
  );

/** The kind each moment should end with: the fixture's own, and null for the near misses. */
const expected = Object.fromEntries([
  ...fixture.moments!.map((m) => [m._id, (m.kind as string | undefined) ?? null]),
  ['M-near-voice', null],
  ['M-lower-voice', null],
  ['M-moves', null],
  ['M-trashed-move', 'move'],
  ['M-kept', 'life'],
]);

describe('A51 migration 12 on a copy of the fixture at version 11', () => {
  let open: OpenBible;
  let bible: BibleHandle;
  beforeAll(async () => {
    bible = await v11Bible('mig12');
    expect(await schemaVersion(bible)).toBe(11);
    expect(await bible.collection('lists').findOne({ _id: 'momentKinds' as never })).toBeNull();
    open = await openBibleSession(store, bible.id, { snapshotRoot: root });
  });

  test('A51 opening takes a snapshot of the version 11 bible first, then runs migration 12', async () => {
    expect(LATEST_SCHEMA_VERSION).toBe(12);
    expect(await schemaVersion(open.handle)).toBe(12);
    const before = (await open.snapshots!.list()).filter((s) => s.reason === 'migration');
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({ label: MIGRATION12_SNAPSHOT_LABEL, schemaVersion: 11 });
    const data = await open.snapshots!.read(before[0]!.id);
    // Only the moment seeded with a kind of its own carries one before the migration.
    expect(data.collections.moments!.every((m) => m._id === 'M-kept' || !('kind' in m))).toBe(true);
  });

  test('IP-9 a bible with no kinds list gets the seeded one: four kinds, Voice with no colour, all plain', async () => {
    const list = await open.handle.collection('lists').findOne({ _id: 'momentKinds' as never });
    expect(list).toEqual({ _id: 'momentKinds', label: 'Moment kinds', items: MOMENT_KIND_SEED });
    expect(
      open.repo
        .lists()
        .find((l) => l._id === 'momentKinds')!
        .items.map((i) => i.id),
    ).toEqual(['move', 'life', 'work', 'voice']);
  });

  test('SM-3 "Lives in" titles become moves and "Voice" titles voice notes, trashed ones too; the rest stay null', async () => {
    expect(await kinds(open.handle)).toEqual(expected);
    expect(open.repo.get('moments', 'M-near-voice')!.kind).toBeNull();
    const moves = Object.values(expected).filter((k) => k === 'move');
    const voices = Object.values(expected).filter((k) => k === 'voice');
    expect(moves.length).toBeGreaterThanOrEqual(3);
    expect(voices.length).toBeGreaterThanOrEqual(2);
    const trashed = await open.handle
      .collection('moments')
      .findOne({ _id: 'M-trashed-move' as never });
    expect(trashed!.deletedAt).toBe(TRASHED);
    // The modified time is not touched.
    for (const m of await open.handle.collection('moments').find({}).toArray()) {
      expect(m.modifiedAt, String(m._id)).toBe(at);
    }
  });

  test('A51 the summary in meta says the list was seeded and counts the moves and voice notes', async () => {
    const summary = (await open.handle
      .collection('meta')
      .findOne({ _id: MIGRATION12_META_ID as never })) as unknown as Migration12Summary;
    expect(summary).toMatchObject({
      listSeeded: true,
      movesSorted: Object.values(expected).filter((k) => k === 'move').length,
      voicesSorted: Object.values(expected).filter((k) => k === 'voice').length,
    });
  });

  test('A51 running it again changes nothing, and a bible at version 12 is not snapshotted again', async () => {
    const dump = async () => ({
      moments: await open.handle.collection('moments').find({}).sort({ _id: 1 }).toArray(),
      lists: await open.handle.collection('lists').find({}).sort({ _id: 1 }).toArray(),
      meta: await open.handle.collection('meta').find({}).sort({ _id: 1 }).toArray(),
    });
    const before = await dump();
    await migrations[11]!.up(open.handle);
    expect(await dump()).toEqual(before);
    await openBibleSession(store, bible.id, { snapshotRoot: root });
    expect((await open.snapshots!.list()).filter((s) => s.reason === 'migration')).toHaveLength(1);
  });

  test('IP-9 the write path takes a kind the list holds and refuses one it does not, in plain words', async () => {
    await open.repo.update('moments', 'M-moves', { kind: 'move' });
    expect(open.repo.get('moments', 'M-moves')!.kind).toBe('move');
    await expect(open.repo.update('moments', 'M-moves', { kind: 'holiday' })).rejects.toThrow(
      'Kind holiday is not in the momentKinds list.',
    );
    await open.repo.update('moments', 'M-moves', { kind: null });
    expect(open.repo.get('moments', 'M-moves')!.kind).toBeNull();
  });
});

describe('A51 migration 12 on a bible that already has a kinds list', () => {
  const OWN = {
    _id: 'momentKinds',
    label: 'Moment kinds',
    items: [
      { id: 'move', label: 'Relocations', parentId: null, color: '#123456', extra: {} },
      { id: 'war', label: 'War', parentId: null, color: '#e34948', extra: { weight: 'big' } },
    ],
  };

  test('IP-9 the list is left exactly as the writer has it, and the titles are still sorted', async () => {
    const bible = await v11Bible('mig12-own', OWN);
    const open = await openBibleSession(store, bible.id, { snapshotRoot: root });
    expect(await open.handle.collection('lists').findOne({ _id: 'momentKinds' as never })).toEqual(
      OWN,
    );
    expect(await kinds(open.handle)).toEqual(expected);
    const summary = await open.handle
      .collection('meta')
      .findOne({ _id: MIGRATION12_META_ID as never });
    expect(summary!.listSeeded).toBe(false);
  });
});

describe('A51 migration 12 on the fixture as it ships', () => {
  test('A51 the fixture loads at version 12 and migration 12 leaves it exactly as it is', async () => {
    const handle = await loadFixture(store, freshSlug('mig12-fx'));
    expect(await schemaVersion(handle)).toBe(12);
    const snapshot = async () => ({
      moments: await handle.collection('moments').find({}).sort({ _id: 1 }).toArray(),
      lists: await handle.collection('lists').find({}).sort({ _id: 1 }).toArray(),
    });
    const before = await snapshot();
    await migrations[11]!.up(handle);
    expect(await snapshot()).toEqual(before);
    const open = await openBibleSession(store, handle.id);
    // Every kind a moment holds is an item of the list, so no moment warns of one.
    for (const m of open.repo.list('moments')) {
      const w = open.repo.warnings('moments', m as never);
      expect(
        w.filter((x) => x.code === 'unknown-list-item'),
        String(m._id),
      ).toEqual([]);
    }
  });
});
