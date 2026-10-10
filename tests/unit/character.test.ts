import { describe, expect, test } from 'vitest';
import { characterPage } from '../../src/shared/domain/character';
import { positionYear } from '../../src/shared/domain/position';
import { readFixture } from '../helpers/loadFixture';

const fixture = readFixture();
const data = { all: (c: string) => fixture[c] ?? [] };
const page = (id: string, storyYear: number | null = null) =>
  characterPage(
    data,
    id,
    positionYear(storyYear === null ? null : { year: storyYear }, fixture.chapters!),
  )!;

describe('CH-2 CH-3 the character page', () => {
  test('CH-3 with no story time, ages show at the last written chapter: chapter 5 in 2040', () => {
    const p = page('H1');
    expect(p.position).toEqual({
      year: 2040,
      source: 'lastWritten',
      chapterId: 'CH5',
      state: { state: 'alive', age: 82, dyingThisYear: false },
    });
  });

  test('CH-3 a story time overrides the current position', () => {
    expect(page('H1', 2041).position.state).toEqual({
      state: 'alive',
      age: 83,
      dyingThisYear: true,
    });
    expect(page('H1', 2075).position.state).toEqual({ state: 'dead', deathYear: 2041 });
    expect(page('Z5', 2040).position.state).toEqual({ state: 'unborn', birthYear: 2058 });
  });

  test('CH-2 every name field, with what each other character calls them', () => {
    const p = page('H1');
    expect(p.names).toEqual({
      full: 'Margaret Hale',
      chinese: '',
      romanization: '',
      order: 'family-last',
      birthName: 'Margaret Doyle',
      marriedName: 'Margaret Hale',
      nicknames: ['Maggie'],
      calledBy: [{ characterId: 'H5', characterName: 'Iris Hale-Zhou', name: 'Gran' }],
    });
    expect(page('Z1').names).toMatchObject({
      chinese: '周美玲',
      romanization: 'Zhōu Měilíng',
      order: 'family-first',
    });
  });

  test('CH-1 families: one, two, or none', () => {
    expect(page('H1').families.map((f) => f.name)).toEqual(['Hale']);
    expect(page('H5').families.map((f) => f.name)).toEqual(['Hale', 'Zhou']);
    expect(page('X1').families).toEqual([]);
  });

  test('CH-3 relatives from unions and parent links', () => {
    const r = page('H3').relatives;
    expect(r.parents.map((p) => [p.name, p.type])).toEqual([
      ['Margaret Hale', 'biological'],
      ['Peter Hale', 'biological'],
    ]);
    expect(r.children.map((c) => c.name)).toEqual(['Iris Hale-Zhou']);
    expect(r.siblings).toEqual([{ id: 'H4', name: 'Ruth Hale', kind: 'full' }]);
    expect(r.partners).toEqual([
      {
        id: 'Z3',
        name: 'Zhou Lan',
        unionId: 'UN-H3-Z3',
        type: 'married',
        startYear: 2029,
        endYear: null,
        endReason: '',
      },
    ]);
    expect(page('H4').relatives.children).toEqual([
      { id: 'H6', name: 'Sam Hale', type: 'adoptive', startYear: 2015 },
    ]);
  });

  test('CH-3 the personal timeline: own events, world events in their lifetime with ages, chapters', () => {
    const t = page('H1').timeline;
    expect(t[0]).toMatchObject({ kind: 'birth', year: 1958, age: 0 });
    expect(t[t.length - 1]).toMatchObject({ kind: 'death', year: 2041, age: 83 });
    const events = t.filter((i) => i.kind === 'event').map((i) => [i.id, i.year, i.age]);
    // Margaret lives 1958 to 2041: the events from 2008 to 2036 fall in her lifetime.
    expect(events).toEqual([
      ['E1', 2008, 50],
      ['E2', 2027, 69],
      ['E3', 2034, 76],
      ['E4', 2036, 78],
    ]);
    const chapters = t.filter((i) => i.kind === 'chapter').map((i) => [i.id, i.year, i.age]);
    expect(chapters).toEqual([
      ['CH3', 2029, 71],
      ['CH4', 2032, 74],
      ['CH5', 2040, 82],
    ]);
    expect(t.filter((i) => i.kind === 'union').map((i) => i.title)).toEqual([
      'Union with Peter Hale begins',
    ]);
    expect(t.filter((i) => i.kind === 'child').map((i) => [i.title, i.year])).toEqual([
      ['Daniel Hale is born', 1985],
      ['Ruth Hale is born', 1990],
    ]);
  });

  test('CH-3 what they know, and whether they know it yet', () => {
    expect(page('H5', 2045).knowledge).toEqual([
      {
        recordId: 'K2',
        factId: 'F2',
        fact: "Peter's letter",
        yearLearned: 2060,
        chapterId: 'CH7',
        chapter: expect.any(String),
        how: "She finds it in Margaret's boxes.",
        knownAtPosition: false,
      },
    ]);
    expect(page('H5', 2061).knowledge[0]!.knownAtPosition).toBe(true);
  });

  test('CH-4 unknown birth: age unknown at every position and no lifetime events', () => {
    const p = page('U1', 2040);
    expect(p.birthKnown).toBe(false);
    expect(p.years).toBe('unknown');
    expect(p.position.state).toEqual({ state: 'unknown' });
    expect(p.timeline.filter((i) => i.kind === 'event')).toEqual([]);
    for (const i of p.timeline) expect(i.age).toBeNull();
  });
});
