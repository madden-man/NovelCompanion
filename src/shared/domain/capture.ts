/**
 * Capture (KB-6, KB-7): filing what Claude proposed from the Cmd+K box, and
 * the open question the box saves when Claude cannot run. Pure apart from the
 * `invoke` it is given, so the integration suite drives the same logic the
 * renderer uses, through the same channels.
 */
import { entryTitle } from '../schema';
import type { EntryCollection } from '../schema';
import type { Channel, Request, Response } from '../ipc';
import { plainErrorMessage } from '../errors';
import { patchBetween } from './diff';
import type { Op, UndoCommand } from './undoRunner';

type Invoke = <C extends Channel>(channel: C, request: Request<C>) => Promise<Response<C>>;

/** A proposal as the box shows it: enough to approve it and undo the approval. */
export interface CaptureProposal {
  id: string;
  op: 'create' | 'update' | 'delete';
  collection: EntryCollection;
  targetId: string | null;
}

export interface FiledEntry {
  collection: EntryCollection;
  id: string;
  title: string;
  op: CaptureProposal['op'];
}

export interface Filing {
  filed: FiledEntry[];
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

  for (const p of ticked) {
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

  const rejected: string[] = [];
  for (const p of unticked) {
    try {
      await invoke('proposal.reject', { id: p.id });
      rejected.push(p.id);
    } catch (e) {
      failed.push({ id: p.id, message: plainErrorMessage(e) });
    }
  }

  const command: UndoCommand | null = filed.length
    ? {
        label: filingLabel(filed),
        // Undo in reverse, so a change to an entry made in this filing is undone before the entry goes.
        undo: undo.reverse().flat(),
        redo,
      }
    : null;
  return { filed, rejected, failed, command };
}

function filingLabel(filed: readonly FiledEntry[]): string {
  const names = filed.map((f) => f.title);
  return names.length <= 2
    ? `Filed a capture: ${names.join(' and ')}`
    : `Filed a capture: ${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
}

const escape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * KB-7: the open question a capture becomes when Claude cannot file it (no
 * key, offline, or a failed run). Title: the first line. Body: the text and
 * the story time. Tagged `capture`, so it can be found and filed later.
 */
export function captureQuestionData(
  text: string,
  storyTime: string,
  capturedOn: string,
): Record<string, unknown> {
  const trimmed = text.trim();
  const first = trimmed.split('\n')[0]!.trim();
  const title = first.length > 120 ? `${first.slice(0, 119)}…` : first;
  const paragraphs = trimmed
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => `<p>${escape(l)}</p>`);
  return {
    title,
    status: 'idea',
    question: trimmed,
    body: [...paragraphs, `<p>${escape(storyTime)}</p>`].join(''),
    tags: ['capture'],
    sourceNote: `From a capture on ${capturedOn} that Claude could not file.`,
  };
}
