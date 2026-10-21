import { describe, expect, test } from 'vitest';
import {
  decadeGroups,
  decadeLabel,
  decadeOf,
  decadeSpan,
  decadesFor,
  demographicOf,
  spanInDecade,
} from '../../src/shared/domain/culture';
import { CulturalEntry, DEMOGRAPHIC_OPTIONS } from '../../src/shared/schema/world';

const line = (
  id: string,
  title: string,
  communityId: string,
  startYear: number | null,
  endYear: number | null,
  demographic?: string,
) => ({ _id: id, title, communityId, startYear, endYear, ...(demographic ? { demographic } : {}) });

describe('A41 cultural lines by decade and age group', () => {
  test('A41 a year falls in its decade, labelled with an s, and a line added there covers that decade only', () => {
    expect(decadeOf(2047)).toBe(2040);
    expect(decadeOf(2040)).toBe(2040);
    expect(decadeOf(-5)).toBe(-10);
    expect(decadeLabel(2040)).toBe('2040s');
    expect(decadeSpan(2040)).toEqual({ startYear: 2040, endYear: 2049 });
  });

  test('A41 an entry made before the age group field is about everyone; the schema fills the same default', () => {
    expect(demographicOf({ title: 'x' })).toBe('all');
    expect(demographicOf({ demographic: '18-30' })).toBe('18-30');
    expect(demographicOf({ demographic: 'teens' })).toBe('all');
    const parsed = CulturalEntry.parse({
      _id: 'CU9',
      title: 'Mooncakes',
      status: 'canon',
      createdAt: '2026-01-15T09:00:00.000Z',
      modifiedAt: '2026-01-15T09:00:00.000Z',
      communityId: 'sf',
      startYear: 2040,
      endYear: 2049,
    });
    expect(parsed.demographic).toBe('all');
    expect(DEMOGRAPHIC_OPTIONS.map((o) => o.value)).toEqual([
      'all',
      '0-18',
      '18-30',
      '30-50',
      '50-70',
      '70+',
    ]);
  });

  test('A41 CU-1 decade groups hold every age group in order, with the lines of one community that touch the decade, earliest first', () => {
    const entries = [
      line('a', 'Ferry picnics', 'sf', 2000, 2034, 'all'),
      line('b', 'Flood walk', 'sf', 2035, 2100),
      line('c', 'Night markets', 'sf', 2041, 2043, '18-30'),
      line('d', 'Apprenticeships', 'sf', 2030, 2049, '18-30'),
      line('e', 'Open ended', 'sf', null, null, '70+'),
      line('f', 'Elsewhere', 'jinan', 2040, 2049, '18-30'),
      { ...line('g', 'Trashed', 'sf', 2040, 2049, '18-30'), deletedAt: '2026-01-01' },
    ];
    const groups = decadeGroups(entries, 'sf', 2040);
    expect(groups.map((g) => g.demographic)).toEqual([
      'all',
      '0-18',
      '18-30',
      '30-50',
      '50-70',
      '70+',
    ]);
    expect(groups.map((g) => g.label)).toEqual(DEMOGRAPHIC_OPTIONS.map((o) => o.label));
    const titles = (d: string) => groups.find((g) => g.demographic === d)!.rows.map((r) => r.title);
    expect(titles('all')).toEqual(['Flood walk']);
    expect(titles('18-30')).toEqual(['Apprenticeships', 'Night markets']);
    expect(titles('70+')).toEqual(['Open ended']);
    expect(titles('0-18')).toEqual([]);
    // The 2030s: the picnics end in 2034 and the walk starts in 2035, so both touch it.
    expect(
      decadeGroups(entries, 'sf', 2030)
        .find((g) => g.demographic === 'all')!
        .rows.map((r) => r.title),
    ).toEqual(['Ferry picnics', 'Flood walk']);
  });

  test('A41 the decades offered run from a decade before the earliest year to a decade after the latest, and always hold the story year', () => {
    expect(decadesFor([], [], 2045)).toEqual([2030, 2040, 2050]);
    const entries = [line('a', 'x', 'sf', 2000, 2034), line('b', 'y', 'sf', 2035, 2100)];
    const eras = [{ startYear: 2020, endYear: 2029 }];
    expect(decadesFor(entries, eras, 2045)).toEqual([
      1990, 2000, 2010, 2020, 2030, 2040, 2050, 2060, 2070, 2080, 2090, 2100, 2110,
    ]);
    expect(decadesFor([{ ...line('t', 'x', 'sf', 1900, 1909), deletedAt: 'x' }], [], 2045)).toEqual(
      [2030, 2040, 2050],
    );
  });

  test('A41 a line reads its years inside a decade only when they differ from that decade', () => {
    expect(spanInDecade({ startYear: 2040, endYear: 2049 }, 2040)).toBeNull();
    expect(spanInDecade({ startYear: 2035, endYear: 2100 }, 2040)).toBe('2035 to 2100');
    expect(spanInDecade({ startYear: 2041, endYear: null }, 2040)).toBe('from 2041');
    expect(spanInDecade({ startYear: null, endYear: 2048 }, 2040)).toBe('until 2048');
    expect(spanInDecade({ startYear: null, endYear: null }, 2040)).toBe('every year');
  });
});
