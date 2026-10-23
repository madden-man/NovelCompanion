import { describe, expect, test } from 'vitest';
import { manifests } from '../../src/shared/schema';
import type { ListDoc } from '../../src/shared/schema';
import { countListUsage, derivedRename, itemPath, newItemId } from '../../src/shared/domain/lists';

const docs = () => [
  {
    collection: 'unions',
    manifest: manifests.unions,
    docs: [
      { _id: 'U1', type: 'married' },
      { _id: 'U2', type: 'partnered' },
    ],
  },
];

describe('ED-8 lists', () => {
  test('ED-8 usage counts the entries that hold an item by its ID', () => {
    const all = docs();
    expect(
      countListUsage('unionTypes', { id: 'married', label: 'Married', parentId: null }, all),
    ).toBe(1);
    expect(
      countListUsage('unionTypes', { id: 'divorced', label: 'Divorced', parentId: null }, all),
    ).toBe(0);
  });

  test('ED-8 A42 an entry in the trash does not count as using an item, so a trashed community can be removed', () => {
    const all = docs().map((c) => ({
      ...c,
      docs: c.docs.map((d) => ({ ...d, deletedAt: '2026-10-21T00:00:00.000Z' })),
    }));
    expect(
      countListUsage('unionTypes', { id: 'married', label: 'Married', parentId: null }, all),
    ).toBe(0);
  });

  test('ED-8 hierarchical items show their path, and new item IDs are unique', () => {
    const list: ListDoc = {
      _id: 'eventCategories',
      label: 'Event categories',
      items: [
        { id: 'technology', label: 'Technology', parentId: null },
        { id: 'robotics', label: 'Robotics', parentId: 'technology' },
      ],
    };
    expect(itemPath(list, 'robotics')).toBe('Technology > Robotics');
    expect(newItemId(list, 'Technology')).toBe('technology-2');
    expect(newItemId(list, 'Jinan / Shandong')).toBe('jinan-shandong');
    expect(newItemId(list, '济南')).toBe('济南');
  });

  test('ED-8 renaming a family or an era renames the entry and a title that contains the name', () => {
    expect(
      derivedRename('families', { _id: 'F', name: 'Hale', title: 'Hale family' }, 'Hale-Doyle'),
    ).toEqual({
      collection: 'families',
      id: 'F',
      patch: { name: 'Hale-Doyle', title: 'Hale-Doyle family' },
    });
    expect(
      derivedRename('eraRanges', { _id: 'E', name: 'Late twenties', title: 'Other' }, 'Hinge')
        .patch,
    ).toEqual({
      name: 'Hinge',
    });
  });
});
