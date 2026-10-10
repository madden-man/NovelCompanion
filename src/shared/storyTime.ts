import { z } from 'zod';
import { Year } from './schema/common';

/**
 * The current story time (TM-1, TM-3): a year or a full date. It lives in the
 * bible's `meta` collection, never in an entry, so setting it changes no entry
 * (TM-5). M2 stores and reads it; M3 adds the dialog, anchors, and status bar.
 */
export const StoryTimeValue = z.strictObject({
  year: Year,
  month: z.int().min(1).max(12).optional(),
  day: z.int().min(1).max(31).optional(),
});
export type StoryTimeValue = z.infer<typeof StoryTimeValue>;
