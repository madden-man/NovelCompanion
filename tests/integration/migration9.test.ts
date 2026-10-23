import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { Document } from 'mongodb';
import { REGISTRY, createBible, migrate, openBible, schemaVersion } from '../../src/main/db';
import type { BibleHandle, Store } from '../../src/main/db';
import { LATEST_SCHEMA_VERSION, migrations } from '../../src/main/db/migrations';
import {
  DROPPED_COLLECTIONS,
  MIGRATION9_META_ID,
} from '../../src/main/db/migrations/009-simplified-model';
import type { Migration9Summary } from '../../src/main/db/migrations/009-simplified-model';
import { openBibleSession } from '../../src/main/db/session';
import type { OpenBible } from '../../src/main/db/session';
import { dumpBible } from '../../src/main/backup/dump';
import { importBibleJson } from '../../src/main/backup/json';
import { restoreSnapshot } from '../../src/main/backup/restore';
import { MIGRATION9_SNAPSHOT_LABEL } from '../../src/shared/domain/snapshots';
import { entrySchemas, isEntryCollection } from '../../src/shared/schema';
import { freshSlug, localStore } from '../helpers/db';

let store: Store;
let root: string;

beforeAll(async () => {
  store = await localStore();
  root = await mkdtemp(join(tmpdir(), 'nc-mig9-'));
});
afterAll(async () => {
  await store.close();
});

const AT = '2026-01-15T09:00:00.000Z';
const base = { body: '', status: 'canon', createdAt: AT, modifiedAt: AT };

