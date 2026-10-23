import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  ERA_SPAN,
  NO_FILTERS,
  compare,
  coverageMessages,
  defaultEraRanges,
  eraCoverage,
  eraFor,
  eraSpans,
  erasFor,
  eventsAhead,
  eventsIn,
  eventsUpTo,
  everyoneIn,
  filterChart,
  fromCollections,
  livedThrough,
  stateIn,
  stepYear,
  strandsIn,
  timelineChart,
  yearForAge,
} from '../../src/shared/domain/timeline';
import type { TimelineData } from '../../src/shared/domain/timeline';
import type { ListDoc } from '../../src/shared/schema';
import { readFixture } from '../helpers/loadFixture';

type Doc = { _id: string } & Record<string, unknown>;
type Expected = {
  years: {
    year: number;
    alive: { id: string; age: number; dyingThisYear: boolean }[];
    dead: { id: string; deathYear: number }[];
    unborn: string[];
    unknown: string[];
  }[];
};

const ROOT = join(import.meta.dirname, '../..');
const expected = JSON.parse(
  readFileSync(join(ROOT, 'fixtures/expected/tl2.json'), 'utf8'),
) as Expected;
const fixture = readFixture();
const data = (): TimelineData => fromCollections(fixture);
const byId = <T extends { id: string }>(xs: T[]) =>
  [...xs].sort((a, b) => a.id.localeCompare(b.id));
const char = (id: string) => fixture.characters!.find((c) => c._id === id)!;

/** A tiny pseudo-random sequence, so property runs are repeatable. */
function rng(seed: number) {
  let s = seed >>> 0;
  return (lo: number, hi: number) => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return lo + (s % (hi - lo + 1));
  };
}

function listFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? listFiles(join(dir, d.name)) : [join(dir, d.name)],
  );
}

