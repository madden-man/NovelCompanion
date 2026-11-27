import { describe, expect, test } from 'vitest';
import {
  ADD_NEW_LABEL,
  addNewReducer,
  chipChoices,
  draftText,
  fieldLabel,
  mergeCommands,
  parseDate,
  parseNumber,
  parseText,
  parseYear,
  patchForPath,
  shownText,
  typedDate,
  typedNumber,
} from '../../src/renderer/src/workspace/editable/model';
import type { AddNewState } from '../../src/renderer/src/workspace/editable/model';
import type { UndoCommand } from '../../src/shared/domain/undoRunner';

describe('IP-1 the value each kind reads from what was typed', () => {
  test('IP-1 text keeps what was typed, drops trailing spaces, and refuses empty when asked', () => {
    expect(parseText('Zhou Lan  ')).toEqual({ ok: true, value: 'Zhou Lan' });
    expect(parseText('')).toEqual({ ok: true, value: '' });
    expect(parseText('   ', false)).toEqual({ ok: false, message: 'Cannot be empty.' });
    expect(parseText('', false, 'Full name')).toEqual({
      ok: false,
      message: 'Full name cannot be empty.',
    });
  });

  test('IP-1 a year accepts digits only and refuses empty unless allowEmpty', () => {
    expect(parseYear('2045')).toEqual({ ok: true, value: 2045 });
    expect(parseYear(' -40 ')).toEqual({ ok: true, value: -40 });
    expect(parseYear('20x5')).toEqual({
      ok: false,
      message: '20x5 is not a year.',
    });
    expect(parseYear('2045.5').ok).toBe(false);
    expect(parseYear('')).toEqual({ ok: false, message: 'Cannot be empty.' });
    expect(parseYear('', false, 'Born')).toEqual({ ok: false, message: 'Born cannot be empty.' });
    expect(parseYear('', true)).toEqual({ ok: true, value: null });
    expect(parseYear('12000')).toEqual({
      ok: false,
      message: '12000 is outside the years the app keeps, -10000 to 10000.',
    });
  });

  test('IP-1 a number accepts digits, a decimal unless integer, and its bounds', () => {
    expect(parseNumber('3.5')).toEqual({ ok: true, value: 3.5 });
    expect(parseNumber('3.5', { integer: true })).toEqual({
      ok: false,
      message: '3.5 is not a whole number.',
    });
    expect(parseNumber('abc').ok).toBe(false);
    expect(parseNumber('').ok).toBe(false);
    expect(parseNumber('', { allowEmpty: true })).toEqual({ ok: true, value: null });
    expect(parseNumber('-1', { min: 0 })).toEqual({
      ok: false,
      message: '-1 is too small. The smallest is 0.',
    });
    expect(parseNumber('900', { max: 500 }).ok).toBe(false);
  });

  test('A57 a year or number box refuses what its kind cannot read as it is typed', () => {
    expect(typedNumber('year', '2045')).toBe('2045');
    expect(typedNumber('year', '-40')).toBe('-40');
    expect(typedNumber('year', '20 45')).toBe('2045');
    expect(typedNumber('year', '20x5')).toBeNull();
    expect(typedNumber('year', '2045.5')).toBeNull();
    expect(typedNumber('year', '4-')).toBeNull();
    expect(typedNumber('number', '3.5')).toBe('3.5');
    expect(typedNumber('number', '3.5.1')).toBeNull();
    expect(typedNumber('number', '3.5', { integer: true })).toBeNull();
    expect(typedNumber('number', '-1', { min: 0 })).toBeNull();
    expect(typedNumber('number', '-1', { min: -5 })).toBe('-1');
    expect(typedNumber('number', 'abc')).toBeNull();
    expect(typedNumber('year', '')).toBe('');
  });

  test('IP-1 SM-1 a date reads one box with the dates.ts parser, and a half-typed date says so in a few words', () => {
    expect(parseDate('1990-3', 'birth')).toEqual({ ok: true, value: { year: 1990, month: 3 } });
    expect(parseDate('', 'birth')).toEqual({ ok: true, value: { unknown: true } });
    expect(parseDate('', 'death')).toEqual({ ok: true, value: null });
    expect(parseDate('1990-', 'birth')).toEqual({ ok: true, value: { year: 1990 } });
    expect(parseDate('1990-03-', 'birth')).toEqual({ ok: true, value: { year: 1990, month: 3 } });
    expect(parseDate('-', 'birth')).toEqual({ ok: false, message: '- is not a date.' });
    expect(parseDate('1990-0', 'birth')).toEqual({ ok: false, message: '1990-0 is not a date.' });
    // No sentence on how to write a date, whatever the box was handed.
    expect(parseDate('March 1990', 'birth')).toEqual({
      ok: false,
      message: 'March 1990 is not a date.',
    });
  });

  test('A57 a one-box date refuses what it cannot read as it is typed, and takes every format it reads', () => {
    // Every format the parser reads goes in, and so does each step of typing one.
    for (const ok of ['1990', '1990-03', '1990-3', '1990-03-14', '1990-3-4', '-40', '-40-02-29']) {
      expect(typedDate(ok)).toBe(ok);
      for (let i = 0; i <= ok.length; i += 1)
        expect(typedDate(ok.slice(0, i))).toBe(ok.slice(0, i));
    }
    expect(typedDate('10000-12-31')).toBe('10000-12-31');
    expect(typedDate('1990 - 03')).toBe('1990-03');
    // A full date with its year cleared, on the way to another year.
    expect(typedDate('-03-14')).toBe('-03-14');
    // Words, other marks, a sixth year digit, a year past 10000, a month past 12, a day past 31.
    for (const bad of ['soon', 'March 1990', '1990/03', '1990.5', '199003', '10001', '1990-13']) {
      expect(typedDate(bad)).toBeNull();
    }
    for (const bad of [
      '1990-00',
      '1990-03-32',
      '1990-03-00',
      '1990-03-14-',
      '1990--',
      '1990-123',
    ]) {
      expect(typedDate(bad)).toBeNull();
    }
  });

  test('IP-1 the closed text of each kind, and the text an opened field starts with', () => {
    const options = [
      { value: 'canon', label: 'Canon' },
      { value: 'FAM-HALE', label: 'Hale' },
    ];
    expect(shownText('text', 'Iris')).toBe('Iris');
    expect(shownText('year', 2045)).toBe('2045');
    expect(shownText('number', null)).toBe('');
    expect(shownText('rich', '**Bold**')).toBe('**Bold**');
    expect(shownText('date', { year: 2031, month: 3, day: 14 })).toBe('2031-03-14');
    expect(shownText('date', { unknown: true })).toBe('');
    expect(shownText('select', 'canon', options)).toBe('Canon');
    expect(shownText('select', 'gone', options)).toBe('gone');
    expect(shownText('chips', ['FAM-HALE', 'X'], options)).toBe('Hale, X');
    expect(draftText('date', { year: 1990, month: 3 })).toBe('1990-03');
    expect(draftText('select', 'canon')).toBe('');
  });
});

