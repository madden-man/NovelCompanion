import { describe, expect, test } from 'vitest';
import { factPage, isKnownBy, knownBy, whoKnows } from '../../src/shared/domain/knowledge';
import { filterQuestions, questionCounts } from '../../src/shared/domain/questions';
import {
  STOP_PROMPT_TIMEOUT_MS,
  latestLog,
  localDateString,
  logsNewestFirst,
  stopLogData,
  stopPromptLabel,
  stopPromptOutcome,
} from '../../src/shared/domain/sessionLog';
import { computeWarnings } from '../../src/shared/domain/warnings';
import { characterPage } from '../../src/shared/domain/character';
import { fromCollections } from '../../src/shared/domain/timeline';
import { CustomSection, entrySchemas, manifests } from '../../src/shared/schema';
import { readFixture } from '../helpers/loadFixture';

const fx = readFixture();
const data = fromCollections(fx);

describe('KN-1 who knows a fact and what a character knows', () => {
  test('KN-1 whoKnows lists everyone who learns a fact, earliest first, from the fixture', () => {
    expect(whoKnows(data, 'F1').map((k) => [k.characterId, k.yearLearned])).toEqual([['Z3', 2028]]);
    expect(whoKnows(data, 'F2').map((k) => [k.characterId, k.name, k.yearLearned])).toEqual([
      ['H4', 'Ruth Hale', 2041],
      ['H5', 'Iris Hale-Zhou', 2060],
    ]);
    expect(whoKnows(data, 'F2')[1]).toMatchObject({
      chapterLearnedId: 'CH7',
      how: "She finds it in Margaret's boxes.",
    });
    expect(whoKnows(data, 'nobody')).toEqual([]);
  });

  test('KN-1 whoKnows with a year keeps only those who have learned it by then', () => {
    expect(whoKnows(data, 'F2', 2040)).toEqual([]);
    expect(whoKnows(data, 'F2', 2041).map((k) => k.characterId)).toEqual(['H4']);
    expect(whoKnows(data, 'F2', 2060).map((k) => k.characterId)).toEqual(['H4', 'H5']);
  });

  test("KN-1 knownBy gives H5 nothing in 2059 and Peter's letter in 2060", () => {
    expect(knownBy(data, 'H5', 2059).known).toEqual([]);
    expect(knownBy(data, 'H5', 2060).known.map((f) => [f.factId, f.fact, f.yearLearned])).toEqual([
      ['F2', "Peter's letter", 2060],
    ]);
    expect(knownBy(data, 'H5', 2099).known).toHaveLength(1);
    expect(knownBy(data, 'Z3', 2027).known).toEqual([]);
    expect(knownBy(data, 'Z3', 2028).known.map((f) => f.factId)).toEqual(['F1']);
  });

  test('KN-1 knownBy lists what H5 does not know: not yet in 2059 for the letter, which H5 learns in 2060, never for the engagement', () => {
    const in2059 = knownBy(data, 'H5', 2059);
    expect(in2059.unknown.map((f) => [f.factId, f.fact, f.reason, f.label])).toEqual([
      ['F2', "Peter's letter", 'not-yet', 'not yet in 2059'],
      ['F1', 'Meiling was engaged before Wei', 'never', 'never'],
    ]);
    expect(in2059.unknown[0]?.yearLearned).toBe(2060);
    expect(in2059.unknown[1]?.yearLearned).toBeNull();
    const in2060 = knownBy(data, 'H5', 2060);
    expect(in2060.known.map((f) => f.factId)).toEqual(['F2']);
    expect(in2060.unknown.map((f) => [f.factId, f.label])).toEqual([['F1', 'never']]);
  });

  test('KN-1 every live fact is either known or unknown, never both, and a trashed fact is in neither', () => {
    for (const [who, year] of [
      ['H5', 2059],
      ['H5', 2060],
      ['Z3', 2028],
      ['Z3', 2027],
      ['U1', 2100],
    ] as const) {
      const k = knownBy(data, who, year);
      const ids = [...k.known.map((f) => f.factId), ...k.unknown.map((f) => f.factId)].sort();
      expect(ids, `${who} ${year}`).toEqual(['F1', 'F2']);
    }
    const trimmed = fromCollections({
      ...fx,
      facts: fx.facts!.map((f) =>
        f._id === 'F1' ? { ...f, deletedAt: '2026-02-01T00:00:00.000Z' } : f,
      ),
    });
    expect(knownBy(trimmed, 'H5', 2059).unknown.map((f) => f.factId)).toEqual(['F2']);
  });

  test('KN-1 the earliest later year is the one a character learns it in', () => {
    const twice = fromCollections({
      ...fx,
      knowledgeRecords: [
        ...fx.knowledgeRecords!,
        { _id: 'K8', factId: 'F1', characterId: 'H5', yearLearned: 2080, how: '' },
        { _id: 'K9', factId: 'F1', characterId: 'H5', yearLearned: 2070, how: '' },
      ],
    });
    const f1 = knownBy(twice, 'H5', 2059).unknown.find((f) => f.factId === 'F1');
    expect(f1).toMatchObject({ reason: 'not-yet', yearLearned: 2070, label: 'not yet in 2059' });
    expect(knownBy(twice, 'H5', 2075).known.map((f) => f.factId)).toContain('F1');
  });

  test('KN-1 whoKnows lists a character once per fact and keeps the earliest record', () => {
    const twice = fromCollections({
      ...fx,
      knowledgeRecords: [
        ...fx.knowledgeRecords!,
        { _id: 'K8', factId: 'F1', characterId: 'Z3', yearLearned: 2040, how: 'Told again' },
        { _id: 'K9', factId: 'F1', characterId: 'Z3', yearLearned: null, how: '' },
      ],
    });
    const knowers = whoKnows(twice, 'F1');
    expect(knowers.map((k) => [k.characterId, k.yearLearned])).toEqual([['Z3', 2028]]);
    expect(whoKnows(twice, 'F1', 2030)).toHaveLength(1);
  });

  test('KN-1 a record with no year is listed on the fact but never counts as known by a year', () => {
    const withBlank = fromCollections({
      ...fx,
      knowledgeRecords: [
        ...fx.knowledgeRecords!,
        { _id: 'K9', factId: 'F1', characterId: 'H3', yearLearned: null, how: '' },
      ],
    });
    expect(whoKnows(withBlank, 'F1').map((k) => k.characterId)).toEqual(['Z3', 'H3']);
    expect(whoKnows(withBlank, 'F1', 2100).map((k) => k.characterId)).toEqual(['Z3']);
    expect(knownBy(withBlank, 'H3', 2100).known).toEqual([]);
    expect(knownBy(withBlank, 'H3', 2100).unknown.find((f) => f.factId === 'F1')?.label).toBe(
      'never',
    );
    expect(isKnownBy(null, 2050)).toBeNull();
    expect(isKnownBy(2040, null)).toBeNull();
    expect(isKnownBy(2040, 2040)).toBe(true);
    expect(isKnownBy(2041, 2040)).toBe(false);
  });

  test('KN-1 records in the trash and records of trashed characters are left out', () => {
    const trimmed = fromCollections({
      ...fx,
      knowledgeRecords: fx.knowledgeRecords!.map((k) =>
        k._id === 'K3' ? { ...k, deletedAt: '2026-02-01T00:00:00.000Z' } : k,
      ),
      characters: fx.characters!.map((c) =>
        c._id === 'H5' ? { ...c, deletedAt: '2026-02-01T00:00:00.000Z' } : c,
      ),
    });
    expect(whoKnows(trimmed, 'F2')).toEqual([]);
  });

  test('KN-1 the character page "what they know" agrees with knownBy', () => {
    const page = characterPage(
      data,
      'H5',
      { chapterId: 'CH7', year: 2060, source: 'lastWritten' },
      null,
    )!;
    expect(page.knowledge.map((k) => [k.factId, k.knownAtPosition])).toEqual([['F2', true]]);
    const early = characterPage(
      data,
      'H5',
      { chapterId: 'CH6', year: 2045, source: 'lastWritten' },
      null,
    )!;
    expect(early.knowledge.map((k) => k.knownAtPosition)).toEqual([false]);
  });

  test('KN-1 the character page lists what H5 does not know in 2059 and in 2060, from knownBy', () => {
    const at = (year: number) =>
      characterPage(data, 'H5', { chapterId: 'CH7', year, source: 'lastWritten' }, null)!;
    expect(at(2059).doesNotKnow.map((f) => [f.factId, f.label])).toEqual([
      ['F2', 'not yet in 2059'],
      ['F1', 'never'],
    ]);
    expect(
      at(2059)
        .knowledge.filter((k) => k.knownAtPosition)
        .map((k) => k.factId),
    ).toEqual([]);
    expect(at(2060).doesNotKnow.map((f) => [f.factId, f.label])).toEqual([['F1', 'never']]);
    expect(
      at(2060)
        .knowledge.filter((k) => k.knownAtPosition)
        .map((k) => k.factId),
    ).toEqual(['F2']);
    expect(at(2060).doesNotKnow).toEqual(knownBy(data, 'H5', 2060).unknown);
  });

  test('KN-1 the fact page lists who learns it, when, and in which chapter', () => {
    const page = factPage(data, 'F2')!;
    expect(page.title).toBe("Peter's letter");
    expect(page.knowers.map((k) => [k.name, k.yearLearned, k.chapter])).toEqual([
      ['Ruth Hale', 2041, null],
      ['Iris Hale-Zhou', 2060, 'Rain in Guangzhou'],
    ]);
    expect(factPage(data, 'missing')).toBeNull();
  });
});

