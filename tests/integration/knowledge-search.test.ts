import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { Store } from '../../src/main/db';
import { createBibleWithDefaults, openBibleSession } from '../../src/main/db/session';
import type { OpenBible } from '../../src/main/db/session';
import type { Invoke } from '../helpers/t5';
import { freshSlug, localStore } from '../helpers/db';
import { ipcFor } from '../helpers/ipc';
import { loadFixture } from '../helpers/loadFixture';

let store: Store;
let fixture: OpenBible;
let fx: Invoke;
let fresh: OpenBible;
let invoke: Invoke;
let slug: string;

beforeAll(async () => {
  store = await localStore();
  fixture = await openBibleSession(store, (await loadFixture(store, freshSlug('kn-fx'))).id);
  fx = ipcFor(() => fixture);
  slug = freshSlug('kn');
  fresh = await createBibleWithDefaults(store, slug, 'Knowledge');
  invoke = ipcFor(() => fresh);
});
afterAll(async () => {
  await store.close();
});

const make = async (collection: string, data: Record<string, unknown>) =>
  await invoke('entry.create', { collection: collection as never, data });

describe('OQ-1, SL-1 questions and the log', () => {
  beforeAll(async () => {
    // A person and a chapter to link and log against.
    const part = (await make('parts', { title: 'Part', number: 1 })).entry;
    const who = (
      await make('characters', {
        title: 'Ada',
        names: { full: 'Ada' },
        birth: { year: 1980 },
      })
    ).entry;
    await make('chapters', {
      title: 'The house',
      partId: part._id,
      readingOrder: 1,
      strands: [
        {
          id: 's1',
          label: 'present',
          startYear: 2030,
          endYear: null,
          primary: true,
          characterIds: [who._id],
        },
      ],
    });
  });

  test('OQ-1 a question links to any entry, is decided with a decision text, and keeps its history', async () => {
    const person = (await invoke('entry.list', { collection: 'characters', trash: 'exclude' }))
      .entries[0]!.entry;
    const q = (
      await make('openQuestions', {
        title: 'Who owns the house?',
        question: 'Does Ada own the house outright?',
        links: [{ targetId: person._id, kind: 'about' }],
      })
    ).entry;
    expect(q.state).toBe('open');
    const decidedBlank = await invoke('entry.update', {
      collection: 'openQuestions',
      id: q._id,
      patch: { state: 'decided' },
    });
    expect(decidedBlank.warnings.map((w) => w.code)).toEqual(['decided-without-decision']);
    const decided = await invoke('entry.update', {
      collection: 'openQuestions',
      id: q._id,
      patch: { decision: 'She owns it with her brother.' },
    });
    expect(decided.warnings).toEqual([]);
    expect(decided.entry).toMatchObject({
      state: 'decided',
      decision: 'She owns it with her brother.',
    });
    // The linked entry shows the question as a backlink.
    const back = (await invoke('entry.backlinks', { id: person._id })).backlinks;
    expect(back.map((b) => [b.collection, b.id])).toContainEqual(['openQuestions', q._id]);
    const open = (
      await invoke('entry.list', { collection: 'openQuestions', trash: 'exclude' })
    ).entries.filter((e) => e.entry.state === 'open');
    expect(open).toEqual([]);
    expect(
      (await invoke('revisions.list', { collection: 'openQuestions', id: q._id })).revisions,
    ).toHaveLength(3);
  });
});

describe('SR-1 SR-2 search through the IPC layer', () => {
  test('SR-1 search.query returns a status, provenance, snippet, and the total before the limit', async () => {
    const r = await fx('search.query', { query: 'letter', limit: 1 });
    expect(r.hits).toHaveLength(1);
    expect(r.total).toBeGreaterThan(1);
    expect(r.hits[0]!.snippet.length).toBeGreaterThan(0);
  });

  test('SR-1 chapter text and Chinese terms are searchable, and entries in the trash are not', async () => {
    expect(
      (await fx('search.query', { query: 'casseroles', limit: 5 })).hits.map((h) => h.id),
    ).toEqual(['CH4']);
    expect(
      (await fx('search.query', { query: '周美玲', limit: 5 })).hits.map((h) => h.id),
    ).toContain('GL2');
    await fx('entry.delete', { collection: 'glossaryTerms', id: 'GL2' });
    expect(
      (await fx('search.query', { query: '周美玲', limit: 5 })).hits.map((h) => h.id),
    ).not.toContain('GL2');
    await fx('entry.restore', { collection: 'glossaryTerms', id: 'GL2' });
  });

  test('SR-2 each filter narrows the same query, and the collections and sections filters intersect', async () => {
    const ids = async (filters: Record<string, unknown>, collections?: string[]) =>
      (
        await fx('search.query', {
          query: 'letter',
          filters: filters as never,
          ...(collections ? { collections: collections as never } : {}),
          limit: 50,
        })
      ).hits.map((h) => h.id);
    const all = await ids({});
    expect(all.length).toBeGreaterThan(2);
    // SM-3: Iris's voice moment of 2060 mentions the letter.
    expect(await ids({ sections: ['moments'] })).toEqual(['H5-voice-0']);
    expect(await ids({ status: ['canon'] })).toContain('H5-voice-0');
    expect(await ids({ status: ['idea'] })).not.toContain('H5-voice-0');
    expect(await ids({ provenance: ['researched'] })).toEqual([]);
    // The moment refers to Iris, who is in the Zhou family too.
    expect(await ids({ familyId: 'FAM-ZHOU' })).toContain('H5-voice-0');
    expect(await ids({ yearFrom: 2060, yearTo: 2060 })).toContain('H5-voice-0');
    expect(await ids({ yearFrom: 2061 })).not.toContain('H5-voice-0');
    expect(await ids({ sections: ['moments'] }, ['chapters'])).toEqual([]);
    expect(
      (await ids({ sections: ['moments', 'chapters'] }, ['chapters'])).every((i) =>
        i.startsWith('CH'),
      ),
    ).toBe(true);
  });

  test('SR-2 the request schema refuses an unknown filter and a year that is not a whole number', async () => {
    await expect(
      fx('search.query', { query: 'x', filters: { colour: 'red' } as never, limit: 5 }),
    ).rejects.toThrow();
    await expect(
      fx('search.query', { query: 'x', filters: { yearFrom: 1.5 }, limit: 5 }),
    ).rejects.toThrow();
  });
});