describe('IP-1 chip pickers and Add new', () => {
  const families = [
    { value: 'FAM-HALE', label: 'Hale' },
    { value: 'FAM-ZHOU', label: 'Zhou' },
    { value: 'FAM-REYES', label: 'Reyes' },
  ];

  test('IP-1 the picker offers the unpicked choices that hold the typed words', () => {
    expect(chipChoices(families, ['FAM-HALE'], '').map((o) => o.label)).toEqual(['Zhou', 'Reyes']);
    expect(chipChoices(families, [], 'ZH').map((o) => o.label)).toEqual(['Zhou']);
    expect(ADD_NEW_LABEL).toBe('Add new...');
  });

  test('IP-1 Add new goes from choosing to naming, adding, saving, and done', () => {
    let s: AddNewState = addNewReducer({ step: 'closed' }, { type: 'open' });
    expect(s).toEqual({ step: 'choosing', query: '' });
    s = addNewReducer(s, { type: 'query', query: 'Okafor' });
    s = addNewReducer(s, { type: 'pickAddNew' });
    // The typed words become the new item's label, ready to change.
    expect(s).toEqual({ step: 'naming', label: 'Okafor', error: null });
    s = addNewReducer(s, { type: 'label', label: 'Okafor family' });
    s = addNewReducer(s, { type: 'submit' });
    expect(s).toEqual({ step: 'adding', label: 'Okafor family' });
    const added = { id: 'FAM-OKAFOR', label: 'Okafor family' };
    s = addNewReducer(s, { type: 'added', added });
    expect(s).toEqual({ step: 'saving', label: 'Okafor family', added });
    s = addNewReducer(s, { type: 'saved' });
    expect(s).toEqual({ step: 'done', added });
    expect(addNewReducer(s, { type: 'cancel' })).toEqual({ step: 'closed' });
  });

  test('IP-1 Add new refuses an empty name and keeps the label after a failure', () => {
    let s: AddNewState = addNewReducer({ step: 'closed' }, { type: 'pickAddNew', label: '' });
    s = addNewReducer(s, { type: 'submit' });
    expect(s).toEqual({ step: 'naming', label: '', error: 'The new item has no name.' });
    s = addNewReducer(s, { type: 'label', label: 'Harbour' });
    s = addNewReducer(s, { type: 'submit' });
    s = addNewReducer(s, {
      type: 'failed',
      message: 'The Event categories list already has an item called Harbour.',
    });
    expect(s).toEqual({
      step: 'naming',
      label: 'Harbour',
      error: 'The Event categories list already has an item called Harbour.',
    });
  });
});

