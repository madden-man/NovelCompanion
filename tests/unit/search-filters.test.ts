import { describe, expect, test } from 'vitest';
import {
  compileFilters,
  entrySpans,
  overlapsYears,
  placeAndDescendants,
} from '../../src/shared/domain/searchFilters';
import type { SearchFilters } from '../../src/shared/domain/searchFilters';
import { SearchIndex } from '../../src/main/search';
import { ReadModel } from '../../src/main/readmodel';
import { readFixture } from '../helpers/loadFixture';

const fx = readFixture();
const at = '2026-01-15T09:00:00.000Z';
const base = { status: 'canon', createdAt: at, modifiedAt: at, body: '' };

const places = [
  { _id: 'PL1', title: 'Portland', ...base, parentId: null },
  { _id: 'PL2', title: 'Pearl District', ...base, parentId: 'PL1' },
  { _id: 'PL3', title: 'The Archive', ...base, parentId: 'PL2' },
  { _id: 'PL4', title: 'Guangzhou', ...base, parentId: null },
];
const extra = {
  places,
  moments: [
    {
      _id: 'M1',
      title: "Meiling's lotus seed mooncakes",
      ...base,
      characterId: 'Z1',
      year: 1980,
      endYear: null,
      body: 'Soak the seeds overnight, then cook the paste slowly for three hours.',
      worldContext: '',
    },
    {
      _id: 'M2',
      title: "Peter's ferry chowder",
      ...base,
      status: 'planned',
      characterId: 'H2',
      year: 1985,
      endYear: null,
      body: 'Clams, potatoes, and too much pepper.',
      worldContext: '',
    },
    {
      _id: 'M3',
      title: 'Inheritance',
      ...base,
      status: 'planned',
      provenance: 'invented',
      tags: ['motif'],
      characterId: 'H5',
      year: 2060,
      endYear: 2065,
      body: 'Iris reads the letter.',
      worldContext: 'The letters pass down',
    },
  ],
  openQuestions: [
    {
      _id: 'Q1',
      title: 'Who wrote it',
      ...base,
      status: 'idea',
      provenance: 'invented',
      question: 'Who wrote the second letter?',
      state: 'open',
      decision: '',
    },
  ],
};
const all: Record<string, Record<string, unknown>[]> = {
  ...fx,
  ...extra,
  moments: [...(fx.moments ?? []), ...extra.moments],
};

const model = new ReadModel();
for (const [c, docs] of Object.entries(all)) {
  for (const d of docs) model.put(c, d as { _id: string });
}
const index = new SearchIndex();
index.rebuild(model);

function run(query: string, filters: SearchFilters = {}): string[] {
  const accepts = compileFilters(filters, {
    get: (c, id) => model.get(c, id),
    places,
  });
  return index
    .search(query, ({ collection, id }) => {
      const doc = model.get(collection, id);
      return !!doc && accepts(collection, doc);
    })
    .map((h) => h.id);
}

describe('SR-1 one search box over entries and chapter text', () => {
  test('SR-1 finds entries from every section with one query', () => {
    const ids = run('letter');
    expect(ids).toEqual(expect.arrayContaining(['M3', 'Q1', 'H5-voice-0']));
  });

  test('SR-1 finds words inside chapter text', () => {
    expect(run('rice')).toContain('CH2');
    expect(run('wedding')).toContain('CH3');
  });

  test('SR-1 finds Chinese by characters, by one character, and by romanization with or without tones', () => {
    expect(run('晓曦')).toContain('GL1');
    expect(run('曦')).toContain('GL1');
    expect(run('tuányuán')).toEqual(['GL3']);
    expect(run('tuanyuan')).toEqual(['GL3']);
    expect(run('tuan2yuan2')).toEqual(['GL3']);
    expect(run('family reunion')).toEqual(['GL3']);
  });

  test('SR-1 SM-3 finds text in moments: what happens, how they experience it, world events, and tags', () => {
    expect(run('soak seeds overnight')).toContain('M1');
    expect(run('chowder')).toContain('M2');
    expect(run('letters pass down')).toContain('M3');
    expect(run('motif')).toContain('M3');
  });

  test('SR-1 a query with several words wants all of them, and falls back to any when none has all', () => {
    expect(run('clams potatoes')).toEqual(['M2']);
    const loose = run('clams mooncake');
    expect(loose).toEqual(expect.arrayContaining(['M1', 'M2']));
  });
});

