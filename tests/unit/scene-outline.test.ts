import { describe, expect, test } from 'vitest';
import {
  EMPTY_OUTLINE,
  VERSION_GAP_MS,
  composeFlow,
  continueBullet,
  giveFirstScene,
  indentLines,
  refitFlow,
  sameBreaks,
  sameRanges,
  sceneBreaks,
  sceneCount,
  sceneLines,
  sceneOutlineText,
  sceneRanges,
  sceneStarts,
  splitFlow,
  startsNewVersion,
  takeSceneAbove,
} from '../../src/shared/domain/sceneOutline';
import {
  eraAt,
  eventLanes,
  eventsBetween,
  eventsIn,
  yearGap,
} from '../../src/shared/domain/outlineWorld';

const at = (text: string, pos: number, end = pos) => ({
  text,
  selectionStart: pos,
  selectionEnd: end,
});

describe('PL-5 the scene outline text behaves as a bulleted list', () => {
  test('PL-5 Enter at the end of a bullet starts the next bullet with the same indent', () => {
    const t = '- Dawn lands in Jinan\n  - She finds the shrine';
    const r = continueBullet(at(t, t.length));
    expect(r).toEqual({
      text: `${t}\n  - `,
      selectionStart: t.length + 5,
      selectionEnd: t.length + 5,
    });
  });

  test('PL-5 Enter in the middle of a bullet splits it into two bullets', () => {
    const t = '- Dawn lands Mark waits';
    const r = continueBullet(at(t, 12));
    expect(r?.text).toBe('- Dawn lands\n-  Mark waits');
    expect(r?.selectionStart).toBe(15);
  });

  test('PL-5 Enter on an empty bullet ends the list', () => {
    const t = '- A scene\n- ';
    const r = continueBullet(at(t, t.length));
    expect(r).toEqual({ text: '- A scene\n', selectionStart: 10, selectionEnd: 10 });
  });

  test('PL-5 Enter on a plain line is left to the textarea', () => {
    expect(continueBullet(at('Part one', 8))).toBeNull();
  });

  test('PL-5 Tab indents the selected lines and Shift+Tab outdents them', () => {
    const t = '- One\n- Two\n- Three';
    const r = indentLines(at(t, 6, 13), false);
    expect(r.text).toBe('- One\n  - Two\n  - Three');
    expect([r.selectionStart, r.selectionEnd]).toEqual([8, 17]);
    const back = indentLines(r, true);
    expect(back.text).toBe(t);
    expect([back.selectionStart, back.selectionEnd]).toEqual([6, 13]);
    // A selection that only touches the start of the next line leaves that line alone.
    expect(indentLines(at(t, 6, 12), false).text).toBe('- One\n  - Two\n- Three');
  });

  test('PL-5 Shift+Tab on an unindented line changes nothing', () => {
    const r = indentLines(at('- One', 3), true);
    expect(r).toEqual(at('- One', 3));
  });

  test('PL-5 scenes are the top-level bullets with text, numbered in order; indented bullets belong to the scene above', () => {
    const text = 'Part one\n- A\n- \n  * B\n\n• C\nnote';
    expect(sceneLines(text)).toEqual([null, 1, null, null, null, 2, null]);
    expect(sceneCount(text)).toBe(2);
    expect(sceneCount(EMPTY_OUTLINE)).toBe(0);
  });

  test('PL-5 stored ranges are cleaned: whole, 1-based, ordered pairs only', () => {
    expect(
      sceneRanges({
        ranges: {
          A: { from: 1, to: 3 },
          B: { from: 4, to: 2 },
          C: { from: 0, to: 1 },
          D: 'x',
          E: { from: 2.5, to: 3 },
        },
      }),
    ).toEqual({ A: { from: 1, to: 3 } });
    expect(sceneRanges(null)).toEqual({});
    expect(sameRanges({ A: { from: 1, to: 2 } }, { A: { from: 1, to: 2 } })).toBe(true);
    expect(sameRanges({ A: { from: 1, to: 2 } }, { A: { from: 1, to: 3 } })).toBe(false);
    expect(sameRanges({}, { A: { from: 1, to: 2 } })).toBe(false);
  });

  test('PL-5 a save starts a new version when there is none, when forced, or after the gap', () => {
    const now = new Date('2026-10-17T12:00:00Z');
    expect(startsNewVersion(null, now)).toBe(true);
    expect(startsNewVersion('2026-10-17T11:55:00Z', now)).toBe(false);
    expect(startsNewVersion('2026-10-17T11:55:00Z', now, true)).toBe(true);
    expect(startsNewVersion(new Date(now.getTime() - VERSION_GAP_MS - 1).toISOString(), now)).toBe(
      true,
    );
    expect(startsNewVersion('not a date', now)).toBe(true);
  });

  test('PL-5 a missing or malformed meta document reads as an empty outline', () => {
    expect(sceneOutlineText(null)).toBe('');
    expect(sceneOutlineText({ _id: 'sceneOutline' })).toBe('');
    expect(sceneOutlineText({ _id: 'sceneOutline', text: '- A' })).toBe('- A');
  });

  test('A37 stored breaks are cleaned: whole, non-negative line numbers only', () => {
    expect(sceneBreaks({ breaks: { A: 0, B: 3, C: -1, D: 1.5, E: 'x' } })).toEqual({ A: 0, B: 3 });
    expect(sceneBreaks(null)).toEqual({});
    expect(sameBreaks({ A: 1 }, { A: 1 })).toBe(true);
    expect(sameBreaks({ A: 1 }, { A: 2 })).toBe(false);
  });
});

