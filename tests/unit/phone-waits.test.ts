import { describe, expect, test } from 'vitest';
import { buildIndex } from '../../src/shared/domain/captureRouter';
import type { RouterIndexInput } from '../../src/shared/domain/captureRouter';
import {
  NO_MARKS,
  factKey,
  trayGroups,
  waitingPages,
  withMarks,
} from '../../src/shared/domain/tray';
import { readWaits, waitingHandled, withWaits } from '../../src/shared/phoneWaits';
import type { WaitingLine } from '../../src/shared/phoneWaits';
import { readFixture } from '../helpers/loadFixture';

/**
 * A58 U5 (PH-28): the tray offers the sentences the phone keeps for the
 * desk as cards like the others, grouped by the day they were kept, each
 * routed in the story year it was caught in. A mark on one of its facts is
 * what tells the phone the desk handled it.
 */
const fixture = readFixture();
const input: RouterIndexInput = {
  lists: (fixture.lists ?? []) as never,
  entries: Object.fromEntries(
    ['characters', 'places', 'culturalEntries', 'moments', 'glossaryTerms'].map((c) => [
      c,
      (fixture[c] ?? []).filter((d) => !d.deletedAt),
    ]),
  ),
  timelineEnd: 2100,
};
const index = buildIndex(input);

const YEE_HAW = 'Teenagers in Portland begin to say yee haw ironically starting around 2065.';
const KESSLER = 'The Kessler crowd stops tipping by 2070.';
const TRAM = 'The tram to the coast was free on Sundays.';

const line = (id: string, text: string, at: string, year = 2034): WaitingLine => ({
  id,
  text,
  year,
  at,
});
const W1 = line('w1', KESSLER, '2026-11-26T09:00:00.000Z');
const W2 = line('w2', YEE_HAW, '2026-11-26T10:00:00.000Z');
const W3 = line('w3', TRAM, '2026-11-25T08:00:00.000Z', 2040);

describe('PH-28 the tray offers the sentences waiting from the phone', () => {
  test('PH-28 each waiting sentence is a one-line page from the phone in its own story year', () => {
    expect(waitingPages([W1, line('blank', '   ', W1.at)])).toEqual([
      {
        id: 'phone:w1',
        kind: 'phone',
        title: '',
        date: W1.at,
        year: 2034,
        lines: [{ id: 'w1', text: KESSLER, speakerId: null }],
      },
    ]);
  });

  test('PH-28 they group by the day they were kept, newest first, as cards routed like any line', () => {
    const groups = trayGroups(waitingPages([W1, W2, W3]), index, {
      storyYear: 2050,
      timeZone: 'UTC',
    });
    expect(groups.map((g) => [g.id, g.kind])).toEqual([
      ['phone:2026-11-26', 'phone'],
      ['phone:2026-11-25', 'phone'],
    ]);
    const day = groups[0]!;
    expect(day.items.map((i) => i.lineText).sort()).toEqual([KESSLER, YEE_HAW].sort());
    const yee = day.items.find((i) => i.lineText === YEE_HAW)!;
    // Route A on the desk, so File it files it; the line's own year, not the stand-in.
    expect(yee.fact.route).toBe('local');
    expect(yee.year).toBe(2034);
    expect(yee.needsYear).toBe(false);
    expect(yee.key).toBe(factKey('w2', YEE_HAW, 0));
    const kessler = day.items.find((i) => i.lineText === KESSLER)!;
    expect(kessler.fact.route).not.toBe('local');
    // The tram line was caught in 2040: it is read in that year.
    const tram = groups[1]!.items[0]!;
    expect(tram.year).toBe(2040);
    expect(tram.fact.years.start).toBe(2040);
  });

  test('PH-28 a fact filed, dismissed or sent leaves the tray, and the phone reads its line as handled', () => {
    const pages = waitingPages([W1, W2]);
    const key = factKey('w2', YEE_HAW, 0);
    for (const mark of ['filed', 'dismissed', 'sent'] as const) {
      const marks = withMarks(NO_MARKS, [key], mark);
      const items = trayGroups(pages, index, { storyYear: 2050, marks }).flatMap((g) => g.items);
      expect(items.map((i) => i.lineText)).toEqual([KESSLER]);
      expect(waitingHandled(W2, marks)).toBe(true);
      expect(waitingHandled(W1, marks)).toBe(false);
    }
    expect(waitingHandled(W2, withMarks(withMarks(NO_MARKS, [key], 'filed'), [key], null))).toBe(
      false,
    );
  });

  test('PH-28 kept lines from the notebook and sentences from the phone never share a group', () => {
    const groups = trayGroups(
      [
        ...waitingPages([W1]),
        {
          id: 'K1',
          kind: 'kept',
          title: '',
          date: W1.at,
          year: 2034,
          lines: [{ id: 'K1', text: YEE_HAW, speakerId: null }],
        },
      ],
      index,
      { storyYear: 2050, timeZone: 'UTC' },
    );
    expect(groups.map((g) => g.id).sort()).toEqual(['day:2026-11-26', 'phone:2026-11-26']);
  });
});

describe('PH-28 the stored waiting lines', () => {
  test('PH-28 an added ID replaces its line in place, a new one goes last, a dropped one goes', () => {
    expect(withWaits([W1, W2], [{ ...W1, text: 'Edited.' }, W3], ['w2'])).toEqual([
      { ...W1, text: 'Edited.' },
      W3,
    ]);
    expect(withWaits([W1], [W1])).toEqual([W1]);
    expect(withWaits([W1], [W2], ['w2'])).toEqual([W1]);
  });

  test('PH-28 an unreadable stored line is left out, never thrown on', () => {
    expect(readWaits(null)).toEqual([]);
    expect(readWaits({ lines: 'no' })).toEqual([]);
    expect(readWaits({ lines: [W1, { id: 'x' }, { ...W2, extra: 1 }] })).toEqual([W1]);
  });
});
