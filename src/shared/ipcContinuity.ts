/**
 * IPC channels for the alignment check (M8: CC-1 to CC-5). Kept apart from
 * `ipc.ts`, which spreads this object into its contract, so every rule there
 * (zod on both sides, preload validation) applies. The Claude half of the
 * check is `claude.alignment` in `claude.ts`, beside the other features.
 */
import { z } from 'zod';

const EntryId = z.string().min(1).max(64);
const Entry = z.looseObject({ _id: z.string().min(1), modifiedAt: z.string() });

export const FindingState = z.enum(['open', 'manuscriptWins', 'rewrite', 'dismissed']);

/** A finding as the alignment screens show it: lines quoted, entries named, the change set as a diff. */
export const FindingWire = z.strictObject({
  id: z.string(),
  key: z.string(),
  kind: z.enum(['structural', 'alignment']),
  check: z.string(),
  /** The check or kind in plain words. */
  label: z.string(),
  chapterId: z.string().nullable(),
  chapter: z.string().nullable(),
  readingOrder: z.int().nullable(),
  strandId: z.string().nullable(),
  storyYear: z.int().nullable(),
  title: z.string(),
  text: z.string(),
  lines: z.array(z.strictObject({ n: z.int(), text: z.string() })),
  lineStart: z.int().nullable(),
  lineEnd: z.int().nullable(),
  /** True when the chapter text changed since the finding was made, so the line numbers may have moved. */
  textChanged: z.boolean(),
  entries: z.array(
    z.strictObject({
      collection: z.string(),
      id: z.string(),
      title: z.string(),
      found: z.boolean(),
    }),
  ),
  mustChange: z.string(),
  state: FindingState,
  changes: z.array(
    z.strictObject({
      collection: z.string(),
      id: z.string(),
      entry: z.string(),
      field: z.string(),
      label: z.string(),
      before: z.string(),
      after: z.string(),
    }),
  ),
  rejectedChanges: z.array(z.strictObject({ summary: z.string(), reason: z.string() })),
  createdAt: z.string(),
});
export type FindingWire = z.infer<typeof FindingWire>;

export const continuityContract = {
  /**
   * CC-1, CC-2: run the structural checks on one chapter or the whole
   * manuscript (null) and record the findings. Returns the chapters in scope,
   * so the renderer can run the Claude half on each that has text.
   */
  'continuity.check': {
    request: z.strictObject({ chapterId: EntryId.nullable() }),
    response: z.strictObject({
      found: z.int().min(0),
      hidden: z.int().min(0),
      chapters: z.array(
        z.strictObject({
          id: z.string(),
          title: z.string(),
          readingOrder: z.int().nullable(),
          lines: z.int().min(0),
        }),
      ),
    }),
  },
  /** CC-3, CC-4: findings for one chapter or all, by state; dismissed ones are only counted. */
  'continuity.findings': {
    request: z.strictObject({
      chapterId: EntryId.nullable(),
      states: z.array(FindingState).max(4).optional(),
    }),
    response: z.strictObject({ findings: z.array(FindingWire), dismissed: z.int().min(0) }),
  },
  /**
   * CC-4: Manuscript wins (apply the change set after a snapshot, in one
   * transaction), Rewrite recommended (the finding becomes a rewrite task),
   * Dismiss, or Done (a rewrite task is finished; it is dismissed against the
   * text as it is now). Returns each entry before and after, for one undo step.
   */
  'continuity.resolve': {
    request: z.strictObject({
      id: EntryId,
      action: z.enum(['manuscriptWins', 'rewrite', 'dismiss', 'done']),
    }),
    response: z.strictObject({
      finding: FindingWire,
      changes: z.array(
        z.strictObject({ collection: z.string(), id: z.string(), before: Entry, after: Entry }),
      ),
    }),
  },
} as const;