describe('A37 the scene outline reads as one flow with the chapters in it', () => {
  const text = 'Opening note\n- A\n  - a detail\n- B\n- C\n- D';

  test("A37 breaks split the text into the lead and each chapter's lines, and join back the same", () => {
    const doc = { text, ranges: {}, breaks: { X: 1, Y: 4 } };
    const flow = splitFlow(doc, ['X', 'Y', 'Z']);
    expect(flow).toEqual({
      lead: ['Opening note'],
      bodies: { X: ['- A', '  - a detail', '- B'], Y: ['- C', '- D'], Z: [] },
    });
    const back = composeFlow(flow, ['X', 'Y', 'Z']);
    expect(back.text).toBe(text);
    expect(back.breaks).toEqual({ X: 1, Y: 4, Z: 6 });
    expect(back.ranges).toEqual({ X: { from: 1, to: 2 }, Y: { from: 3, to: 4 } });
  });

  test('A37 the text follows its chapters into a new reading order', () => {
    const flow = splitFlow({ text, ranges: {}, breaks: { X: 1, Y: 4 } }, ['X', 'Y']);
    const moved = composeFlow(flow, ['Y', 'X']);
    expect(moved.text).toBe('Opening note\n- C\n- D\n- A\n  - a detail\n- B');
    expect(moved.breaks).toEqual({ Y: 1, X: 3 });
    // Read back in the new order, nothing moves again.
    expect(splitFlow(moved, ['Y', 'X'])).toEqual(flow);
  });

  test('A37 an outline saved with ranges only starts each chapter at the first scene of its range', () => {
    const flow = splitFlow(
      { text, ranges: { X: { from: 1, to: 2 }, Y: { from: 3, to: 4 } }, breaks: {} },
      ['X', 'Y'],
    );
    expect(flow.lead).toEqual(['Opening note']);
    expect(flow.bodies.X).toEqual(['- A', '  - a detail', '- B']);
    expect(flow.bodies.Y).toEqual(['- C', '- D']);
  });

  test('A37 a section whose chapter is gone joins the section above, so no line is lost', () => {
    const flow = splitFlow({ text, ranges: {}, breaks: { X: 1, Gone: 4 } }, ['X']);
    expect(flow.bodies.X).toEqual(['- A', '  - a detail', '- B', '- C', '- D']);
    const start = splitFlow({ text, ranges: {}, breaks: { X: 1, Y: 4 } }, ['X', 'Y']);
    const refit = refitFlow(start, ['X', 'Y'], ['Y']);
    expect(refit.lead).toEqual(['Opening note', '- A', '  - a detail', '- B']);
    expect(refit.bodies).toEqual({ Y: ['- C', '- D'] });
    expect(refitFlow(start, ['X', 'Y'], ['X', 'Y', 'New']).bodies.New).toEqual([]);
  });

  test('A37 sections of blank lines and empty bullets are left out of the stored text', () => {
    const out = composeFlow({ lead: [], bodies: { X: ['- '], Y: ['- One'] } }, ['X', 'Y']);
    expect(out.text).toBe('- One');
    expect(out.breaks).toEqual({ X: 0, Y: 0 });
    expect(out.ranges).toEqual({ Y: { from: 1, to: 1 } });
  });

  test("A37 a chapter starts a scene earlier or later, carrying the scene's indented lines", () => {
    const above = ['- A', '- B', '  - b detail'];
    const own = ['- C', '  - c detail', '- D'];
    expect(sceneStarts(own)).toEqual([0, 2]);
    expect(takeSceneAbove(above, own)).toEqual({
      above: ['- A'],
      own: ['- B', '  - b detail', '- C', '  - c detail', '- D'],
    });
    expect(giveFirstScene(above, own)).toEqual({
      above: ['- A', '- B', '  - b detail', '- C', '  - c detail'],
      own: ['- D'],
    });
    expect(giveFirstScene(above, ['- Only'])).toEqual({ above: [...above, '- Only'], own: [] });
    // An empty bullet left in a section does not stay behind the scene that arrives.
    expect(takeSceneAbove(['- A'], ['- '])).toEqual({ above: [], own: ['- A'] });
    expect(giveFirstScene(['- '], ['- B'])).toEqual({ above: ['- B'], own: [] });
    expect(takeSceneAbove(['A heading'], own)).toBeNull();
    expect(giveFirstScene(above, [])).toBeNull();
  });
});

