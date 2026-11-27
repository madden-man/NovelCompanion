import type { BibleHandle } from '../bibles';
import type { Migration } from './types';

/**
 * A58 U5 (schema version 17, PH-20, PH-28): the `meta` document
 * `phoneWaits`, the sentences caught on the phone that wait for the desk
 * (`src/shared/phoneWaits.ts`). It is written on the first keep, so the
 * migration writes nothing; it exists so a side that lags sees a version
 * mismatch instead of a document it cannot read. Running it again changes
 * nothing.
 */
export const phoneWaits: Migration = {
  version: 17,
  name: 'phone waits: sentences from the phone that wait for the desk',
  async up(_bible: BibleHandle) {
    // Nothing to write: the document appears with the first sentence kept.
  },
};
