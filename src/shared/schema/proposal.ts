import { z } from 'zod';
import { Id, Timestamp } from './common';

/**
 * IP-17: a new list item a proposal set names before it exists, such as
 * `new:jinan`. Entries in the same set use it as the value of a list field;
 * approval swaps in the item's real ID.
 */
export const ListRef = z
  .string()
  .regex(/^new:[A-Za-z0-9_-]{1,60}$/, 'A new list item ref looks like new:jinan.');
export type ListRef = z.infer<typeof ListRef>;

/** IP-17: the lists a proposal may add an item to. */
export const MINTABLE_LISTS = [
  'communities',
  'eventCategories',
  'regions',
  'languages',
] as const;

/** IP-17: what a `listAdd` proposal adds. */
export const ListAddProposal = z.strictObject({
  listId: z.string().min(1).max(64),
  label: z.string().trim().min(1, 'A list item needs a name.').max(200),
  parentId: z.string().min(1).max(64).nullable().default(null),
  ref: ListRef,
});
export type ListAddProposal = z.infer<typeof ListAddProposal>;

/**
 * A change waiting for approval (ED-7, AI-3). Re-import, Claude, and bulk
 * actions write here; nothing reaches the bible until it is approved through
 * `applyProposal`, which records the approval.
 */
export const Proposal = z.strictObject({
  _id: Id,
  source: z.enum(['import', 'claude', 'bulk']),
  /** IP-17: `listAdd` adds an item to a list (its collection is `lists`). */
  op: z.enum(['create', 'update', 'delete', 'listAdd']),
  collection: z.string().min(1),
  /** The entry to change or delete; for a create, the ID to use if given. */
  targetId: Id.nullable().default(null),
  /** The full entry for a create, or the fields to change for an update. */
  data: z.record(z.string(), z.unknown()).default({}),
  /** The target's `modifiedAt` when the proposal was made, so a later edit shows as a conflict. */
  baseModifiedAt: Timestamp.nullable().default(null),
  reason: z.string().default(''),
  state: z.enum(['pending', 'approved', 'rejected']).default('pending'),
  createdAt: Timestamp,
  decidedAt: Timestamp.nullable().default(null),
  /** True when the person edited the proposal before approving it. */
  edited: z.boolean().default(false),
  appliedEntryId: Id.nullable().default(null),
  /** IP-17: the item a `listAdd` proposal adds; null on every other kind. */
  listAdd: ListAddProposal.nullable().default(null),
  /** IP-17: the new list items this proposal's values name, each with the `listAdd` proposal that adds it. */
  uses: z.array(z.strictObject({ ref: ListRef, proposalId: Id })).default([]),
  /** IP-17: the ID of the list item an approved `listAdd` proposal created. */
  appliedItemId: z.string().nullable().default(null),
  /** IP-17: true when the list already had the item at approval, so nothing was added (and undo removes nothing). */
  appliedItemExisted: z.boolean().default(false),
  /** IP-18: why the proposal was rejected as it was made, or null. */
  refusal: z.string().nullable().default(null),
});
export type Proposal = z.infer<typeof Proposal>;
