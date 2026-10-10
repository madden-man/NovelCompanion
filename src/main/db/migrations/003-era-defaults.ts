import type { BibleHandle } from '../bibles';
import type { Migration } from './types';

/**
 * The default eras every bible starts with (WE-2): decades from 2025 to 2100
 * with no gaps, as a list in the bible's `lists` collection. Item IDs are
 * "start-end" and labels are the era names. A new bible copies them into era
 * states; a bible's own eras (for example from import) replace them.
 * The values are written out here because migrations never change.
 */
const ERA_DEFAULTS = {
  _id: 'eraDefaults',
  label: 'Default eras',
  items: [
    { id: '2025-2029', label: 'The late 2020s', parentId: null },
    { id: '2030-2039', label: 'The 2030s', parentId: null },
    { id: '2040-2049', label: 'The 2040s', parentId: null },
    { id: '2050-2059', label: 'The 2050s', parentId: null },
    { id: '2060-2069', label: 'The 2060s', parentId: null },
    { id: '2070-2079', label: 'The 2070s', parentId: null },
    { id: '2080-2089', label: 'The 2080s', parentId: null },
    { id: '2090-2100', label: 'The 2090s', parentId: null },
  ],
};

export const eraDefaults: Migration = {
  version: 3,
  name: 'default era ranges list',
  async up(bible: BibleHandle) {
    await bible
      .collection<{ _id: string }>('lists')
      .updateOne({ _id: ERA_DEFAULTS._id }, { $setOnInsert: ERA_DEFAULTS }, { upsert: true });
  },
};
