import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { Document } from 'mongodb';
import { REGISTRY, createBible, migrate, openBible, schemaVersion } from '../../src/main/db';
import type { BibleHandle, Store } from '../../src/main/db';
import { LATEST_SCHEMA_VERSION, migrations } from '../../src/main/db/migrations';
import { MIGRATION13_META_ID, REMOVED_FIELDS } from '../../src/main/db/migrations/013-cuts';
import type { Migration13Summary } from '../../src/main/db/migrations/013-cuts';
import { openBibleSession } from '../../src/main/db/session';
import type { OpenBible } from '../../src/main/db/session';
import { MIGRATION13_SNAPSHOT_LABEL } from '../../src/shared/domain/snapshots';
import { ENTRY_COLLECTIONS, entrySchemas, isEntryCollection } from '../../src/shared/schema';
import { freshSlug, localStore } from '../helpers/db';
import { readFixture } from '../helpers/loadFixture';

let store: Store;
let root: string;

beforeAll(async () => {
  store = await localStore();
  root = await mkdtemp(join(tmpdir(), 'nc-mig13-'));
});
afterAll(async () => {
  await store.close();
});

const fixture = readFixture();
const AT = '2026-01-15T09:00:00.000Z';
const TRASHED = '2026-02-01T00:00:00.000Z';

/** The six fields as a version 12 bible stored them on an entry. */
const SIX = {
  status: 'canon',
  provenance: 'invented',
  sourceNote: 'From the workbook',
  sourceRef: 'East_Winds_World.xlsx#Characters!A3',
  tags: ['audit'],
  links: [{ targetId: 'H1', kind: 'mentions' }],
};

const question = (id: string, extra: Document = {}) => ({
  _id: id,
  title: `Question ${id}`,
  body: '',
  question: 'Who knows?',
  state: 'open',
  decision: '',
  status: 'idea',
  provenance: null,
  sourceNote: '',
  sourceRef: '',
  tags: [],
  links: [],
  createdAt: AT,
  modifiedAt: AT,
  ...extra,
});

/** Questions beside the fixture's, one for each case of steps 1 and 2. */
const QUESTIONS = [
  // Step 1: an audit question and an import question go to the trash.
  question('Q-AUDIT', { tags: ['audit'], links: [{ targetId: 'H1', kind: 'about' }] }),
  question('Q-IMPORT', { tags: ['capture', 'import conflict'] }),
  // An offline capture question and an untagged one stay live.
  question('Q-CAPTURE', { tags: ['capture'] }),
  question('Q-PLAIN'),
  // Already in the trash: its trash time is kept.
  question('Q-OLD', { tags: ['audit'], deletedAt: TRASHED }),
  // Step 2: the unique targets of the links, any kind, in order.
  question('Q-LINKED', {
    links: [
      { targetId: 'H1', kind: 'about' },
      { targetId: 'E1', kind: 'mentions' },
      { targetId: 'H1', kind: 'conflict' },
    ],
  }),
  // A question that already has what it is about keeps it.
  question('Q-ABOUT', { aboutIds: ['Z1'], links: [{ targetId: 'H2', kind: 'about' }] }),
];

/** Documents in the collections migration 13 drops. */
const DROPPED = {
  revisions: [
    { _id: 'REV-1', collection: 'characters', entryId: 'H1', op: 'update', at: AT, prior: {} },
    { _id: 'REV-2', collection: 'characters', entryId: 'H2', op: 'update', at: AT, prior: {} },
  ],
  importSources: [{ _id: 'H1', collection: 'characters', fields: [] }],
  briefs: [{ _id: 'BR1', title: 'A brief', content: 'Text', createdAt: AT, modifiedAt: AT }],
  sessionLogs: [{ _id: 'SL1', title: 'A session', date: '2026-10-01', createdAt: AT }],
  books: [
    { _id: 'BK1', title: 'Book One', number: 1, createdAt: AT, modifiedAt: AT },
    { _id: 'BK2', title: 'Book Two', number: 2, createdAt: AT, modifiedAt: AT },
  ],
};

/**
 * The fixture as a version 12 bible stored it: every entry carries the six
 * fields (trashed ones too), parts name their book, the three lists and the
 * import and Drive meta documents are there, and so are the collections
 * migration 13 drops.
 */
