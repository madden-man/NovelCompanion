import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { Document } from 'mongodb';
import { REGISTRY, migrate, openBible, schemaVersion } from '../../src/main/db';
import type { BibleHandle, Store } from '../../src/main/db';
import { LATEST_SCHEMA_VERSION, migrations } from '../../src/main/db/migrations';
import { MIGRATION11_META_ID } from '../../src/main/db/migrations/011-vocabulary';
import type { Migration11Summary } from '../../src/main/db/migrations/011-vocabulary';
import { openBibleSession } from '../../src/main/db/session';
import type { OpenBible } from '../../src/main/db/session';
import { MIGRATION11_SNAPSHOT_LABEL } from '../../src/shared/domain/snapshots';
import { entrySchemas, isEntryCollection } from '../../src/shared/schema';
import { freshSlug, localStore } from '../helpers/db';
import { loadFixture, readFixture } from '../helpers/loadFixture';

let store: Store;
let root: string;

beforeAll(async () => {
  store = await localStore();
  root = await mkdtemp(join(tmpdir(), 'nc-mig11-'));
});
afterAll(async () => {
  await store.close();
});

const fixture = readFixture();
const regionLabel = new Map(
  (fixture.lists!.find((l) => l._id === 'regions')!.items as { id: string; label: string }[]).map(
    (i) => [i.id, i.label],
  ),
);
const TOKEN: Record<string, string> = { '#2a78d6': 'series-1', '#1baf7a': 'series-3' };
const TRASHED = '2026-02-01T00:00:00.000Z';

/**
 * The fixture as a version 10 bible stored it: region names on the events
 * (one event in the trash), colour tokens on the families, no regions or
 * age groups list, statuses and provenance without colours or kinds, and a
 * brief window of 5 in the old brief settings.
 */
async function v10Bible(label: string): Promise<BibleHandle> {
  const slug = freshSlug(label);
  await store.db.collection(REGISTRY).insertOne({
    _id: slug as never,
    name: 'Before A47',
    createdAt: '2026-01-15T09:00:00.000Z',
    schemaVersion: 0,
  });
  const bible = await openBible(store, slug);
  await migrate(bible, migrations.slice(0, 10));
  for (const [c, raw] of Object.entries(fixture)) {
    if (!isEntryCollection(c) || raw.length === 0) continue;
    const docs = raw.map((d) => entrySchemas[c].parse(d) as Document);
    if (c === 'worldEvents') {
      docs.forEach((d, i) => {
        d.regions = (d.regions as string[]).map((r) => regionLabel.get(r) ?? r);
        if (i === 0) d.deletedAt = TRASHED;
      });
    }
    if (c === 'families') for (const d of docs) d.color = TOKEN[d.color as string];
    await bible.collection(c).insertMany(docs);
  }
  for (const l of fixture.lists!.filter((x) =>
    ['communities', 'eventCategories'].includes(x._id),
  )) {
    await bible.collection('lists').replaceOne({ _id: l._id as never }, l, { upsert: true });
  }
  // The writer had renamed Canon before A47; the label is kept.
  await bible
    .collection('lists')
    .updateOne(
      { _id: 'statuses' as never, 'items.id': 'canon' },
      { $set: { 'items.$.label': 'Settled' } },
    );
  await bible
    .collection('meta')
    .insertOne({ _id: 'briefSettings' as never, window: 5, budget: 9000 });
  return bible;
}

const list = (open: OpenBible, id: string) =>
  open.handle.collection('lists').findOne({ _id: id as never }) as Promise<Document>;

