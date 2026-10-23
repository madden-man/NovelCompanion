import { describe, expect, test } from 'vitest';
import { GlossaryTerm, Moment, entrySchemas, manifests } from '../../src/shared/schema';
import {
  beatToMoment,
  characterMoments,
  foldedBody,
  nameGlossaryTerms,
  nameLanguage,
  placeToMoment,
  voiceNoteToMoment,
} from '../../src/shared/domain/moments';
import { computeWarnings } from '../../src/shared/domain/warnings';

const at = '2026-10-21T09:00:00.000Z';
const later = '2026-10-21T10:00:00.000Z';

// Shaped on the East Winds audit: a Sullivan sheet beat with a world context and an experience note.
const beat = {
  _id: '01JBEAT0000000000000000001',
  title: 'Mark starts high school',
  body: '',
  createdAt: at,
  modifiedAt: later,
  arcIds: ['ARC1'],
  arcOrders: [{ arcId: 'ARC1', order: 3 }],
  chapterId: 'CH12',
  year: 2051,
  povCharacterId: 'MARK',
  description: '',
  worldContext: 'Robots in every classroom.',
  experienceNote: 'He feels watched.',
};

const mark = {
  _id: 'MARK',
  title: 'Mark Sullivan',
  createdAt: at,
  modifiedAt: later,
  birth: { year: 2037 },
  voiceNotes: [
    { at: { year: 2055 }, text: 'Clipped, ironic.' },
    { at: { age: 14 }, text: 'Mumbles.' },
  ],
  placesLived: [
    { place: 'San Francisco, California', startYear: 2037, endYear: 2055 },
    { place: 'Los Angeles, California (USC)', startYear: 2055, endYear: null },
    { place: 'Somewhere', startYear: null, endYear: 2060 },
  ],
};

describe('SM-3 the moment schema', () => {
  test('SM-3 a moment is an entry: a character, a year, an optional end, how they experience it, world events', () => {
    const m = Moment.parse({
      _id: 'M1',
      title: 'Moves to Portland',
      createdAt: at,
      modifiedAt: at,
      characterId: 'Z3',
      year: 2027,
    });
    expect(m).toMatchObject({ endYear: null, body: '', worldContext: '' });
    expect(entrySchemas.moments).toBe(Moment);
    expect(Moment.safeParse({ ...m, year: undefined }).success).toBe(false);
    expect(Moment.safeParse({ ...m, characterId: '' }).success).toBe(false);
    expect(Moment.safeParse({ ...m, extra: 1 }).success).toBe(false);
  });

  test('SM-3 the field labels are the Backstory columns', () => {
    const label = (name: string) => manifests.moments.find((s) => s.name === name)?.label;
    expect(label('year')).toBe('Year');
    expect(label('endYear')).toBe('To');
    expect(label('title')).toBe('What happens');
    expect(label('body')).toBe('How they experience it');
    expect(label('worldContext')).toBe('Relevant world events');
    expect(label('characterId')).toBe('Character');
  });

  test('SM-3 ED-10 a moment outside the lifetime is a warning on its year, declared in the manifest', () => {
    const ctx = {
      get: (c: string, id: string) =>
        c === 'characters' && id === 'MARK' ? { ...mark, death: { year: 2090 } } : undefined,
      find: () => undefined,
      list: () => undefined,
    };
    const ws = computeWarnings(
      'moments',
      manifests.moments,
      { _id: 'M', characterId: 'MARK', year: 2030, endYear: null },
      ctx,
    );
    expect(ws).toEqual([
      {
        path: 'year',
        code: 'outside-lifetime',
        message: '2030 is before Mark Sullivan is born in 2037.',
      },
    ]);
    const spec = manifests.moments.find((s) => s.name === 'year')!;
    expect(spec.warnings).toContain('outside-lifetime');
  });
});

