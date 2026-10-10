import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  ageAt,
  describeState,
  lifeState,
  lifeYears,
  statesInYear,
} from '../../src/shared/domain/ages';
import { readFixture } from '../helpers/loadFixture';

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

const people = readFixture().characters as unknown as Parameters<typeof statesInYear>[0];
const byId = (id: string) => people.find((p) => p._id === id)!;
const sortIds = <T extends { id: string }>(xs: T[]) =>
  [...xs].sort((a, b) => a.id.localeCompare(b.id));

describe('ages (TL-3, TL-4, CH-4)', () => {
  for (const y of expected.years) {
    test(`FT-5 CH-3 the fixture states in ${y.year} match the hand-written TL-2 answers`, () => {
      const got = statesInYear(people, y.year);
      expect(sortIds(got.alive)).toEqual(sortIds(y.alive));
      expect(sortIds(got.dead)).toEqual(sortIds(y.dead));
      expect([...got.unborn].sort()).toEqual([...y.unborn].sort());
      expect([...got.unknown].sort()).toEqual([...y.unknown].sort());
    });
  }

  test('CH-3 year-only birth gives Y minus the birth year; a full date gives the exact age', () => {
    expect(ageAt({ birth: { year: 1958 }, death: null }, 2040)).toBe(82);
    const iris = byId('H5');
    expect(ageAt(iris, 2040)).toBe(9);
    expect(ageAt(iris, { year: 2040, month: 3, day: 13 })).toBe(8);
    expect(ageAt(iris, { year: 2040, month: 3, day: 14 })).toBe(9);
    expect(lifeState(iris, { year: 2031, month: 1, day: 1 })).toEqual({
      state: 'unborn',
      birthYear: 2031,
    });
  });

  test('CH-3 in the year of death a character is alive and flagged as dying; after it, dead', () => {
    const h1 = byId('H1');
    expect(lifeState(h1, 2041)).toEqual({ state: 'alive', age: 83, dyingThisYear: true });
    expect(lifeState(h1, 2042)).toEqual({ state: 'dead', deathYear: 2041 });
    const full = {
      birth: { year: 2000, month: 1, day: 1 },
      death: { year: 2050, month: 6, day: 1 },
    };
    expect(lifeState(full, { year: 2050, month: 5, day: 31 })).toEqual({
      state: 'alive',
      age: 50,
      dyingThisYear: true,
    });
    expect(lifeState(full, { year: 2050, month: 6, day: 2 })).toEqual({
      state: 'dead',
      deathYear: 2050,
    });
  });

  test('CH-4 an unknown birth is reported as age unknown, never estimated', () => {
    const u1 = byId('U1');
    for (const y of [1900, 2040, 2075, 2200]) {
      expect(lifeState(u1, y)).toEqual({ state: 'unknown' });
      expect(ageAt(u1, y)).toBeNull();
    }
    expect(describeState(lifeState(u1, 2040))).toBe('age unknown');
    expect(lifeYears(u1)).toBe('unknown');
    // Even with a known death year, the age stays unknown while they are alive.
    expect(lifeState({ birth: { unknown: true }, death: { year: 2050 } }, 2049)).toEqual({
      state: 'unknown',
    });
  });

  test('FT-7 node years read as birth to death', () => {
    expect(lifeYears(byId('H1'))).toBe('1958 to 2041');
    expect(lifeYears(byId('H3'))).toBe('1985');
    expect(describeState(lifeState(byId('H1'), 2041))).toBe('alive, age 83, dies this year');
    expect(describeState(lifeState(byId('Z5'), 2040))).toBe('not yet born (born 2058)');
  });
});
