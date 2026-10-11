import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { Store } from '../../src/main/db';
import { createBibleWithDefaults, openBibleSession } from '../../src/main/db/session';
import type { OpenBible } from '../../src/main/db/session';
import { ALL_KINDS_SECTION } from '../helpers/t5';
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

describe('KN-1 knowledge through the IPC layer', () => {
  test('KN-1 fact.page, knowledge.whoKnows and knowledge.knownBy answer the fixture questions', async () => {
    const f2 = (await fx('fact.page', { id: 'F2' })).page;
    expect(f2.knowers.map((k) => [k.characterId, k.yearLearned])).toEqual([
      ['H4', 2041],
      ['H5', 2060],
    ]);
    expect(f2.inPlay.map((p) => p.chapterId)).toEqual(['CH6']);
    expect((await fx('knowledge.whoKnows', { factId: 'F2', year: 2050 })).knowers).toHaveLength(1);
    expect((await fx('knowledge.knownBy', { characterId: 'H5', year: 2059 })).facts).toEqual([]);
    expect(
      (await fx('knowledge.knownBy', { characterId: 'H5', year: 2060 })).facts.map((f) => f.factId),
    ).toEqual(['F2']);
    await expect(fx('fact.page', { id: 'nope' })).rejects.toThrow(/No fact/);
  });

  test('KN-1 knowledge.knownBy lists what H5 does not know: not yet in 2059 for the letter, never for the other fact', async () => {
    const labels = async (year: number) =>
      (await fx('knowledge.knownBy', { characterId: 'H5', year })).unknown.map((f) => [
        f.factId,
        f.label,
      ]);
    expect(await labels(2059)).toEqual([
      ['F2', 'not yet in 2059'],
      ['F1', 'never'],
    ]);
    expect(await labels(2060)).toEqual([['F1', 'never']]);
  });

  test('KN-1 the character page lists what H5 does not know in the story-time year', async () => {
    const doesNotKnow = async (year: number) => {
      await fx('storyTime.set', { time: { year } });
      return (await fx('character.page', { id: 'H5' })).page.doesNotKnow.map((f) => [
        f.factId,
        f.label,
      ]);
    };
    expect(await doesNotKnow(2059)).toEqual([
      ['F2', 'not yet in 2059'],
      ['F1', 'never'],
    ]);
    expect(await doesNotKnow(2060)).toEqual([['F1', 'never']]);
    await fx('storyTime.set', { time: null });
  });

  test('KN-1 the character page lists what they know, from the same records', async () => {
    const page = (await fx('character.page', { id: 'Z3' })).page;
    expect(page.knowledge.map((k) => [k.factId, k.yearLearned])).toEqual([['F1', 2028]]);
  });
});

describe('KN-2 a fact learned before birth warns and still saves', () => {
  test('KN-2 recording H5 learning in 2020 returns learned-before-birth and stores the record', async () => {
    const r = await fx('entry.create', {
      collection: 'knowledgeRecords',
      data: {
        title: 'Iris too early',
        status: 'idea',
        factId: 'F1',
        characterId: 'H5',
        yearLearned: 2020,
        how: 'A mistake in the draft.',
      },
    });
    expect(r.warnings.map((w) => [w.path, w.code])).toEqual([
      ['yearLearned', 'learned-before-birth'],
    ]);
    const stored = fixture.repo.get('knowledgeRecords', r.entry._id)!;
    expect(stored.yearLearned).toBe(2020);
    // The same warning comes back when the entry is listed or read later.
    const again = await fx('entry.get', { collection: 'knowledgeRecords', id: r.entry._id });
    expect(again.warnings.map((w) => w.code)).toEqual(['learned-before-birth']);
    // Fixing the year clears it.
    const fixed = await fx('entry.update', {
      collection: 'knowledgeRecords',
      id: r.entry._id,
      patch: { yearLearned: 2060 },
    });
    expect(fixed.warnings).toEqual([]);
  });
});

