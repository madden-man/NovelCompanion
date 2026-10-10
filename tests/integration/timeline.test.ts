import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { Store } from '../../src/main/db';
import { createBibleWithDefaults, openBibleSession } from '../../src/main/db/session';
import type { OpenBible } from '../../src/main/db/session';
import { freshSlug, localStore } from '../helpers/db';
import { ipcFor } from '../helpers/ipc';
import { loadFixture, readFixture } from '../helpers/loadFixture';
import type { Invoke } from '../helpers/t5';

type Expected = {
  years: {
    year: number;
    alive: { id: string; age: number; dyingThisYear: boolean }[];
    dead: { id: string; deathYear: number }[];
    unborn: string[];
    unknown: string[];
  }[];
};
const expected = JSON.parse(
  readFileSync(join(import.meta.dirname, '../../fixtures/expected/tl2.json'), 'utf8'),
) as Expected;
const byId = <T extends { id: string }>(xs: T[]) =>
  [...xs].sort((a, b) => a.id.localeCompare(b.id));

let store: Store;
let bible: OpenBible;
let invoke: Invoke;

beforeAll(async () => {
  store = await localStore();
  bible = await openBibleSession(store, (await loadFixture(store, freshSlug('timeline'))).id);
  invoke = ipcFor(() => bible);
});
afterAll(async () => {
  await store.close();
});

const revisionCount = () => bible.handle.collection('revisions').countDocuments();

describe('TL-2 TM-2 the year view over IPC from the read model', () => {
  test('TL-2 timeline.year returns the hand-written answers for 2040, 2041, and 2075', async () => {
    for (const y of expected.years) {
      const v = await invoke('timeline.year', { at: { year: y.year } });
      expect(byId(v.alive)).toEqual(byId(y.alive));
      expect(byId(v.dead)).toEqual(byId(y.dead));
      expect([...v.unborn].sort()).toEqual([...y.unborn].sort());
      expect([...v.unknown].sort()).toEqual([...y.unknown].sort());
    }
  });

  test('TM-2 WE-3 for 2045: everyone, the era, the events of that year, and the strands in it', async () => {
    const v = await invoke('timeline.year', { at: { year: 2045 } });
    expect(v.rows).toHaveLength(13);
    expect(v.era?.id).toBe('ERA-2040');
    expect(v.events).toEqual([]);
    expect(v.strands.map((s) => s.strandId)).toEqual(['CH2-present', 'CH6-present']);
    const w = await invoke('timeline.year', { at: { year: 2049 } });
    expect(w.events.map((e) => e.id)).toEqual(['E6']);
  });

  test('TL-5 timeline.livedThrough lists events with ages and category paths', async () => {
    const r = await invoke('timeline.livedThrough', { characterId: 'Z3', year: 2030 });
    expect(r.events.map((e) => [e.id, e.age, e.categoryPath, e.formative])).toEqual([
      ['E1', 20, 'Culture', true],
      ['E2', 39, 'Technology > Robotics', false],
    ]);
  });

  test('TL-7 timeline.compare steps by 5 and by 1', async () => {
    const five = await invoke('timeline.compare', {
      a: 'H5',
      b: 'X1',
      from: 2030,
      to: 2060,
      step: 5,
    });
    expect(five.rows.map((r) => [r.year, r.gap])).toEqual([
      [2030, null],
      [2035, 1],
      [2040, 1],
      [2045, 1],
      [2050, 1],
      [2055, 1],
      [2060, 1],
    ]);
    const one = await invoke('timeline.compare', {
      a: 'H5',
      b: 'X1',
      from: 2030,
      to: 2032,
      step: 1,
    });
    expect(one.rows).toHaveLength(3);
  });
});