describe('TL-1 computed in code, never by a model', () => {
  test('TL-1 src/shared/domain imports nothing from src/main/claude or anything else in main', () => {
    const files = listFiles(join(ROOT, 'src/shared/domain')).filter((f) => /\.tsx?$/.test(f));
    expect(files.map((f) => f.split('/').pop())).toContain('timeline.ts');
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      const specs = [...text.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map(
        (m) => m[1]!,
      );
      for (const s of specs) {
        expect(s, `${f} imports ${s}`).not.toMatch(/main\/claude|claude-agent-sdk|anthropic/);
        expect(s, `${f} imports ${s}`).not.toMatch(/(^|\/)main\//);
        expect(s, `${f} imports ${s}`).not.toMatch(/^(electron|mongodb|react)/);
      }
    }
  });
});

describe('TL-2 to TL-4 everyone in a year', () => {
  for (const y of expected.years) {
    test(`TL-2 TL-4 everyoneIn(${y.year}) matches the hand-written fixture answers exactly`, () => {
      const got = everyoneIn(data(), y.year);
      expect(got.year).toBe(y.year);
      expect(byId(got.alive)).toEqual(byId(y.alive));
      expect(byId(got.dead)).toEqual(byId(y.dead));
      expect([...got.unborn].sort()).toEqual([...y.unborn].sort());
      expect([...got.unknown].sort()).toEqual([...y.unknown].sort());
      expect(got.rows).toHaveLength(fixture.characters!.length);
    });
  }

  test('TL-4 in 2041 Margaret Hale is listed alive at 83 and flagged as dying that year', () => {
    const row = everyoneIn(data(), 2041).rows.find((r) => r.id === 'H1')!;
    expect(row.state).toEqual({ state: 'alive', age: 83, dyingThisYear: true });
    expect(stateIn(char('H1'), 2042)).toEqual({ state: 'dead', deathYear: 2041 });
  });

  test('TL-2 rows list the alive first, then the unborn, the dead, and the unknown', () => {
    const order = everyoneIn(data(), 2040).rows.map((r) => r.state.state);
    const rank = { alive: 0, unborn: 1, dead: 2, unknown: 3 };
    expect([...order].sort((a, b) => rank[a] - rank[b])).toEqual(order);
    expect(order.at(-1)).toBe('unknown');
  });

  test('TL-2 characters in the trash are left out', () => {
    const chars = fixture.characters!.map((c) =>
      c._id === 'H2' ? { ...c, deletedAt: '2026-02-01T00:00:00.000Z' } : c,
    );
    const got = everyoneIn(fromCollections({ ...fixture, characters: chars }), 2040);
    expect(got.dead).toEqual([]);
  });
});

describe('TL-3 TL-4 CH-4 date edge cases (property style)', () => {
  test('TL-3 with full dates, the age is one less until the birthday is reached in that year', () => {
    const r = rng(7);
    for (let i = 0; i < 500; i++) {
      const birth = { year: r(1900, 2080), month: r(1, 12), day: r(1, 28) };
      const year = birth.year + r(1, 90);
      const person = { birth, death: null };
      const before =
        birth.month > 1 || birth.day > 1
          ? birth.day > 1
            ? { year, month: birth.month, day: birth.day - 1 }
            : { year, month: birth.month - 1, day: 28 }
          : null;
      const on = { year, month: birth.month, day: birth.day };
      expect(stateIn(person, on)).toEqual({
        state: 'alive',
        age: year - birth.year,
        dyingThisYear: false,
      });
      if (before) {
        expect(stateIn(person, before)).toEqual({
          state: 'alive',
          age: year - birth.year - 1,
          dyingThisYear: false,
        });
      }
      // A year-only question is always year minus birth year.
      expect(stateIn(person, year)).toEqual({
        state: 'alive',
        age: year - birth.year,
        dyingThisYear: false,
      });
    }
  });

  test('TL-3 a full-date birth asked about a date before it in the birth year is not yet born', () => {
    const person = { birth: { year: 2031, month: 6, day: 15 }, death: null };
    expect(stateIn(person, { year: 2031, month: 6, day: 14 })).toEqual({
      state: 'unborn',
      birthYear: 2031,
    });
    expect(stateIn(person, { year: 2031, month: 6, day: 15 })).toEqual({
      state: 'alive',
      age: 0,
      dyingThisYear: false,
    });
  });

  test('TL-4 death year equals birth year: alive at 0 and dying that year, dead after', () => {
    const r = rng(11);
    for (let i = 0; i < 200; i++) {
      const y = r(1800, 2200);
      const person = { birth: { year: y }, death: { year: y } };
      expect(stateIn(person, y)).toEqual({ state: 'alive', age: 0, dyingThisYear: true });
      expect(stateIn(person, y - 1)).toEqual({ state: 'unborn', birthYear: y });
      expect(stateIn(person, y + 1)).toEqual({ state: 'dead', deathYear: y });
    }
  });

  test('TL-4 for any lifespan, every year from birth to death is alive and only the death year is flagged', () => {
    const r = rng(23);
    for (let i = 0; i < 200; i++) {
      const born = r(1900, 2080);
      const died = born + r(0, 100);
      const person = { birth: { year: born }, death: { year: died } };
      for (let y = born - 2; y <= died + 2; y++) {
        const s = stateIn(person, y);
        if (y < born) expect(s.state).toBe('unborn');
        else if (y > died) expect(s).toEqual({ state: 'dead', deathYear: died });
        else expect(s).toEqual({ state: 'alive', age: y - born, dyingThisYear: y === died });
      }
    }
  });

  test('CH-4 an unknown birth is unknown in every year and never estimated', () => {
    const r = rng(5);
    const u1 = char('U1');
    for (let i = 0; i < 100; i++) {
      const y = r(1800, 2200);
      expect(stateIn(u1, y)).toEqual({ state: 'unknown' });
      expect(stateIn({ birth: { unknown: true }, death: null }, y)).toEqual({ state: 'unknown' });
    }
    expect(yearForAge(u1, 30)).toBeNull();
    const lived = livedThrough(data(), 'U1', 2075)!;
    expect(lived.birthKnown).toBe(false);
    expect(lived.events).toEqual([]);
    expect(compare(data(), 'U1', 'H5', 2040, 2040, 1)[0]!.a).toEqual({ state: 'unknown' });
  });

  test('CH-4 an unknown birth with a known death is dead after the death and unknown before', () => {
    const person = { birth: { unknown: true as const }, death: { year: 2050 } };
    expect(stateIn(person, 2051)).toEqual({ state: 'dead', deathYear: 2050 });
    expect(stateIn(person, 2040)).toEqual({ state: 'unknown' });
  });
});

describe('TL-5 lived through', () => {
  test('TL-5 Iris Hale-Zhou by 2060 lived through five events, with her age at each', () => {
    const got = livedThrough(data(), 'H5', 2060)!;
    expect(got.birthKnown).toBe(true);
    expect(got.events.map((e) => [e.id, e.year, e.age, e.formative])).toEqual([
      ['E3', 2034, 3, true],
      ['E4', 2036, 5, false],
      ['E5', 2042, 11, false],
      ['E6', 2048, 17, false],
      ['E7', 2057, 26, false],
    ]);
  });

  test('TL-5 events after death are left out; Peter Hale (1956 to 2030) lived through two', () => {
    const got = livedThrough(data(), 'H2', 2075)!;
    expect(got.events.map((e) => [e.id, e.age])).toEqual([
      ['E1', 52],
      ['E2', 71],
    ]);
  });

  test('TL-5 an event already running at birth counts from the birth year at age 0', () => {
    const d = fromCollections({
      characters: [{ _id: 'C', birth: { year: 2049 }, death: null }],
      worldEvents: [{ _id: 'W', title: 'Seawall', start: { year: 2048 }, end: { year: 2051 } }],
    });
    expect(livedThrough(d, 'C', 2050)!.events.map((e) => [e.year, e.age])).toEqual([[2049, 0]]);
  });

  test('TL-5 a character not yet born has lived through nothing', () => {
    expect(livedThrough(data(), 'Z5', 2040)!.events).toEqual([]);
  });
});

describe('WE-2 WE-3 eras and events', () => {
  test('WE-3 the era for a year, and none outside the eras', () => {
    expect(eraFor(data(), 2040)!.id).toBe('ERA-2040');
    expect(eraFor(data(), 2049)!.id).toBe('ERA-2040');
    expect(eraFor(data(), 2100)!.id).toBe('ERA-2090');
    expect(eraFor(data(), 2025)!.id).toBe('ERA-2025');
    expect(eraFor(data(), 2024)).toBeNull();
  });

  test('WE-3 the events up to a year, in date order, and within a window', () => {
    expect(eventsUpTo(data(), 2045).map((e) => e.id)).toEqual(['E1', 'E2', 'E3', 'E4', 'E5']);
    expect(eventsUpTo(data(), 2045, 5).map((e) => e.id)).toEqual(['E5']);
    expect(eventsUpTo(data(), 2050, 0).map((e) => e.id)).toEqual(['E6']);
    expect(eventsUpTo(data(), 2100).map((e) => e.id)).toHaveLength(11);
    expect(eventsUpTo(data(), 2007)).toEqual([]);
  });

  test('A33 eventsAhead: the events not yet begun that start within the years ahead', () => {
    expect(eventsAhead(data(), 2047, 1).map((e) => e.id)).toEqual(['E6']);
    expect(eventsAhead(data(), 2048, 1).map((e) => e.id)).toEqual([]);
    expect(eventsAhead(data(), 2056, 1).map((e) => e.id)).toEqual(['E7']);
    expect(eventsAhead(data(), { year: 2008, month: 8, day: 7 }, 0).map((e) => e.id)).toEqual([
      'E1',
    ]);
    expect(eventsAhead(data(), 2045, 0)).toEqual([]);
  });

  test('WE-3 with a full date, an event later in the same year has not happened yet', () => {
    expect(eventsUpTo(data(), { year: 2008, month: 8, day: 7 }).map((e) => e.id)).toEqual([]);
    expect(eventsUpTo(data(), { year: 2008, month: 8, day: 8 }).map((e) => e.id)).toEqual(['E1']);
  });

  test('WE-1 events can be a date, a year, or a range', () => {
    const ev = eventsIn(data(), 2049);
    expect(ev.map((e) => [e.id, e.startYear, e.endYear])).toEqual([['E6', 2048, 2051]]);
    expect(eventsIn(data(), 2008)[0]!.start).toEqual({ year: 2008, month: 8, day: 8 });
    expect(eventsIn(data(), 2027)[0]!.end).toBeNull();
  });

  test('WE-2 the fixture eras cover 2025 to 2100 with no gaps or overlaps', () => {
    const c = eraCoverage(eraSpans(data()));
    expect(c).toEqual({ from: 2025, to: 2100, gaps: [], overlaps: [], backwards: [] });
    expect(coverageMessages(c)).toEqual([]);
  });

  test('WE-2 removing an era is flagged as a gap, and widening one as an overlap', () => {
    const eras = fixture.eraStates!;
    const gap = eraCoverage(
      eraSpans(fromCollections({ eraStates: eras.filter((e) => e._id !== 'ERA-2050') })),
    );
    expect(gap.gaps).toEqual([{ from: 2050, to: 2059 }]);
    expect(coverageMessages(gap)).toEqual(['No era covers 2050 to 2059.']);
    const wide = eras.map((e) => (e._id === 'ERA-2040' ? { ...e, endYear: 2052 } : e));
    const over = eraCoverage(eraSpans(fromCollections({ eraStates: wide })));
    expect(over.gaps).toEqual([]);
    expect(over.overlaps).toEqual([
      {
        ids: ['ERA-2040', 'ERA-2050'],
        names: ['The forties', 'The fifties'],
        from: 2050,
        to: 2052,
      },
    ]);
    expect(erasFor(fromCollections({ eraStates: wide }), 2051).map((e) => e.id)).toEqual([
      'ERA-2050',
      'ERA-2040',
    ]);
    expect(eraFor(fromCollections({ eraStates: wide }), 2051)!.id).toBe('ERA-2050');
  });

  test('WE-2 gaps at either end, an era ending before it starts, and eras in the trash', () => {
    const c = eraCoverage(
      eraSpans(
        fromCollections({
          eraStates: [
            { _id: 'A', name: 'A', startYear: 2030, endYear: 2060 },
            { _id: 'B', name: 'B', startYear: 2090, endYear: 2080 },
            {
              _id: 'C',
              name: 'C',
              startYear: 2025,
              endYear: 2100,
              deletedAt: '2026-01-01T00:00:00Z',
            },
          ],
        }),
      ),
    );
    expect(c.gaps).toEqual([
      { from: 2025, to: 2029 },
      { from: 2061, to: 2100 },
    ]);
    expect(c.backwards).toEqual([{ id: 'B', name: 'B' }]);
    expect(eraCoverage([]).gaps).toEqual([{ from: 2025, to: 2100 }]);
  });

  test('WE-2 the default eras for a new bible cover 2025 to 2100 with no gaps', () => {
    const eras = defaultEraRanges().map((r, i) => ({ _id: `D${i}`, ...r }));
    const c = eraCoverage(eraSpans(fromCollections({ eraStates: eras })));
    expect(c.gaps).toEqual([]);
    expect(c.overlaps).toEqual([]);
    expect(eras[0]!.startYear).toBe(ERA_SPAN.from);
    expect(eras.at(-1)!.endYear).toBe(ERA_SPAN.to);
  });
});

describe('TM-2 TM-4 story time helpers', () => {
  test('TM-2 the strands that fall in a year, including a backstory strand', () => {
    expect(strandsIn(data(), 2045).map((s) => s.strandId)).toEqual(['CH2-present', 'CH6-present']);
    expect(strandsIn(data(), 2032).map((s) => [s.strandId, s.primary])).toEqual([
      ['CH2-backstory', false],
      ['CH4-present', true],
    ]);
    expect(strandsIn(data(), 2050)).toEqual([]);
  });

  test('TM-4 "Iris Hale-Zhou is 9" gives 2040, and stepping moves by one or ten', () => {
    expect(yearForAge(char('H5'), 9)).toBe(2040);
    expect(stepYear(2040, 10)).toBe(2050);
    expect(stepYear(2040, -1)).toBe(2039);
  });
});

describe('TL-7 compare', () => {
  test('TL-7 Margaret Hale and Iris Hale-Zhou every five years from 2030 to 2045', () => {
    const rows = compare(data(), 'H1', 'H5', 2030, 2045, 5);
    expect(rows).toEqual([
      {
        year: 2030,
        a: { state: 'alive', age: 72, dyingThisYear: false },
        b: { state: 'unborn', birthYear: 2031 },
        gap: null,
      },
      {
        year: 2035,
        a: { state: 'alive', age: 77, dyingThisYear: false },
        b: { state: 'alive', age: 4, dyingThisYear: false },
        gap: 73,
      },
      {
        year: 2040,
        a: { state: 'alive', age: 82, dyingThisYear: false },
        b: { state: 'alive', age: 9, dyingThisYear: false },
        gap: 73,
      },
      {
        year: 2045,
        a: { state: 'dead', deathYear: 2041 },
        b: { state: 'alive', age: 14, dyingThisYear: false },
        gap: null,
      },
    ]);
  });

  test('TL-7 every year gives one row per year, and a reversed range still runs low to high', () => {
    const rows = compare(data(), 'H3', 'Z3', 2045, 2030, 1);
    expect(rows.map((r) => r.year)).toEqual(Array.from({ length: 16 }, (_, i) => 2030 + i));
    expect(rows.every((r) => r.gap === 3)).toBe(true);
    expect(compare(data(), 'H3', 'NOPE', 2030, 2040, 1)).toEqual([]);
  });
});

describe('TL-6 timeline chart and filters', () => {
  const categories = fixture.lists!.find((l) => l._id === 'eventCategories') as unknown as ListDoc;
  const chart = () => timelineChart(data());

  test('TL-6 the chart has every era, event, strand, and lifespan; unknown births are listed, not drawn', () => {
    const c = chart();
    expect(c.eras).toHaveLength(8);
    expect(c.events).toHaveLength(11);
    expect(c.strands).toHaveLength(9);
    expect(c.lifespans.map((l) => l.id)).not.toContain('U1');
    expect(c.lifespans).toHaveLength(12);
    expect(c.undrawn).toEqual([{ id: 'U1', name: 'The Archivist' }]);
    const robots = c.events.find((e) => e.id === 'E2')!;
    expect([robots.categoryPath, robots.categoryRoot]).toEqual([
      'Technology > Robotics',
      'technology',
    ]);
    const h1 = c.lifespans.find((l) => l.id === 'H1')!;
    expect([h1.birthYear, h1.deathYear, h1.familyIds]).toEqual([1958, 2041, ['FAM-HALE']]);
  });

  test('TL-6 WE-1 the category filter keeps the category and everything under it', () => {
    const f = filterChart(chart(), { ...NO_FILTERS, categoryId: 'technology' }, { categories });
    expect(f.events.map((e) => e.id).sort()).toEqual(['E11', 'E2', 'E5', 'E9']);
    expect(f.lifespans).toHaveLength(12);
    expect(f.eras).toHaveLength(8);
  });

  test('TL-6 the family filter keeps that family, the events that touch it, and its chapters', () => {
    const f = filterChart(chart(), { ...NO_FILTERS, familyId: 'FAM-ZHOU' }, { categories });
    expect(f.lifespans.map((l) => l.id).sort()).toEqual(['H5', 'Z1', 'Z2', 'Z3', 'Z4', 'Z5']);
    expect(f.events.map((e) => e.id).sort()).toEqual(['E1', 'E3', 'E7']);
    expect(f.strands.map((s) => s.chapterId)).not.toContain('CH4');
    const none = filterChart(chart(), { ...NO_FILTERS, familyId: 'none' });
    expect(none.lifespans.map((l) => l.id)).toEqual(['X1']);
  });

  test('TL-6 SM-3 SM-4 the place filter keeps strands and lives tied to the place or a place inside it; world events have no places', () => {
    const places: Doc[] = [
      { _id: 'P-OR', title: 'Oregon', parentId: null },
      { _id: 'P-PDX', title: 'Portland, Oregon', parentId: 'P-OR' },
      { _id: 'P-GZ', title: 'Guangzhou', parentId: null },
    ];
    const chapters = fixture.chapters!.map((c) =>
      c._id === 'CH5'
        ? { ...c, strands: (c.strands as Doc[]).map((s) => ({ ...s, placeIds: ['P-PDX'] })) }
        : c,
    );
    const d = fromCollections({ ...fixture, chapters, places });
    const f = filterChart(timelineChart(d), { ...NO_FILTERS, placeId: 'P-OR' }, { places });
    // A39 dropped the places of world events, so a place filter leaves them all.
    expect(f.events).toHaveLength(timelineChart(d).events.length);
    expect(f.strands.map((s) => s.chapterId)).toEqual(['CH5']);
    // Zhou Lan's "Lives in Portland, Oregon" moment ties her to it.
    expect(f.lifespans.map((l) => l.id).sort()).toEqual(['Z3']);
  });
});
