import { z } from 'zod';

/** Entry IDs are ULIDs for new entries. Fixture and imported IDs may be any short safe string. */
export const Id = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, 'IDs use letters, digits, dashes, and underscores only');
export type Id = z.infer<typeof Id>;

export const Year = z.int().min(-10000).max(10000);

/** A full date, a year, or unknown (ARCHITECTURE rule 6). */
export const StoryDate = z.union([
  z.strictObject({
    year: Year,
    month: z.int().min(1).max(12).optional(),
    day: z.int().min(1).max(31).optional(),
  }),
  z.strictObject({ unknown: z.literal(true) }),
]);
export type StoryDate = z.infer<typeof StoryDate>;

/** A53 shim, wave 3 deletes it. Was the item ID in the removed `statuses` list. */
export const Status = z.string().min(1).max(64);
export type Status = z.infer<typeof Status>;

/** A53 shim, wave 3 deletes it. Was the item ID in the removed `provenance` list. */
export const Provenance = z.string().min(1).max(64);
export type Provenance = z.infer<typeof Provenance>;

/** A53 shim, wave 3 deletes it. Was the removed `{ targetId, kind }` link. */
export const Link = z.strictObject({
  targetId: Id,
  kind: z.string().min(1).max(64),
});
export type Link = z.infer<typeof Link>;

export const Timestamp = z.iso.datetime({ offset: true });

/** Fields every entry shares (SPEC section 4, top paragraph). */
export const EntryBase = z.strictObject({
  _id: Id,
  title: z.string().max(500),
  /** Rich text, stored as sanitized HTML. */
  body: z.string().default(''),
  createdAt: Timestamp,
  modifiedAt: Timestamp,
  /** Set when the entry is in the trash; absent otherwise (ARCHITECTURE rule 5). */
  deletedAt: Timestamp.optional(),
});
export type EntryBase = z.infer<typeof EntryBase>;

/** Build an entity schema from the shared entry fields plus its own fields. */
export function entry<Shape extends z.ZodRawShape>(shape: Shape) {
  return EntryBase.extend(shape);
}

/**
 * An optional year range, used by era states, cultural entries, and places
 * lived. An end before the start is a warning (ED-10), never a rejection.
 */
export const YearRange = z.strictObject({ startYear: Year.nullable(), endYear: Year.nullable() });

/** A real-world calendar date, YYYY-MM-DD, for session logs. */
export const CalendarDate = z.iso.date();
