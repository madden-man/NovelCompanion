import { describe, expect, test } from 'vitest';
import { manifests } from '../../src/shared/schema';
import type { ListDoc } from '../../src/shared/schema';
import {
  countListUsage,
  derivedRename,
  itemPath,
  newItemId,
  renameCascade,
  tagsUsed,
} from '../../src/shared/domain/lists';
import { customFieldSpecs } from '../../src/shared/schema';

const section = {
  _id: 'S',
  fields: [{ id: 'flavor', label: 'Flavors', type: 'tags' as const, options: [] }],
};
const custom = (id: string) => (id === 'S' ? customFieldSpecs(section) : undefined);

const docs = () => [
  {
    collection: 'characters',
    manifest: manifests.characters,
    docs: [
      { _id: 'A', tags: ['matriarch', 'teacher'] },
      { _id: 'B', tags: ['teacher'] },
      { _id: 'C', tags: [] },
    ],
  },
  {
    collection: 'unions',
    manifest: manifests.unions,
    docs: [
      { _id: 'U1', tags: [], type: 'married' },
      { _id: 'U2', tags: ['teacher'], type: 'partnered' },
    ],
  },
  {
    collection: 'customEntries',
    manifest: manifests.customEntries,
    docs: [{ _id: 'E', sectionId: 'S', tags: [], values: { flavor: ['teacher', 'sweet'] } }],
  },
];

describe('ED-8 list rename cascade', () => {
  test('ED-8 renaming a tag rewrites it on every entry that carries it, including custom tag fields', () => {
    expect(renameCascade('tags', 'teacher', 'educator', docs(), custom)).toEqual([
      { collection: 'characters', id: 'A', patch: { tags: ['matriarch', 'educator'] } },
      { collection: 'characters', id: 'B', patch: { tags: ['educator'] } },
      { collection: 'unions', id: 'U2', patch: { tags: ['educator'] } },
      {
        collection: 'customEntries',
        id: 'E',
        patch: { values: { flavor: ['educator', 'sweet'] } },
      },
    ]);
  });

  test('ED-8 renaming a tag onto one an entry already has merges them', () => {
    expect(renameCascade('tags', 'teacher', 'matriarch', docs(), custom)[0]).toEqual({
      collection: 'characters',
      id: 'A',
      patch: { tags: ['matriarch'] },
    });
  });

  test('ED-8 lists stored by item ID need no entry changes; the new label shows everywhere at once', () => {
    expect(renameCascade('unionTypes', 'Married', 'Wed', docs(), custom)).toEqual([]);
    expect(renameCascade('tags', 'teacher', 'teacher', docs(), custom)).toEqual([]);
  });

  test('ED-8 usage counts entries by item ID for lists and by label for tags', () => {
    const all = docs();
    expect(
      countListUsage('unionTypes', { id: 'married', label: 'Married', parentId: null }, all),
    ).toBe(1);
    expect(countListUsage('tags', { id: 't', label: 'teacher', parentId: null }, all, custom)).toBe(
      4,
    );
    expect(countListUsage('tags', { id: 'n', label: 'nobody', parentId: null }, all, custom)).toBe(
      0,
    );
  });

  test('ED-8 tags used are collected from entry tags and custom tag fields', () => {
    expect(tagsUsed(manifests.customEntries, docs()[2]!.docs[0]!, custom)).toEqual([
      'teacher',
      'sweet',
    ]);
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

  test('ED-8 renaming a family, a section, or an era renames the entry and a title that contains the name', () => {
    expect(
      derivedRename('families', { _id: 'F', name: 'Hale', title: 'Hale family' }, 'Hale-Doyle'),
    ).toEqual({
      collection: 'families',
      id: 'F',
      patch: { name: 'Hale-Doyle', title: 'Hale-Doyle family' },
    });
    expect(derivedRename('sectionNames', { _id: 'S', name: 'Recipes' }, 'Family recipes')).toEqual({
      collection: 'customSections',
      id: 'S',
      patch: { name: 'Family recipes' },
    });
    expect(
      derivedRename('eraRanges', { _id: 'E', name: 'Late twenties', title: 'Other' }, 'Hinge')
        .patch,
    ).toEqual({
      name: 'Hinge',
    });
  });
});
