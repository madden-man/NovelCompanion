/**
 * A56 (FN-3): File it for one group of the tray, without React, so its order
 * is tested on its own. The drafts are written through the capture box's
 * Route A filing; the undo step is recorded before the facts are marked
 * filed, so a mark that fails never leaves entries with no way back, and the
 * facts are hidden here anyway so a second File it cannot write them twice.
 */
import type { Channel, Request, Response } from '../../../shared/ipc';
import { fileLocalDrafts } from '../../../shared/domain/capture';
import type { FiledEntry } from '../../../shared/domain/capture';
import type { CaptureDraft } from '../../../shared/domain/captureRouter';
import { withMarks } from '../../../shared/domain/tray';
import type { TrayMarks } from '../../../shared/domain/tray';
import type { Op, UndoCommand } from '../../../shared/domain/undoRunner';
import { plainErrorMessage } from '../../../shared/errors';

type Invoke = <C extends Channel>(channel: C, request: Request<C>) => Promise<Response<C>>;

export interface TrayFiling {
  filed: FiledEntry[];
  /** Facts whose drafts did not all file: they stay offered. */
  failedKeys: string[];
  firstFailure: string | null;
  /** The marks to show now: the stored ones, or the old ones with the filed facts hidden. */
  marks: TrayMarks;
  /** Why the filed mark could not be stored, when it could not; the entries and the undo step stand. */
  markError: string | null;
}

/** A `run` step that sets or clears marks (FN-3 undo and redo). */
export function markOp(
  invoke: Invoke,
  keys: string[],
  mark: keyof TrayMarks | null,
  onMarks: (m: TrayMarks) => void,
): Op {
  return {
    kind: 'run',
    apply: async () => onMarks(await invoke('tray.mark', { keys, mark })),
    check: async () => null,
  };
}

export async function fileTrayGroup(
  invoke: Invoke,
  facts: readonly { key: string; drafts: readonly CaptureDraft[] }[],
  marks: TrayMarks,
  record: (c: UndoCommand) => void,
  onMarks: (m: TrayMarks) => void,
): Promise<TrayFiling> {
  const drafts: CaptureDraft[] = [];
  const owner: string[] = [];
  for (const f of facts) {
    for (const d of f.drafts) {
      drafts.push(d);
      owner.push(f.key);
    }
  }
  const r = await fileLocalDrafts(invoke, drafts);
  const failed = new Set(r.failed.map((f) => owner[Number(f.id.replace('draft ', ''))] ?? ''));
  const done = facts.map((f) => f.key).filter((k) => !failed.has(k));
  if (r.command) {
    record({
      ...r.command,
      undo: [...r.command.undo, ...(done.length ? [markOp(invoke, done, null, onMarks)] : [])],
      redo: [...r.command.redo, ...(done.length ? [markOp(invoke, done, 'filed', onMarks)] : [])],
    });
  }
  let next = marks;
  let markError: string | null = null;
  if (done.length) {
    try {
      next = await invoke('tray.mark', { keys: done, mark: 'filed' });
    } catch (e) {
      markError = plainErrorMessage(e);
      next = withMarks(marks, done, 'filed');
    }
  }
  return {
    filed: r.filed,
    failedKeys: [...failed],
    firstFailure: r.failed[0]?.message ?? null,
    marks: next,
    markError,
  };
}