describe('KN-2 learning a fact before birth is a warning', () => {
  const ctx = {
    get: (c: string, id: string) => fx[c]?.find((d) => d._id === id),
    find: () => undefined,
    list: () => undefined,
  };
  const warn = (record: Record<string, unknown>) =>
    computeWarnings('knowledgeRecords', manifests.knowledgeRecords, record, ctx).filter(
      (w) => w.path === 'yearLearned',
    );

  test('KN-2 H5 learning in 2020, before her 2031 birth, gets learned-before-birth', () => {
    const w = warn({ factId: 'F2', characterId: 'H5', yearLearned: 2020 });
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ code: 'learned-before-birth' });
    expect(w[0]!.message).toContain('2031');
  });

  test('KN-2 the fixture records, a record with no year, and the birth year itself raise nothing', () => {
    for (const k of fx.knowledgeRecords!) expect(warn(k)).toEqual([]);
    expect(warn({ factId: 'F2', characterId: 'H5', yearLearned: null })).toEqual([]);
    expect(warn({ factId: 'F2', characterId: 'H5', yearLearned: 2031 })).toEqual([]);
  });

  test('KN-2 the schema accepts the record, so the write is never blocked', () => {
    const now = '2026-01-15T09:00:00.000Z';
    const r = entrySchemas.knowledgeRecords.safeParse({
      _id: 'K-early',
      title: 'Too early',
      status: 'idea',
      createdAt: now,
      modifiedAt: now,
      factId: 'F2',
      characterId: 'H5',
      yearLearned: 2020,
    });
    expect(r.success).toBe(true);
  });
});

