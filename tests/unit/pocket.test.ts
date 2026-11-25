import { describe, expect, test } from 'vitest';
import { buildPocket, firstNameOf, pocketText } from '../../src/shared/domain/pocket';
import type { PocketInput } from '../../src/shared/domain/pocket';
import { STAMP, WORLD_ID, worldForBible, worldIdFor } from '../../src/shared/bridge';
import { stampOf } from '../../src/main/bridge/service';
import { readFixture } from '../helpers/loadFixture';

const fx = readFixture();
type Doc = Record<string, unknown> & { _id: string };
const docs = (c: string) => (fx[c] ?? []) as Doc[];
const AT = '2026-11-20T10:00:00.000Z';

const input = (o: Partial<PocketInput> = {}): PocketInput => ({
  characters: docs('characters'),
  families: docs('families'),
  places: docs('places'),
  chapters: docs('chapters'),
  worldEvents: docs('worldEvents'),
  openQuestions: [
    {
      _id: 'Q1',
      title: 'Q1',
      question: 'Does Iris **stay**?',
      state: 'open',
      decision: '',
      modifiedAt: AT,
    },
    {
      _id: 'Q2',
      title: 'Old',
      question: 'Was it 2040?',
      state: 'decided',
      decision: 'Yes.',
      modifiedAt: '2026-01-01T00:00:00.000Z',
    },
    {
      _id: 'Q3',
      title: 'New',
      question: 'Who wrote the letter?',
      state: 'decided',
      decision: 'Ruth.',
      modifiedAt: AT,
    },
    {
      _id: 'Q4',
      title: 'Trashed',
      question: 'Gone?',
      state: 'open',
      modifiedAt: AT,
      deletedAt: AT,
    },
  ],
  communities: [{ id: 'C-PDX', label: 'Portland' }],
  storyYear: 2045,
  span: { from: 2025, to: 2100 },
  decidedSince: Date.parse('2026-11-01T00:00:00.000Z'),
  ...o,
});

describe('NB-1 the world ID', () => {
  test('NB-1 a bible ID is its world ID, an underscore written as a dash, and two bibles never share one', () => {
    expect(worldIdFor('eastwinds')).toBe('eastwinds');
    expect(worldIdFor('east_winds')).toBe('east-winds');
    expect(worldIdFor('Bad ID')).toBeNull();
    for (const id of ['eastwinds', 'east_winds', 'a-1'])
      expect(WORLD_ID.test(worldIdFor(id)!)).toBe(true);
    expect(worldForBible('eastwinds', ['eastwinds', 'other'])).toBe('eastwinds');
    expect(worldForBible('a_b', ['a_b', 'a-b'])).toBeNull();
    expect(worldForBible('a-b', ['a_b', 'a-b'])).toBeNull();
  });
});