describe('A47 migration 11 on a copy of the fixture at version 10', () => {
  let open: OpenBible;
  let bible: BibleHandle;
  beforeAll(async () => {
    bible = await v10Bible('mig11');
    expect(await schemaVersion(bible)).toBe(10);
    expect((await bible.collection('lists').findOne({ _id: 'regions' as never })) === null).toBe(
      true,
    );
    open = await openBibleSession(store, bible.id, { snapshotRoot: root });
  });

  test('A47 IP-8 opening takes a snapshot of the version 10 bible first, then runs migration 11', async () => {
    expect(LATEST_SCHEMA_VERSION).toBe(11);
    expect(await schemaVersion(open.handle)).toBe(11);
    const before = (await open.snapshots!.list()).filter((s) => s.reason === 'migration');
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({ label: MIGRATION11_SNAPSHOT_LABEL, schemaVersion: 10 });
    const data = await open.snapshots!.read(before[0]!.id);
    const oregon = data.collections.worldEvents!.filter((e) =>
      (e.regions as string[]).includes('Oregon'),
    );
    expect(oregon.length).toBeGreaterThan(0);
    expect(data.collections.families!.map((f) => f.color).sort()).toEqual(['series-1', 'series-3']);
  });

  test('IP-8 the regions list is made from every region name events used, the trashed one too, in name order', async () => {
    const regions = await list(open, 'regions');
    expect(regions.label).toBe('Regions');
    expect(regions.items.map((i: { id: string; label: string }) => [i.id, i.label])).toEqual(
      [...regionLabel.entries()].sort((a, b) => a[1].localeCompare(b[1])),
    );
  });

  test('IP-8 every event stores region item IDs, exactly as the fixture holds them, trashed or not', async () => {
    const stored = await open.handle.collection('worldEvents').find({}).toArray();
    expect(stored).toHaveLength(fixture.worldEvents!.length);
    for (const e of fixture.worldEvents!) {
      const got = stored.find((s) => String(s._id) === e._id)!;
      expect(got.regions, String(e._id)).toEqual(e.regions ?? []);
    }
    expect(stored.find((s) => String(s._id) === fixture.worldEvents![0]!._id)!.deletedAt).toBe(
      TRASHED,
    );
    // The modified time is not touched.
    const first = fixture.worldEvents![1]!;
    expect(stored.find((s) => String(s._id) === first._id)!.modifiedAt).toBe(
      entrySchemas.worldEvents.parse(first).modifiedAt,
    );
  });

  test('IP-9 IP-10 statuses and provenance hold colours and kinds, age groups hold the six bands, and a renamed label is kept', async () => {
    const statuses = await list(open, 'statuses');
    expect(statuses.items.map((i: Document) => [i.id, i.label, i.color, i.extra.kind])).toEqual([
      ['canon', 'Settled', '#1b705f', 'canon'],
      ['planned', 'Planned', '#4a3aa7', 'planned'],
      ['idea', 'Idea', '#7a611b', 'idea'],
    ]);
    const prov = await list(open, 'provenance');
    expect(prov.items.map((i: Document) => [i.id, i.color])).toEqual([
      ['researched', '#2a78d6'],
      ['invented', '#b84f25'],
    ]);
    const ages = await list(open, 'ageGroups');
    expect(ages.items).toEqual(
      fixture.lists!.find((l) => l._id === 'ageGroups')!.items as unknown as Document[],
    );
  });

  test('IP-12 each family colour token becomes its hex value', async () => {
    const families = await open.handle.collection('families').find({}).sort({ _id: 1 }).toArray();
    expect(families.map((f) => [f._id, f.color])).toEqual(
      [...fixture.families!]
        .sort((a, b) => String(a._id).localeCompare(String(b._id)))
        .map((f) => [f._id, f.color]),
    );
    expect(open.repo.get('families', String(families[0]!._id))!.color).toMatch(/^#[0-9a-f]{6}$/);
  });

  test('IP-11 the brief window stored before A47 becomes the bible window before, and the budget stays', async () => {
    expect(open.repo.bibleSettings().numbers.windowBefore).toBe(5);
    expect(open.repo.briefSettings()).toEqual({ window: 5, budget: 9000 });
  });

  test('A47 the summary in meta counts the regions made, the events rewritten and the families recoloured', async () => {
    const summary = (await open.handle
      .collection('meta')
      .findOne({ _id: MIGRATION11_META_ID as never })) as unknown as Migration11Summary;
    const withRegions = fixture.worldEvents!.filter((e) => (e.regions as string[]).length > 0);
    expect(summary).toMatchObject({
      regionsMade: regionLabel.size,
      eventsRewritten: withRegions.length,
      familiesRecoloured: 2,
    });
    expect(summary.itemsSeeded).toBeGreaterThanOrEqual(5 + 6);
  });

  test('A47 running it again changes nothing, and a bible at version 11 is not snapshotted again', async () => {
    const dump = async () => ({
      events: await open.handle.collection('worldEvents').find({}).sort({ _id: 1 }).toArray(),
      families: await open.handle.collection('families').find({}).sort({ _id: 1 }).toArray(),
      lists: await open.handle.collection('lists').find({}).sort({ _id: 1 }).toArray(),
      meta: await open.handle.collection('meta').find({}).sort({ _id: 1 }).toArray(),
    });
    const before = await dump();
    await migrations[10]!.up(open.handle);
    expect(await dump()).toEqual(before);
    await openBibleSession(store, bible.id, { snapshotRoot: root });
    expect((await open.snapshots!.list()).filter((s) => s.reason === 'migration')).toHaveLength(1);
  });
});

describe('A47 migration 11 on the fixture as it ships', () => {
  test('A47 the fixture loads at version 11 and migration 11 leaves it exactly as it is', async () => {
    const handle = await loadFixture(store, freshSlug('mig11-fx'));
    expect(await schemaVersion(handle)).toBe(11);
    const snapshot = async () => ({
      events: await handle.collection('worldEvents').find({}).sort({ _id: 1 }).toArray(),
      families: await handle.collection('families').find({}).sort({ _id: 1 }).toArray(),
      lists: await handle.collection('lists').find({}).sort({ _id: 1 }).toArray(),
    });
    const before = await snapshot();
    await migrations[10]!.up(handle);
    expect(await snapshot()).toEqual(before);
    const open = await openBibleSession(store, handle.id);
    // Every region an event names is an item of the list, so no event warns of one.
    for (const e of open.repo.list('worldEvents')) {
      const w = open.repo.warnings('worldEvents', e as never);
      expect(
        w.filter((x) => x.code === 'unknown-list-item'),
        String(e._id),
      ).toEqual([]);
    }
  });
});
