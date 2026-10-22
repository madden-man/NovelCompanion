/**
 * IPC channels for housekeeping (IP-16) and the manuscript lock (IP-18),
 * branch a47-guard. Kept apart from `ipc.ts`, which spreads this object into
 * its contract, so every rule there (zod on both sides, preload validation)
 * applies. The Claude channels of the same branch (instructions, conversation
 * rename, clear and delete) are in `claude.ts` with the other Claude channels.
 */
import { z } from 'zod';
import { ENTRY_COLLECTIONS } from './schema';
import type { EntryCollection } from './schema';
import { sessionContract } from './ipcSession';

const Collection = z.enum(ENTRY_COLLECTIONS as [EntryCollection, ...EntryCollection[]]);
const EntryId = z.string().min(1).max(64);
const Entry = z.looseObject({ _id: z.string().min(1), modifiedAt: z.string() });

/** What a purge removed: entries and their revisions. */
const PurgeCounts = z.strictObject({ entries: z.int().min(0), revisions: z.int().min(0) });

export const guardContract = {
  /**
   * IP-16: delete one entry in the trash forever, with its revisions, in one
   * transaction. Refused for an entry not in the trash. Not an undo step; a
   * snapshot is taken first.
   */
  'entry.purge': {
    request: z.strictObject({ collection: Collection, id: EntryId }),
    response: PurgeCounts,
  },
  /** IP-16: delete every entry in the trash forever, in one transaction. Not an undo step. */
  'trash.empty': {
    request: z.strictObject({}),
    response: PurgeCounts,
  },
  /**
   * IP-16: remove the revisions written before a date, for one entry
   * (collection and id) or the whole bible (neither). `dryRun` only counts
   * them, for the count shown before confirming. Not an undo step.
   */
  'revisions.prune': {
    request: z
      .strictObject({
        collection: Collection.optional(),
        id: EntryId.optional(),
        before: z.union([z.iso.date(), z.iso.datetime({ offset: true })]),
        dryRun: z.boolean().default(false),
      })
      .refine((r) => !r.id || r.collection, {
        message: 'Say which section the entry is in.',
        path: ['collection'],
      }),
    response: z.strictObject({ count: z.int().min(0) }),
  },
  /**
   * IP-18, MS-1, MS-4: read a chapter again from its linked manuscript and
   * store the text when it changed, in one call. Returns the comparison the
   * Manuscript tab shows, whether it was stored, and the chapter after.
   */
  'manuscript.reimport': {
    request: z.strictObject({ chapterId: EntryId }),
    response: sessionContract['manuscript.read'].response.omit({ token: true }).extend({
      applied: z.boolean(),
      entry: Entry,
      /** The stored manuscript fields before the re-import, empty when nothing changed. */
      before: z.record(z.string(), z.unknown()),
    }),
  },
} as const;
