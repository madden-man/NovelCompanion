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
    positionYear(null, fixture.chapters!),
    storyYear === null ? null : { year: storyYear },
  )!;

describe('SM-1 CH-3 the character page', () => {
  test('CH-3 with no story time, ages show at the last written chapter: chapter 5 in 2040', () => {
    const p = page('H1');
    expect(p.current).toEqual({
      year: 2040,
      chapterId: 'CH5',
      chapter: expect.any(String),
      readingOrder: 5,
      state: { state: 'alive', age: 82, dyingThisYear: false },
    });
    expect(p.storyTime).toBeNull();
  });

  test('CH-3 with a story time, the page has both the current-position age and the story-time age', () => {
    const p = page('H1', 2041);
    expect(p.current.state).toEqual({ state: 'alive', age: 82, dyingThisYear: false });
    expect(p.storyTime).toEqual({
      year: 2041,
      state: { state: 'alive', age: 83, dyingThisYear: true },
    });
    expect(page('H1', 2075).storyTime!.state).toEqual({ state: 'dead', deathYear: 2041 });
    expect(page('Z5', 2040).storyTime!.state).toEqual({ state: 'unborn', birthYear: 2058 });
    expect(page('Z5').current.state).toEqual({ state: 'unborn', birthYear: 2058 });
  });

  test('SM-1 the page carries the full name and the Chinese name, nothing else', () => {
    expect(page('H1').names).toEqual({ full: 'Margaret Hale', chinese: '' });
    expect(page('Z1').names).toEqual({ full: 'Zhou Meiling', chinese: '周美玲' });
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

  test('CH-4 unknown birth: age unknown at every position', () => {
    const p = page('U1', 2040);
    expect(p.birthKnown).toBe(false);
    expect(p.years).toBe('unknown');
    expect(p.current.state).toEqual({ state: 'unknown' });
    expect(p.storyTime!.state).toEqual({ state: 'unknown' });
  });
});
