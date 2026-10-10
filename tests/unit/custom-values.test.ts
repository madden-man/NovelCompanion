import { describe, expect, test } from 'vitest';
import { customValueIssues, hasValue } from '../../src/shared/domain/customValues';
import { computeWarnings } from '../../src/shared/domain/warnings';
import { customFieldSpecs, manifests } from '../../src/shared/schema';
import type { CustomField, CustomSection } from '../../src/shared/schema';

const fields: CustomField[] = [
  { id: 'n', label: 'Servings', type: 'number', options: [] },
  { id: 'c', label: 'Occasion', type: 'singleChoice', options: ['Holiday'] },
  { id: 'r', label: 'Made between', type: 'yearRange', options: [] },
];

describe('ED-10 custom entry values that no longer fit their section are warnings', () => {
  test('ED-10 values of the right kind fit and blanks are allowed', () => {
    expect(
      customValueIssues(
        { name: 'Recipes', fields },
        { n: 4, c: 'Holiday', r: { startYear: 1980, endYear: null } },
      ),
    ).toEqual([]);
    expect(
      customValueIssues({ name: 'Recipes', fields }, { n: null, c: null, gone: null }),
    ).toEqual([]);
  });

  test('ED-10 a value of the wrong kind, a removed choice, or a removed field is reported by field', () => {
    expect(
      customValueIssues({ name: 'Recipes', fields }, { n: 'four', c: 'Funeral', x: 1 }),
    ).toEqual([
      { fieldId: 'n', message: 'Servings needs a number.' },
      { fieldId: 'c', message: 'Occasion has no choice called "Funeral".' },
      {
        fieldId: 'x',
        message: 'The section Recipes no longer has this field. The old value is kept.',
      },
    ]);
  });

  test('ED-10 the warnings land on the custom entry field, declared in its manifest', () => {
    const section = { _id: 'S', name: 'Recipes', fields } as unknown as CustomSection;
    const ws = computeWarnings(
      'customEntries',
      manifests.customEntries,
      { _id: 'E', sectionId: 'S', links: [], values: { c: 'Funeral' } },
      {
        get: (c, id) => (c === 'customSections' && id === 'S' ? (section as never) : undefined),
        find: (id) =>
          id === 'S' ? { collection: 'customSections', doc: section as never } : undefined,
        list: () => undefined,
        customSpecs: () => customFieldSpecs(section),
        customSection: () => section,
      },
    );
    expect(ws).toEqual([
      {
        path: 'values.c',
        code: 'custom-value',
        message: 'Occasion has no choice called "Funeral".',
      },
    ]);
    expect(manifests.customEntries.find((s) => s.name === 'values')!.warnings).toContain(
      'custom-value',
    );
  });

  test('ED-8 a field counts as in use only when it holds a value', () => {
    expect([null, '', [], { startYear: null, endYear: null }].map(hasValue)).toEqual([
      false,
      false,
      false,
      false,
    ]);
    expect([0, 'x', ['t'], { startYear: 1980, endYear: null }].map(hasValue)).toEqual([
      true,
      true,
      true,
      true,
    ]);
  });
});