describe('NB-2 the pocket', () => {
  test('NB-2 characters carry full and first name, Chinese name, family colour and the years born and died', () => {
    const p = buildPocket(input());
    expect(p.kind).toBe('novel');
    const byId = new Map(p.characters.map((c) => [c.id, c]));
    expect(byId.get('H1')).toEqual({
      id: 'H1',
      fullName: 'Margaret Hale',
      firstName: 'Margaret',
      familyColour: '#2a78d6',
      born: 1958,
      died: 2041,
    });
    expect(byId.get('H5')).toEqual({
      id: 'H5',
      fullName: 'Iris Hale-Zhou',
      firstName: 'Iris',
      chineseName: '晓曦',
      familyColour: '#2a78d6',
      born: 2031,
    });
    // Family name first: the given name is the second word.
    expect(byId.get('Z3')).toMatchObject({
      fullName: 'Zhou Lan',
      firstName: 'Lan',
      chineseName: '周兰',
      familyColour: '#1baf7a',
    });
    // No birth year and no family: neither is sent.
    expect(byId.get('U1')).toEqual({
      id: 'U1',
      fullName: 'The Archivist',
      firstName: 'The Archivist',
    });
    expect(p.characters.map((c) => c.fullName)).toEqual(
      [...p.characters.map((c) => c.fullName)].sort(),
    );
  });

  test("NB-2 the family colour is the first family's; none when the first family has none", () => {
    const p = buildPocket(
      input({
        families: [...docs('families'), { _id: 'FAM-PLAIN', name: 'Plain', color: null }],
        characters: [
          {
            _id: 'A',
            title: 'Ann Plain',
            names: { full: 'Ann Plain' },
            birth: { year: 2000 },
            familyIds: ['FAM-PLAIN', 'FAM-ZHOU'],
          },
          {
            _id: 'B',
            title: 'Bo Zhou',
            names: { full: 'Bo Zhou' },
            birth: { year: 2000 },
            familyIds: ['FAM-ZHOU', 'FAM-HALE'],
          },
        ],
      }),
    );
    expect(p.characters.find((c) => c.id === 'A')!.familyColour).toBeUndefined();
    expect(p.characters.find((c) => c.id === 'B')!.familyColour).toBe('#1baf7a');
  });

  test('NB-2 places with their community, chapters in reading order with their story year, events with their year, the story year and the span', () => {
    const p = buildPocket(
      input({
        places: [...docs('places'), { _id: 'PLC9', title: 'Pearl District', communityId: 'C-PDX' }],
      }),
    );
    expect(p.places.find((x) => x.id === 'PLC9')).toEqual({
      id: 'PLC9',
      name: 'Pearl District',
      community: 'Portland',
    });
    expect(p.places.find((x) => x.id === 'PLC1')).toEqual({ id: 'PLC1', name: 'Portland' });
    expect(p.chapters.map((c) => c.id)).toEqual([
      'CH1',
      'CH2',
      'CH3',
      'CH4',
      'CH5',
      'CH6',
      'CH7',
      'CH8',
    ]);
    expect(p.chapters[1]).toEqual({ id: 'CH2', title: 'Two Kitchens', year: 2045 });
    expect(p.events[0]).toEqual({
      id: 'E1',
      title: 'Beijing hosts the Summer Olympics',
      year: 2008,
    });
    expect(p.events.map((e) => e.year)).toEqual(
      [...p.events.map((e) => e.year)].sort((a, b) => a - b),
    );
    expect(p.storyYear).toBe(2045);
    expect(p.span).toEqual({ from: 2025, to: 2100 });
  });

  test('NB-2 every open question, and the decided ones changed since the bible was first given to the phone; never a trashed one', () => {
    const p = buildPocket(input());
    expect(p.questions).toEqual([
      { id: 'Q1', question: 'Does Iris stay?', state: 'open', changedAt: Date.parse(AT) },
      {
        id: 'Q3',
        question: 'Who wrote the letter?',
        state: 'decided',
        decision: 'Ruth.',
        changedAt: Date.parse(AT),
      },
    ]);
  });

  test('NB-2 the stamp is the same for the same content in any order and moves when the content does', () => {
    const a = buildPocket(input());
    const b = buildPocket(input({ characters: [...docs('characters')].reverse() }));
    expect(stampOf(a)).toBe(stampOf(b));
    expect(STAMP.test(stampOf(a))).toBe(true);
    const renamed = docs('characters').map((c) =>
      c._id === 'H1' ? { ...c, names: { full: 'Maggie Hale' } } : c,
    );
    expect(stampOf(buildPocket(input({ characters: renamed })))).not.toBe(stampOf(a));
    // A moment is not in the pocket, so nothing about moments can move it.
    expect(pocketText(a)).not.toContain('moments');
    // Trashed entries are left out.
    const trashed = docs('characters').map((c) => (c._id === 'H1' ? { ...c, deletedAt: AT } : c));
    expect(buildPocket(input({ characters: trashed })).characters.some((c) => c.id === 'H1')).toBe(
      false,
    );
  });

  test('NB-2 the first name follows the router: the first word, or the second for a Chinese name written family name first', () => {
    expect(firstNameOf('Dawn Li', '')).toBe('Dawn');
    expect(firstNameOf('Li Siyuan', '李思远')).toBe('Siyuan');
    expect(firstNameOf('Siyuan', '')).toBe('Siyuan');
    expect(firstNameOf('Margaret (Peggy) Hale', '')).toBe('Margaret');
  });
});
