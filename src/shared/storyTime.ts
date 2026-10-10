import { z } from 'zod';
import { Id, Year } from './schema/common';

/**
 * The current story time (TM-1, TM-3): a year or a full date, and optionally
 * the chapter and strand being written. It lives in the bible's `meta`
 * collection, never in an entry, so setting it changes no entry (TM-5).
 */
export const StoryTimeValue = z
  .strictObject({
    year: Year,
    month: z.int().min(1).max(12).optional(),
    day: z.int().min(1).max(31).optional(),
    chapterId: Id.optional(),
    strandId: Id.optional(),
  })
  .refine((v) => v.day === undefined || v.month !== undefined, {
    message: 'A day needs a month.',
    path: ['day'],
  })
  .refine((v) => v.strandId === undefined || v.chapterId !== undefined, {
    message: 'A strand needs its chapter.',
    path: ['strandId'],
  });
export type StoryTimeValue = z.infer<typeof StoryTimeValue>;
