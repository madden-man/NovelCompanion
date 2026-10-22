/**
 * Capture (KB-6, KB-7, CR-6, CR-9): filing what Claude proposed from the
 * Cmd+K box, filing the router's Route A drafts without Claude, and the open
 * question the box saves when Claude cannot run. Pure apart from the `invoke`
 * it is given, so the integration suite drives the same logic the renderer
 * uses, through the same channels.
 */
import { entryTitle, isEntryCollection } from '../schema';
import type { EntryCollection } from '../schema';
import type { Channel, Request, Response } from '../ipc';
import { plainErrorMessage } from '../errors';
import { patchBetween } from './diff';
import type { Op, UndoCommand } from './undoRunner';
import { listAddCommand } from '../undoCommands';
import { localSourceNote } from './captureRouter/types';
import type { CaptureDraft } from './captureRouter/types';

type Invoke = <C extends Channel>(channel: C, request: Request<C>) => Promise<Response<C>>;

/** A proposal as the box shows it: enough to approve it and undo the approval. */
export interface CaptureProposal {
  id: string;
  /** IP-17: `listAdd` adds a list item; its collection is `lists`. */
  op: 'create' | 'update' | 'delete' | 'listAdd';
  collection: EntryCollection;
  targetId: string | null;
}

export interface FiledEntry {
  collection: EntryCollection;
  id: string;
  title: string;
  op: Exclude<CaptureProposal['op'], 'listAdd'>;
}

export interface Filing {
  filed: FiledEntry[];
  /** IP-17: the names of the list items the filing added. */
  minted: string[];
  rejected: string[];
  /** Proposals that could not be approved or rejected, with why; they stay pending. */
  failed: { id: string; message: string }[];
  /** The whole filing as one undo step (ED-3), or null when nothing was approved. */
  command: UndoCommand | null;
}

/**
 * KB-6 "File it": approve the ticked proposals through `applyProposal`, in
 * order, then reject the unticked ones. Each approval's inverse is recorded,
 * and the whole filing becomes one undo step. One that fails (a conflict, a
 * lost connection) is reported and left pending; the rest still file.
 */
export async function fileCapture(
  invoke: Invoke,
  ticked: readonly CaptureProposal[],
  unticked: readonly CaptureProposal[],
): Promise<Filing> {
  const filed: FiledEntry[] = [];
  const failed: Filing['failed'] = [];
  const undo: Op[][] = [];
  const redo: Op[] = [];
  const get = async (collection: EntryCollection, id: string) =>
    (await invoke('entry.get', { collection, id })).entry;
  const minted: string[] = [];
  const rejected: string[] = [];
  const reject = async (p: CaptureProposal) => {
    try {
      await invoke('proposal.reject', { id: p.id });
      rejected.push(p.id);
    } catch (e) {
      failed.push({ id: p.id, message: plainErrorMessage(e) });
    }
  };
  // IP-17: an unticked new list item is rejected first, so an entry that uses it is not filed with it.
  for (const p of unticked) if (p.op === 'listAdd') await reject(p);

  // New list items are approved before the entries that use them.
  const order = [
    ...ticked.filter((p) => p.op === 'listAdd'),
    ...ticked.filter((p) => p.op !== 'listAdd'),
  ];
  for (const p of order) {
    if (p.op === 'listAdd') {
      try {
        const { proposal } = await invoke('proposal.approve', { id: p.id });
        const add = proposal.listAdd;
        if (!add || !proposal.appliedItemId) throw new Error('The approval did not add the item.');
        // The list had this item already: nothing was added, so undo must not take it out.
        if (proposal.appliedItemExisted) continue;
        const lists = (await invoke('lists.get', {})).lists;
        const label = lists.find((l) => l._id === add.listId)?.label ?? add.listId;
        const item = { id: proposal.appliedItemId, label: add.label, parentId: add.parentId };
        const step = listAddCommand(invoke, label, add.listId, item);
        undo.push(step.undo);
        redo.push(...step.redo);
        minted.push(add.label);
      } catch (e) {
        failed.push({ id: p.id, message: plainErrorMessage(e) });
      }
      continue;
    }
    try {
      const before = p.targetId && p.op !== 'create' ? await get(p.collection, p.targetId) : null;
      const { proposal } = await invoke('proposal.approve', { id: p.id });
      const id = proposal.appliedEntryId ?? p.targetId;
      if (!id) throw new Error('The approval did not say which entry it changed.');
      const after = await get(p.collection, id);
      filed.push({ collection: p.collection, id, title: entryTitle(after), op: p.op });
      if (p.op === 'create') {
        undo.push([{ kind: 'delete', collection: p.collection, id }]);
        redo.push({ kind: 'restore', collection: p.collection, id });
      } else if (p.op === 'delete') {
        undo.push([{ kind: 'restore', collection: p.collection, id }]);
        redo.push({ kind: 'delete', collection: p.collection, id });
      } else if (before) {
        const { forward, backward } = patchBetween(before, after);
        if (Object.keys(forward).length) {
          undo.push([
            { kind: 'update', collection: p.collection, id, patch: backward, expect: forward },
          ]);
          redo.push({
            kind: 'update',
            collection: p.collection,
            id,
            patch: forward,
            expect: backward,
          });
        }
      }
    } catch (e) {
      failed.push({ id: p.id, message: plainErrorMessage(e) });
    }
  }

  for (const p of unticked) if (p.op !== 'listAdd') await reject(p);

  const command: UndoCommand | null =
    filed.length || minted.length
      ? {
          label: filingLabel([...filed.map((f) => f.title), ...minted]),
          // Undo in reverse, so a change to an entry made in this filing is undone before the entry goes.
          undo: undo.reverse().flat(),
          redo,
        }
      : null;
  return { filed, minted, rejected, failed, command };
}