describe('WE-1 WE-2 world events and eras through the repository', () => {
  test('WE-1 events with a full date, a year, or a range, real or invented, with category, regions, places, characters, and the formative flag', async () => {
    const place = await bible.repo.create('places', {
      title: 'Pearl River delta',
      status: 'canon',
    } as never);
    const before = await revisionCount();
    const made = await bible.repo.createMany([
      {
        collection: 'worldEvents',
        data: {
          _id: 'W-DATE',
          title: 'Typhoon makes landfall',
          status: 'planned',
          start: { year: 2044, month: 9, day: 2 },
          reality: 'invented',
          categoryId: 'climate',
          regions: ['Guangdong'],
          placeIds: [place._id],
          characterIds: ['Z3'],
          formative: true,
        },
      },
      {
        collection: 'worldEvents',
        data: {
          _id: 'W-YEAR',
          title: 'Ferry line closes',
          status: 'idea',
          start: { year: 2044 },
          reality: 'invented',
          categoryId: 'economy',
        },
      },
      {
        collection: 'worldEvents',
        data: {
          _id: 'W-RANGE',
          title: 'Drought years',
          status: 'planned',
          start: { year: 2043 },
          end: { year: 2046 },
          reality: 'real',
          categoryId: 'climate',
        },
      },
    ]);
    expect(made).toHaveLength(3);
    expect(await revisionCount()).toBe(before + 3);
    const year = await invoke('timeline.year', { at: { year: 2044 } });
    expect(year.events.map((e) => e.id)).toEqual(['W-RANGE', 'W-YEAR', 'W-DATE']);
    const chart = await invoke('timeline.chart', {
      filters: { familyId: null, placeId: place._id, status: null, categoryId: null },
    });
    expect(chart.events.map((e) => [e.id, e.categoryPath, e.regions, e.formative])).toEqual([
      ['W-DATE', 'Climate', ['Guangdong'], true],
    ]);
    const lived = await invoke('timeline.livedThrough', { characterId: 'Z3', year: 2044 });
    expect(lived.events.find((e) => e.id === 'W-DATE')).toMatchObject({ age: 56, formative: true });
  });

  test('WE-1 ED-8 the category list is editable, and the timeline filter follows a new subcategory', async () => {
    const { item } = await invoke('lists.addItem', {
      listId: 'eventCategories',
      label: 'Floods',
      parentId: 'climate',
    });
    await bible.repo.update('worldEvents', 'E3', { categoryId: item.id } as never);
    await invoke('lists.rename', {
      listId: 'eventCategories',
      itemId: 'climate',
      label: 'Climate and water',
    });
    const chart = await invoke('timeline.chart', {
      filters: { familyId: null, placeId: null, status: null, categoryId: 'climate' },
    });
    expect(chart.events.find((e) => e.id === 'E3')?.categoryPath).toBe(
      'Climate and water > Floods',
    );
    expect(chart.events.map((e) => e.id)).toEqual(
      expect.arrayContaining(['E3', 'E6', 'E10', 'W-DATE', 'W-RANGE']),
    );
    expect(chart.events.map((e) => e.id)).not.toContain('E2');
  });

  test('WE-2 the fixture eras have no gaps; an edit that opens a gap is flagged and still saved', async () => {
    expect((await invoke('timeline.eraCoverage', {})).messages).toEqual([]);
    const saved = await invoke('entry.update', {
      collection: 'eraStates',
      id: 'ERA-2050',
      patch: { startYear: 2052 },
    });
    expect(saved.entry.startYear).toBe(2052);
    const after = await invoke('timeline.eraCoverage', {});
    expect(after.coverage.gaps).toEqual([{ from: 2050, to: 2051 }]);
    expect(after.messages).toEqual(['No era covers 2050 to 2051.']);
    await invoke('entry.update', {
      collection: 'eraStates',
      id: 'ERA-2040',
      patch: { endYear: 2053 },
    });
    const over = await invoke('timeline.eraCoverage', {});
    expect(over.coverage.gaps).toEqual([]);
    expect(over.messages).toEqual(['The forties and The fifties both cover 2052 to 2053.']);
    const y = await invoke('timeline.year', { at: { year: 2053 } });
    expect(y.eras.map((e) => e.id)).toEqual(['ERA-2050', 'ERA-2040']);
    expect(y.era?.id).toBe('ERA-2050');
    // Put the fixture back for the tests that follow.
    await invoke('entry.update', {
      collection: 'eraStates',
      id: 'ERA-2050',
      patch: { startYear: 2050 },
    });
    await invoke('entry.update', {
      collection: 'eraStates',
      id: 'ERA-2040',
      patch: { endYear: 2049 },
    });
    expect((await invoke('timeline.eraCoverage', {})).messages).toEqual([]);
  });

  test('WE-2 ARCH-8 a new bible gets default decades from its lists collection, through the write path', async () => {
    const fresh = await createBibleWithDefaults(store, freshSlug('eras'), 'Fresh');
    const list = await fresh.handle.collection('lists').findOne({ _id: 'eraDefaults' as never });
    expect(list?.items).toHaveLength(8);
    const eras = fresh.repo.list('eraStates');
    expect(eras.map((e) => [e.startYear, e.endYear])).toEqual([
      [2025, 2029],
      [2030, 2039],
      [2040, 2049],
      [2050, 2059],
      [2060, 2069],
      [2070, 2079],
      [2080, 2089],
      [2090, 2100],
    ]);
    expect(
      await fresh.handle.collection('revisions').countDocuments({ collection: 'eraStates' }),
    ).toBe(8);
    const freshIpc = ipcFor(() => fresh);
    expect((await freshIpc('timeline.eraCoverage', {})).messages).toEqual([]);
    // Seeding again, or a bible that already has eras, changes nothing.
    expect(await fresh.repo.seedDefaultEras()).toBe(0);
    expect(await bible.repo.seedDefaultEras()).toBe(0);
    expect(bible.repo.list('eraStates')).toHaveLength(readFixture().eraStates!.length);
  });
});

