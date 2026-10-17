import { describe, expect, test } from 'vitest';
import {
  EMPTY_OUTLINE,
  continueBullet,
  indentLines,
  sceneCount,
  sceneOutlineText,
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

  test('PL-5 the scene count is the number of bullets with text', () => {
    expect(sceneCount('Part one\n- A\n- \n  * B\n\n• C\nnote')).toBe(3);
    expect(sceneCount(EMPTY_OUTLINE)).toBe(0);
  });

  test('PL-5 a missing or malformed meta document reads as an empty outline', () => {
    expect(sceneOutlineText(null)).toBe('');
    expect(sceneOutlineText({ _id: 'sceneOutline' })).toBe('');
    expect(sceneOutlineText({ _id: 'sceneOutline', text: '- A' })).toBe('- A');
  });
});
