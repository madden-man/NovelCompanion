import { describe, expect, test } from 'vitest';
import { datePassages, passageKey, passagesFor } from '../../src/shared/domain/backstory';
import { placeForText } from '../../src/shared/domain/culture';
import { selectForSession } from '../../src/shared/domain/brief/selection';
import { fromCollections } from '../../src/shared/domain/timeline';
import { SelectionWire } from '../../src/shared/ipcSession';

// Shaped on the East Winds backstories (Mark born 2037, Chaney's one-line summary).
const MARK = [
  '<p>Narrative Summary</p>',
  '<p>Mark is born on July 8, 2037, to a family oriented around Frank.</p>',
  '<p>This tragedy colors his childhood.</p>',
  '<p>Emilie gets pregnant when Mark is twelve years old, and the family turns upside down.</p>',
  '<p>Early into Mark’s junior year, Matthew is four years old and about to start kindergarten.</p>',
  '<p>Mark’s first year of high school proves formative. Linh trades him for new friends.</p>',
  '<p>By sophomore year, Mark is a soccer player (Marks_Life L41-63; Sullivan!A43).</p>',
  '<p>In the summer between junior and senior year, Frank and Mark have it out for the first time.</p>',
  '<p>Throughout the rest of the summer, they hike in the mountains.</p>',
].join('');

const CHANEY =
  "<p>Mark's classmate. Homecoming kiss 2052; fights with Mark about religion 2053; the Greece trip ends it (2054).</p>";

describe('A35 backstory passages are dated from their cues', () => {
  const ps = datePassages(MARK, 2037, ['Mark']);
  const at = (start: string) => ps.find((p) => p.text.startsWith(start))!;

  test('headings are skipped and an explicit year dates its passage', () => {
    expect(ps.some((p) => p.text === 'Narrative Summary')).toBe(false);
    expect(at('Mark is born')).toMatchObject({ year: 2037, source: 'cue', tag: '' });
  });

  test('a passage with no cue carries the year before it', () => {
    expect(at('This tragedy')).toMatchObject({ year: 2037, source: 'carried' });
    expect(at('Throughout the rest')).toMatchObject({ year: 2054, source: 'carried' });
  });

  test("the character's age and school stage give the year; another person's age does not", () => {
    expect(at('Emilie gets pregnant')).toMatchObject({ year: 2049, tag: 'Age 12' });
    // "Matthew is four" is Matthew's age: the passage dates from Mark's junior year.
    expect(at('Early into')).toMatchObject({ year: 2053, tag: 'Junior' });
    expect(at('Mark’s first year')).toMatchObject({ year: 2051, tag: 'Freshman' });
    expect(at('In the summer')).toMatchObject({ year: 2054, tag: 'Summer' });
  });

  test('source citations are dropped from the text', () => {
    expect(at('By sophomore year').text).toBe('By sophomore year, Mark is a soccer player.');
  });

  test('a paragraph naming several years is split into dated passages', () => {
    const c = datePassages(CHANEY, null, ['Chaney']);
    expect(c.map((p) => p.year)).toEqual([null, 2052, 2053, 2054]);
    expect(c[1]!.excerpt).toBe('Homecoming kiss 2052.');
  });

  test('a year set by hand wins, and a pin is kept', () => {
    const key = passageKey(at('This tragedy').text);
    const marked = datePassages(MARK, 2037, ['Mark'], [{ key, year: 2038, pinned: true }]);
    expect(marked.find((p) => p.key === key)).toMatchObject({
      year: 2038,
      source: 'set',
      pinned: true,
    });
  });

  test('a span gives its passages, the one leading up to it, and pins from any year', () => {
    const key = passageKey(at('Mark is born').text);
    const marked = datePassages(MARK, 2037, ['Mark'], [{ key, pinned: true }]);
    const rows = passagesFor(marked, 2051, 2054);
    expect(rows.map((r) => [r.kind, r.year])).toEqual([
      ['pinned', 2037],
      ['lead', 2049],
      ['window', 2053],
      ['window', 2051],
      ['window', 2052],
      ['window', 2054],
      ['window', 2054],
    ]);
    expect(passagesFor(datePassages(MARK, 2037, ['Mark']), 2090, 2095)).toEqual([]);
  });
});

describe('A35 a place lived names a place in the bible', () => {
  const places = [
    { _id: 'LA', title: 'Los Angeles' },
    { _id: 'USC', title: 'University of Southern California (USC)' },
    { _id: 'SF', title: 'San Francisco' },
  ];
  test('the parenthesised part first, then the comma parts in order', () => {
    expect(placeForText(places, 'Los Angeles, California (USC)')).toBe('USC');
    expect(placeForText(places, "San Francisco, California (Frank's house)")).toBe('SF');
    expect(placeForText(places, 'Seattle, Washington')).toBeNull();
  });
});

