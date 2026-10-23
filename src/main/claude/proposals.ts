import { plainErrorMessage } from '../../shared/errors';
import { z } from 'zod';
import {
  ENTRY_COLLECTIONS,
  ListRef,
  MINTABLE_LISTS,
  entrySchemas,
  entryTitle,
  isEntryCollection,
} from '../../shared/schema';
import type { EntryCollection } from '../../shared/schema';
import type { OpenBible } from '../db/session';

/**
 * AI-3: Claude never writes to the bible. What it suggests is a proposal
 * draft; `queueDraft` checks it against the schema and the entries as they
 * are now, and puts it in the review queue through `Repository.propose`.
 * A draft that fails is reported with its reason, never silently dropped.
 */
export const ProposalDraft = z.strictObject({
  op: z.enum(['create', 'update', 'delete', 'link', 'listAdd']),
  /** The section of the entry. Every kind but listAdd needs it. */
  collection: z.enum(ENTRY_COLLECTIONS as [EntryCollection, ...EntryCollection[]]).optional(),
  /** The entry to change, delete, or link from. Absent for a create. */
  targetId: z.string().min(1).max(64).nullable().optional(),
  /** Create: the new entry's fields. Update: only the fields to change. */
  data: z.record(z.string(), z.unknown()).optional(),
  /** Link: the entry to link to and the kind of link. */
  link: z
    .strictObject({ targetId: z.string().min(1).max(64), kind: z.string().min(1).max(64) })
    .optional(),
  /** IP-17, listAdd: the list to add an item to. */
  listId: z.enum(MINTABLE_LISTS).optional(),
  /** IP-17, listAdd: the new item's name. */
  label: z.string().min(1).max(200).optional(),
  /** IP-17, listAdd: the item it goes under, in a list with levels. */
  parentId: z.string().min(1).max(64).nullable().optional(),
  /** IP-17, listAdd: the ref the entries in the same set use for the new item, for example new:jinan. */
  ref: ListRef.optional(),
  reason: z.string().max(2000),
});
export type ProposalDraft = z.infer<typeof ProposalDraft>;

const SYSTEM = new Set(['_id', 'createdAt', 'modifiedAt', 'deletedAt']);
const strip = (data: Record<string, unknown> = {}) =>
  Object.fromEntries(Object.entries(data).filter(([k]) => !SYSTEM.has(k)));

export function draftSummary(d: ProposalDraft): string {
  if (d.op === 'listAdd') return `add to ${d.listId ?? 'a list'}: ${d.label ?? ''}`.trim();
  const what = d.op === 'create' ? entryTitle(d.data) : (d.targetId ?? 'an entry');
  return `${d.op} ${d.collection ?? 'an unnamed section'}: ${what}`;
}

type Checked =
  | {
      ok: true;
      input: {
        op: 'create' | 'update' | 'delete' | 'listAdd';
        collection: EntryCollection | 'lists';
        targetId: string | null;
        data: Record<string, unknown>;
        listAdd?: { listId: string; label: string; parentId: string | null; ref: string };
      };
    }
  | { ok: false; reason: string };

function problems(error: z.ZodError): string {
  return error.issues
    .slice(0, 4)
    .map((i) => `${i.path.join('.') || 'entry'}: ${i.message}`)
    .join('; ');
}

