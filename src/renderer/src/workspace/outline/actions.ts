import { useCallback, useMemo, useState } from 'react';
import { createCommand, editCommand, reorderCommand } from '../../../../shared/domain/undoRunner';
import type { Request } from '../../../../shared/ipc';
import { entryTitle } from '../../../../shared/schema';
import type { EntryCollection } from '../../../../shared/schema';
import { call, plainError } from '../../api';
import { useWriteGuard } from '../../connection';
import { useUndo } from '../undo';

/**
 * KB-3: every write the outline makes, each through the one write path and
 * each recorded as one undo step (ED-3, PL-3). Errors land in `error` for the
 * outline to show; a read-only snapshot writes nothing (ARCH-6).
 */
export function useOutlineWrites() {
  const undo = useUndo();
  const ro = useWriteGuard();
  const [error, setError] = useState<string | null>(null);

  const guard = useCallback(
    async <T>(fn: () => Promise<T>): Promise<T | undefined> => {
      setError(null);
      if (ro.off) return undefined;
      try {
        return await fn();
      } catch (e) {
        setError(plainError(e));
        return undefined;
      }
    },
    [ro.off],
  );

  /** PL-3, KB-3: move a chapter, a beat, or a part. */
  const reorder = useCallback(
    (req: Request<'plot.reorder'>, label: string) =>
      guard(async () => {
        const r = await call('plot.reorder', req);
        if (r.changes.length) undo.record(reorderCommand(label, r.collection, r.changes));
        return r.changes.length > 0;
      }),
    [guard, undo],
  );

  /** A new entry through `entry.create`; one undo step. Returns its ID. */
  const create = useCallback(
    (collection: EntryCollection, data: Record<string, unknown>) =>
      guard(async () => {
        const { entry } = await call('entry.create', { collection, data });
        undo.record(createCommand(collection, entry._id, entryTitle(entry)));
        return entry._id;
      }),
    [guard, undo],
  );

  /**
   * KB-3: a new chapter last in a part, or right after `afterId` (A37), and the
   * reading-order shifts after it, as one undo step.
   */
  const newChapter = useCallback(
    (partId: string, title: string, year: number, afterId?: string) =>
      guard(async () => {
        const r = await call('outline.newChapter', { partId, title, year, afterId });
        const made = createCommand('chapters', r.entry._id, entryTitle(r.entry));
        const shifts = reorderCommand(made.label, 'chapters', r.changes);
        undo.record({
          label: made.label,
          undo: [...made.undo, ...shifts.undo],
          redo: [...made.redo, ...shifts.redo],
        });
        return r.entry._id;
      }),
    [guard, undo],
  );

  /** ED-1: change one or two fields of an entry, as the editor does; one undo step. */
  const edit = useCallback(
    (collection: EntryCollection, id: string, patch: Record<string, unknown>, label: string) =>
      guard(async () => {
        const { entry: before } = await call('entry.get', { collection, id });
        const changed = Object.keys(patch).some((k) => before[k] !== patch[k]);
        if (!changed) return false;
        const { entry: after } = await call('entry.update', { collection, id, patch });
        undo.record(editCommand(label, collection, id, before, after));
        return true;
      }),
    [guard, undo],
  );

  return useMemo(
    () => ({ reorder, create, newChapter, edit, error, clearError: () => setError(null), ro }),
    [reorder, create, newChapter, edit, error, ro],
  );
}

export type OutlineWrites = ReturnType<typeof useOutlineWrites>;
