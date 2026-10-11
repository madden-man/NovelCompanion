import type { BibleHandle } from '../bibles';
import type { Migration } from './types';

/**
 * Saved question-panel conversations (AI-1), newest first. Matches the
 * version 7 the East Winds bible already carries in Atlas.
 */
export const conversations: Migration = {
  version: 7,
  name: 'question panel conversations',
  async up(bible: BibleHandle) {
    const existing = new Set(await bible.collectionNames());
    if (!existing.has('conversations')) {
      await bible.db.createCollection(bible.qualified('conversations'));
    }
    await bible.collection('conversations').createIndex({ modifiedAt: -1 });
  },
};
