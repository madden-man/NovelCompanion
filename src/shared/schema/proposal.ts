import { z } from 'zod';
import { Id, Timestamp } from './common';

/**
 * A change waiting for approval (ED-7, AI-3). Re-import, Claude, and bulk
 * actions write here; nothing reaches the bible until it is approved through
 * `applyProposal`, which records the approval.
 */
export const Proposal = z.strictObject({
  _id: Id,
  source: z.enum(['import', 'claude', 'bulk']),
  op: z.enum(['create', 'update', 'delete']),
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
});
export type Proposal = z.infer<typeof Proposal>;
