import { ENTRY_COLLECTIONS } from '../../../shared/schema';
import type { BibleHandle } from '../bibles';
import { defaultLists } from '../defaultLists';
import type { Migration } from './types';

/** Prefixed collections, indexes, and the default lists every new bible starts with (ARCH-8). */
export const initial: Migration = {
  version: 1,
  name: 'initial collections, indexes, and default lists',
  async up(bible: BibleHandle) {
    const existing = new Set(await bible.collectionNames());
    for (const name of [...ENTRY_COLLECTIONS, 'lists', 'customSections', 'revisions']) {
      if (!existing.has(name)) await bible.db.createCollection(bible.qualified(name));
    }
    await bible.collection('revisions').createIndex({ entryId: 1, at: 1 });
    await bible.collection('revisions').createIndex({ collection: 1 });
    const lists = bible.collection<{ _id: string }>('lists');
    for (const list of defaultLists()) {
      await lists.updateOne({ _id: list._id }, { $setOnInsert: list }, { upsert: true });
    }
  },
};