async function v12Bible(label: string): Promise<BibleHandle> {
  const slug = freshSlug(label);
  await store.db.collection(REGISTRY).insertOne({
    _id: slug as never,
    name: 'Before A53',
    createdAt: AT,
    schemaVersion: 0,
  });
  const bible = await openBible(store, slug);
  await migrate(bible, migrations.slice(0, 12));
  for (const [c, raw] of Object.entries(fixture)) {
    if (!isEntryCollection(c) || raw.length === 0) continue;
    const docs: Document[] = raw.map((d, i) => ({
      ...d,
      ...SIX,
      // The first entry of each collection is in the trash.
      ...(i === 0 ? { deletedAt: TRASHED } : {}),
      ...(c === 'parts' ? { bookId: 'BK1' } : {}),
    }));
    await bible.collection(c).insertMany(docs);
  }
  await bible.collection('openQuestions').insertMany(QUESTIONS as Document[]);
  for (const [c, docs] of Object.entries(DROPPED)) {
    await bible.collection(c).insertMany(docs as Document[]);
  }
  type Named = { _id: string } & Document;
  const lists = bible.collection<Named>('lists');
  for (const l of fixture.lists!) await lists.replaceOne({ _id: l._id }, l, { upsert: true });
  await lists.replaceOne(
    { _id: 'tags' },
    {
      _id: 'tags',
      label: 'Tags',
      items: [
        { id: 'audit', label: 'audit', parentId: null, color: null, extra: {} },
        { id: 'capture', label: 'capture', parentId: null, color: null, extra: {} },
      ],
    },
    { upsert: true },
  );
  const meta = bible.collection<Named>('meta');
  await meta.insertMany([
    { _id: 'importMappings', mappings: [{ key: 'w.xlsx#People', mapping: {} }] },
    { _id: 'drive', linked: [] },
    { _id: 'briefSettings', window: 3, budget: 40000 },
  ]);
  return bible;
}

const dump = async (handle: BibleHandle) => {
  const out: Record<string, Document[]> = {};
  for (const name of await handle.collectionNames()) {
    out[name] = await handle.collection(name).find({}).sort({ _id: 1 }).toArray();
  }
  return out;
};

