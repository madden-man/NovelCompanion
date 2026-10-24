import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { Document } from 'mongodb';
import { REGISTRY, migrate, openBible, schemaVersion } from '../../src/main/db';
import type { BibleHandle, Store } from '../../src/main/db';
import { LATEST_SCHEMA_VERSION, migrations } from '../../src/main/db/migrations';
import { MIGRATION14_META_ID, partOrderKeys } from '../../src/main/db/migrations/014-part-order';
import type { Migration14Summary } from '../../src/main/db/migrations/014-part-order';
import { openBibleSession } from '../../src/main/db/session';
import { freshSlug, localStore } from '../helpers/db';
import { readFixture } from '../helpers/loadFixture';

let store: Store;
beforeAll(async () => {
  store = await localStore();
});
afterAll(async () => {
  await store.close();
});

const AT = '2026-01-15T09:00:00.000Z';
const part = (
  id: string,
  number: number,
  title: string,
  createdAt: string,
  extra: Document = {},
) => ({
  _id: id,
  number,
  title,
  summary: '',
  body: '',
  createdAt,
  modifiedAt: AT,
  ...extra,
});
const chapter = (id: string, partId: string, readingOrder: number, extra: Document = {}) => ({
  _id: id,
  title: `Chapter ${id}`,
  body: '',
  partId,
  readingOrder,
  strands: [],
  written: false,
  createdAt: AT,
  modifiedAt: AT,
  ...extra,
});

/**
 * East Winds as migration 13 left it: two books' parts, each numbered 1 to 4
 * within its book, the second book's parts created a millisecond later, one
 * part with no chapter, and one part in the trash.
 */
const PARTS = [
  part('P-sins', 1, 'Sins of the Father', '2026-01-10T00:00:00.569Z'),
  part('P-lost', 2, 'Lost Spirits', '2026-01-10T00:00:00.569Z'),
  part('P-inherit', 3, 'Inheritance', '2026-01-10T00:00:00.569Z'),
  part('P-circ', 4, 'Circulation', '2026-01-10T00:00:00.569Z'),
  part('P-claws', 1, 'Claws Come Out', '2026-01-10T00:00:00.570Z'),
  part('P-fangs', 2, 'Fangs of the Dragon', '2026-01-10T00:00:00.570Z'),
  part('P-ties', 3, 'What Ties Us Together', '2026-01-10T00:00:00.570Z'),
  part('P-tears', 4, 'Tears Us Apart', '2026-01-10T00:00:00.570Z'),
  part('P-old', 2, 'An old part', '2026-01-09T00:00:00.000Z', { deletedAt: AT }),
];
const CHAPTERS = [
  chapter('C1', 'P-sins', 1),
  chapter('C2', 'P-sins', 2),
  chapter('C3', 'P-sins', 3, { deletedAt: AT }),
  chapter('C22', 'P-lost', 22),
  chapter('C26', 'P-inherit', 26),
  chapter('C38', 'P-circ', 38),
  chapter('C50', 'P-claws', 50),
  chapter('C89', 'P-ties', 89),
  chapter('C90', 'P-tears', 90),
  chapter('C0', 'P-old', 0, { deletedAt: AT }),
];
const EXPECTED = [
  'Sins of the Father',
  'Lost Spirits',
  'Inheritance',
  'Circulation',
  'Claws Come Out',
  'Fangs of the Dragon',
  'What Ties Us Together',
  'Tears Us Apart',
  'An old part',
];

async function v13Bible(label: string): Promise<BibleHandle> {
  const slug = freshSlug(label);
  await store.db.collection(REGISTRY).insertOne({
    _id: slug as never,
    name: 'After A53',
    createdAt: AT,
    schemaVersion: 0,
  });
  const bible = await openBible(store, slug);
  await migrate(bible, migrations.slice(0, 13));
  await bible.collection('parts').insertMany(PARTS as never[]);
  await bible.collection('chapters').insertMany(CHAPTERS as never[]);
  expect(await schemaVersion(bible)).toBe(13);
  return bible;
}

const titlesByNumber = async (handle: BibleHandle) =>
  (await handle.collection('parts').find({}).sort({ number: 1 }).toArray()).map((p) => p.title);

describe('A54 migration 14: parts numbered from 1 in reading order', () => {
  test('KB-3 A54 partOrderKeys reads parts in the order of their first chapter, an empty part after the one made before it', () => {
    const keys = partOrderKeys(PARTS, CHAPTERS);
    const order = [...PARTS]
      .sort((a, b) => keys.get(a._id)! - keys.get(b._id)!)
      .map((p) => p.title);
    expect(order).toEqual(['An old part', ...EXPECTED.slice(0, 8)]);
    expect(keys.get('P-fangs')).toBe(50.5);
  });

  test('KB-3 A54 opening a version 13 bible numbers the parts 1 to n in reading order, trashed parts last, and records the order', async () => {
    const bible = await v13Bible('mig14');
    const open = await openBibleSession(store, bible.id);
    expect(LATEST_SCHEMA_VERSION).toBe(14);
    expect(await schemaVersion(open.handle)).toBe(14);
    expect(await titlesByNumber(open.handle)).toEqual(EXPECTED);
    const parts = await open.handle.collection('parts').find({}).toArray();
    expect(parts.map((p) => p.number).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(parts.every((p) => p.modifiedAt === AT)).toBe(true);
    const summary = (await open.handle
      .collection('meta')
      .findOne({ _id: MIGRATION14_META_ID as never })) as Migration14Summary | null;
    expect(summary).toMatchObject({ partsRenumbered: 5 });
    expect(summary?.order.map((o) => o.title)).toEqual(EXPECTED);
  });

  test('KB-3 A54 running it again changes nothing', async () => {
    const bible = await v13Bible('mig14-again');
    await openBibleSession(store, bible.id);
    const before = await bible.collection('parts').find({}).sort({ _id: 1 }).toArray();
    const summaryBefore = await bible
      .collection('meta')
      .findOne({ _id: MIGRATION14_META_ID as never });
    await migrations[13]!.up(bible);
    expect(await bible.collection('parts').find({}).sort({ _id: 1 }).toArray()).toEqual(before);
    expect(await bible.collection('meta').findOne({ _id: MIGRATION14_META_ID as never })).toEqual(
      summaryBefore,
    );
  });

  test('KB-3 A54 the fixture as it ships keeps its part numbers', () => {
    const fixture = readFixture();
    const keys = partOrderKeys(fixture.parts!, fixture.chapters!);
    const numbered = [...fixture.parts!]
      .sort((a, b) => keys.get(a._id as string)! - keys.get(b._id as string)!)
      .map((p, i) => [p.number, i + 1]);
    for (const [have, want] of numbered) expect(have).toBe(want);
  });
});