describe('SR-2 search filters', () => {
  test('SR-2 section filter keeps only the chosen sections', () => {
    const ids = run('letter', { sections: ['moments'] });
    expect(ids.sort()).toEqual(['H5-voice-0', 'M3']);
    expect(run('letter', { sections: ['moments', 'openQuestions'] }).sort()).toEqual([
      'H5-voice-0',
      'M3',
      'Q1',
    ]);
  });

  test('SR-2 status and provenance filters', () => {
    expect(run('letter', { status: ['idea'] })).toEqual(['Q1']);
    expect(run('letter', { status: ['planned'] })).toContain('M3');
    expect(run('letter', { provenance: ['invented'] })).toEqual(
      expect.arrayContaining(['M3', 'Q1']),
    );
    expect(run('letter', { provenance: ['researched'] })).toEqual([]);
  });

  test('SR-2 family filter matches the family, its characters, and entries that refer to them', () => {
    const zhou = run('zhou', { familyId: 'FAM-ZHOU' });
    expect(zhou).toEqual(expect.arrayContaining(['Z1', 'Z3']));
    expect(zhou).not.toContain('H3');
    // A chapter refers to characters; Hale-only chapter text does not match the Zhou filter.
    expect(run('casseroles', { familyId: 'FAM-ZHOU' })).not.toContain('CH4');
    expect(run('casseroles', { familyId: 'FAM-HALE' })).toContain('CH4');
    // Iris belongs to both families.
    expect(run('iris', { familyId: 'FAM-ZHOU' })).toContain('H5');
    expect(run('iris', { familyId: 'FAM-HALE' })).toContain('H5');
  });

  test('SR-2 place filter includes the places inside the chosen place', () => {
    expect([...placeAndDescendants(places, 'PL1')].sort()).toEqual(['PL1', 'PL2', 'PL3']);
    expect(run('archive', { placeId: 'PL1' })).toEqual(['PL3']);
    expect(run('archive', { placeId: 'PL4' })).toEqual([]);
    expect(run('pearl', { placeId: 'PL3' })).toEqual([]);
  });

  test('SR-2 tag filter matches entries that carry the tag', () => {
    expect(run('inheritance', { tag: 'motif' })).toEqual(['M3']);
    expect(run('inheritance', { tag: 'other' })).toEqual([]);
  });

  test('SR-2 year range filter applies to any entry with a year or range field', () => {
    // Moments: 1980 and 1985.
    expect(run('seeds clams', { yearFrom: 1984, yearTo: 1990 })).toEqual(['M2']);
    // A moment has a year range, a world event a date range.
    expect(run('letter', { yearFrom: 2063, yearTo: 2063 })).toContain('M3');
    expect(run('letter', { yearFrom: 2066 })).not.toContain('M3');
    // An entry with no year is left out once a year filter is set.
    expect(run('letter', { yearFrom: 1000, yearTo: 3000 })).not.toContain('Q1');
    // Chapters use their strands; characters use birth and death.
    expect(run('wedding weather', { yearFrom: 2029, yearTo: 2029 })).toContain('CH3');
    expect(run('margaret', { yearFrom: 2041, yearTo: 2041 })).toContain('H1');
  });

  test('SR-2 filters combine, and an empty filter set keeps every match', () => {
    expect(run('letter', {})).toEqual(run('letter'));
    expect(run('letter', { sections: ['moments'], status: ['idea'] })).toEqual([]);
    expect(
      run('letter', { sections: ['openQuestions'], status: ['idea'], tag: undefined }),
    ).toEqual(['Q1']);
  });

  test('SR-2 entrySpans reads points, pairs, and dates from the manifests', () => {
    const doc = (c: string, id: string) => fx[c]!.find((d) => d._id === id)!;
    expect(entrySpans('moments', doc('moments', 'H5-voice-0'))).toEqual([[2060, 2060]]);
    expect(entrySpans('moments', doc('moments', 'Z3-lives-0'))).toEqual([[1988, 2027]]);
    expect(entrySpans('chapters', doc('chapters', 'CH2')).sort()).toEqual([
      [2032, 2032],
      [2045, 2045],
    ]);
    const event = fx.worldEvents!.find((e) => e.end)!;
    const [lo, hi] = entrySpans('worldEvents', event)[0]!;
    expect(hi).toBeGreaterThanOrEqual(lo);
    expect(entrySpans('families', doc('families', 'FAM-HALE'))).toEqual([]);
    expect(entrySpans('nothing', {})).toEqual([]);
  });

  test('SR-2 overlap treats a missing bound as open', () => {
    const spans = [[2000, 2010]] as const;
    expect(overlapsYears(spans, 2005, null)).toBe(true);
    expect(overlapsYears(spans, null, 1999)).toBe(false);
    expect(overlapsYears(spans, 2010, 2020)).toBe(true);
    expect(overlapsYears(spans, 2011, 2020)).toBe(false);
    expect(overlapsYears([], null, null)).toBe(false);
  });
});