describe('A53 migration 13 on a copy of the fixture at version 12', () => {
  let open: OpenBible;
  let bible: BibleHandle;
  let listsBefore: Document[];
  beforeAll(async () => {
    bible = await v12Bible('mig13');
    expect(await schemaVersion(bible)).toBe(12);
    listsBefore = await bible.collection('lists').find({}).sort({ _id: 1 }).toArray();
    expect(listsBefore.map((l) => l._id)).toEqual(
      expect.arrayContaining(['statuses', 'provenance', 'tags']),
    );
    const parts = await bible.collection('parts').indexes();
    expect(parts.map((i) => i.key)).toContainEqual({ bookId: 1, number: 1 });
    open = await openBibleSession(store, bible.id, { snapshotRoot: root });
  });

  test('A53 opening takes a snapshot of the version 12 bible first, then runs migration 13', async () => {
    expect(LATEST_SCHEMA_VERSION).toBe(13);
    expect(await schemaVersion(open.handle)).toBe(13);
    const before = (await open.snapshots!.list()).filter((s) => s.reason === 'migration');
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({ label: MIGRATION13_SNAPSHOT_LABEL, schemaVersion: 12 });
    const data = await open.snapshots!.read(before[0]!.id);
    // The snapshot holds every removed value and every dropped collection.
    expect(data.collections.characters!.every((c) => c.status === 'canon')).toBe(true);
    expect(data.collections.revisions).toHaveLength(2);
    expect(data.collections.books).toHaveLength(2);
    expect(data.collections.lists!.map((l) => l._id)).toContain('tags');
  });

  test('A53 step 1: live questions tagged with anything but capture go to the trash; capture and untagged ones stay', async () => {
    const q = (id: string) => open.handle.collection('openQuestions').findOne({ _id: id as never });
    for (const id of ['Q-AUDIT', 'Q-IMPORT']) {
      const doc = await q(id);
      expect(doc!.deletedAt, id).toEqual(expect.any(String));
      expect(doc!.deletedAt, id).not.toBe(TRASHED);
      expect(doc!.modifiedAt, id).toBe(AT);
    }
    expect((await q('Q-OLD'))!.deletedAt).toBe(TRASHED);
    for (const id of ['Q-CAPTURE', 'Q-PLAIN', 'Q-LINKED', 'Q-ABOUT']) {
      expect(await q(id), id).not.toHaveProperty('deletedAt');
    }
    expect(open.repo.get('openQuestions', 'Q-CAPTURE')).toBeDefined();
    expect(open.repo.get('openQuestions', 'Q-AUDIT')).toBeUndefined();
    // The fixture's own entries were tagged too, but only questions are trashed.
    expect(open.repo.get('characters', 'H2')).toBeDefined();
  });

  test('A53 step 2: questions keep what they were linked to as About, unique and in order', async () => {
    const q = (id: string) => open.repo.get('openQuestions', id, { includeDeleted: true })!;
    expect(q('Q-LINKED').aboutIds).toEqual(['H1', 'E1']);
    expect(q('Q-AUDIT').aboutIds).toEqual(['H1']);
    expect(q('Q-PLAIN').aboutIds).toEqual([]);
    expect(q('Q-ABOUT').aboutIds).toEqual(['Z1']);
    // About is a reference field, so the question is found from what it is about.
    expect(open.repo.backlinks('E1').map((b) => b.id)).toContain('Q-LINKED');
  });

  test('A53 step 3: the six fields are gone from every entry, live and trashed, in every collection', async () => {
    let trashed = 0;
    for (const c of ENTRY_COLLECTIONS) {
      for (const d of await open.handle.collection(c).find({}).toArray()) {
        for (const f of REMOVED_FIELDS) expect(d, `${c} ${String(d._id)}`).not.toHaveProperty(f);
        if (d.deletedAt) trashed++;
        expect(d.modifiedAt, `${c} ${String(d._id)}`).toBe(AT);
      }
    }
    expect(trashed).toBeGreaterThan(10);
    // Every entry is one the app can store.
    for (const c of ENTRY_COLLECTIONS) {
      for (const d of await open.handle.collection(c).find({}).toArray()) {
        const r = entrySchemas[c].safeParse(d);
        expect(r.success, `${c} ${String(d._id)} ${r.error?.message ?? ''}`).toBe(true);
      }
    }
  });

  test('A53 step 4: parts lose their book and the book index goes', async () => {
    const parts = await open.handle.collection('parts').find({}).toArray();
    expect(parts.length).toBe(fixture.parts!.length);
    for (const p of parts) expect(p).not.toHaveProperty('bookId');
    const indexes = await open.handle.collection('parts').indexes();
    expect(indexes.map((i) => i.key)).not.toContainEqual({ bookId: 1, number: 1 });
  });

  test('A53 step 5: revisions, import sources, briefs, session logs and books are dropped', async () => {
    const names = await open.handle.collectionNames();
    for (const c of Object.keys(DROPPED)) expect(names, c).not.toContain(c);
  });

  test('A53 step 6: the three lists and the import and Drive meta documents go; every other list and the brief settings stay', async () => {
    const lists = await open.handle.collection('lists').find({}).sort({ _id: 1 }).toArray();
    const ids = lists.map((l) => l._id);
    for (const gone of ['statuses', 'provenance', 'tags']) expect(ids).not.toContain(gone);
    expect(ids).toEqual(expect.arrayContaining(['momentKinds', 'regions', 'ageGroups']));
    expect(lists).toEqual(
      listsBefore.filter((l) => !['statuses', 'provenance', 'tags'].includes(String(l._id))),
    );
    const meta = open.handle.collection('meta');
    expect(await meta.findOne({ _id: 'importMappings' as never })).toBeNull();
    expect(await meta.findOne({ _id: 'drive' as never })).toBeNull();
    expect(await meta.findOne({ _id: 'briefSettings' as never })).toMatchObject({
      window: 3,
      budget: 40000,
    });
  });

  test('A53 step 7: the summary in meta counts what each step did', async () => {
    const summary = (await open.handle
      .collection('meta')
      .findOne({ _id: MIGRATION13_META_ID as never })) as unknown as Migration13Summary;
    const fixtureQuestions = fixture.openQuestions?.length ?? 0;
    expect(summary).toMatchObject({
      questionsTrashed: 2 + (fixtureQuestions > 0 ? fixtureQuestions - 1 : 0),
      partsUnlinked: fixture.parts!.length,
      dropped: { revisions: 2, importSources: 1, briefs: 1, sessionLogs: 1, books: 2 },
    });
    expect(summary.questionsAbout).toBe(QUESTIONS.length - 1 + fixtureQuestions);
    for (const c of ENTRY_COLLECTIONS) {
      const stored = (fixture[c]?.length ?? 0) + (c === 'openQuestions' ? QUESTIONS.length : 0);
      expect(summary.fieldsCleared[c] ?? 0, c).toBe(stored);
    }
    const before = (n: string) =>
      (listsBefore.find((l) => l._id === n)?.items as unknown[] | undefined)?.length ?? 0;
    expect(summary.listsRemoved).toEqual({
      statuses: before('statuses'),
      provenance: before('provenance'),
      tags: 2,
    });
    expect(summary.listsRemoved.statuses).toBeGreaterThan(0);
    expect(summary.takenAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test('A53 running it again changes nothing, and a bible at version 13 is not snapshotted again', async () => {
    const before = await dump(open.handle);
    await migrations[12]!.up(open.handle);
    expect(await dump(open.handle)).toEqual(before);
    await openBibleSession(store, bible.id, { snapshotRoot: root });
    expect((await open.snapshots!.list()).filter((s) => s.reason === 'migration')).toHaveLength(1);
  });
});

describe('A53 migration 13 on the fixture as it ships', () => {
  test('A53 a new bible ends at version 13 with none of what migration 13 removes', async () => {
    const handle = await createBible(store, freshSlug('mig13-new'), 'New');
    expect(await schemaVersion(handle)).toBe(13);
    const names = await handle.collectionNames();
    for (const c of Object.keys(DROPPED)) expect(names, c).not.toContain(c);
    const lists = (await handle.collection('lists').find({}).toArray()).map((l) => l._id);
    for (const gone of ['statuses', 'provenance', 'tags']) expect(lists).not.toContain(gone);
    expect(lists).toContain('momentKinds');
    const summary = await handle.collection('meta').findOne({ _id: MIGRATION13_META_ID as never });
    expect(summary).toMatchObject({ questionsTrashed: 0, partsUnlinked: 0 });
  });
});
