import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import { UndoStack } from '../../../shared/domain/undo';
import type { Command } from '../../../shared/domain/undo';
import type { EntryCollection } from '../../../shared/schema';
import { call, plainError } from '../api';

/** One write an undo or redo replays through the normal write path (ARCHITECTURE rule 5). */
export type Op =
  | { kind: 'update'; collection: EntryCollection; id: string; patch: Record<string, unknown> }
  | { kind: 'delete'; collection: EntryCollection; id: string }
  | { kind: 'restore'; collection: EntryCollection; id: string }
  | { kind: 'rename'; listId: string; itemId: string; label: string };

export type UndoCommand = Command<Op>;

async function apply(op: Op): Promise<void> {
  switch (op.kind) {
    case 'update':
      await call('entry.update', { collection: op.collection, id: op.id, patch: op.patch });
      return;
    case 'delete':
      await call('entry.delete', { collection: op.collection, id: op.id });
      return;
    case 'restore':
      await call('entry.restore', { collection: op.collection, id: op.id });
      return;
    case 'rename':
      await call('lists.rename', {
        listId: op.listId as never,
        itemId: op.itemId,
        label: op.label,
      });
  }
}

interface Undo {
  record(cmd: UndoCommand): void;
  undo(): Promise<void>;
  redo(): Promise<void>;
  canUndo: boolean;
  canRedo: boolean;
  history: { undo: UndoCommand[]; redo: UndoCommand[] };
  /** The last thing undo or redo did, or why it could not. */
  notice: string | null;
  /** Editors register a flush so a pending autosave lands before an undo. */
  registerFlush(fn: () => Promise<void>): () => void;
}

const UndoContext = createContext<Undo | null>(null);

/** Session undo and redo (ED-3): at least 50 steps, Cmd+Z and Shift+Cmd+Z. */
export function UndoProvider({ children }: { children: ReactNode }) {
  const stack = useRef(new UndoStack<Op>());
  const flushes = useRef(new Set<() => Promise<void>>());
  const busy = useRef(Promise.resolve());
  const [snapshot, setSnapshot] = useState(() => ({
    canUndo: false,
    canRedo: false,
    history: { undo: [] as UndoCommand[], redo: [] as UndoCommand[] },
  }));
  const [notice, setNotice] = useState<string | null>(null);
  const refresh = useCallback(() => {
    const s = stack.current;
    setSnapshot({ canUndo: s.canUndo, canRedo: s.canRedo, history: s.history() });
  }, []);

  const record = useCallback(
    (cmd: UndoCommand) => {
      stack.current.push(cmd);
      refresh();
    },
    [refresh],
  );

  const flushAll = useCallback(async () => {
    for (const f of [...flushes.current]) await f();
  }, []);

  const step = useCallback(
    (direction: 'undo' | 'redo') => {
      // Steps run one after another, so fast key presses replay in order.
      busy.current = busy.current.then(async () => {
        await flushAll();
        const cmd = direction === 'undo' ? stack.current.undo() : stack.current.redo();
        if (!cmd) {
          setNotice(direction === 'undo' ? 'Nothing to undo.' : 'Nothing to redo.');
          refresh();
          return;
        }
        try {
          for (const op of cmd[direction]) await apply(op);
          setNotice(`${direction === 'undo' ? 'Undid' : 'Redid'}: ${cmd.label}`);
        } catch (e) {
          if (direction === 'undo') stack.current.revertUndo();
          else stack.current.revertRedo();
          setNotice(`Could not ${direction}: ${plainError(e)}`);
        }
        refresh();
      });
      return busy.current;
    },
    [flushAll, refresh],
  );

  useEffect(() => {
    const off = window.api.on('app.command', ({ command }) => void step(command));
    // Fallback for key presses that reach the page directly.
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.key.toLowerCase() !== 'z') return;
      e.preventDefault();
      void step(e.shiftKey ? 'redo' : 'undo');
    };
    window.addEventListener('keydown', onKey);
    return () => {
      off();
      window.removeEventListener('keydown', onKey);
    };
  }, [step]);

  const registerFlush = useCallback((fn: () => Promise<void>) => {
    flushes.current.add(fn);
    return () => {
      flushes.current.delete(fn);
    };
  }, []);

  const value = useMemo<Undo>(
    () => ({
      record,
      undo: () => step('undo'),
      redo: () => step('redo'),
      ...snapshot,
      notice,
      registerFlush,
    }),
    [record, step, notice, registerFlush, snapshot],
  );

  return <UndoContext.Provider value={value}>{children}</UndoContext.Provider>;
}

export function useUndo(): Undo {
  const u = useContext(UndoContext);
  if (!u) throw new Error('useUndo needs an UndoProvider.');
  return u;
}
