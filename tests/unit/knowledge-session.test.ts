import { describe, expect, test } from 'vitest';
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
import { entrySchemas, manifests } from '../../src/shared/schema';

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