describe('SM-3 migration 9 as pure functions', () => {
  test('SM-3 a beat becomes a moment of its point of view, keeping its ID, year, text, and common fields', () => {
    const r = beatToMoment(beat);
    expect('moment' in r).toBe(true);
    if (!('moment' in r)) return;
    expect(r.moment).toEqual({
      _id: beat._id,
      title: 'Mark starts high school',
      body: 'He feels watched.',
      createdAt: at,
      modifiedAt: later,
      characterId: 'MARK',
      year: 2051,
      endYear: null,
      worldContext: 'Robots in every classroom.',
    });
    // Arcs, arc positions, and the chapter do not travel.
    expect(r.moment).not.toHaveProperty('arcIds');
    expect(r.moment).not.toHaveProperty('chapterId');
    expect(Moment.safeParse(r.moment).success).toBe(true);
  });

  test('SM-3 a beat description is kept ahead of the experience note; a trashed beat makes a trashed moment', () => {
    const r = beatToMoment({ ...beat, description: 'First day.', deletedAt: later });
    if (!('moment' in r)) throw new Error('skipped');
    expect(r.moment.body).toBe('First day.\n\nHe feels watched.');
    expect(r.moment.deletedAt).toBe(later);
  });

  test('SM-3 a beat with no point of view or no year is skipped, with the reason', () => {
    expect(beatToMoment({ ...beat, povCharacterId: null })).toEqual({
      skip: { source: 'plotBeat', id: beat._id, reason: 'it has no point of view character' },
    });
    expect(beatToMoment({ ...beat, year: null })).toEqual({
      skip: { source: 'plotBeat', id: beat._id, reason: 'it has no year' },
    });
  });

  test('SM-3 a voice note is a moment titled Voice at its year, or at the birth year plus its age', () => {
    const byYear = voiceNoteToMoment(mark, mark.voiceNotes[0], 0);
    const byAge = voiceNoteToMoment(mark, mark.voiceNotes[1], 1);
    if (!('moment' in byYear) || !('moment' in byAge)) throw new Error('skipped');
    expect(byYear.moment).toMatchObject({
      _id: 'MARK-voice-0',
      title: 'Voice',
      body: 'Clipped, ironic.',
      characterId: 'MARK',
      year: 2055,
      createdAt: at,
      modifiedAt: later,
    });
    expect(byAge.moment).toMatchObject({ _id: 'MARK-voice-1', year: 2051, body: 'Mumbles.' });
    expect(Moment.safeParse(byAge.moment).success).toBe(true);
  });

  test('SM-3 a voice note set at an age, for a character whose birth is unknown, is skipped', () => {
    const unknown = { ...mark, birth: { unknown: true } };
    expect(voiceNoteToMoment(unknown, mark.voiceNotes[1], 1)).toEqual({
      skip: {
        source: 'voiceNote',
        id: 'MARK-voice-1',
        reason: 'it is set at age 14 and the birth year is unknown',
      },
    });
    // A note with a year still places itself without a birth year.
    expect('moment' in voiceNoteToMoment(unknown, mark.voiceNotes[0], 0)).toBe(true);
  });

  test('SM-3 a place lived is a moment "Lives in" the place for its years; an open end stays open; no start year is skipped', () => {
    const sf = placeToMoment(mark, mark.placesLived[0], 0);
    const la = placeToMoment(mark, mark.placesLived[1], 1);
    if (!('moment' in sf) || !('moment' in la)) throw new Error('skipped');
    expect(sf.moment).toMatchObject({
      _id: 'MARK-lives-0',
      title: 'Lives in San Francisco, California',
      year: 2037,
      endYear: 2055,
    });
    expect(la.moment).toMatchObject({
      title: 'Lives in Los Angeles, California (USC)',
      year: 2055,
      endYear: null,
    });
    expect(placeToMoment(mark, mark.placesLived[2], 2)).toEqual({
      skip: { source: 'placeLived', id: 'MARK-lives-2', reason: 'Somewhere has no start year' },
    });
  });

  test('SM-3 the first place lived with no start year is the birthplace: it starts at the birth year', () => {
    const first = { place: 'Oakland, California', startYear: null, endYear: 2037 };
    const r = placeToMoment(mark, first, 0);
    expect(r).toMatchObject({
      moment: {
        _id: 'MARK-lives-0',
        title: 'Lives in Oakland, California',
        year: 2037,
        endYear: 2037,
      },
    });
    if ('moment' in r) expect(Moment.safeParse(r.moment).success).toBe(true);
    // With the birth unknown it has no year, so it is skipped.
    expect(placeToMoment({ ...mark, birth: { unknown: true } }, first, 0)).toEqual({
      skip: {
        source: 'placeLived',
        id: 'MARK-lives-0',
        reason: 'Oakland, California has no start year',
      },
    });
    // Only the first place is the birthplace; a later one with no start year is skipped.
    expect(placeToMoment(mark, first, 1)).toEqual({
      skip: {
        source: 'placeLived',
        id: 'MARK-lives-1',
        reason: 'Oakland, California has no start year',
      },
    });
  });

  test('SM-3 a character makes every moment of its lists in order, and a trashed character makes trashed moments', () => {
    const r = characterMoments({ ...mark, deletedAt: later });
    expect(r.moments.map((m) => [m._id, m.year, m.deletedAt])).toEqual([
      ['MARK-voice-0', 2055, later],
      ['MARK-voice-1', 2051, later],
      ['MARK-lives-0', 2037, later],
      ['MARK-lives-1', 2055, later],
    ]);
    expect(r.skipped.map((s) => s.id)).toEqual(['MARK-lives-2']);
    expect(characterMoments({ _id: 'X', birth: { year: 2000 } })).toEqual({
      moments: [],
      skipped: [],
    });
  });

  test('SM-4 generation notes and era prose are folded into the body under their labels', () => {
    expect(foldedBody('Lanterns.', [['Generation notes', 'Kids prefer LEDs.']])).toBe(
      'Lanterns.\n\nGeneration notes: Kids prefer LEDs.',
    );
    expect(
      foldedBody('', [
        ['Technology', 'Robots.'],
        ['Climate', ''],
        ['Daily life', 'Long commutes.'],
      ]),
    ).toBe('Technology: Robots.\n\nDaily life: Long commutes.');
    expect(foldedBody('Kept.', [['Climate', '  ']])).toBeNull();
  });
});

