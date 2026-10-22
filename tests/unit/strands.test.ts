import { describe, expect, test } from 'vitest';
import {
  addStrandCharacter,
  charactersChange,
  charactersChangeLabel,
  removeStrandCharacter,
  setStrandCharacters,
  setStrandPov,
  setStrandYear,
  strandById,
  strandCharacters,
  strandsOf,
} from '../../src/shared/domain/strands';

const strands = [
  {
    id: 'CH6-present',
    label: 'present',
    startYear: 2045,
    endYear: null,
    primary: true,
    povCharacterId: 'H5',
    characterIds: ['H2'],
    placeIds: ['P1'],
  },
  {
    id: 'CH6-back',
    label: 'backstory',
    startYear: 2030,
    endYear: 2032,
    primary: false,
    povCharacterId: null,
    characterIds: [],
    placeIds: [],
  },
];

const names: Record<string, string> = { H2: 'Daniel Hale', H5: 'Iris Hale-Zhou', Z4: 'Zhou Jun' };

describe('IP-2 strands.ts builds the patch over chapters.strands for the writing desk', () => {
  test('IP-2 strandsOf reads the stored strands and skips anything that is not one', () => {
    expect(strandsOf({ strands: [...strands, 'x', { label: 'no id' }] })).toHaveLength(2);
    expect(strandsOf({})).toEqual([]);
    expect(strandsOf(null)).toEqual([]);
    expect(strandById(strandsOf({ strands }), 'CH6-back')?.label).toBe('backstory');
  });

  test('IP-2 the story year moves one strand and a range keeps its length', () => {
    const one = setStrandYear(strands, 'CH6-present', 2046);
    expect(one?.[0]).toMatchObject({ startYear: 2046, endYear: null });
    expect(one?.[1]).toBe(strands[1]);
    const range = setStrandYear(strands, 'CH6-back', 2040);
    expect(range?.[1]).toMatchObject({ startYear: 2040, endYear: 2042 });
    expect(setStrandYear(strands, 'nope', 2040)).toBeNull();
    // The input is never changed.
    expect(strands[0]?.startYear).toBe(2045);
  });

  test('IP-2 the point of view is set or cleared on that strand only', () => {
    expect(setStrandPov(strands, 'CH6-present', 'H2')?.[0]?.povCharacterId).toBe('H2');
    expect(setStrandPov(strands, 'CH6-present', null)?.[0]?.povCharacterId).toBeNull();
    expect(setStrandPov(strands, 'CH6-present', 'H2')?.[1]).toBe(strands[1]);
    expect(setStrandPov(strands, 'nope', 'H2')).toBeNull();
  });

  test('IP-2 characters present are added once, removed, and set in order without repeats', () => {
    const added = addStrandCharacter(strands, 'CH6-present', 'Z4');
    expect(strandCharacters(added?.[0])).toEqual(['H2', 'Z4']);
    const twice = addStrandCharacter(added ?? [], 'CH6-present', 'Z4');
    expect(strandCharacters(twice?.[0])).toEqual(['H2', 'Z4']);
    const removed = removeStrandCharacter(added ?? [], 'CH6-present', 'H2');
    expect(strandCharacters(removed?.[0])).toEqual(['Z4']);
    const set = setStrandCharacters(strands, 'CH6-back', ['Z4', 'H2', 'Z4']);
    expect(strandCharacters(set?.[1])).toEqual(['Z4', 'H2']);
    expect(addStrandCharacter(strands, 'nope', 'Z4')).toBeNull();
    expect(removeStrandCharacter(strands, 'nope', 'Z4')).toBeNull();
    // Other fields of the strand stay as they were.
    expect(added?.[0]).toMatchObject({ povCharacterId: 'H5', placeIds: ['P1'], startYear: 2045 });
  });

  test('IP-2 the undo label names who was added or removed and the chapter', () => {
    const nameOf = (id: string) => names[id] ?? id;
    expect(charactersChange(['H2'], ['H2', 'Z4'])).toEqual({ added: ['Z4'], removed: [] });
    expect(charactersChangeLabel(['H2'], ['H2', 'Z4'], nameOf, 'The Letter')).toBe(
      'Added Zhou Jun to The Letter',
    );
    expect(charactersChangeLabel(['H2', 'Z4'], ['Z4'], nameOf, 'The Letter')).toBe(
      'Removed Daniel Hale from The Letter',
    );
    expect(charactersChangeLabel(['H2'], ['Z4'], nameOf, 'The Letter')).toBe(
      'Changed who is in The Letter',
    );
  });
});