describe('IP-1 entry field paths and steps', () => {
  test('IP-1 a dotted path becomes the top-level patch the write path takes', () => {
    const entry = { names: { full: 'Sam Hale', chinese: '山' }, strands: [{ year: 2045 }] };
    expect(patchForPath(entry, 'birth', { year: 2012 })).toEqual({ birth: { year: 2012 } });
    expect(patchForPath(entry, 'names.full', 'Samuel Hale')).toEqual({
      names: { full: 'Samuel Hale', chinese: '山' },
    });
    expect(patchForPath(entry, 'strands.0.year', 2046)).toEqual({ strands: [{ year: 2046 }] });
    // The entry itself is left alone.
    expect(entry.names.full).toBe('Sam Hale');
  });

  test('IP-1 the step label is the field label from the manifest', () => {
    expect(fieldLabel('characters', 'birth')).toBe('Birth');
    expect(fieldLabel('characters', 'names.full')).toBe('Full name');
    expect(fieldLabel('characters', 'names.chinese')).toBe('Name in Chinese characters');
    expect(fieldLabel('worldEvents', 'categoryId')).toBe('Category');
  });

  test('IP-1 an item added on the way and the field that picks it are one step', () => {
    const op = (n: string) => ({ kind: 'delete' as const, collection: 'families' as const, id: n });
    const add: UndoCommand = { label: 'Added', undo: [op('add-undo')], redo: [op('add-redo')] };
    const edit: UndoCommand = { label: 'Edit', undo: [op('edit-undo')], redo: [op('edit-redo')] };
    const both = mergeCommands('Changed Category on Floods', add, edit);
    expect(both.label).toBe('Changed Category on Floods');
    // Redo makes the item first; undo takes the field back first, then the item.
    expect(both.redo.map((o) => (o as { id: string }).id)).toEqual(['add-redo', 'edit-redo']);
    expect(both.undo.map((o) => (o as { id: string }).id)).toEqual(['edit-undo', 'add-undo']);
  });
});