describe('SM-1 migration 9: a name romanization moves to the glossary term for the name', () => {
  const lan = {
    _id: 'Z3',
    title: 'Zhou Lan',
    createdAt: at,
    modifiedAt: later,
    names: { full: 'Zhou Lan', chinese: '周岚', romanization: 'Zhōu Lán' },
  };

  test('SM-1 a name with no glossary term makes one: characters, romanization, language, meaning, usage note, status and provenance', () => {
    const r = nameGlossaryTerms([lan], [], 'mandarin');
    expect(r.filled).toEqual([]);
    expect(r.made).toEqual([
      {
        _id: 'Z3-name',
        title: '周岚',
        body: '',
        createdAt: at,
        modifiedAt: later,
        characters: '周岚',
        romanization: 'Zhōu Lán',
        language: 'mandarin',
        meaning: 'Zhou Lan',
        usageNote: 'The name of Zhou Lan',
      },
    ]);
    expect(GlossaryTerm.safeParse(r.made[0]).success).toBe(true);
  });

  test('SM-1 a term with the same characters is filled when its romanization is empty and left when it has one', () => {
    const empty = { _id: 'GL9', characters: '周岚', romanization: '' };
    expect(nameGlossaryTerms([lan], [empty], 'mandarin')).toEqual({
      made: [],
      filled: [{ _id: 'GL9', romanization: 'Zhōu Lán' }],
    });
    const kept = { _id: 'GL9', characters: '周岚', romanization: 'Zhou Lan' };
    expect(nameGlossaryTerms([lan], [kept], 'mandarin')).toEqual({ made: [], filled: [] });
    // A term in the trash does not count: a new one is made.
    const trashed = { ...kept, deletedAt: later };
    expect(nameGlossaryTerms([lan], [trashed], 'mandarin').made.map((t) => t._id)).toEqual([
      'Z3-name',
    ]);
  });

  test('SM-1 no Chinese name or no romanization makes nothing; two characters with one name make one term', () => {
    const noChinese = { ...lan, _id: 'A', names: { full: 'A', romanization: 'a' } };
    const noRoman = { ...lan, _id: 'B', names: { full: 'B', chinese: '乙', romanization: ' ' } };
    expect(nameGlossaryTerms([noChinese, noRoman], [], 'mandarin')).toEqual({
      made: [],
      filled: [],
    });
    const twin = { ...lan, _id: 'Z9', names: { ...lan.names, full: 'Another Zhou Lan' } };
    expect(nameGlossaryTerms([lan, twin], [], 'mandarin').made.map((t) => t._id)).toEqual([
      'Z3-name',
    ]);
  });

  test('SM-1 the language is Mandarin unless the bible languages list names it otherwise', () => {
    expect(nameLanguage(null)).toBe('mandarin');
    expect(nameLanguage({ items: [{ id: 'mandarin', label: 'Mandarin' }] })).toBe('mandarin');
    expect(
      nameLanguage({
        items: [
          { id: 'cantonese', label: 'Cantonese' },
          { id: 'zh', label: 'Mandarin Chinese' },
        ],
      }),
    ).toBe('zh');
    expect(nameLanguage({ items: [{ id: 'putonghua', label: 'Putonghua' }] })).toBe('putonghua');
  });
});
