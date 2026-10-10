import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { Store } from '../../src/main/db';
import { createBibleWithDefaults, openBibleSession } from '../../src/main/db/session';
import type { OpenBible } from '../../src/main/db/session';
import { freshSlug, localStore } from '../helpers/db';
import { ipcFor } from '../helpers/ipc';
import { loadFixture } from '../helpers/loadFixture';
import type { Invoke } from '../helpers/t5';

let store: Store;
let fixture: OpenBible;
let fxInvoke: Invoke;
let fresh: OpenBible;
let invoke: Invoke;

const strand = (id: string, year: number, primary = true) => ({
  id,
  label: id,
  startYear: year,
  endYear: null,
  primary,
  povCharacterId: null,
  characterIds: [],
  placeIds: [],
});

beforeAll(async () => {
  store = await localStore();
  fixture = await openBibleSession(store, (await loadFixture(store, freshSlug('plot-fx'))).id);
  fxInvoke = ipcFor(() => fixture);
  fresh = await createBibleWithDefaults(store, freshSlug('plot'), 'Plot');
  invoke = ipcFor(() => fresh);
});
afterAll(async () => {
  await store.close();
});

const make = async (collection: string, data: Record<string, unknown>) =>
  (await invoke('entry.create', { collection: collection as never, data })).entry;

describe('PL-1 books, parts, chapters, arcs, and beats through the write path', () => {
  test('PL-1 arcs keep scope, owner, and year range; chapters and beats join several arcs', async () => {
    const book = await make('books', { title: 'Book One', number: 1, status: 'planned' });
    const part = await make('parts', {
      title: 'Part One',
      bookId: book._id,
      number: 1,
      status: 'planned',
    });
    const family = await make('families', {
      title: 'Hale',
      name: 'Hale',
      color: 'series-2',
      status: 'canon',
    });
    const who = await make('characters', {
      title: 'Iris',
      names: { full: 'Iris Hale' },
      birth: { year: 2000 },
      familyIds: [family._id],
      status: 'canon',
    });
    const whole = await make('arcs', {
      title: 'Whole book',
      name: 'Whole book',
      scope: 'book',
      startYear: 2030,
      endYear: 2080,
      status: 'planned',
    });
    const owned = await make('arcs', {
      title: 'Iris',
      name: 'Iris arc',
      scope: 'character',
      ownerCharacterId: who._id,
      familyId: family._id,
      startYear: 2040,
      endYear: 2060,
      status: 'planned',
    });
    expect(owned).toMatchObject({
      scope: 'character',
      ownerCharacterId: who._id,
      startYear: 2040,
      endYear: 2060,
    });
    const ch = await make('chapters', {
      title: 'Opening',
      partId: part._id,
      readingOrder: 1,
      strands: [strand('s1', 2045)],
      arcIds: [whole._id, owned._id],
      status: 'planned',
    });
    const beat = await make('plotBeats', {
      title: 'The letter arrives',
      arcIds: [whole._id, owned._id],
      chapterId: ch._id,
      year: 2045,
      povCharacterId: who._id,
      description: 'A letter.',
      worldContext: 'Flood year.',
      experienceNote: 'Iris feels cold.',
      order: 1,
      status: 'planned',
    });
    expect(ch.arcIds).toEqual([whole._id, owned._id]);
    expect(beat).toMatchObject({ worldContext: 'Flood year.', experienceNote: 'Iris feels cold.' });
    const grid = await invoke('outline.get', { order: 'reading', cursorYear: null });
    const row = grid.rows.find((r) => r.kind === 'chapter');
    expect(
      row?.kind === 'chapter' && row.arcSpans.map((s) => [s.name, s.color, s.from, s.to]),
    ).toEqual([
      ['Whole book', 'series-4', 2030, 2080],
      ['Iris arc', 'series-2', 2040, 2060],
    ]);
  });
});

describe('PL-2 PL-4 the outline and chapter page over IPC', () => {
  test('PL-2 outline.get returns the fixture chapters in reading order, then story order, with the cursor', async () => {
    const reading = await fxInvoke('outline.get', { order: 'reading', cursorYear: null });
    const ids = reading.rows.filter((r) => r.kind === 'chapter').map((r) => r.id);
    const orders = reading.rows.flatMap((r) => (r.kind === 'chapter' ? [r.readingOrder] : []));
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
    const story = await fxInvoke('outline.get', { order: 'story', cursorYear: 2040 });
    const years = story.rows.flatMap((r) =>
      r.kind === 'chapter' ? [r.storyYear ?? Infinity] : [],
    );
    expect(years).toEqual([...years].sort((a, b) => a - b));
    expect([...story.rows.filter((r) => r.kind === 'chapter').map((r) => r.id)].sort()).toEqual(
      [...ids].sort(),
    );
    expect(story.cursorYear).toBe(2040);
  });

  test('PL-2 the cursor follows the story time when none is passed', async () => {
    await fxInvoke('storyTime.set', { time: { year: 2051 } });
    expect((await fxInvoke('outline.get', { order: 'reading', cursorYear: null })).cursorYear).toBe(
      2051,
    );
    await fxInvoke('storyTime.set', { time: null });
  });

  test('PL-4 chapter.page shows strands with ages, facts in play, and rejects an unknown chapter', async () => {
    const { page } = await fxInvoke('chapter.page', { id: 'CH3' });
    expect(page.factsInPlay.map((f) => f.factId)).toEqual(['F1']);
    expect(page.strands[0]?.characters.find((c) => c.id === 'Z3')?.state).toMatchObject({
      state: 'alive',
      age: 41,
    });
    await expect(fxInvoke('chapter.page', { id: 'nope' })).rejects.toThrow(/No chapter/);
  });
});