describe('TM-1 TM-3 TM-4 TM-5 story time', () => {
  test('TM-3 the story time with a full date, chapter, and strand persists in meta and reads back after reopening', async () => {
    const entriesBefore = await revisionCount();
    const set = await invoke('storyTime.set', {
      time: { year: 2045, month: 3, day: 14, chapterId: 'CH2', strandId: 'CH2-present' },
    });
    expect(set.time).toEqual({
      year: 2045,
      month: 3,
      day: 14,
      chapterId: 'CH2',
      strandId: 'CH2-present',
    });
    const meta = await bible.handle.collection('meta').findOne({ _id: 'storyTime' as never });
    expect(meta).toMatchObject({ year: 2045, month: 3, day: 14, chapterId: 'CH2' });
    // TM-5: setting the time wrote no entry and no revision.
    expect(await revisionCount()).toBe(entriesBefore);
    const reopened = await openBibleSession(store, bible.handle.id);
    const again = await ipcFor(() => reopened)('storyTime.get', {});
    expect(again.time).toEqual(set.time);
    expect(again.position).toEqual({ year: 2045, source: 'storyTime', chapterId: null });
    // The year view without a year follows the story time, as an exact date.
    const v = await ipcFor(() => reopened)('timeline.year', {});
    expect(v.at).toEqual({ year: 2045, month: 3, day: 14 });
    expect(v.alive.find((a) => a.id === 'H5')?.age).toBe(14);
  });

  test('TM-3 the character page shows ages at the story time', async () => {
    await invoke('storyTime.set', { time: { year: 2040 } });
    const { page } = await invoke('character.page', { id: 'H5' });
    expect(page.storyTime).toEqual({
      year: 2040,
      state: { state: 'alive', age: 9, dyingThisYear: false },
    });
  });

  test('TM-1 a story time that names a strand without its chapter is refused at the IPC boundary', async () => {
    await expect(
      invoke('storyTime.set', { time: { year: 2040, strandId: 'CH2-present' } }),
    ).rejects.toThrow(/strand needs its chapter/);
    await expect(invoke('storyTime.set', { time: { year: 2040, day: 3 } })).rejects.toThrow(
      /day needs a month/,
    );
  });

  test('TM-4 anchor by age: Iris Hale-Zhou is 9 in 2040; an unknown birth gives no year', async () => {
    expect(await invoke('storyTime.anchorAge', { characterId: 'H5', age: 9 })).toEqual({
      year: 2040,
      message: 'Iris Hale-Zhou is 9 in 2040.',
    });
    const u = await invoke('storyTime.anchorAge', { characterId: 'U1', age: 30 });
    expect(u.year).toBeNull();
    expect(u.message).toBe('The Archivist has no known birth year, so no year can be computed.');
  });

  test('TM-5 "Use as strand year" shows the change, then writes the strand through the write path with a note', async () => {
    await invoke('storyTime.set', {
      time: { year: 2046, chapterId: 'CH2', strandId: 'CH2-present' },
    });
    const chapterBefore = bible.repo.get('chapters', 'CH2')!;
    const preview = await invoke('storyTime.promotePreview', {
      chapterId: 'CH2',
      strandId: 'CH2-present',
    });
    expect(preview).toMatchObject({
      chapterTitle: 'Two Kitchens',
      strandLabel: 'present',
      year: 2046,
      from: { startYear: 2045, endYear: null },
      to: { startYear: 2046, endYear: null },
      unchanged: false,
    });
    // The preview wrote nothing.
    expect(bible.repo.get('chapters', 'CH2')!.modifiedAt).toBe(chapterBefore.modifiedAt);
    const done = await invoke('storyTime.promote', {
      chapterId: 'CH2',
      strandId: 'CH2-present',
      baseModifiedAt: preview.baseModifiedAt,
    });
    const strands = done.entry.strands as { id: string; startYear: number }[];
    expect(strands.map((s) => [s.id, s.startYear])).toEqual([
      ['CH2-present', 2046],
      ['CH2-backstory', 2032],
    ]);
    const revs = await bible.repo.revisions('chapters', 'CH2');
    expect(revs.at(-1)?.note).toBe('Set the present strand year to 2046 from the story time');
    // A stale approval is refused: the person has not seen the chapter as it is now.
    await expect(
      invoke('storyTime.promote', {
        chapterId: 'CH2',
        strandId: 'CH2-present',
        baseModifiedAt: preview.baseModifiedAt,
      }),
    ).rejects.toThrow(/changed after you saw the change/);
    // Put it back.
    await invoke('entry.update', {
      collection: 'chapters',
      id: 'CH2',
      patch: { strands: chapterBefore.strands },
    });
  });
});
