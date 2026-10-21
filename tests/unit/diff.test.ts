import { describe, expect, test } from 'vitest';
import { contentOf, diffEntries } from '../../src/shared/domain/diff';

describe('ED-4 revision comparison', () => {
  test('ED-4 the diff lists each changed field by path with its old and new value', () => {
    const before = {
      _id: 'H1',
      modifiedAt: '2026-01-01T00:00:00.000Z',
      title: 'Margaret Hale',
      names: { full: 'Margaret Hale', chinese: '玛' },
      death: { year: 2041 },
      tags: [],
    };
    const after = {
      _id: 'H1',
      modifiedAt: '2026-02-01T00:00:00.000Z',
      title: 'Margaret Doyle Hale',
      names: { full: 'Margaret Hale', chinese: '玛格' },
      death: null,
      tags: ['matriarch'],
    };
    expect(diffEntries(before, after)).toEqual([
      { path: 'title', before: 'Margaret Hale', after: 'Margaret Doyle Hale' },
      { path: 'names.chinese', before: '玛', after: '玛格' },
      { path: 'death', before: { year: 2041 }, after: null },
      { path: 'tags', before: [], after: ['matriarch'] },
    ]);
  });

  test('ED-4 identical versions have no differences, and bookkeeping fields are ignored', () => {
    const a = { _id: 'A', createdAt: 'x', modifiedAt: 'y', title: 'T' };
    expect(diffEntries(a, { ...a, modifiedAt: 'z' })).toEqual([]);
  });

  test('ED-4 content leaves out identity, timestamps, and trash state', () => {
    expect(
      contentOf({
        _id: 'A',
        createdAt: 'c',
        modifiedAt: 'm',
        deletedAt: 'd',
        title: 'T',
        links: [],
      }),
    ).toEqual({ title: 'T', links: [] });
  });
});
