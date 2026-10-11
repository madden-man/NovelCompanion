import type { BibleHandle } from '../bibles';
import type { Migration } from './types';

/**
 * Which source gave each imported field its value, and when that source was
 * last modified (IM-7). One document per entry, keyed by the entry's ID.
 */
export const importSources: Migration = {
  version: 6,
  name: 'import source records per entry',
  async up(bible: BibleHandle) {
    const existing = new Set(await bible.collectionNames());
    if (!existing.has('importSources')) {
      await bible.db.createCollection(bible.qualified('importSources'));
    }
  },
};