describe('A35 the selection: setting, communities, and backstory', () => {
  const now = '2026-10-13T00:00:00.000Z';
  const base = { status: 'canon', body: '', createdAt: now, modifiedAt: now };
  const collections = {
    lists: [
      {
        _id: 'communities',
        items: [
          { id: 'sf', label: 'San Francisco', parentId: null },
          { id: 'us', label: 'United States', parentId: null },
          { id: 'pac', label: 'Pacific States', parentId: 'us' },
          { id: 'church', label: 'Evangelical church', parentId: null },
        ],
      },
    ],
    places: [
      { ...base, _id: 'P-US', title: 'United States', communityId: 'us' },
      { ...base, _id: 'P-CA', title: 'California', parentId: 'P-US', communityId: 'pac' },
      { ...base, _id: 'P-SF', title: 'San Francisco', parentId: 'P-CA', communityId: 'sf' },
      {
        ...base,
        _id: 'P-CH',
        title: "The Sullivans' church",
        parentId: 'P-SF',
        communityId: 'church',
      },
    ],
    culturalEntries: [
      {
        ...base,
        _id: 'CU-SF',
        title: 'Teen life',
        communityId: 'sf',
        startYear: 2048,
        endYear: 2055,
      },
      {
        ...base,
        _id: 'CU-US',
        title: 'National mood',
        communityId: 'us',
        startYear: 2050,
        endYear: 2060,
      },
      {
        ...base,
        _id: 'CU-CH',
        title: 'Church life',
        communityId: 'church',
        startYear: 2040,
        endYear: 2066,
      },
      {
        ...base,
        _id: 'CU-OLD',
        title: 'Too early',
        communityId: 'sf',
        startYear: 2012,
        endYear: 2018,
      },
    ],
    characters: [
      {
        ...base,
        _id: 'MARK',
        title: 'Mark Sullivan',
        names: { full: 'Mark Sullivan', order: 'family-last', nicknames: [], calledBy: [] },
        birth: { year: 2037 },
        backstory: MARK,
        placesLived: [
          { place: 'San Francisco, California', startYear: 2037, endYear: 2055 },
          { place: 'Los Angeles, California (USC)', startYear: 2055, endYear: 2060 },
        ],
      },
      {
        ...base,
        _id: 'CHANEY',
        title: 'Chaney',
        names: { full: 'Chaney', order: 'family-last', nicknames: [], calledBy: [] },
        birth: { unknown: true },
        backstory: CHANEY,
      },
    ],
    chapters: [
      {
        ...base,
        _id: 'CH1',
        title: 'Mark Feels Free',
        readingOrder: 1,
        strands: [
          {
            id: 'COL',
            label: 'Mark: College Arc',
            startYear: 2055,
            endYear: 2058,
            primary: true,
            povCharacterId: 'MARK',
            characterIds: ['MARK'],
            placeIds: [],
          },
          {
            id: 'HS',
            label: 'Backstory: High School',
            startYear: 2051,
            endYear: 2054,
            primary: false,
            povCharacterId: 'MARK',
            characterIds: ['MARK', 'CHANEY'],
            placeIds: [],
          },
        ],
      },
    ],
  };
  const data = fromCollections(collections as never);
  const strand = (strandId: string) =>
    selectForSession(data, { kind: 'strand', chapterId: 'CH1', strandId }).strands[0]!;

  test('with no places on the strand, the setting is where the point of view lived that year', () => {
    const s = strand('HS');
    expect(s.setting).toEqual({
      placeIds: ['P-SF'],
      source: 'placesLived',
      characterId: 'MARK',
      note: "from Mark Sullivan's places lived, 2037 to 2055",
    });
    // Every community out to the country, nearest first, and only entries for the year.
    expect(s.communities.map((c) => c.id)).toEqual(['sf', 'pac', 'us']);
    const culture = s.groups.find((g) => g.kind === 'culture')!.items;
    expect(culture.map((i) => [i.id, i.community])).toEqual([
      ['CU-SF', 'sf'],
      ['CU-US', 'us'],
    ]);
  });

  test("the strand's own places win, and a community list parent joins", () => {
    const cols = structuredClone(collections);
    (cols.chapters[0]!.strands[1]!.placeIds as string[]) = ['P-CH'];
    const s = selectForSession(fromCollections(cols as never), {
      kind: 'strand',
      chapterId: 'CH1',
      strandId: 'HS',
    }).strands[0]!;
    expect(s.setting.source).toBe('strand');
    expect(s.communities.map((c) => c.id)).toEqual(['church', 'sf', 'pac', 'us']);
    expect(s.groups.find((g) => g.kind === 'culture')!.items.map((i) => i.id)).toEqual([
      'CU-CH',
      'CU-SF',
      'CU-US',
    ]);
  });

  test("a backstory strand's backstory is its own years; the primary strand's is the backstory strand's", () => {
    const hs = strand('HS').backstory;
    expect([hs.from, hs.to, hs.label]).toEqual([2051, 2054, 'High School']);
    expect(hs.people.map((p) => [p.name, p.ages])).toEqual([
      ['Mark Sullivan', 'ages 14 to 17'],
      ['Chaney', 'age unknown'],
    ]);
    const col = strand('COL').backstory;
    expect([col.from, col.to, col.label]).toEqual([2051, 2054, 'High School']);
    // Chaney is not in the college strand, but is in the backstory it draws on.
    expect(col.people.map((p) => p.characterId)).toEqual(['MARK', 'CHANEY']);
    expect(col.people[1]!.rows.map((r) => r.year)).toEqual([2052, 2053, 2054]);
  });

  test('the selection with setting and backstory passes the wire schema', () => {
    const sel = selectForSession(data, { kind: 'chapter', chapterId: 'CH1' });
    expect(() => SelectionWire.parse(sel)).not.toThrow();
  });
});
