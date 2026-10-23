import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { Document } from 'mongodb';
import { REGISTRY, migrate, openBible, schemaVersion } from '../../src/main/db';
import type { BibleHandle, Store } from '../../src/main/db';
import { LATEST_SCHEMA_VERSION, migrations } from '../../src/main/db/migrations';
import { MIGRATION10_META_ID } from '../../src/main/db/migrations/010-markdown-text';
import type { Migration10Summary } from '../../src/main/db/migrations/010-markdown-text';
import { openBibleSession } from '../../src/main/db/session';
import type { OpenBible } from '../../src/main/db/session';
import { MIGRATION10_SNAPSHOT_LABEL } from '../../src/shared/domain/snapshots';
import { entrySchemas, isEntryCollection } from '../../src/shared/schema';
import { readFixture } from '../helpers/loadFixture';
import { freshSlug, localStore } from '../helpers/db';

let store: Store;
let root: string;

beforeAll(async () => {
  store = await localStore();
  root = await mkdtemp(join(tmpdir(), 'nc-mig10-'));
});
afterAll(async () => {
  await store.close();
});

const fixture = readFixture();
const pick = (c: string, id: string) => {
  const d = fixture[c]!.find((x) => x._id === id);
  if (!d) throw new Error(`No fixture ${c} ${id}`);
  return d;
};

/** The HTML the importer wrote before A44 (`blocksToBody`), and its Markdown. */
const ERA_HTML =
  '<h1>The battery years</h1><p>Every block keeps a <strong>battery</strong> and the <em>old grid</em> hums at night.</p><ul><li>Rationed cooling</li><li>Night markets</li></ul><hr><p>Line one<br>Line two</p>';
const ERA_MD =
  '## The battery years\n\nEvery block keeps a **battery** and the *old grid* hums at night.\n\n- Rationed cooling\n- Night markets\n\n---\n\nLine one\nLine two';
const MANUSCRIPT_HTML = '<p>She opened the box.</p><hr><p>Rain &amp; wind.</p>';

/** A bible at schema version 9, as the app stored it before A44, with HTML bodies. */
function v9Data(): Record<string, Document[]> {
  return {
    characters: [
      {
        ...pick('characters', 'H1'),
        role: 'Keeps the letters.',
        body: '<p>A <em>careful</em> woman.</p>',
        backstory:
          '<h2>Early years</h2><p>Born in Portland.</p><ol><li>School</li><li>Work</li></ol>',
      },
      {
        ...pick('characters', 'H2'),
        backstory: '<p>In the trash, but <strong>converted</strong>.</p>',
        deletedAt: '2026-02-01T00:00:00.000Z',
      },
    ],
    eraStates: [
      {
        _id: 'ERA-A44',
        title: 'The battery years',
        name: 'The battery years',
        startYear: 2040,
        endYear: 2049,
        body: ERA_HTML,
        status: 'planned',
        provenance: 'invented',
        createdAt: '2026-01-15T09:00:00.000Z',
        modifiedAt: '2026-01-15T09:00:00.000Z',
      },
    ],
    places: [
      {
        ...pick('places', 'PLC1'),
        descriptions: [
          { startYear: null, endYear: null, text: '<p>A <em>rainy</em> river city.</p>' },
        ],
      },
    ],
    chapters: [
      {
        ...pick('chapters', fixture.chapters![0]!._id),
        manuscriptText: MANUSCRIPT_HTML,
        summary: '<p>The box is opened.</p>',
        sceneNote: 'Plain text stays as it is: 3 < 4, *really*.',
      },
    ],
  };
}

async function v9Bible(label: string): Promise<BibleHandle> {
  const slug = freshSlug(label);
  await store.db.collection(REGISTRY).insertOne({
    _id: slug as never,
    name: 'Before A44',
    createdAt: '2026-01-15T09:00:00.000Z',
    schemaVersion: 0,
  });
  const bible = await openBible(store, slug);
  await migrate(bible, migrations.slice(0, 9));
  for (const [c, docs] of Object.entries(v9Data())) {
    if (!isEntryCollection(c)) throw new Error(c);
    const parsed = docs.map((d) => entrySchemas[c].parse(d) as Document);
    await bible.collection(c).deleteMany({});
    await bible.collection(c).insertMany(parsed);
  }
  await bible.collection('revisions').insertOne({
    _id: 'REV-H1' as never,
    collection: 'characters',
    entryId: 'H1',
    at: '2026-01-15T09:00:00.000Z',
    prior: { backstory: '<p>An older backstory.</p>' },
  });
  return bible;
}

