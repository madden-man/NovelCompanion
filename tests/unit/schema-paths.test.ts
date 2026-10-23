import { describe, expect, test } from 'vitest';
import { unknownPaths } from '../../src/shared/domain/schemaPaths';
import { entrySchemas } from '../../src/shared/schema';

describe('ED-7 SM-1 the paths a value has that its schema does not', () => {
  test('ED-7 SM-1 dropped fields are found at the top, nested, inside arrays, and in unions', () => {
    const c = entrySchemas.characters;
    expect(unknownPaths(c, { role: 'x', birthplace: 'Salem' })).toEqual(['birthplace']);
    expect(unknownPaths(c, { names: { full: 'A', romanization: 'a', order: 'x' } })).toEqual([
      'names.romanization',
      'names.order',
    ]);
    // A52: links left every entry, so they are a dropped field at the top.
    expect(unknownPaths(c, { links: [{ targetId: 'H1', kind: 'about' }] })).toEqual(['links']);
    expect(
      unknownPaths(entrySchemas.places, {
        descriptions: [{ startYear: null, endYear: null, text: 'x', note: 'x' }],
      }),
    ).toEqual(['descriptions.0.note']);
    expect(unknownPaths(c, { birth: { year: 1990, era: 'x' } })).toEqual(['birth.era']);
    expect(unknownPaths(c, { birth: { unknown: true } })).toEqual([]);
    expect(unknownPaths(c, { names: { full: 'A', chinese: '甲' }, familyIds: ['F'] })).toEqual([]);
  });

  test('ED-7 prototype keys are not fields', () => {
    const data = JSON.parse('{"toString": 1, "__proto__": 2, "hasOwnProperty": 3}') as object;
    expect(unknownPaths(entrySchemas.places, data)).toEqual([
      'toString',
      '__proto__',
      'hasOwnProperty',
    ]);
  });
});
