import { describe, expect, test } from 'vitest';
import {
  EMPTY_OUTLINE,
  VERSION_GAP_MS,
  composeFlow,
  continueBullet,
  giveFirstScene,
  indentLines,
  refitFlow,
  LEAD,
  chapterBars,
  edgeLimits,
  moveEdge,
  moveOnto,
  neighbourOf,
  retext,
  sameBreaks,
  sameYears,
  sceneBreaks,
  sceneCount,
  sceneLines,
  sceneOutlineText,
  sceneStarts,
  sceneYears,
  section,
  sectionOf,
  setSceneYear,
  shownYears,
  splitFlow,
  startsNewVersion,
  takeSceneAbove,
  yearOf,
} from '../../src/shared/domain/sceneOutline';
import type { Flow, Section } from '../../src/shared/domain/sceneOutline';
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

  test('PL-5 Cmd+] indents the selected lines and Cmd+[ outdents them', () => {
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

describe('A37 SM-7 the scene outline reads as one flow split among the chapters', () => {
  const text = 'Opening note\n- A\n  - a detail\n- B\n- C\n- D';
  const lines = (f: Flow, key: string) => sectionOf(f, key).lines;

  test("A37 breaks split the text into the lead and each chapter's lines, and join back the same", () => {
    const doc = { text, breaks: { X: 1, Y: 4 } };
    const flow = splitFlow(doc, ['X', 'Y', 'Z']);
    expect(lines(flow, LEAD)).toEqual(['Opening note']);
    expect(lines(flow, 'X')).toEqual(['- A', '  - a detail', '- B']);
    expect(lines(flow, 'Y')).toEqual(['- C', '- D']);
    expect(lines(flow, 'Z')).toEqual([]);
    const back = composeFlow(flow, ['X', 'Y', 'Z']);
    expect(back.text).toBe(text);
    expect(back.breaks).toEqual({ X: 1, Y: 4, Z: 6 });
    expect(back.years).toEqual({});
  });

  test('A37 the text follows its chapters into a new reading order', () => {
    const flow = splitFlow({ text, breaks: { X: 1, Y: 4 } }, ['X', 'Y']);
    const moved = composeFlow(flow, ['Y', 'X']);
    expect(moved.text).toBe('Opening note\n- C\n- D\n- A\n  - a detail\n- B');
    expect(moved.breaks).toEqual({ Y: 1, X: 3 });
    // Read back in the new order, nothing moves again.
    expect(splitFlow(moved, ['Y', 'X'])).toEqual(flow);
  });

  test('A37 a section whose chapter is gone joins the section above, so no line is lost', () => {
    const flow = splitFlow({ text, breaks: { X: 1, Gone: 4 } }, ['X']);
    expect(lines(flow, 'X')).toEqual(['- A', '  - a detail', '- B', '- C', '- D']);
    const start = splitFlow({ text, breaks: { X: 1, Y: 4 } }, ['X', 'Y']);
    const refit = refitFlow(start, ['X', 'Y'], ['Y']);
    expect(lines(refit, LEAD)).toEqual(['Opening note', '- A', '  - a detail', '- B']);
    expect(Object.keys(refit.bodies)).toEqual(['Y']);
    expect(lines(refit, 'Y')).toEqual(['- C', '- D']);
    expect(lines(refitFlow(start, ['X', 'Y'], ['X', 'Y', 'New']), 'New')).toEqual([]);
  });

  test('A37 sections of blank lines and empty bullets are left out of the stored text', () => {
    const out = composeFlow(
      { lead: section(), bodies: { X: section(['- ']), Y: section(['- One']) } },
      ['X', 'Y'],
    );
    expect(out.text).toBe('- One');
    expect(out.breaks).toEqual({ X: 0, Y: 0 });
  });

  test("A37 a chapter starts a scene earlier or later, carrying the scene's indented lines", () => {
    const above = section(['- A', '- B', '  - b detail']);
    const own = section(['- C', '  - c detail', '- D']);
    expect(sceneStarts(own.lines)).toEqual([0, 2]);
    expect(takeSceneAbove(above, own)).toEqual({
      above: section(['- A']),
      own: section(['- B', '  - b detail', '- C', '  - c detail', '- D']),
    });
    expect(giveFirstScene(above, own)).toEqual({
      above: section(['- A', '- B', '  - b detail', '- C', '  - c detail']),
      own: section(['- D']),
    });
    expect(giveFirstScene(above, section(['- Only']))).toEqual({
      above: section([...above.lines, '- Only']),
      own: section(),
    });
    // An empty bullet left in a section does not stay behind the scene that arrives.
    expect(takeSceneAbove(section(['- A']), section(['- ']))).toEqual({
      above: section(),
      own: section(['- A']),
    });
    expect(giveFirstScene(section(['- ']), section(['- B']))).toEqual({
      above: section(['- B']),
      own: section(),
    });
    expect(takeSceneAbove(section(['A heading']), own)).toBeNull();
    expect(giveFirstScene(above, section())).toBeNull();
  });
});

describe('SM-5 every scene has a year, its own or inherited, kept in step with the text', () => {
  const sec = (ls: string[], years: Record<number, number> = {}): Section => section(ls, years);

  test('SM-5 stored years are cleaned: whole line numbers to whole years only', () => {
    expect(
      sceneYears({
        years: { '0': 2040, '3': -50, '01': 2041, '-1': 2042, x: 2043, '4': 2044.5, '5': 20001 },
      }),
    ).toEqual({ '0': 2040, '3': -50 });
    expect(sceneYears(null)).toEqual({});
    expect(sceneYears({ years: 'x' })).toEqual({});
    expect(sameYears({ '1': 2040 }, { '1': 2040 })).toBe(true);
    expect(sameYears({ '1': 2040 }, { '1': 2041 })).toBe(false);
  });

  test('SM-5 A37 an outline saved with ranges only derives its breaks from them once', () => {
    const text = 'Opening note\n- A\n  - a detail\n- B\n- C\n- D';
    const old = {
      text,
      ranges: { X: { from: 1, to: 2 }, Y: { from: 3, to: 4 }, Z: { from: 9, to: 9 }, W: 'x' },
    };
    expect(sceneBreaks(old)).toEqual({ X: 1, Y: 4, Z: 6 });
    expect(sceneYears(old)).toEqual({});
    const flow = splitFlow({ text, breaks: sceneBreaks(old) }, ['X', 'Y']);
    expect(sectionOf(flow, LEAD).lines).toEqual(['Opening note']);
    expect(sectionOf(flow, 'X').lines).toEqual(['- A', '  - a detail', '- B']);
    expect(sectionOf(flow, 'Y').lines).toEqual(['- C', '- D']);
    // Overlapping ranges (A36 allowed two chapters on one scene) still give each chapter its own start.
    expect(
      sceneBreaks({
        text,
        ranges: { X: { from: 1, to: 3 }, Y: { from: 1, to: 2 }, Z: { from: 2, to: 4 } },
      }),
    ).toEqual({ X: 1, Y: 2, Z: 3 });
    expect(
      sceneBreaks({ text: '- A', ranges: { X: { from: 1, to: 1 }, Y: { from: 1, to: 1 } } }),
    ).toEqual({ X: 0, Y: 1 });
    // Once breaks are stored, the ranges are ignored.
    expect(sceneBreaks({ ...old, breaks: { X: 0 } })).toEqual({ X: 0 });
    expect(sceneBreaks({ text, ranges: 'x' })).toEqual({});
  });

  test('SM-5 years split with the text into the sections and join back by line of the whole text', () => {
    const doc = {
      text: '- A\n- B\n  - b\n- C',
      breaks: { X: 0, Y: 3 },
      years: { '1': 2040, '3': 2050 },
    };
    const flow = splitFlow(doc, ['X', 'Y']);
    expect(sectionOf(flow, 'X').years).toEqual({ 1: 2040 });
    expect(sectionOf(flow, 'Y').years).toEqual({ 0: 2050 });
    expect(composeFlow(flow, ['X', 'Y'])).toEqual(doc);
    // A year on a line that is not a scene is not stored.
    expect(
      composeFlow(splitFlow({ ...doc, years: { '2': 2045 } }, ['X', 'Y']), ['X', 'Y']).years,
    ).toEqual({});
  });

  test('SM-5 a year set on a scene survives a line inserted above it', () => {
    const before = sec(['- A', '- B'], { 1: 2040 });
    const after = retext(before, ['- New', '- A', '- B']);
    expect(after.years).toEqual({ 2: 2040 });
    expect(retext(before, ['- A', '  - a note', '- B']).years).toEqual({ 2: 2040 });
    // Typing in the scene keeps its year on it.
    expect(retext(before, ['- A', '- Bee']).years).toEqual({ 1: 2040 });
  });

  test("SM-5 a deleted scene's year goes", () => {
    const before = sec(['- A', '- B', '- C'], { 0: 2030, 1: 2040, 2: 2050 });
    expect(retext(before, ['- A', '- C']).years).toEqual({ 0: 2030, 1: 2050 });
    // A scene turned into a note under the one above loses its year too.
    expect(retext(before, ['- A', '  - B', '- C']).years).toEqual({ 0: 2030, 2: 2050 });
  });

  test('SM-5 a split scene keeps its year on the first half, and joined scenes keep the first year among them', () => {
    const before = sec(['- Dawn lands Mark waits', '- C'], { 0: 2040 });
    const split = retext(before, ['- Dawn lands', '-  Mark waits', '- C']);
    expect(split.years).toEqual({ 0: 2040 });
    const joined = retext(sec(['- A', '- B'], { 1: 2045 }), ['- A- B']);
    expect(joined.years).toEqual({ 0: 2045 });
    expect(retext(sec(['- A', '- B'], { 0: 2030, 1: 2045 }), ['- A- B']).years).toEqual({
      0: 2030,
    });
  });

  test('SM-5 a year is set on a scene and cleared back to inheritance; a line that is no scene takes none', () => {
    const s0 = sec(['- A', '  - note', '- B']);
    const set = setSceneYear(s0, 2, 2041);
    expect(set.years).toEqual({ 2: 2041 });
    expect(setSceneYear(set, 2, null).years).toEqual({});
    expect(setSceneYear(s0, 1, 2041).years).toEqual({});
  });

  test('SM-5 a scene without a year inherits the nearest scene above with one, else its chapter year', () => {
    const s0 = sec(['- A', '  - note', '- B', '- C', '- D'], { 2: 2041 });
    expect(shownYears(s0, 2032)).toEqual([
      { year: 2032, own: false },
      null,
      { year: 2041, own: true },
      { year: 2041, own: false },
      { year: 2041, own: false },
    ]);
    expect(shownYears(sec(['- A']), null)).toEqual([{ year: null, own: false }]);
  });

  test("SM-5 inheritance across a chapter boundary stops at the chapter's year", () => {
    const doc = { text: '- A\n- B\n- C\n- D', breaks: { X: 0, Y: 2 }, years: { '1': 2050 } };
    const years = { X: 2040, Y: 2032 };
    expect(yearOf(doc, ['X', 'Y'], years, 0)).toEqual({ year: 2040, own: false });
    expect(yearOf(doc, ['X', 'Y'], years, 1)).toEqual({ year: 2050, own: true });
    // Chapter Y's first scene takes Y's year, not the 2050 of the scene above it.
    expect(yearOf(doc, ['X', 'Y'], years, 2)).toEqual({ year: 2032, own: false });
    expect(yearOf(doc, ['X', 'Y'], years, 3)).toEqual({ year: 2032, own: false });
    expect(yearOf(doc, ['X', 'Y'], years, 9)).toBeNull();
  });
});

describe('SM-7 the chapter bars beside the text', () => {
  const doc = {
    text: 'Opening\n- A\n- B\n  - b\n- C\n- D\n- E',
    breaks: { X: 1, Y: 4, Z: 6 },
    years: { '2': 2040, '4': 2045 },
  };
  const order = ['X', 'Y', 'Z'];
  const flow = () => splitFlow(doc, order);

  test('SM-7 each bar runs from its break to the next break or the end, with its scenes', () => {
    expect(chapterBars(doc, order)).toEqual([
      { id: 'X', from: 1, to: 4, scenes: 2, firstScene: 1 },
      { id: 'Y', from: 4, to: 6, scenes: 2, firstScene: 3 },
      { id: 'Z', from: 6, to: 7, scenes: 1, firstScene: 5 },
    ]);
    // A chapter with no break starts empty at the end.
    expect(chapterBars(doc, [...order, 'W']).at(-1)).toEqual({
      id: 'W',
      from: 7,
      to: 7,
      scenes: 0,
      firstScene: 6,
    });
  });

  test('SM-7 the limits of the edges: no chapter gives away or takes the last scene of a chapter', () => {
    expect(edgeLimits(flow(), order, 'X')).toEqual({
      start: { up: 0, down: 1 },
      end: { up: 1, down: 1 },
    });
    expect(edgeLimits(flow(), order, 'Z')).toEqual({
      start: { up: 1, down: 0 },
      end: { up: 0, down: 0 },
    });
    // The lines before the first chapter can give all their scenes.
    const led = splitFlow({ text: '- L1\n- L2\n- A', breaks: { X: 2 } }, ['X']);
    expect(edgeLimits(led, ['X'], 'X').start).toEqual({ up: 2, down: 0 });
    expect(edgeLimits(flow(), order, 'missing').start).toEqual({ up: 0, down: 0 });
  });

  test("SM-7 pulling a bar's end edge down a scene moves the break and the next chapter shrinks; years go with their scenes", () => {
    const next = moveEdge(flow(), order, 'X', 'end', 1) as Flow;
    const out = composeFlow(next, order);
    expect(out.text).toBe(doc.text);
    expect(out.breaks).toEqual({ X: 1, Y: 5, Z: 6 });
    expect(out.years).toEqual(doc.years);
    expect(chapterBars(out, order).map((b) => b.scenes)).toEqual([3, 1, 1]);
    // Y cannot give its last scene away.
    expect(moveEdge(next, order, 'X', 'end', 1)).toBeNull();
    // Up gives X's last scene, with its indented line, to Y.
    const up = composeFlow(moveEdge(flow(), order, 'X', 'end', -1) as Flow, order);
    expect(up.breaks).toEqual({ X: 1, Y: 2, Z: 6 });
  });

  test("SM-7 pulling a bar's start edge moves the break with the section above, within the limits", () => {
    const up = composeFlow(moveEdge(flow(), order, 'Z', 'start', -1) as Flow, order);
    expect(up.breaks).toEqual({ X: 1, Y: 4, Z: 5 });
    const down = composeFlow(moveEdge(flow(), order, 'Y', 'start', 5) as Flow, order);
    // Y keeps one scene however far the edge is pulled.
    expect(down.breaks).toEqual({ X: 1, Y: 5, Z: 6 });
    expect(moveEdge(flow(), order, 'X', 'start', -1)).toBeNull();
    const intoLead = composeFlow(moveEdge(flow(), order, 'X', 'start', 1) as Flow, order);
    expect(intoLead.breaks).toEqual({ X: 2, Y: 4, Z: 6 });
  });

  test('SM-7 a swap carries the years with their scenes', () => {
    const swapped = composeFlow(flow(), ['Y', 'X', 'Z']);
    expect(swapped.text).toBe('Opening\n- C\n- D\n- A\n- B\n  - b\n- E');
    expect(swapped.breaks).toEqual({ Y: 1, X: 3, Z: 6 });
    expect(swapped.years).toEqual({ '1': 2045, '4': 2040 });
    expect(composeFlow(splitFlow(swapped, ['Y', 'X', 'Z']), order)).toEqual(doc);
  });

  test('SM-7 what one swap writes: the chapter goes just past its neighbour, in that part', () => {
    const chapters = [
      { id: 'A', partId: 'P1' },
      { id: 'B', partId: 'P1' },
      { id: 'C', partId: 'P2' },
      { id: 'D', partId: 'P2' },
    ];
    expect(moveOnto(chapters, 'A', 'B')).toEqual({
      kind: 'chapters',
      groupId: 'P1',
      movedId: 'A',
      toIndex: 1,
    });
    expect(moveOnto(chapters, 'B', 'A')).toMatchObject({ groupId: 'P1', toIndex: 0 });
    // Across a part: down lands after the target, up before it.
    expect(moveOnto(chapters, 'B', 'C')).toMatchObject({ groupId: 'P2', toIndex: 1 });
    expect(moveOnto(chapters, 'C', 'B')).toMatchObject({ groupId: 'P1', toIndex: 1 });
    expect(moveOnto(chapters, 'D', 'A')).toMatchObject({ groupId: 'P1', toIndex: 0 });
    expect(moveOnto(chapters, 'A', 'A')).toBeNull();
    expect(neighbourOf(chapters, 'A', -1)).toBeNull();
    expect(neighbourOf(chapters, 'A', 1)).toBe('B');
    expect(neighbourOf(chapters, 'D', 1)).toBeNull();
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