function filingLabel(names: readonly string[]): string {
  return names.length <= 2
    ? `Filed a capture: ${names.join(' and ')}`
    : `Filed a capture: ${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
}

/** Put the minted item IDs where a draft names a new item by its ref (IP-17). */
function withRefs(value: unknown, refs: ReadonlyMap<string, string>): unknown {
  if (typeof value === 'string') return refs.get(value) ?? value;
  if (Array.isArray(value)) return value.map((v) => withRefs(v, refs));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, withRefs(v, refs)]),
    );
  }
  return value;
}

/**
 * CR-6 "File it" for Route A: write the router's ticked drafts through the
 * entry and list channels, without Claude. New list items first (IP-17), each
 * `ref` replaced by the minted ID; every entry gets the bible's idea status
 * and the source note "From a capture on <date>, filed without Claude." The
 * whole filing is one undo step (ED-3). A list that already holds an item of
 * that name (in any case) gives its ID and adds nothing, so undo leaves it. A
 * draft that cannot be written is reported in `failed` (its `id` is
 * "draft <n>", its place in `drafts`) and the rest still file; an entry that
 * names a new item that could not be added is not written.
 */
export async function fileLocalDrafts(
  invoke: Invoke,
  drafts: readonly CaptureDraft[],
  capturedOn: string,
  /** A47 (IP-9): the bible's first status of kind idea (`defaultStatus`). */
  status = 'idea',
): Promise<Filing> {
  const filed: FiledEntry[] = [];
  const failed: Filing['failed'] = [];
  const undo: Op[][] = [];
  const redo: Op[] = [];
  const minted: string[] = [];
  const refs = new Map<string, string>();
  const lost = new Set<string>();
  const numbered = drafts.map((d, i) => ({ d, id: `draft ${i}` }));

  const adds = numbered.filter(({ d }) => d.op === 'listAdd');
  let lists: { _id: string; label: string; items: { id: string; label: string }[] }[] = adds.length
    ? (await invoke('lists.get', {})).lists
    : [];
  for (const { d, id } of adds) {
    try {
      if (!d.listId || !d.label) throw new Error('A new list item needs a list and a name.');
      const list = lists.find((l) => l._id === d.listId);
      const name = d.label.trim();
      const have = list?.items.find((i) => i.label.toLowerCase() === name.toLowerCase());
      if (have) {
        if (d.ref) refs.set(d.ref, have.id);
        continue;
      }
      const parentId = d.parentId ?? null;
      const { item } = await invoke('lists.addItem', {
        listId: d.listId as never,
        label: name,
        parentId,
      });
      if (d.ref) refs.set(d.ref, item.id);
      const step = listAddCommand(invoke, list?.label ?? d.listId, d.listId, {
        id: item.id,
        label: item.label,
        parentId,
      });
      undo.push(step.undo);
      redo.push(...step.redo);
      minted.push(item.label);
      lists = lists.map((l) => (l._id === d.listId ? { ...l, items: [...l.items, item] } : l));
    } catch (e) {
      if (d.ref) lost.add(d.ref);
      failed.push({ id, message: plainErrorMessage(e) });
    }
  }

  for (const { d, id } of numbered) {
    if (d.op === 'listAdd') continue;
    try {
      if (d.op !== 'create' || !d.collection || !isEntryCollection(d.collection)) {
        throw new Error('The box files only new entries; Claude handles changes.');
      }
      const missingItem = [...lost].find((ref) => JSON.stringify(d.data ?? {}).includes(ref));
      if (missingItem) throw new Error('The new list item it uses could not be added.');
      const data = {
        ...(withRefs(d.data ?? {}, refs) as Record<string, unknown>),
        status,
        sourceNote: localSourceNote(capturedOn),
      };
      const { entry } = await invoke('entry.create', { collection: d.collection, data });
      filed.push({
        collection: d.collection,
        id: entry._id,
        title: entryTitle(entry),
        op: 'create',
      });
      undo.push([{ kind: 'delete', collection: d.collection, id: entry._id }]);
      redo.push({ kind: 'restore', collection: d.collection, id: entry._id });
    } catch (e) {
      failed.push({ id, message: plainErrorMessage(e) });
    }
  }

  const command: UndoCommand | null =
    filed.length || minted.length
      ? {
          label: filingLabel([...filed.map((f) => f.title), ...minted]),
          undo: undo.reverse().flat(),
          redo,
        }
      : null;
  return { filed, minted, rejected: [], failed, command };
}

/**
 * CR-9: one File it writes the Route A drafts and approves the Route B and C
 * proposals; the filings become one undo step, in the order they ran (undo
 * takes the later one back first).
 */
export function mergeFilings(...filings: readonly Filing[]): Filing {
  const filed = filings.flatMap((f) => f.filed);
  const minted = filings.flatMap((f) => f.minted);
  const commands = filings.flatMap((f) => (f.command ? [f.command] : []));
  return {
    filed,
    minted,
    rejected: filings.flatMap((f) => f.rejected),
    failed: filings.flatMap((f) => f.failed),
    command: commands.length
      ? {
          label: filingLabel([...filed.map((f) => f.title), ...minted]),
          undo: [...commands].reverse().flatMap((c) => c.undo),
          redo: commands.flatMap((c) => c.redo),
        }
      : null,
  };
}

/**
 * KB-7: the open question a capture becomes when Claude cannot file it (no
 * key, offline, or a failed run), or when the writer picks Review later on a
 * fact the box would file (CR-6). Title: the first line. Body (Markdown,
 * A44): the text, a blank line, the story time. Tagged `capture`, so it can
 * be found and filed later.
 */
export function captureQuestionData(
  text: string,
  storyTime: string,
  capturedOn: string,
  /** A47 (IP-9): the bible's first status of kind idea (`defaultStatus`). */
  status = 'idea',
): Record<string, unknown> {
  const trimmed = text.trim();
  const first = (trimmed.split('\n')[0] ?? '').trim();
  const title = first.length > 120 ? `${first.slice(0, 119)}…` : first;
  return {
    title,
    status,
    question: trimmed,
    body: `${trimmed}\n\n${storyTime}`,
    tags: ['capture'],
    sourceNote: `From a capture on ${capturedOn} that Claude could not file.`,
  };
}