describe('KN-3 facts in play on a chapter', () => {
  test('KN-3 the fact page lists the chapters that act on it, in reading order, with the character', () => {
    const page = factPage(data, 'F1')!;
    expect(page.inPlay.map((p) => [p.chapterId, p.character])).toEqual([
      ['CH3', 'Zhou Lan'],
      ['CH7', 'Zhou Lan'],
    ]);
    expect(page.inPlay[0]!.note).toContain('letters');
    expect(factPage(data, 'F2')!.inPlay.map((p) => p.chapterId)).toEqual(['CH6']);
  });

  test('KN-3 a chapter stores its facts in play in the schema, one fact and one character each', () => {
    const chapter = fx.chapters!.find((c) => c._id === 'CH3')!;
    expect(entrySchemas.chapters.parse(chapter).factsInPlay).toEqual([
      { factId: 'F1', characterId: 'Z3', note: "Lan hides her mother's old letters from Daniel." },
    ]);
    expect(
      entrySchemas.chapters.safeParse({ ...chapter, factsInPlay: [{ factId: 'F1' }] }).success,
    ).toBe(false);
  });
});

describe('OQ-1 open questions', () => {
  const qs = [
    { _id: 'a', state: 'open' },
    { _id: 'b', state: 'decided' },
    { _id: 'c', state: 'open' },
  ];
  test('OQ-1 filtering by state keeps open or decided questions, and all shows everything', () => {
    expect(filterQuestions(qs, 'open').map((q) => q._id)).toEqual(['a', 'c']);
    expect(filterQuestions(qs, 'decided').map((q) => q._id)).toEqual(['b']);
    expect(filterQuestions(qs, 'all')).toHaveLength(3);
    expect(questionCounts(qs)).toEqual({ open: 2, decided: 1 });
  });

  test('OQ-1 a decided question without a decision text is flagged, and one with it is not', () => {
    const base = { _id: 'q', question: 'Who sent the letter?', state: 'decided' };
    const ctx = { get: () => undefined, find: () => undefined, list: () => undefined };
    const codes = (d: Record<string, unknown>) =>
      computeWarnings('openQuestions', manifests.openQuestions, d, ctx).map((w) => w.code);
    expect(codes({ ...base, decision: '' })).toContain('decided-without-decision');
    expect(codes({ ...base, decision: 'Peter did.' })).not.toContain('decided-without-decision');
    expect(codes({ ...base, state: 'open', decision: '' })).not.toContain(
      'decided-without-decision',
    );
  });
});