const get = (open: OpenBible, c: string, id: string) =>
  open.handle.collection(c).findOne({ _id: id as never }) as Promise<Document>;

describe('A44 migration 10 on a version 9 bible', () => {
  let open: OpenBible;
  let bible: BibleHandle;
  beforeAll(async () => {
    bible = await v9Bible('mig10');
    expect(await schemaVersion(bible)).toBe(9);
    open = await openBibleSession(store, bible.id, { snapshotRoot: root });
  });

  test('A44 opening takes a snapshot of the HTML first, then runs migration 10', async () => {
    expect(LATEST_SCHEMA_VERSION).toBe(12);
    expect(await schemaVersion(open.handle)).toBe(12);
    const before = (await open.snapshots!.list()).find((s) => s.reason === 'migration')!;
    expect(before).toMatchObject({ label: MIGRATION10_SNAPSHOT_LABEL, schemaVersion: 9 });
    const data = await open.snapshots!.read(before.id);
    expect(data.collections.eraStates!.find((e) => e._id === 'ERA-A44')!.body).toBe(ERA_HTML);
  });

  test('A44 every HTML body becomes Markdown, nested and trashed ones too', async () => {
    expect((await get(open, 'eraStates', 'ERA-A44')).body).toBe(ERA_MD);
    const h1 = await get(open, 'characters', 'H1');
    expect(h1.body).toBe('A *careful* woman.');
    expect(h1.backstory).toBe('## Early years\n\nBorn in Portland.\n\n1. School\n2. Work');
    expect(h1.role).toBe('Keeps the letters.');
    expect((await get(open, 'characters', 'H2')).backstory).toBe(
      'In the trash, but **converted**.',
    );
    expect((await get(open, 'places', 'PLC1')).descriptions[0].text).toBe('A *rainy* river city.');
    const chapter = await get(open, 'chapters', fixture.chapters![0]!._id);
    expect(chapter.summary).toBe('The box is opened.');
    expect(chapter.sceneNote).toBe('Plain text stays as it is: 3 < 4, *really*.');
  });

  test('A44 the manuscript text, the history and the modified times are left as they were', async () => {
    const chapter = await get(open, 'chapters', fixture.chapters![0]!._id);
    expect(chapter.manuscriptText).toBe(MANUSCRIPT_HTML);
    expect((await get(open, 'revisions', 'REV-H1')).prior.backstory).toBe(
      '<p>An older backstory.</p>',
    );
    expect((await get(open, 'eraStates', 'ERA-A44')).modifiedAt).toBe('2026-01-15T09:00:00.000Z');
  });

  test('A44 the summary in meta counts what changed, and search reads the Markdown as words', async () => {
    const summary = (await get(open, 'meta', MIGRATION10_META_ID)) as unknown as Migration10Summary;
    expect(summary.documents).toEqual({ characters: 2, eraStates: 1, places: 1, chapters: 1 });
    expect(summary.fields).toMatchObject({
      'characters.body': 1,
      'characters.backstory': 2,
      'eraStates.body': 1,
      'places.descriptions.n.text': 1,
      'chapters.summary': 1,
    });
    expect(summary.fields['chapters.manuscriptText']).toBeUndefined();
    expect(open.search.search('battery').map((h) => h.id)).toContain('ERA-A44');
    expect(open.repo.get('eraStates', 'ERA-A44')!.body).toBe(ERA_MD);
  });

  test('A44 running it again changes nothing, and a bible at version 10 is not snapshotted again', async () => {
    const era = await get(open, 'eraStates', 'ERA-A44');
    await migrations[9]!.up(open.handle);
    expect(await get(open, 'eraStates', 'ERA-A44')).toEqual(era);
    await openBibleSession(store, bible.id, { snapshotRoot: root });
    expect((await open.snapshots!.list()).filter((s) => s.reason === 'migration')).toHaveLength(1);
  });
});