describe('A37 the world around the outline', () => {
  const events = [
    { id: 'e1', title: 'Drought', startYear: 2030, endYear: 2034 },
    { id: 'e2', title: 'Election', startYear: 2032, endYear: 2032 },
    { id: 'e3', title: 'Treaty', startYear: 2036, endYear: 2036 },
    { id: 'e4', title: 'Flood', startYear: 2040, endYear: 2041 },
  ];

  test('A37 a year shows what begins in it first, then what is ongoing', () => {
    expect(eventsIn(events, 2032).map((e) => e.id)).toEqual(['e2', 'e1']);
    expect(eventsIn(events, 2035)).toEqual([]);
  });

  test('A37 between two chapters come the events that begin strictly between their years', () => {
    expect(eventsBetween(events, 2032, 2040).map((e) => e.id)).toEqual(['e3']);
    expect(eventsBetween(events, 2029, 2041).map((e) => e.id)).toEqual(['e1', 'e2', 'e3', 'e4']);
    expect(eventsBetween(events, 2040, 2030)).toEqual([]);
    expect(eventsBetween(events, 2035, 2036)).toEqual([]);
  });

  test('A37 the gap between chapters is said in plain words', () => {
    expect(yearGap(2030, 2030)).toBe('Same year, 2030');
    expect(yearGap(2030, 2031)).toBe('1 year later, 2031');
    expect(yearGap(2030, 2042)).toBe('12 years later, 2042');
    expect(yearGap(2042, 2025)).toBe('Back 17 years, to 2025');
  });

  test('A37 the era of a year is the latest one that covers it', () => {
    const eras = [
      { id: 'a', name: 'Early', startYear: 2025, endYear: 2040 },
      { id: 'b', name: 'Late', startYear: 2038, endYear: 2060 },
    ];
    expect(eraAt(eras, 2030)?.id).toBe('a');
    expect(eraAt(eras, 2039)?.id).toBe('b');
    expect(eraAt(eras, 2070)).toBeNull();
  });

  test('A37 events stack in rows so none hides another, up to the row limit', () => {
    const lanes = eventLanes(events, 4);
    const lane = (id: string) => lanes.find((l) => l.event.id === id)?.lane;
    expect(lane('e1')).toBe(0);
    expect(lane('e2')).toBe(1);
    expect(lane('e3')).toBe(0);
    expect(lane('e4')).toBe(0);
    expect(new Set(eventLanes(events, 1).map((l) => l.lane))).toEqual(new Set([0]));
  });
});
