import type { Document } from 'mongodb';
import { REV_META_ID } from '../../../shared/freshness';
import type { BibleHandle } from '../bibles';
import type { Migration } from './types';

/**
 * A58 (schema version 16, PH-6, PH-20): the `meta` document `rev`, the one
 * number every write raises, starting at 0. A counter already there is left
 * as it is, so running it again changes nothing. No snapshot: it adds one
 * small document and changes nothing else.
 */
export const revCounter: Migration = {
  version: 16,
  name: 'rev: the number every write raises',
  async up(bible: BibleHandle) {
    await bible
      .collection('meta')
      .updateOne({ _id: REV_META_ID } as Document, { $setOnInsert: { rev: 0 } }, { upsert: true });
  },
};
