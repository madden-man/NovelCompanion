import { describe, expect, test } from 'vitest';
import { placeForText } from '../../src/shared/domain/culture';
import { selectForSession } from '../../src/shared/domain/brief/selection';
import { fromCollections } from '../../src/shared/domain/timeline';
import { SelectionWire } from '../../src/shared/ipcSession';

describe('SM-3 A35 a Lives in moment names a place in the bible', () => {
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

describe('SM-3 A35 the selection: setting, communities, and backstory moments', () => {
  const now = '2026-10-13T00:00:00.000Z';
  const base = { body: '', createdAt: now, modifiedAt: now };
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
        names: { full: 'Mark Sullivan' },
        birth: { year: 2037 },
      },
      {
        ...base,
        _id: 'CHANEY',
        title: 'Chaney',
        names: { full: 'Chaney' },
        birth: { unknown: true },
      },
    ],
    moments: [
      {
        ...base,
        _id: 'M-SF',
        characterId: 'MARK',
        title: 'Lives in San Francisco, California',
        year: 2037,
        endYear: 2055,
      },
      {
        ...base,
        _id: 'M-LA',
        characterId: 'MARK',
        title: 'Lives in Los Angeles, California (USC)',
        year: 2055,
        endYear: 2060,
      },
      {
        ...base,
        _id: 'M-SOCCER',
        characterId: 'MARK',
        title: 'Plays soccer',
        year: 2052,
        endYear: null,
        body: 'By sophomore year he is on the team.',
      },
      {
        ...base,
        _id: 'M-HIKE',
        characterId: 'MARK',
        title: 'Hikes with Frank',
        year: 2054,
        endYear: null,
      },
      {
        ...base,
        _id: 'M-KISS',
        characterId: 'CHANEY',
        title: 'Homecoming kiss',
        year: 2052,
        endYear: null,
      },
      {
        ...base,
        _id: 'M-FIGHT',
        characterId: 'CHANEY',
        title: 'Fights with Mark about religion',
        year: 2053,
        endYear: null,
      },
      {
        ...base,
        _id: 'M-GREECE',
        characterId: 'CHANEY',
        title: 'The Greece trip ends it',
        year: 2054,
        endYear: null,
      },
      {
        ...base,
        _id: 'M-LATER',
        characterId: 'CHANEY',
        title: 'Moves away',
        year: 2059,
        endYear: null,
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

  test('SM-3 with no places on the strand, the setting is where the point of view lived that year, from their Lives in moments', () => {
    const s = strand('HS');
    expect(s.setting).toEqual({
      placeIds: ['P-SF'],
      source: 'livesIn',
      characterId: 'MARK',
      note: "from Mark Sullivan's Lives in San Francisco, California, 2037 to 2055",
    });
    // Every community out to the country, nearest first, and only entries for the year.
    expect(s.communities.map((c) => c.id)).toEqual(['sf', 'pac', 'us']);
    const culture = s.groups.find((g) => g.kind === 'culture')!.items;
    expect(culture.map((i) => [i.id, i.community])).toEqual([
      ['CU-SF', 'sf'],
      ['CU-US', 'us'],
    ]);
  });

  test("SM-3 the strand's own places win, and a community list parent joins", () => {
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

  test("SM-3 a backstory strand's backstory is the moments of its own years; the primary strand's is the backstory strand's", () => {
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
    expect(col.people[1]!.rows.map((r) => [r.id, r.year])).toEqual([
      ['M-KISS', 2052],
      ['M-FIGHT', 2053],
      ['M-GREECE', 2054],
    ]);
    expect(col.people[0]!.rows.map((r) => r.id)).toEqual(['M-SF', 'M-SOCCER', 'M-HIKE']);
    expect(col.people[0]!.rows[1]).toMatchObject({
      title: 'Plays soccer',
      body: 'By sophomore year he is on the team.',
    });
  });

  test('SM-3 a Lives in moment with no end runs on until a later one', () => {
    const cols = structuredClone(collections);
    cols.places.push({
      ...base,
      _id: 'P-LA',
      title: 'Los Angeles',
      parentId: 'P-CA',
      communityId: 'pac',
    });
    cols.moments = cols.moments.map((m) => (m._id === 'M-SF' ? { ...m, endYear: null } : m));
    const at = (year: number) => {
      const c = structuredClone(cols);
      c.chapters[0]!.strands[0]!.startYear = year;
      c.chapters[0]!.strands[0]!.endYear = year;
      return selectForSession(fromCollections(c as never), {
        kind: 'strand',
        chapterId: 'CH1',
        strandId: 'COL',
      }).strands[0]!.setting;
    };
    // San Francisco has no end, so it runs on; Los Angeles begins in 2055 and wins from then.
    expect(at(2054).placeIds).toEqual(['P-SF']);
    expect(at(2056)).toMatchObject({
      placeIds: ['P-LA'],
      note: "from Mark Sullivan's Lives in Los Angeles, California (USC), 2055 to 2060",
    });
    // After Los Angeles ends, the open San Francisco moment is the one in force again.
    expect(at(2062).placeIds).toEqual(['P-SF']);
  });

  test('SM-3 the selection with setting and backstory passes the wire schema', () => {
    const sel = selectForSession(data, { kind: 'chapter', chapterId: 'CH1' });
    expect(() => SelectionWire.parse(sel)).not.toThrow();
  });
});
