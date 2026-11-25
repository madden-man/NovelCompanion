import type { BibleHandle } from '../bibles';
import type { Migration } from './types';

/** A55 (NB-4): the collection the notebook pages from the phone land in. */
export const NOTEBOOK_PAGES = 'notebookPages';

/** The indexes the Notebook lists and the bridge's pull read by (NB-4, NB-7). */
export const NOTEBOOK_INDEXES = [
  { key: { characterIds: 1 }, name: 'characterIds_1' },
  { key: { placeIds: 1 }, name: 'placeIds_1' },
  { key: { chapterIds: 1 }, name: 'chapterIds_1' },
  { key: { world: 1, modifiedAt: -1 }, name: 'world_1_modifiedAt_-1' },
] as const;

/**
 * A55 (schema version 15): the `notebookPages` collection and its indexes.
 * Nothing else changes and no document is written, so there is no snapshot
 * and no summary. Running it again changes nothing.
 */
export const notebookPages: Migration = {
  version: 15,
  name: 'notebook pages: the collection the phone notebook lands in',
  async up(bible: BibleHandle) {
    if (!(await bible.collectionNames()).includes(NOTEBOOK_PAGES)) {
      await bible.db.createCollection(bible.qualified(NOTEBOOK_PAGES));
    }
    const pages = bible.collection(NOTEBOOK_PAGES);
    for (const index of NOTEBOOK_INDEXES) {
      await pages.createIndex(index.key, { name: index.name });
    }
  },
};
