import { z } from 'zod';

/**
 * A58 (PH-6 to PH-11): one number per bible. Every write raises the `rev`
 * counter in the bible's `meta`; a process that finds it moved by someone
 * else reloads the bible.
 */

/** The `meta` document that holds the counter. */
export const REV_META_ID = 'rev';

/** The stored shape of the counter (schema version 16). */
export const RevDoc = z.strictObject({
  _id: z.literal(REV_META_ID),
  rev: z.int().min(0),
});
export type RevDoc = z.infer<typeof RevDoc>;

/** PH-8: how often the desktop checks while its window is in front. */
export const FRESHEN_EVERY_MS = 20_000;

/** PH-8: what a reload made because the bible changed somewhere else says. */
export const ELSEWHERE_MESSAGE = 'Changes made somewhere else are shown.';

/** PH-11: a write planned against an entry that has since changed somewhere else. */
export const ENTRY_MOVED_MESSAGE = 'This entry changed somewhere else, so nothing was written.';