describe('KN-3 facts in play are stored on the chapter', () => {
  test('KN-3 a chapter keeps who acts on which fact, and chapter.page and fact.page show it', async () => {
    const book = (await make('books', { title: 'Book', status: 'planned', number: 1 })).entry;
    const part = (
      await make('parts', { title: 'Part', status: 'planned', bookId: book._id, number: 1 })
    ).entry;
    const who = (
      await make('characters', {
        title: 'Ada',
        status: 'canon',
        names: { full: 'Ada' },
        birth: { year: 1980 },
      })
    ).entry;
    const fact = (
      await make('facts', { title: 'The deed', status: 'canon', body: 'Who owns the house.' })
    ).entry;
    const chapter = (
      await make('chapters', {
        title: 'The house',
        status: 'planned',
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
      })
    ).entry;
    const updated = await invoke('entry.update', {
      collection: 'chapters',
      id: chapter._id,
      patch: {
        factsInPlay: [{ factId: fact._id, characterId: who._id, note: 'Ada hides the deed.' }],
      },
    });
    expect(updated.warnings).toEqual([]);
    expect((await invoke('chapter.page', { id: chapter._id })).page.factsInPlay).toEqual([
      {
        factId: fact._id,
        fact: 'The deed',
        characterId: who._id,
        character: 'Ada',
        note: 'Ada hides the deed.',
      },
    ]);
    expect((await invoke('fact.page', { id: fact._id })).page.inPlay).toMatchObject([
      { chapterId: chapter._id, character: 'Ada' },
    ]);
    // A fact in play that does not exist is a warning on the field, not a refusal.
    const bad = await invoke('entry.update', {
      collection: 'chapters',
      id: chapter._id,
      patch: { factsInPlay: [{ factId: 'GONE', characterId: who._id, note: '' }] },
    });
    expect(bad.warnings.map((w) => w.code)).toContain('missing-target');
  });
});