/** Check a draft against the schema and the read model. Pure apart from reading the model. */
export function checkDraft(session: OpenBible, draft: ProposalDraft, now: Date): Checked {
  const { model } = session;
  if (draft.op === 'listAdd') return checkListAdd(session, draft);
  const c = draft.collection;
  if (!c || !isEntryCollection(c)) {
    return { ok: false, reason: `There is no section called ${c ?? '(none given)'}.` };
  }
  const stamp = now.toISOString();
  if (draft.op === 'create') {
    const data = strip(draft.data);
    if (entryTitle(data) === 'Untitled') return { ok: false, reason: 'A new entry needs a title.' };
    if (data.status === undefined) data.status = 'idea';
    const result = entrySchemas[c].safeParse({
      ...data,
      _id: 'CHECK',
      createdAt: stamp,
      modifiedAt: stamp,
    });
    if (!result.success)
      return { ok: false, reason: `The new entry is not valid: ${problems(result.error)}` };
    return { ok: true, input: { op: 'create', collection: c, targetId: null, data } };
  }
  const targetId = draft.targetId ?? '';
  const target = targetId ? model.get(c, targetId) : undefined;
  if (!target || target.deletedAt)
    return { ok: false, reason: `No ${c} entry has the ID ${targetId || '(none given)'}.` };
  if (draft.op === 'delete') {
    return { ok: true, input: { op: 'delete', collection: c, targetId, data: {} } };
  }
  if (draft.op === 'link') {
    if (!draft.link) return { ok: false, reason: 'A link proposal needs the entry to link to.' };
    const to = model.find(draft.link.targetId);
    if (!to || to.doc.deletedAt)
      return { ok: false, reason: `No entry has the ID ${draft.link.targetId}.` };
    const links = Array.isArray(target.links)
      ? (target.links as { targetId: string; kind: string }[])
      : [];
    if (links.some((l) => l.targetId === draft.link?.targetId && l.kind === draft.link.kind)) {
      return { ok: false, reason: 'That link is already there.' };
    }
    return {
      ok: true,
      input: { op: 'update', collection: c, targetId, data: { links: [...links, draft.link] } },
    };
  }
  const data = strip(draft.data);
  if (Object.keys(data).length === 0) return { ok: false, reason: 'The change has no fields.' };
  const result = entrySchemas[c].safeParse({ ...target, ...data });
  if (!result.success)
    return { ok: false, reason: `The change is not valid: ${problems(result.error)}` };
  return { ok: true, input: { op: 'update', collection: c, targetId, data } };
}

/** IP-17: a new list item, checked against the list as it is now. */
function checkListAdd(session: OpenBible, draft: ProposalDraft): Checked {
  const { listId, ref } = draft;
  const label = draft.label?.trim() ?? '';
  if (!listId || !label || !ref) {
    return { ok: false, reason: 'A new list item needs listId, label and ref.' };
  }
  const list = session.model.get('lists', listId);
  if (!list) return { ok: false, reason: `This bible has no ${listId} list.` };
  const items = Array.isArray(list.items) ? (list.items as { id: string; label: string }[]) : [];
  const same = items.find((i) => i.label.toLowerCase() === label.toLowerCase());
  if (same) {
    return {
      ok: false,
      reason: `The list already has ${same.label} (ID ${same.id}). Use that ID instead.`,
    };
  }
  return {
    ok: true,
    input: {
      op: 'listAdd',
      collection: 'lists',
      targetId: null,
      data: {},
      listAdd: { listId, label, parentId: draft.parentId ?? null, ref },
    },
  };
}

/** Check and queue one draft. Returns the proposal ID, or why it was not queued. */
export async function queueDraft(
  session: OpenBible,
  draft: ProposalDraft,
  label: string,
  now: Date,
): Promise<{ ok: true; proposalId: string } | { ok: false; summary: string; reason: string }> {
  const checked = checkDraft(session, draft, now);
  if (!checked.ok) return { ok: false, summary: draftSummary(draft), reason: checked.reason };
  try {
    const proposal = await session.repo.propose({
      source: 'claude',
      ...checked.input,
      reason: `${draft.reason.trim()} (Claude, ${label})`.trim(),
    });
    // IP-18: a proposal refused as it was made is kept with its reason, not queued.
    if (proposal.refusal) {
      return { ok: false, summary: draftSummary(draft), reason: proposal.refusal };
    }
    return { ok: true, proposalId: proposal._id };
  } catch (e) {
    return {
      ok: false,
      summary: draftSummary(draft),
      reason: plainErrorMessage(e),
    };
  }
}

/** Every section ID, for tool descriptions. */
export const SECTION_IDS = ENTRY_COLLECTIONS;