/** A version 8 bible as the app stored it before A39, with every collection the migration drops. */
function v8Data(): Record<string, Document[]> {
  return {
    characters: [
      {
        ...base,
        _id: 'H1',
        title: 'Margaret Hale',
        provenance: 'invented',
        sourceRef: '',
        names: {
          full: 'Margaret Hale',
          order: 'family-last',
          birthName: 'Margaret Doyle',
          nicknames: ['Maggie'],
          calledBy: [{ characterId: 'H5', name: 'Gran' }],
        },
        birth: { year: 1958 },
        death: { year: 2041 },
        birthplace: 'Portland, Oregon',
        familyIds: [],
        backstory: 'A schoolteacher.',
        voiceNotes: [{ at: { age: 70 }, text: 'Short, dry sentences.' }],
        placesLived: [
          { place: 'Portland, Oregon', startYear: 1958, endYear: null },
          { place: 'Nowhere yet', startYear: null, endYear: null },
        ],
        backstoryMarks: [{ key: 'a schoolteacher', pinned: true }],
        links: [],
      },
      {
        ...base,
        _id: 'U1',
        title: 'The Archivist',
        names: { full: 'The Archivist', order: 'family-last', nicknames: [], calledBy: [] },
        birth: { unknown: true },
        death: null,
        voiceNotes: [
          { at: { age: 40 }, text: 'Whispers.' },
          { at: { year: 2075 }, text: 'Speaks in riddles.' },
        ],
        placesLived: [],
        links: [],
      },
      {
        ...base,
        _id: 'GONE',
        title: 'A character in the trash',
        names: { full: 'Gone', order: 'family-last' },
        birth: { year: 2000 },
        voiceNotes: [{ at: { year: 2020 }, text: 'Quiet.' }],
        deletedAt: AT,
        links: [],
      },
    ],
    plotBeats: [
      {
        ...base,
        _id: 'B1',
        title: 'Margaret hides the letter',
        status: 'planned',
        provenance: 'invented',
        tags: ['Hale'],
        arcIds: ['ARC1'],
        arcOrders: [{ arcId: 'ARC1', order: 1 }],
        chapterId: 'CH1',
        year: 2032,
        povCharacterId: 'H1',
        description: '',
        worldContext: 'Floods on the Columbia.',
        experienceNote: 'She is afraid of it.',
        links: [{ targetId: 'E1', kind: 'mentions' }],
      },
      {
        ...base,
        _id: 'B2',
        title: 'A beat in the trash',
        arcIds: [],
        year: 2035,
        povCharacterId: 'H1',
        deletedAt: AT,
      },
      { ...base, _id: 'B3', title: 'A beat with no point of view', arcIds: [], year: 2040 },
    ],
    facts: [{ ...base, _id: 'F1', title: 'The letter', tags: ['secret'] }],
    knowledgeRecords: [
      {
        ...base,
        _id: 'K1',
        title: 'Margaret knows',
        factId: 'F1',
        characterId: 'H1',
        yearLearned: 2030,
      },
    ],
    themes: [
      { ...base, _id: 'TH1', title: 'Water', appearances: [{ chapterId: 'CH1', note: 'Rain' }] },
    ],
    customSections: [{ _id: 'CS1', name: 'Recipes', fields: [], createdAt: AT, modifiedAt: AT }],
    customEntries: [{ ...base, _id: 'CE1', title: 'Soup', sectionId: 'CS1', values: {} }],
    arcs: [{ ...base, _id: 'ARC1', title: 'The secret', name: 'The secret', scope: 'book' }],
    relationships: [
      { ...base, _id: 'R1', title: 'Friends', characterIds: ['H1', 'U1'], type: 'friend' },
    ],
    worldEvents: [
      {
        ...base,
        _id: 'E1',
        title: 'The flood',
        start: { year: 2034 },
        end: null,
        reality: 'invented',
        categoryId: 'climate',
        regions: [],
        placeIds: ['PL1'],
        characterIds: [],
        formative: true,
      },
    ],
    eraStates: [
      {
        ...base,
        _id: 'ERA1',
        title: 'The thirties',
        name: 'The thirties',
        startYear: 2030,
        endYear: 2039,
        body: 'Home robots.',
        technology: 'Robots everywhere.',
        climate: '',
        economy: '',
        politics: 'Trade talks.',
        dailyLife: '',
      },
    ],
    culturalEntries: [
      {
        ...base,
        _id: 'CU1',
        title: 'Mooncakes',
        body: 'Boxes at work.',
        communityId: 'guangzhou',
        startYear: 1980,
        endYear: 2039,
        generationNotes: 'Grandparents make them by hand.',
      },
    ],
    chapters: [
      {
        ...base,
        _id: 'CH1',
        title: 'After the Funeral',
        partId: 'PT1',
        readingOrder: 1,
        strands: [
          {
            id: 'CH1-present',
            label: 'present',
            startYear: 2032,
            endYear: null,
            primary: true,
            povCharacterId: 'H1',
            characterIds: ['H1'],
            placeIds: [],
          },
        ],
        arcIds: ['ARC1'],
        factsInPlay: [{ factId: 'F1', characterId: 'H1', note: '' }],
        links: [],
      },
    ],
    openQuestions: [
      {
        ...base,
        _id: 'Q1',
        title: 'Who wrote it?',
        question: 'Who wrote the letter?',
        state: 'open',
        decision: '',
        links: [
          { targetId: 'F1', kind: 'about' },
          { targetId: 'B1', kind: 'about' },
          { targetId: 'H1', kind: 'about' },
        ],
      },
    ],
    revisions: [
      {
        _id: 'REV-F1',
        collection: 'facts',
        entryId: 'F1',
        op: 'create',
        at: AT,
        prior: null,
      },
      {
        _id: 'REV-H1',
        collection: 'characters',
        entryId: 'H1',
        op: 'update',
        at: AT,
        prior: { _id: 'H1', title: 'Margaret', voiceNotes: [], birthplace: 'Salem' },
      },
    ],
    proposals: [
      {
        _id: 'P1',
        source: 'claude',
        op: 'create',
        collection: 'facts',
        targetId: null,
        data: { title: 'Another fact' },
        state: 'pending',
        createdAt: AT,
      },
      {
        _id: 'P2',
        source: 'claude',
        op: 'update',
        collection: 'characters',
        targetId: 'H1',
        data: { backstory: 'A teacher.' },
        state: 'pending',
        createdAt: AT,
      },
    ],
    meta: [
      {
        _id: 'importMappings',
        mappings: [
          { key: 'w.xlsx#Sullivan', mapping: { target: { collection: 'plotBeats' } } },
          { key: 'w.xlsx#People', mapping: { target: { collection: 'characters' } } },
        ],
      },
    ],
  };
}