describe('TH-1, OQ-1, SL-1 themes, questions, and the log', () => {
  test('TH-1 a theme keeps appearances by chapter, and the chapter page lists the theme with its note', async () => {
    const chapters = (await invoke('entry.list', { collection: 'chapters', trash: 'exclude' }))
      .entries;
    const chapterId = chapters[0]!.entry._id;
    const theme = (
      await make('themes', {
        title: 'Inheritance',
        status: 'idea',
        appearances: [{ chapterId, note: 'The deed changes hands' }],
      })
    ).entry;
    expect((await invoke('chapter.page', { id: chapterId })).page.themes).toEqual([
      { id: theme._id, title: 'Inheritance', note: 'The deed changes hands' },
    ]);
    const bad = await invoke('entry.update', {
      collection: 'themes',
      id: theme._id,
      patch: { appearances: [{ chapterId: 'GONE', note: '' }] },
    });
    expect(bad.warnings.map((w) => w.code)).toContain('missing-target');
  });

  test('OQ-1 a question links to any entry, is decided with a decision text, and keeps its history', async () => {
    const person = (await invoke('entry.list', { collection: 'characters', trash: 'exclude' }))
      .entries[0]!.entry;
    const q = (
      await make('openQuestions', {
        title: 'Who owns the house?',
        status: 'idea',
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

  test('SL-1 the latest log is the newest dated one with a note, survives reopening, and ignores the trash', async () => {
    expect((await invoke('sessionLog.latest', {})).log).toBeNull();
    const chapterId = (await invoke('entry.list', { collection: 'chapters', trash: 'exclude' }))
      .entries[0]!.entry._id;
    await make('sessionLogs', {
      title: 'Session 2026-10-08',
      status: 'canon',
      date: '2026-10-08',
      stoppedAt: 'Start of chapter 1',
    });
    const newest = (
      await make('sessionLogs', {
        title: 'Session 2026-10-09',
        status: 'canon',
        date: '2026-10-09',
        chapterId,
        stoppedAt: 'Ada at the door',
      })
    ).entry;
    const latest = (await invoke('sessionLog.latest', {})).log!;
    expect(latest).toMatchObject({
      id: newest._id,
      date: '2026-10-09',
      stoppedAt: 'Ada at the door',
      chapter: 'The house',
    });
    const reopened = await openBibleSession(store, slug);
    expect((await ipcFor(() => reopened)('sessionLog.latest', {})).log!.id).toBe(newest._id);
    await invoke('entry.delete', { collection: 'sessionLogs', id: newest._id });
    expect((await invoke('sessionLog.latest', {})).log!.stoppedAt).toBe('Start of chapter 1');
  });
});

describe('CS-1 to CS-3 custom sections', () => {
  let sectionId: string;
  let entryId: string;

  test('CS-1 a section with a field of every kind and a brief rule saves through the IPC layer', async () => {
    const s = (
      await make('customSections', {
        name: 'Songs',
        fields: ALL_KINDS_SECTION,
        briefRule: 'storyYear',
      })
    ).entry;
    sectionId = s._id;
    expect(s.briefRule).toBe('storyYear');
    expect((s.fields as unknown[]).map((f) => (f as { type: string }).type)).toEqual([
      'text',
      'longText',
      'number',
      'year',
      'yearRange',
      'singleChoice',
      'tags',
      'link',
    ]);
    const changed = await invoke('entry.update', {
      collection: 'customSections',
      id: sectionId,
      patch: { briefRule: 'always' },
    });
    expect(changed.entry.briefRule).toBe('always');
  });

  test('CS-2 a custom entry has the common fields, status, provenance, links, revisions, and trash', async () => {
    const link = (await make('facts', { title: 'Song fact', status: 'canon' })).entry;
    const e = (
      await make('customEntries', {
        title: 'The harbor lullaby',
        status: 'canon',
        provenance: 'researched',
        sourceNote: 'Sung by Peter',
        sectionId,
        links: [{ targetId: link._id, kind: 'mentions' }],
        values: {
          f_text: 'Portland',
          f_long: 'Sung at the dock when the ferry leaves.',
          f_number: 3,
          f_year: 1991,
          f_range: { startYear: 1980, endYear: 1999 },
          f_choice: 'Holiday',
          f_tags: ['lullaby'],
          f_link: link._id,
        },
      })
    ).entry;
    entryId = e._id;
    expect(e).toMatchObject({ status: 'canon', provenance: 'researched' });
    await invoke('entry.update', {
      collection: 'customEntries',
      id: entryId,
      patch: { status: 'planned' },
    });
    expect(
      (await invoke('revisions.list', { collection: 'customEntries', id: entryId })).revisions,
    ).toHaveLength(2);
    expect(
      (await invoke('entry.backlinks', { id: link._id })).backlinks.map((b) => b.id),
    ).toContain(entryId);
    await invoke('entry.delete', { collection: 'customEntries', id: entryId });
    expect((await invoke('trash.list', {})).entries.map((t) => t.entry._id)).toContain(entryId);
    await invoke('entry.restore', { collection: 'customEntries', id: entryId });
    await expect(
      make('customEntries', { title: 'Orphan', status: 'idea', sectionId: 'NOPE', values: {} }),
    ).rejects.toThrow(/no custom section/i);
  });

  test('CS-2 custom entries are found by search through their values, tags, and filters', async () => {
    const found = (q: string, filters = {}) =>
      invoke('search.query', { query: q, filters, limit: 10 });
    expect((await found('lullaby')).hits.map((h) => h.id)).toContain(entryId);
    expect((await found('dock ferry')).hits.map((h) => h.id)).toEqual([entryId]);
    expect((await found('lullaby', { tag: 'lullaby' })).hits.map((h) => h.id)).toContain(entryId);
    expect(
      (await found('lullaby', { yearFrom: 1991, yearTo: 1991 })).hits.map((h) => h.id),
    ).toContain(entryId);
    expect((await found('lullaby', { yearFrom: 2000 })).hits.map((h) => h.id)).not.toContain(
      entryId,
    );
    expect((await found('lullaby', { sections: ['customEntries'] })).hits[0]).toMatchObject({
      collection: 'customEntries',
      status: 'planned',
      provenance: 'researched',
    });
    await invoke('entry.delete', { collection: 'customEntries', id: entryId });
    expect((await found('lullaby')).hits.map((h) => h.id)).not.toContain(entryId);
    await invoke('entry.restore', { collection: 'customEntries', id: entryId });
  });

  test('CS-3 the brief rule persists across a reopen and rejects a value outside the rules', async () => {
    const reopened = await openBibleSession(store, slug);
    expect(reopened.repo.get('customSections', sectionId)!.briefRule).toBe('always');
    await expect(
      invoke('entry.update', {
        collection: 'customSections',
        id: sectionId,
        patch: { briefRule: 'sometimes' },
      }),
    ).rejects.toThrow();
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
    expect(await ids({ sections: ['facts'] })).toEqual(expect.arrayContaining(['F1', 'F2']));
    expect(await ids({ status: ['planned'] })).toContain('F2');
    expect(await ids({ status: ['planned'] })).not.toContain('F1');
    expect(await ids({ provenance: ['researched'] })).toEqual([]);
    expect(await ids({ familyId: 'FAM-ZHOU' })).not.toContain('F2');
    expect(await ids({ yearFrom: 2060, yearTo: 2060 })).toContain('K2');
    expect(await ids({ sections: ['facts'] }, ['chapters'])).toEqual([]);
    expect(
      (await ids({ sections: ['facts', 'chapters'] }, ['chapters'])).every((i) =>
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