describe('PL-3 reordering changes reading order only', () => {
  test('PL-3 plot.reorder moves a chapter within its part, writes revisions, and leaves story years alone', async () => {
    const before = await fxInvoke('entry.list', { collection: 'chapters', trash: 'exclude' });
    const part = before.entries.map((e) => e.entry).filter((c) => c.partId === 'PT1');
    const sorted = [...part].sort((a, b) => Number(a.readingOrder) - Number(b.readingOrder));
    const last = sorted[sorted.length - 1]!;
    const yearsBefore = new Map(part.map((c) => [c._id, JSON.stringify(c.strands)]));
    const revs = () => fixture.handle.collection('revisions').countDocuments();
    const n = await revs();
    const r = await fxInvoke('plot.reorder', {
      kind: 'chapters',
      groupId: 'PT1',
      movedId: last._id,
      toIndex: 0,
    });
    expect(r.field).toBe('readingOrder');
    expect(r.changes.find((c) => c.id === last._id)).toMatchObject({
      after: sorted[0]!.readingOrder,
    });
    expect(await revs()).toBe(n + r.changes.length);
    const after = (
      await fxInvoke('entry.list', { collection: 'chapters', trash: 'exclude' })
    ).entries
      .map((e) => e.entry)
      .filter((c) => c.partId === 'PT1')
      .sort((a, b) => Number(a.readingOrder) - Number(b.readingOrder));
    expect(after[0]?._id).toBe(last._id);
    for (const c of after) expect(JSON.stringify(c.strands)).toBe(yearsBefore.get(c._id));
    // The other part keeps its numbers.
    const other = (
      await fxInvoke('entry.list', { collection: 'chapters', trash: 'exclude' })
    ).entries
      .map((e) => e.entry)
      .filter((c) => c.partId !== 'PT1');
    const otherBefore = before.entries.map((e) => e.entry).filter((c) => c.partId !== 'PT1');
    expect(other.map((c) => [c._id, c.readingOrder])).toEqual(
      otherBefore.map((c) => [c._id, c.readingOrder]),
    );
    // Undo replays the same moves backwards through the write path.
    for (const c of r.changes) {
      await fxInvoke('entry.update', {
        collection: 'chapters',
        id: c.id,
        patch: { readingOrder: c.before },
      });
    }
  });

  test('PL-3 plot.reorder numbers the beats of an arc 1 to n and refuses an item outside the group', async () => {
    const arc = await make('arcs', { title: 'A', name: 'A', scope: 'custom', status: 'planned' });
    const ids: string[] = [];
    for (const t of ['one', 'two', 'three']) {
      ids.push(
        (
          await make('plotBeats', {
            title: t,
            arcIds: [arc._id],
            order: ids.length + 1,
            status: 'planned',
          })
        )._id,
      );
    }
    const r = await invoke('plot.reorder', {
      kind: 'beats',
      groupId: arc._id,
      movedId: ids[2]!,
      toIndex: 0,
    });
    expect(r.field).toBe('order');
    const order = (
      await invoke('entry.list', { collection: 'plotBeats', trash: 'exclude' })
    ).entries
      .map((e) => e.entry)
      .filter((b) => (b.arcIds as string[]).includes(arc._id))
      .sort((a, b) => Number(a.order) - Number(b.order))
      .map((b) => b.title);
    expect(order).toEqual(['three', 'one', 'two']);
    await expect(
      invoke('plot.reorder', { kind: 'beats', groupId: 'no-arc', movedId: ids[0]!, toIndex: 0 }),
    ).rejects.toThrow(/not in this group/);
  });
});

