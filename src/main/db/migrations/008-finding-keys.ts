import type { BibleHandle } from '../bibles';
import type { Migration } from './types';

/**
 * M8 alignment check (CC-2 to CC-4): a finding is found again on every run
 * by its stable key, so the key is indexed. Findings written before this
 * version have no key and take the schema defaults on their next write; a
 * re-run creates keyed findings beside them.
 */
export const findingKeys: Migration = {
  version: 8,
  name: 'finding keys for re-runs and dismissals',
  async up(bible: BibleHandle) {
    const existing = new Set(await bible.collectionNames());
    if (!existing.has('findings')) {
      await bible.db.createCollection(bible.qualified('findings'));
    }
    await bible.collection('findings').createIndex({ key: 1 });
  },
};