/** Register a bible at schema version 8 and fill it with the data the app held before A39. */
async function v8Bible(
  label: string,
  extra: Record<string, Document[]> = {},
): Promise<BibleHandle> {
  const slug = freshSlug(label);
  await store.db.collection(REGISTRY).insertOne({
    _id: slug as never,
    name: 'Before A39',
    createdAt: AT,
    schemaVersion: 0,
  });
  const bible = await openBible(store, slug);
  await migrate(bible, migrations.slice(0, 8));
  const data = v8Data();
  for (const [c, docs] of Object.entries(extra)) data[c] = [...(data[c] ?? []), ...docs];
  for (const [c, docs] of Object.entries(data)) {
    await bible.collection(c).insertMany(docs);
  }
  return bible;
}

const doc = (open: OpenBible, c: string, id: string) =>
  open.handle.collection(c).findOne({ _id: id as never });

describe('SM-2 SM-3 migration 9 on a version 8 bible', () => {
  let open: OpenBible;
  let bible: BibleHandle;
  beforeAll(async () => {
    bible = await v8Bible('mig9');
    expect(await schemaVersion(bible)).toBe(8);
    open = await openBibleSession(store, bible.id, { snapshotRoot: root });
  });

  test('SM-2 opening takes a snapshot first, and it holds every document the migration drops', async () => {
    const snaps = await open.snapshots!.list();
    const before = snaps.find((s) => s.reason === 'migration')!;
    expect(before).toMatchObject({ label: MIGRATION9_SNAPSHOT_LABEL, schemaVersion: 8 });
    const data = await open.snapshots!.read(before.id);
    const seeded = v8Data();
    for (const c of DROPPED_COLLECTIONS) {
      expect(
        data.collections[c]!.map((d) => d._id),
        c,
      ).toEqual(seeded[c]!.map((d) => d._id));
    }
    // The characters are in it as they were, voice notes and places lived included.
    expect(data.collections.characters!.find((c) => c._id === 'H1')).toMatchObject({
      voiceNotes: [{ at: { age: 70 }, text: 'Short, dry sentences.' }],
      birthplace: 'Portland, Oregon',
    });
    // A bible already at version 9 is not snapshotted again on the next open.
    await openBibleSession(store, bible.id, { snapshotRoot: root });
    expect((await open.snapshots!.list()).filter((s) => s.reason === 'migration')).toHaveLength(1);
  });

  test('SM-3 every beat, voice note, and place lived becomes a moment, the trash carried over', async () => {
    expect(await schemaVersion(bible)).toBe(LATEST_SCHEMA_VERSION);
    // A44, A47 and A51: migrations 10, 11 and 12 run after it.
    expect(LATEST_SCHEMA_VERSION).toBe(12);
    const moments = await open.handle.collection('moments').find({}).sort({ _id: 1 }).toArray();
    expect(
      moments.map((m) => [m._id, m.characterId, m.year, m.endYear, m.title, !!m.deletedAt]),
    ).toEqual([
      ['B1', 'H1', 2032, null, 'Margaret hides the letter', false],
      ['B2', 'H1', 2035, null, 'A beat in the trash', true],
      ['GONE-voice-0', 'GONE', 2020, null, 'Voice', true],
      ['H1-lives-0', 'H1', 1958, null, 'Lives in Portland, Oregon', false],
      ['H1-voice-0', 'H1', 2028, null, 'Voice', false],
      ['U1-voice-1', 'U1', 2075, null, 'Voice', false],
    ]);
    expect(moments.find((m) => String(m._id) === 'B1')).toMatchObject({
      body: 'She is afraid of it.',
      worldContext: 'Floods on the Columbia.',
      tags: ['Hale'],
      status: 'planned',
      provenance: 'invented',
      links: [{ targetId: 'E1', kind: 'mentions' }],
      createdAt: AT,
    });
    // Every moment is one the app can store, and the read model holds them.
    for (const m of moments) {
      expect(entrySchemas.moments.safeParse(m).success, String(m._id)).toBe(true);
    }
    expect(
      open.repo
        .list('moments')
        .map((m) => m._id)
        .sort(),
    ).toEqual(['B1', 'H1-lives-0', 'H1-voice-0', 'U1-voice-1']);
    const indexes = await open.handle.collection('moments').indexes();
    expect(indexes.map((i) => i.key)).toContainEqual({ characterId: 1, year: 1 });
  });

  test('SM-1 SM-4 the dropped fields are unset, with era prose and generation notes kept in the body', async () => {
    const h1 = await doc(open, 'characters', 'H1');
    expect(h1!.names).toEqual({ full: 'Margaret Hale' });
    for (const f of ['birthplace', 'voiceNotes', 'placesLived', 'backstoryMarks']) {
      expect(h1, f).not.toHaveProperty(f);
    }
    const e1 = await doc(open, 'worldEvents', 'E1');
    expect(e1).not.toHaveProperty('reality');
    expect(e1).not.toHaveProperty('placeIds');
    const era = await doc(open, 'eraStates', 'ERA1');
    expect(era!.body).toBe(
      'Home robots.\n\nTechnology: Robots everywhere.\n\nPolitics: Trade talks.',
    );
    for (const f of ['technology', 'climate', 'economy', 'politics', 'dailyLife']) {
      expect(era, f).not.toHaveProperty(f);
    }
    const cu = await doc(open, 'culturalEntries', 'CU1');
    expect(cu!.body).toBe('Boxes at work.\n\nGeneration notes: Grandparents make them by hand.');
    expect(cu).not.toHaveProperty('generationNotes');
    const ch = await doc(open, 'chapters', 'CH1');
    expect(ch).not.toHaveProperty('arcIds');
    expect(ch).not.toHaveProperty('factsInPlay');
    // Every remaining entry fits the cut schemas.
    const dump = await dumpBible(open.handle);
    for (const [c, docs] of Object.entries(dump.collections)) {
      if (!isEntryCollection(c)) continue;
      for (const d of docs) {
        const r = entrySchemas[c].safeParse(d);
        expect(r.success, `${c} ${String(d._id)} ${r.error?.message ?? ''}`).toBe(true);
      }
    }
  });

  test('SM-2 the eight collections and their revisions are gone; links, proposals and mappings to them too', async () => {
    const names = await open.handle.collectionNames();
    for (const c of DROPPED_COLLECTIONS) expect(names, c).not.toContain(c);
    const revs = await open.handle.collection('revisions').find({}).toArray();
    expect(revs.map((r) => r._id)).toEqual(['REV-H1']);
    expect(revs[0]!.prior).toEqual({ _id: 'H1', title: 'Margaret' });
    // The link to the fact goes; the link to the beat lands on its moment, which keeps the ID.
    expect((await doc(open, 'openQuestions', 'Q1'))!.links).toEqual([
      { targetId: 'B1', kind: 'about' },
      { targetId: 'H1', kind: 'about' },
    ]);
    expect(open.repo.backlinks('B1').map((b) => b.id)).toContain('Q1');
    expect(await doc(open, 'proposals', 'P1')).toMatchObject({ state: 'rejected' });
    expect(await doc(open, 'proposals', 'P2')).toMatchObject({ state: 'pending' });
    // The mapping list is history after A53; it is read from the meta document as stored.
    const mappings = (await doc(open, 'meta', 'importMappings'))!.mappings as { key: string }[];
    expect(mappings.map((m) => m.key)).toEqual(['w.xlsx#People']);
  });

  test('SM-2 the summary in meta counts what was made, skipped, and dropped', async () => {
    const summary = (await doc(open, 'meta', MIGRATION9_META_ID)) as unknown as Migration9Summary;
    expect(summary.made).toEqual({ fromBeats: 2, fromVoiceNotes: 3, fromPlacesLived: 1, total: 6 });
    expect(summary.madeInTrash).toBe(2);
    expect(summary.skipped).toEqual([
      { source: 'plotBeat', id: 'B3', reason: 'it has no point of view character' },
      { source: 'placeLived', id: 'H1-lives-1', reason: 'Nowhere yet has no start year' },
      {
        source: 'voiceNote',
        id: 'U1-voice-0',
        reason: 'it is set at age 40 and the birth year is unknown',
      },
    ]);
    expect(summary.dropped).toEqual({
      facts: 1,
      knowledgeRecords: 1,
      themes: 1,
      customSections: 1,
      customEntries: 1,
      arcs: 1,
      relationships: 1,
      plotBeats: 3,
    });
    expect(summary).toMatchObject({
      revisionsDropped: 1,
      linksRemoved: 1,
      proposalsRejected: 1,
      mappingsRemoved: 1,
      glossaryMade: 0,
      glossaryFilled: 0,
    });
    expect(summary.takenAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test('SM-2 running migration 9 again changes nothing', async () => {
    const before = await dumpBible(open.handle);
    await store.db
      .collection(REGISTRY)
      .updateOne({ _id: bible.id as never }, { $set: { schemaVersion: 8 } });
    await migrate(open.handle);
    const after = await dumpBible(open.handle);
    expect(after.collections).toEqual(before.collections);
  });

  test('SM-2 BK-1 the snapshot before migration 9 survives thirty later snapshots, which the keep setting prunes', async () => {
    const migration = (await open.snapshots!.list()).find((x) => x.reason === 'migration')!;
    expect(migration.label).toBe(MIGRATION9_SNAPSHOT_LABEL);
    await open.repo.setSnapshotKeep(5);
    try {
      for (let i = 0; i < 30; i++) await open.snapshots!.take('manual', `later ${i}`);
      const list = await open.snapshots!.list();
      // The migration snapshot is kept and not counted: five others remain, the newest five.
      expect(list.filter((x) => x.reason === 'migration').map((x) => x.id)).toEqual([migration.id]);
      expect(list.filter((x) => x.reason !== 'migration').map((x) => x.label)).toEqual([
        'later 29',
        'later 28',
        'later 27',
        'later 26',
        'later 25',
      ]);
    } finally {
      await open.repo.setSnapshotKeep(30);
    }
  });

  test('BK-2 SM-2 restoring the snapshot taken before migration 9 runs it again and ends in the same bible', async () => {
    const migrated = await dumpBible(open.handle);
    await open.repo.create('moments', {
      title: 'Made after the migration',
      characterId: 'H1',
      year: 2030,
    });
    const before = (await open.snapshots!.list()).find((s) => s.reason === 'migration')!;
    const out = await restoreSnapshot(open, before.id);
    expect(out.restored.schemaVersion).toBe(8);
    expect(await schemaVersion(open.handle)).toBe(LATEST_SCHEMA_VERSION);
    const restored = await dumpBible(open.handle);
    for (const c of DROPPED_COLLECTIONS) expect(restored.collections[c], c).toBeUndefined();
    const ids = (d: typeof restored, c: string) =>
      (d.collections[c] ?? []).map((x) => x._id).sort();
    for (const c of [
      'moments',
      'characters',
      'worldEvents',
      'eraStates',
      'chapters',
      'openQuestions',
    ]) {
      expect(ids(restored, c), c).toEqual(ids(migrated, c));
    }
    expect(restored.collections.characters).toEqual(migrated.collections.characters);
    expect(open.repo.list('moments').map((m) => m.title)).not.toContain('Made after the migration');
    // The read model and search follow the restore.
    expect(open.search.search('afraid').map((h) => h.id)).toContain('B1');
  });
});

describe('SM-2 BK-3 an export written before A39 still imports', () => {
  test('SM-2 BK-3 a version 8 export with facts and beats comes in as moments, through migration 9', async () => {
    const collections = v8Data();
    const file = {
      format: 'novel-companion-bible',
      version: 1,
      exportedAt: AT,
      bible: { id: 'old', name: 'Before A39', createdAt: AT, schemaVersion: 8 },
      collections,
    };
    const handle = await createBible(store, freshSlug('mig9-json'), 'Imported');
    const docs = await importBibleJson(handle, JSON.stringify(file));
    expect(await schemaVersion(handle)).toBe(LATEST_SCHEMA_VERSION);
    expect(docs.facts).toBeUndefined();
    expect(docs.plotBeats).toBeUndefined();
    expect(docs.moments!.map((m) => m._id).sort()).toEqual([
      'B1',
      'B2',
      'GONE-voice-0',
      'H1-lives-0',
      'H1-voice-0',
      'U1-voice-1',
    ]);
    const open = await openBibleSession(store, handle.id);
    expect(open.repo.get('moments', 'B1')).toMatchObject({
      characterId: 'H1',
      year: 2032,
      body: 'She is afraid of it.',
    });
    expect(open.repo.get('characters', 'H1')!.names).toEqual({ full: 'Margaret Hale' });
    for (const c of DROPPED_COLLECTIONS) {
      expect(await open.handle.collectionNames(), c).not.toContain(c);
    }
  });
});

describe('SM-1 SM-3 migration 9: the birthplace row and name romanizations', () => {
  let open: OpenBible;
  const zhou = (id: string, full: string, chinese: string, romanization: string) => ({
    ...base,
    _id: id,
    title: full,
    provenance: 'researched',
    sourceRef: `w.xlsx#Characters!${id}`,
    names: { full, chinese, romanization, order: 'family-first', nicknames: [], calledBy: [] },
    birth: { year: 1988 },
    death: null,
    familyIds: [],
    voiceNotes: [],
    placesLived: [],
    links: [],
  });
  beforeAll(async () => {
    const bible = await v8Bible('mig9names', {
      characters: [
        {
          ...zhou('Z3', 'Zhou Lan', '周岚', 'Zhōu Lán'),
          placesLived: [
            { place: 'Guangzhou', startYear: null, endYear: 2027 },
            { place: 'Portland, Oregon', startYear: 2027, endYear: null },
          ],
        },
        zhou('Z1', 'Zhou Meiling', '周美玲', 'Zhōu Měilíng'),
        zhou('Z2', 'Zhou Wei', '周伟', 'Zhōu Wěi'),
      ],
      glossaryTerms: [
        {
          ...base,
          _id: 'GLZ1',
          title: '周美玲',
          characters: '周美玲',
          romanization: '',
          language: 'mandarin',
        },
        {
          ...base,
          _id: 'GLZ2',
          title: '周伟',
          characters: '周伟',
          romanization: 'Zhou Wei',
          language: 'mandarin',
        },
      ],
    });
    open = await openBibleSession(store, bible.id, { snapshotRoot: root });
  });

  test('SM-3 the first place lived with no start year starts at the birth year and is counted as made', async () => {
    expect(await doc(open, 'moments', 'Z3-lives-0')).toMatchObject({
      title: 'Lives in Guangzhou',
      characterId: 'Z3',
      year: 1988,
      endYear: 2027,
    });
    expect(await doc(open, 'moments', 'Z3-lives-1')).toMatchObject({
      title: 'Lives in Portland, Oregon',
      year: 2027,
      endYear: null,
    });
    const summary = (await doc(open, 'meta', MIGRATION9_META_ID)) as unknown as Migration9Summary;
    // H1's Portland, and Lan's two; H1's second place, with no start year, is still skipped.
    expect(summary.made.fromPlacesLived).toBe(3);
    expect(summary.skipped.map((s) => s.id)).toEqual(['B3', 'H1-lives-1', 'U1-voice-0']);
  });

  test('SM-1 a name romanization makes a glossary term, fills an empty one, and leaves one that has its own', async () => {
    expect(await doc(open, 'glossaryTerms', 'Z3-name')).toMatchObject({
      title: '周岚',
      characters: '周岚',
      romanization: 'Zhōu Lán',
      language: 'mandarin',
      meaning: 'Zhou Lan',
      usageNote: 'The name of Zhou Lan',
      status: 'canon',
      provenance: 'researched',
      sourceNote: "Made by migration 9 from the character's romanization",
    });
    expect(await doc(open, 'glossaryTerms', 'GLZ1')).toMatchObject({
      romanization: 'Zhōu Měilíng',
    });
    expect(await doc(open, 'glossaryTerms', 'GLZ2')).toMatchObject({ romanization: 'Zhou Wei' });
    expect(await doc(open, 'glossaryTerms', 'Z1-name')).toBeNull();
    expect(await doc(open, 'glossaryTerms', 'Z2-name')).toBeNull();
    // The romanization is gone from the characters, and the new term is in the read model and search.
    for (const id of ['Z1', 'Z2', 'Z3']) {
      const c = await doc(open, 'characters', id);
      expect(c!.names).toEqual({ full: expect.any(String), chinese: expect.any(String) });
    }
    expect(open.model.get('glossaryTerms', 'Z3-name')).toBeTruthy();
    expect(
      entrySchemas.glossaryTerms.safeParse(await doc(open, 'glossaryTerms', 'Z3-name')).success,
    ).toBe(true);
    const summary = (await doc(open, 'meta', MIGRATION9_META_ID)) as unknown as Migration9Summary;
    expect(summary).toMatchObject({ glossaryMade: 1, glossaryFilled: 1 });
  });

  test('SM-1 running migration 9 again makes no second term', async () => {
    await store.db
      .collection(REGISTRY)
      .updateOne({ _id: open.handle.id as never }, { $set: { schemaVersion: 8 } });
    await migrate(open.handle);
    const terms = await open.handle.collection('glossaryTerms').find({}).toArray();
    expect(terms.filter((t) => t.characters === '周岚')).toHaveLength(1);
  });
});
