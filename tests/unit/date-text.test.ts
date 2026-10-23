import { describe, expect, test } from 'vitest';
import { dateText, parseDateText } from '../../src/shared/domain/dates';
import { ageAt, lifeState } from '../../src/shared/domain/ages';
import { computeWarnings } from '../../src/shared/domain/warnings';
import { StoryDate, manifests } from '../../src/shared/schema';

describe('SM-1 Birth and Death as one text box', () => {
  test('SM-1 a year, a year and month, and a full date are read and written back the same way', () => {
    for (const [text, value] of [
      ['1990', { year: 1990 }],
      ['1990-03', { year: 1990, month: 3 }],
      ['1990-03-14', { year: 1990, month: 3, day: 14 }],
      [' 2034-5-1 ', { year: 2034, month: 5, day: 1 }],
    ] as const) {
      const r = parseDateText(text, 'birth');
      expect(r, text).toEqual({ ok: true, value });
      if (r.ok) expect(StoryDate.safeParse(r.value).success).toBe(true);
    }
    expect(dateText({ year: 1990 })).toBe('1990');
    expect(dateText({ year: 1990, month: 3 })).toBe('1990-03');
    expect(dateText({ year: 2034, month: 5, day: 1 })).toBe('2034-05-01');
  });

  test('SM-1 blank Birth is unknown and blank Death is not recorded as dead; both show blank', () => {
    expect(parseDateText('', 'birth')).toEqual({ ok: true, value: { unknown: true } });
    expect(parseDateText('   ', 'death')).toEqual({ ok: true, value: null });
    expect(dateText({ unknown: true })).toBe('');
    expect(dateText(null)).toBe('');
    expect(dateText(undefined)).toBe('');
  });

  test('SM-1 a value it cannot read is refused with a plain message, and nothing is given to write', () => {
    for (const bad of [
      'March 1990',
      '1990/03/14',
      '1990-13',
      '1990-03-32',
      '1990-00-10',
      '99999',
    ]) {
      const r = parseDateText(bad, 'death');
      expect(r.ok, bad).toBe(false);
      expect(r).not.toHaveProperty('value');
      if (!r.ok) expect(r.message, bad).toMatch(/\.$/);
    }
    expect(parseDateText('March 1990', 'birth')).toEqual({
      ok: false,
      message:
        'March 1990 is not a date. Write a year (1990), a year and month (1990-03), or a full date (1990-03-14).',
    });
    expect(parseDateText('1990-13', 'birth')).toEqual({
      ok: false,
      message: '13 is not a month. Months run from 01 to 12.',
    });
  });

  test('SM-1 ED-10 30 February is read, so the impossible-date warning shows on the field', () => {
    const r = parseDateText('2031-02-30', 'birth');
    expect(r).toEqual({ ok: true, value: { year: 2031, month: 2, day: 30 } });
    const ws = computeWarnings(
      'characters',
      manifests.characters,
      {
        _id: 'X',
        birth: { year: 2031, month: 2, day: 30 },
        death: null,
      },
      { get: () => undefined, find: () => undefined, list: () => undefined },
    );
    expect(ws.map((w) => [w.path, w.code])).toContainEqual(['birth', 'impossible-date']);
  });

  test('TL-3 SM-1 a full date typed in the box still gives exact ages: one less until the birthday', () => {
    const born = parseDateText('2031-03-14', 'birth');
    if (!born.ok) throw new Error(born.message);
    const iris = { birth: born.value, death: null };
    expect(ageAt(iris, { year: 2045, month: 3, day: 13 })).toBe(13);
    expect(ageAt(iris, { year: 2045, month: 3, day: 14 })).toBe(14);
    // A year alone gives the age reached that year.
    const year = parseDateText('2031', 'birth');
    if (!year.ok) throw new Error(year.message);
    expect(ageAt({ birth: year.value, death: null }, 2045)).toBe(14);
    expect(lifeState(iris, { year: 2031, month: 3, day: 1 })).toMatchObject({ state: 'unborn' });
  });
});
