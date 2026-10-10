import { describe, expect, test } from 'vitest';
import { characterPage, storyTimeState } from '../../src/shared/domain/character';
import { trapTarget } from '../../src/shared/domain/focus';
import { positionYear } from '../../src/shared/domain/position';
import { shiftStrand } from '../../src/shared/domain/strands';
import { everyoneIn, fromCollections, livedThrough } from '../../src/shared/domain/timeline';

const person = {
  _id: 'P',
  title: 'Ada Birch',
  names: { full: 'Ada Birch' },
  birth: { year: 2000, month: 6, day: 15 },
  death: { year: 2060, month: 3, day: 10 },
  familyIds: [],
};

describe('M3 review: the character page and the Story Time dialog agree', () => {
  test('TM-3 CH-3 the character page judges a full story-time date exactly, before the birthday', () => {
    const data = fromCollections({ characters: [person] });
    const at = { year: 2040, month: 3, day: 1 };
    const page = characterPage(data, 'P', positionYear(null, []), at)!;
    expect(page.storyTime).toEqual({
      ...at,
      state: { state: 'alive', age: 39, dyingThisYear: false },
    });
    // The dialog's year view uses the same moment.
    const dialog = everyoneIn(data, at);
    expect(dialog.alive).toEqual([{ id: 'P', age: 39, dyingThisYear: false }]);
    // On the birthday the age goes up; a year alone uses year arithmetic.
    expect(storyTimeState(person, { year: 2040, month: 6, day: 15 }).state).toEqual({
      state: 'alive',
      age: 40,
      dyingThisYear: false,
    });
    expect(storyTimeState(person, { year: 2040 })).toEqual({
      year: 2040,
      state: { state: 'alive', age: 40, dyingThisYear: false },
    });
  });
});

describe('M3 review: the Story Time dialog traps focus', () => {
  test('NF-2 Tab from the last control wraps to the first, Shift+Tab from the first to the last', () => {
    expect(trapTarget(4, 5, false)).toBe(0);
    expect(trapTarget(0, 5, true)).toBe(4);
    expect(trapTarget(2, 5, false)).toBeNull();
    expect(trapTarget(2, 5, true)).toBeNull();
  });

  test('NF-2 focus outside the dialog comes back in, and an empty dialog does nothing', () => {
    expect(trapTarget(-1, 3, false)).toBe(0);
    expect(trapTarget(-1, 3, true)).toBe(2);
    expect(trapTarget(-1, 0, false)).toBeNull();
  });
});

describe('M3 review: lived through stops at a full death date', () => {
  const events = [
    { _id: 'BEFORE', title: 'Before', start: { year: 2060, month: 2, day: 1 } },
    { _id: 'SAMEDAY', title: 'Same day', start: { year: 2060, month: 3, day: 10 } },
    { _id: 'LATERDAY', title: 'Later that month', start: { year: 2060, month: 3, day: 20 } },
    { _id: 'LATERMONTH', title: 'Later that year', start: { year: 2060, month: 8 } },
    { _id: 'YEARONLY', title: 'Some time that year', start: { year: 2060 } },
  ];

  test('TL-5 an event that starts after a full death date in the death year is left out', () => {
    const d = fromCollections({ characters: [person], worldEvents: events });
    const got = livedThrough(d, 'P', 2070)!.events.map((e) => e.id);
    expect(got).toEqual(['BEFORE', 'SAMEDAY', 'YEARONLY']);
  });

  test('TL-5 with a year-only death, every event of the death year still counts', () => {
    const yearOnly = { ...person, death: { year: 2060 } };
    const d = fromCollections({ characters: [yearOnly], worldEvents: events });
    expect(livedThrough(d, 'P', 2070)!.events).toHaveLength(5);
  });
});

describe('M3 review: one strand shift for the preview and the write', () => {
  const strands = [
    {
      id: 'S1',
      label: 'present',
      startYear: 2045,
      endYear: null,
      primary: true,
      povCharacterId: null,
      characterIds: [],
      placeIds: [],
    },
    {
      id: 'S2',
      label: 'backstory',
      startYear: 2030,
      endYear: 2033,
      primary: false,
      povCharacterId: null,
      characterIds: [],
      placeIds: [],
    },
  ];

  test('TM-5 a single year stays a single year; a range keeps its length; other strands are untouched', () => {
    const one = shiftStrand(strands, 'S1', 2050)!;
    expect(one.from).toEqual({ startYear: 2045, endYear: null });
    expect(one.to).toEqual({ startYear: 2050, endYear: null });
    expect(one.next[1]).toBe(strands[1]);
    expect(one.unchanged).toBe(false);
    const range = shiftStrand(strands, 'S2', 2040)!;
    expect(range.to).toEqual({ startYear: 2040, endYear: 2043 });
    expect(range.strand.label).toBe('backstory');
    expect(range.next[0]).toBe(strands[0]);
  });

  test('TM-5 the same year is unchanged, and a missing strand gives null', () => {
    expect(shiftStrand(strands, 'S1', 2045)!.unchanged).toBe(true);
    expect(shiftStrand(strands, 'NOPE', 2045)).toBeNull();
  });
});
