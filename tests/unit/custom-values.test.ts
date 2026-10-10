import { describe, expect, test } from 'vitest';
import { customValueIssues } from '../../src/shared/domain/customValues';
import type { CustomField } from '../../src/shared/schema';

const fields: CustomField[] = [
  { id: 'n', label: 'Servings', type: 'number', options: [] },
  { id: 'c', label: 'Occasion', type: 'singleChoice', options: ['Holiday'] },
  { id: 'r', label: 'Made between', type: 'yearRange', options: [] },
];

describe('ED-1 custom entry values fit their section', () => {
  test('ED-1 values of the right kind pass and blanks are allowed', () => {
    expect(
      customValueIssues(
        { name: 'Recipes', fields },
        { n: 4, c: 'Holiday', r: { startYear: 1980, endYear: null } },
      ),
    ).toEqual([]);
    expect(customValueIssues({ name: 'Recipes', fields }, { n: null, c: null })).toEqual([]);
  });

  test('ED-1 a value of the wrong kind, an unknown choice, or an unknown field is refused plainly', () => {
    expect(
      customValueIssues({ name: 'Recipes', fields }, { n: 'four', c: 'Funeral', x: 1 }),
    ).toEqual([
      'Servings needs a number.',
      'Occasion has no choice called "Funeral".',
      'The section Recipes has no field with the ID x.',
    ]);
  });
});
