import { plainErrorMessage } from '../errors';
/**
 * Replaying undo and redo steps through the write path (ED-3, ARCHITECTURE
 * rule 5). Every step records what it expects to find, and a step whose
 * fields changed since is skipped instead of writing old values over newer
 * ones. Pure apart from the `UndoIO` it is given, so unit and integration
 * tests drive the same logic the renderer uses.
 */
import { manifests, entryTitle } from '../schema';
import type { EntryCollection } from '../schema';
import { contentOf, patchBetween } from './diff';
import { labelPath } from './issues';
import { deepEqual } from './paths';
import type { Doc } from './paths';
import { UndoStack } from './undo';
import type { Command } from './undo';

export type Op =
  | {
      kind: 'update';
      collection: EntryCollection;
      id: string;
      patch: Doc;
      /** The values these fields must hold for the step to apply. */
      expect: Doc;
    }
  | { kind: 'delete'; collection: EntryCollection; id: string }
  | { kind: 'restore'; collection: EntryCollection; id: string }
  | { kind: 'rename'; listId: string; itemId: string; label: string; expect: string }
  /** SM-7: a write outside the entries (the scene outline); `check` names why it cannot apply. */
  | { kind: 'run'; apply: () => Promise<void>; check: () => Promise<string | null> };

export type UndoCommand = Command<Op>;

export interface UndoIO {
  /** The stored entry, including one in the trash, or undefined. */
  get(collection: EntryCollection, id: string): Promise<Doc | undefined>;
  listLabel(listId: string, itemId: string): Promise<string | undefined>;
  apply(op: Op): Promise<void>;
}

/** A field edit: undo writes the old values back, redo the new ones. */
export function editCommand(
  label: string,
  collection: EntryCollection,
  id: string,
  before: Doc,
  after: Doc,
): UndoCommand {
  const { forward, backward } = patchBetween(before, after);
  return {
    label,
    undo: [{ kind: 'update', collection, id, patch: backward, expect: forward }],
    redo: [{ kind: 'update', collection, id, patch: forward, expect: backward }],
  };
}

/**
 * PL-3: a reorder changes order fields on several entries (a chapter's reading
 * order and part, a beat's per-arc positions); undo puts the old values back.
 */
export function reorderCommand(
  label: string,
  collection: EntryCollection,
  changes: readonly { id: string; before: Doc; after: Doc }[],
): UndoCommand {
  const step = (from: 'before' | 'after', to: 'before' | 'after'): Op[] =>
    changes.map((c) => ({
      kind: 'update',
      collection,
      id: c.id,
      patch: c[to],
      expect: c[from],
    }));
  return { label, undo: step('after', 'before'), redo: step('before', 'after') };
}

export function createCommand(collection: EntryCollection, id: string, title: string): UndoCommand {
  return {
    label: `Created ${title}`,
    undo: [{ kind: 'delete', collection, id }],
    redo: [{ kind: 'restore', collection, id }],
  };
}

export function deleteCommand(collection: EntryCollection, id: string, title: string): UndoCommand {
  return {
    label: `Moved ${title} to the trash`,
    undo: [{ kind: 'restore', collection, id }],
    redo: [{ kind: 'delete', collection, id }],
  };
}

export function restoreCommand(
  collection: EntryCollection,
  id: string,
  title: string,
): UndoCommand {
  return {
    label: `Restored ${title} from the trash`,
    undo: [{ kind: 'delete', collection, id }],
    redo: [{ kind: 'restore', collection, id }],
  };
}

export function renameCommand(
  listLabel: string,
  listId: string,
  itemId: string,
  from: string,
  to: string,
  /** Items keyed by their text, such as custom choices, change ID when renamed. */
  itemIdAfter: string = itemId,
): UndoCommand {
  return {
    label: `Renamed ${from} to ${to} in ${listLabel}`,
    undo: [{ kind: 'rename', listId, itemId: itemIdAfter, label: from, expect: to }],
    redo: [{ kind: 'rename', listId, itemId, label: to, expect: from }],
  };
}

/** Why a step cannot apply, in plain words, or null when it can. */
async function blocked(op: Op, io: UndoIO): Promise<string | null> {
  if (op.kind === 'run') return op.check();
  if (op.kind === 'rename') {
    const label = await io.listLabel(op.listId, op.itemId);
    return label === op.expect
      ? null
      : `the item ${op.expect} is now called ${label ?? 'something else'}`;
  }
  const doc = await io.get(op.collection, op.id);
  if (!doc) return 'the entry no longer exists';
  if (op.kind === 'delete')
    return doc.deletedAt ? `${entryTitle(doc)} is already in the trash` : null;
  if (op.kind === 'restore')
    return doc.deletedAt ? null : `${entryTitle(doc)} is no longer in the trash`;
  const current = contentOf(doc);
  const changed = Object.keys(op.expect).filter(
    (k) => !deepEqual(current[k] ?? null, op.expect[k] ?? null),
  );
  if (changed.length === 0) return null;
  const labels = changed.map((k) => labelPath(manifests[op.collection], k)).join(', ');
  return `${labels} on ${entryTitle(doc)}`;
}

export type StepResult =
  | { status: 'applied'; label: string }
  | { status: 'skipped'; label: string; reason: string }
  | { status: 'failed'; label: string; error: string }
  | { status: 'empty' };

/** Undo and redo with the guard: the stacks stay consistent whatever happens. */
export class UndoManager {
  readonly stack = new UndoStack<Op>();

  record(cmd: UndoCommand): void {
    this.stack.push(cmd);
  }

  async step(direction: 'undo' | 'redo', io: UndoIO): Promise<StepResult> {
    const cmd = direction === 'undo' ? this.stack.undo() : this.stack.redo();
    if (!cmd) return { status: 'empty' };
    const ops = cmd[direction];
    for (const op of ops) {
      const reason = await blocked(op, io);
      if (reason) {
        // The step would overwrite a newer change, so it is dropped, not kept for later.
        if (direction === 'undo') this.stack.discardUndone();
        else this.stack.discardDone();
        return { status: 'skipped', label: cmd.label, reason };
      }
    }
    try {
      for (const op of ops) await io.apply(op);
      return { status: 'applied', label: cmd.label };
    } catch (e) {
      if (direction === 'undo') this.stack.revertUndo();
      else this.stack.revertRedo();
      return {
        status: 'failed',
        label: cmd.label,
        error: plainErrorMessage(e),
      };
    }
  }
}

/** The line the interface shows after a step. */
export function stepNotice(direction: 'undo' | 'redo', r: StepResult): string {
  const verb = direction === 'undo' ? 'Undo' : 'Redo';
  switch (r.status) {
    case 'empty':
      return direction === 'undo' ? 'Nothing to undo.' : 'Nothing to redo.';
    case 'applied':
      return `${direction === 'undo' ? 'Undid' : 'Redid'}: ${r.label}`;
    case 'skipped':
      return `${verb} skipped: this field changed since that step, so nothing was overwritten (${r.reason}).`;
    case 'failed':
      return `Could not ${direction}: ${r.error}`;
  }
}
