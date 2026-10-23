import { describe, expect, test } from 'vitest';
import { filterQuestions, questionCounts } from '../../src/shared/domain/questions';
import { localDateString } from '../../src/shared/domain/dates';
import { computeWarnings } from '../../src/shared/domain/warnings';
import { manifests } from '../../src/shared/schema';

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

describe('KB-6 the capture date', () => {
  test('KB-6 local dates are zero padded', () => {
    expect(localDateString(new Date(2026, 0, 5))).toBe('2026-01-05');
  });
});