describe('CU-2 PC-1 culture and places over IPC', () => {
  test('CU-2 culture.entriesFor returns the entries for a community and year', async () => {
    const a = await fxInvoke('culture.entriesFor', { communityId: 'guangzhou', year: 2050 });
    expect(a.entries.map((e) => e._id)).toEqual(['CU2']);
    const b = await fxInvoke('culture.entriesFor', { communityId: 'guangzhou', year: 2010 });
    expect(b.entries.map((e) => e._id)).toEqual(['CU1']);
  });

  test('CU-1 a cultural entry for a community and year range saves and edits like any entry', async () => {
    const e = await make('culturalEntries', {
      title: 'Lantern walk',
      communityId: 'portland',
      startYear: 2040,
      endYear: 2050,
      status: 'idea',
    });
    await invoke('entry.update', {
      collection: 'culturalEntries',
      id: e._id,
      patch: { endYear: 2060 },
    });
    expect(
      (await invoke('culture.entriesFor', { communityId: 'portland', year: 2055 })).entries,
    ).toHaveLength(1);
  });

  test('PC-1 places nest and place.describe returns the path, the description for the year, and the children', async () => {
    const city = await make('places', { title: 'Portland', status: 'canon' });
    const hood = await make('places', {
      title: 'Pearl District',
      parentId: city._id,
      status: 'canon',
      descriptions: [
        { startYear: null, endYear: 2034, text: 'Warehouses.' },
        { startYear: 2035, endYear: null, text: 'Stilt houses.' },
      ],
    });
    const early = await invoke('place.describe', { id: hood._id, year: 2000 });
    expect(early).toMatchObject({
      path: 'Portland > Pearl District',
      description: { text: 'Warehouses.' },
    });
    expect((await invoke('place.describe', { id: hood._id, year: 2040 })).description?.text).toBe(
      'Stilt houses.',
    );
    expect((await invoke('place.describe', { id: city._id, year: 2040 })).children).toEqual([
      { id: hood._id, title: 'Pearl District' },
    ]);
  });
});

describe('GL-1 GL-2 glossary settings, warnings, and search', () => {
  const term = (extra: Record<string, unknown>) => ({
    title: 'term',
    characters: '你好',
    language: 'mandarin',
    meaning: 'hello',
    status: 'canon',
    ...extra,
  });

  test('GL-1 one system per language is listed, defaults to the matching system, and can be changed', async () => {
    const r = await invoke('romanization.get', {});
    expect(r.languages.find((l) => l.id === 'mandarin')).toMatchObject({
      systemId: 'mandarin',
      kind: 'pinyin',
    });
    expect(r.languages.find((l) => l.id === 'cantonese')).toMatchObject({ kind: 'jyutping' });
    expect(r.languages.find((l) => l.id === 'english')?.systemId).toBeNull();
  });

  test('GL-1 a term that breaks the system saves with a warning on the romanization field', async () => {
    const bad = await invoke('entry.create', {
      collection: 'glossaryTerms',
      data: term({ romanization: 'nii haoo' }),
    });
    expect(bad.warnings.map((w) => [w.path, w.code])).toContainEqual([
      'romanization',
      'romanization-system',
    ]);
    const ok = await invoke('entry.create', {
      collection: 'glossaryTerms',
      data: term({ romanization: 'nǐ hǎo' }),
    });
    expect(ok.warnings.some((w) => w.code === 'romanization-system')).toBe(false);
  });

  test('GL-1 changing a language system changes which terms are flagged, and none turns the check off', async () => {
    const t = await invoke('entry.create', {
      collection: 'glossaryTerms',
      data: term({ romanization: 'gwong2dung1', language: 'mandarin' }),
    });
    expect(t.warnings.some((w) => w.code === 'romanization-system')).toBe(true);
    await invoke('romanization.set', { languageId: 'mandarin', systemId: 'cantonese' });
    expect(
      (await invoke('entry.get', { collection: 'glossaryTerms', id: t.entry._id })).warnings.some(
        (w) => w.code === 'romanization-system',
      ),
    ).toBe(false);
    expect(
      (await invoke('romanization.check', { languageId: 'mandarin', text: 'ni3 hao3' })).ok,
    ).toBe(false);
    await invoke('romanization.set', { languageId: 'mandarin', systemId: null });
    expect((await invoke('romanization.check', { languageId: 'mandarin', text: 'zzz' })).ok).toBe(
      true,
    );
    await invoke('romanization.set', { languageId: 'mandarin', systemId: 'mandarin' });
    expect((await invoke('romanization.check', { languageId: 'mandarin', text: 'zzz' })).ok).toBe(
      false,
    );
  });

  test('GL-1 the settings survive reopening the bible, and a bad language is refused', async () => {
    await invoke('romanization.set', { languageId: 'cantonese', systemId: 'mandarin' });
    const reopened = await openBibleSession(store, fresh.handle.id);
    expect(reopened.repo.romanizationSettings()).toMatchObject({ cantonese: 'mandarin' });
    await invoke('romanization.set', { languageId: 'cantonese', systemId: 'cantonese' });
    await expect(
      invoke('romanization.set', { languageId: 'klingon', systemId: null }),
    ).rejects.toThrow(/Languages list/);
  });

  test('GL-2 search.query finds fixture terms by characters, tone-free romanization, and meaning', async () => {
    const ids = async (query: string) =>
      (await fxInvoke('search.query', { query, limit: 5 })).hits
        .filter((h) => h.collection === 'glossaryTerms')
        .map((h) => h.id);
    expect(await ids('晓曦')).toContain('GL1');
    expect(await ids('yuebing')).toContain('GL5');
    expect(await ids('yuèbǐng')).toContain('GL5');
    expect(await ids('mooncake')).toContain('GL5');
  });
});
