import { describe, expect, test } from 'vitest';
import {
  EMPTY_OUTLINE,
  VERSION_GAP_MS,
  chaptersAtScene,
  clampRange,
  continueBullet,
  indentLines,
  laneLayout,
  moveRange,
  nextFreeScene,
  rangeIssues,
  resizeRange,
  sceneAtY,
  sameRanges,
  sceneCount,
  sceneLines,
  sceneOutlineText,
  sceneRanges,
  startsNewVersion,
} from '../../src/shared/domain/sceneOutline';

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

  test('PL-5 range issues name overlaps on both chapters and ranges past the last scene', () => {
    const ranges = { A: { from: 1, to: 3 }, B: { from: 3, to: 5 }, C: { from: 9, to: 9 } };
    const number = (id: string) => ({ A: 1, B: 2, C: 3 })[id] ?? '?';
    expect(rangeIssues(ranges, 6, number)).toEqual([
      { chapterId: 'A', message: 'overlaps chapter 2' },
      { chapterId: 'B', message: 'overlaps chapter 1' },
      { chapterId: 'C', message: 'past the last scene' },
    ]);
    expect(rangeIssues({ A: { from: 1, to: 1 } }, 0, number)).toEqual([
      { chapterId: 'A', message: 'no scenes yet' },
    ]);
    expect(rangeIssues({ A: { from: 1, to: 2 }, B: { from: 3, to: 4 } }, 4, number)).toEqual([]);
    expect(chaptersAtScene(ranges, ['A', 'B', 'C'], 3)).toEqual(['A', 'B']);
    expect(chaptersAtScene(ranges, ['A', 'B', 'C'], 7)).toEqual([]);
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

  test('PL-5 a range moves and resizes inside the scenes there are, and the ends never cross', () => {
    expect(moveRange({ from: 2, to: 4 }, 1, 6)).toEqual({ from: 3, to: 5 });
    expect(moveRange({ from: 2, to: 4 }, 5, 6)).toEqual({ from: 4, to: 6 });
    expect(moveRange({ from: 2, to: 4 }, -5, 6)).toEqual({ from: 1, to: 3 });
    expect(resizeRange({ from: 2, to: 4 }, 'to', 1, 6)).toEqual({ from: 2, to: 5 });
    expect(resizeRange({ from: 2, to: 4 }, 'to', -9, 6)).toEqual({ from: 2, to: 2 });
    expect(resizeRange({ from: 2, to: 4 }, 'from', -1, 6)).toEqual({ from: 1, to: 4 });
    expect(resizeRange({ from: 2, to: 4 }, 'from', 9, 6)).toEqual({ from: 4, to: 4 });
    expect(clampRange({ from: 5, to: 9 }, 6)).toEqual({ from: 5, to: 6 });
    expect(clampRange({ from: 5, to: 9 }, 0)).toEqual({ from: 5, to: 9 });
  });

  test('PL-5 the next free scene follows the last placed chapter', () => {
    expect(nextFreeScene({}, 4)).toBe(1);
    expect(nextFreeScene({ A: { from: 1, to: 2 }, B: { from: 1, to: 1 } }, 4)).toBe(3);
    expect(nextFreeScene({ A: { from: 1, to: 4 } }, 4)).toBeNull();
    expect(nextFreeScene({}, 0)).toBeNull();
  });

  test('PL-5 overlapping chapters take lanes side by side; others share lane one', () => {
    const lanes = laneLayout(['A', 'B', 'C', 'D'], {
      A: { from: 1, to: 3 },
      B: { from: 2, to: 4 },
      C: { from: 5, to: 6 },
    });
    expect(lanes.get('A')).toEqual({ lane: 0, lanes: 2 });
    expect(lanes.get('B')).toEqual({ lane: 1, lanes: 2 });
    expect(lanes.get('C')).toEqual({ lane: 0, lanes: 2 });
    expect(lanes.has('D')).toBe(false);
    expect(laneLayout(['A'], {}).size).toBe(0);
  });

  test('PL-5 the scene under a point is the line box that holds it, clamped to the first and last', () => {
    const boxes = [
      { scene: 1, top: 0, bottom: 20 },
      { scene: 2, top: 20, bottom: 60 },
      { scene: 3, top: 60, bottom: 80 },
    ];
    expect(sceneAtY(boxes, -5)).toBe(1);
    expect(sceneAtY(boxes, 30)).toBe(2);
    expect(sceneAtY(boxes, 79)).toBe(3);
    expect(sceneAtY(boxes, 500)).toBe(3);
    expect(sceneAtY([], 10)).toBeNull();
  });
});
