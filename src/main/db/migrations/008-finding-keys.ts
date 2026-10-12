import type { BibleHandle } from '../bibles';
import type { Migration } from './types';

/**
 * M8 alignment check (CC-2 to CC-4): a finding is found again on every run
 * by its stable key, so the key is indexed. Findings written before this
 * version have no key, so a re-run could never match, refresh, or trash them:
 * they are moved to the trash here, and the next check records them again.
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
    const at = new Date().toISOString();
    await bible.collection('findings').updateMany(
      {
        deletedAt: { $in: [null, undefined] },
        $or: [{ key: { $exists: false } }, { key: null }, { key: '' }],
      } as never,
      { $set: { deletedAt: at, modifiedAt: at } } as never,
    );
  },
};
