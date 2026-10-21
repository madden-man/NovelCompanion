import { describe, expect, test } from 'vitest';
import { savedFieldText } from '../../src/shared/domain/undoText';
import { zhPieces } from '../../src/shared/domain/zh';

describe('ED-3 saved value of the focused field after a save (M1 review fix)', () => {
  const saved = {
    role: 'Astoria',
    names: { full: 'Ruth Hale', chinese: '' },
    birth: { year: 1990 },
    readingOrder: 3,
    sourceFile: null,
  };

  test('ED-3 a field of the saved entry takes the stored value, not what it shows now', () => {
    expect(savedFieldText(saved, 'role')).toBe('Astoria');
    expect(savedFieldText(saved, 'names.full')).toBe('Ruth Hale');
    expect(savedFieldText(saved, 'readingOrder')).toBe('3');
    expect(savedFieldText(saved, 'sourceFile')).toBe('');
  });

  test('ED-3 a field outside the saved entry, or not a text value, keeps its own saved value', () => {
    expect(savedFieldText(saved, null)).toBeUndefined();
    expect(savedFieldText(saved, 'backstory')).toBeUndefined();
    expect(savedFieldText(saved, 'birth')).toBeUndefined();
  });
});

describe('CH-2 Chinese names matched to the glossary (GL-3 stub)', () => {
  const terms = [
    { id: 'GL1', characters: '晓曦', romanization: 'xiǎoxī', meaning: 'dawn light' },
    { id: 'GL4', characters: '外婆', romanization: 'wàipó', meaning: 'maternal grandmother' },
  ];
  test('CH-2 an exact term, a longest prefix, and a run with no term', () => {
    expect(zhPieces('Iris 晓曦', terms)).toEqual([
      { kind: 'text', text: 'Iris ' },
      { kind: 'zh', text: '晓曦', term: terms[0] },
    ]);
    expect(zhPieces('外婆家', terms)).toEqual([
      { kind: 'zh', text: '外婆', term: terms[1] },
      { kind: 'zh', text: '家', term: null },
    ]);
  });
});