describe('SL-1 the session log', () => {
  const log = (id: string, date: string, stoppedAt: string, extra = {}) => ({
    _id: id,
    date,
    stoppedAt,
    notes: '',
    createdAt: `${date}T10:00:00.000Z`,
    ...extra,
  });

  test('SL-1 an answer becomes a session log entry the schema accepts, and an empty answer makes none', () => {
    const data = stopLogData(
      { stoppedAt: '  Iris at the box.  ', chapterId: 'CH6' },
      new Date(2026, 9, 10, 18, 30),
    );
    expect(data).toEqual({
      title: 'Session 2026-10-10',
      status: 'canon',
      date: '2026-10-10',
      chapterId: 'CH6',
      stoppedAt: 'Iris at the box.',
      notes: '',
    });
    const now = '2026-10-10T18:30:00.000Z';
    expect(
      entrySchemas.sessionLogs.safeParse({ ...data, _id: 'L1', createdAt: now, modifiedAt: now })
        .success,
    ).toBe(true);
    expect(stopLogData({ stoppedAt: '   ' }, new Date())).toBeNull();
    expect(stopLogData({ stoppedAt: 'x', chapterId: '' }, new Date())!.chapterId).toBeNull();
  });

  test('SL-1 the stop prompt button says close when only the window closes and quit when the app quits', () => {
    expect(stopPromptLabel(true, false)).toBe('Save note and close');
    expect(stopPromptLabel(true, true)).toBe('Save note and quit');
    expect(stopPromptLabel(false, false)).toBe('Close without a note');
    expect(stopPromptLabel(false, true)).toBe('Quit without a note');
  });

  test('SL-1 a page that never shows the prompt is closed after 10 seconds, with no log', () => {
    expect(STOP_PROMPT_TIMEOUT_MS).toBe(10_000);
    const asked = { shown: false, decision: null };
    expect(stopPromptOutcome({ ...asked, elapsedMs: 0 })).toBe('wait');
    expect(stopPromptOutcome({ ...asked, elapsedMs: 9_999 })).toBe('wait');
    expect(stopPromptOutcome({ ...asked, elapsedMs: 10_000 })).toBe('close');
    expect(stopPromptOutcome({ ...asked, elapsedMs: 3_000 }, 2_500)).toBe('close');
  });

  test('SL-1 once the prompt is showing, main waits for the person however long they take', () => {
    expect(stopPromptOutcome({ shown: true, decision: null, elapsedMs: 600_000 })).toBe('wait');
  });

  test('SL-1 an answer decides at once: close, or keep working', () => {
    expect(stopPromptOutcome({ shown: true, decision: true, elapsedMs: 50 })).toBe('close');
    expect(stopPromptOutcome({ shown: true, decision: false, elapsedMs: 50 })).toBe('stay');
    expect(stopPromptOutcome({ shown: false, decision: false, elapsedMs: 99_999 })).toBe('stay');
  });

  test('SL-1 local dates are zero padded', () => {
    expect(localDateString(new Date(2026, 0, 5))).toBe('2026-01-05');
  });

  test('SL-1 the launch note is the newest log with a note, ignoring the trash and empty logs', () => {
    const logs = [
      log('old', '2026-10-01', 'Chapter 2 start'),
      log('new', '2026-10-09', 'Halfway through Wedding Weather'),
      log('trashed', '2026-10-10', 'Deleted note', { deletedAt: '2026-10-10T12:00:00.000Z' }),
      log('empty', '2026-10-10', ''),
    ];
    expect(latestLog(logs)!._id).toBe('new');
    expect(latestLog([])).toBeNull();
    const sameDay = [
      log('first', '2026-10-09', 'Morning', { createdAt: '2026-10-09T08:00:00.000Z' }),
      log('second', '2026-10-09', 'Evening', { createdAt: '2026-10-09T20:00:00.000Z' }),
    ];
    expect(latestLog(sameDay)!._id).toBe('second');
    expect(logsNewestFirst(logs).map((l) => l._id)).toEqual(['trashed', 'empty', 'new', 'old']);
  });
});

describe('CS-3 the per-section brief rule', () => {
  const base = {
    _id: 'S1',
    name: 'Recipes',
    fields: [],
    createdAt: '2026-01-15T09:00:00.000Z',
    modifiedAt: '2026-01-15T09:00:00.000Z',
  };
  test('CS-3 a section stores linked, storyYear, or always, and defaults to linked', () => {
    expect(CustomSection.parse(base).briefRule).toBe('linked');
    for (const rule of ['linked', 'storyYear', 'always'] as const) {
      expect(CustomSection.parse({ ...base, briefRule: rule }).briefRule).toBe(rule);
    }
    expect(CustomSection.safeParse({ ...base, briefRule: 'sometimes' }).success).toBe(false);
  });

  test('CS-3 the fixture section keeps its rule', () => {
    expect(CustomSection.parse(fx.customSections![0]).briefRule).toBe('linked');
  });
});
