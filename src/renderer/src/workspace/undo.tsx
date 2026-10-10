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
import { UndoManager, stepNotice } from '../../../shared/domain/undoRunner';
import type { Op, UndoCommand, UndoIO } from '../../../shared/domain/undoRunner';
import { undoIO } from '../../../shared/undoIO';
import { savedFieldText } from '../../../shared/domain/undoText';
import { call } from '../api';

export type { Op, UndoCommand };

/** Undo writes go through the same IPC channels as every other write. */
const io: UndoIO = undoIO(call);

type TextField = HTMLInputElement | HTMLTextAreaElement;

function focusedTextField(): TextField | null {
  const el = document.activeElement;
  if (el instanceof HTMLTextAreaElement) return el;
  if (
    el instanceof HTMLInputElement &&
    !['checkbox', 'radio', 'button', 'submit'].includes(el.type)
  ) {
    return el;
  }
  return null;
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
  /**
   * Editors call this after a save with the stored entry. The focused field's
   * saved value changes only when that field belongs to the saved entry, and
   * then to the stored value, so typing elsewhere stays undoable (ED-3).
   */
  markSaved(saved: Record<string, unknown>): void;
}

const UndoContext = createContext<Undo | null>(null);

/**
 * Session undo and redo (ED-3): at least 50 steps, Cmd+Z and Shift+Cmd+Z.
 * Inside a text field holding unsaved typing, the keys undo the typing (the
 * browser's own text undo); everywhere else they step through the app's history.
 */
export function UndoProvider({ children }: { children: ReactNode }) {
  const manager = useRef(new UndoManager());
  const flushes = useRef(new Set<() => Promise<void>>());
  const busy = useRef(Promise.resolve());
  /** The value the focused text field held when it was focused or last saved. */
  const savedValue = useRef<{ el: TextField; value: string; nativeUndone: boolean } | null>(null);
  const [snapshot, setSnapshot] = useState(() => ({
    canUndo: false,
    canRedo: false,
    history: { undo: [] as UndoCommand[], redo: [] as UndoCommand[] },
  }));
  const [notice, setNotice] = useState<string | null>(null);
  const refresh = useCallback(() => {
    const s = manager.current.stack;
    setSnapshot({ canUndo: s.canUndo, canRedo: s.canRedo, history: s.history() });
  }, []);

  const record = useCallback(
    (cmd: UndoCommand) => {
      manager.current.record(cmd);
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
        const r = await manager.current.step(direction, io);
        setNotice(stepNotice(direction, r));
        refresh();
      });
      return busy.current;
    },
    [flushAll, refresh],
  );

  /** Undo typing in the focused field when it has unsaved typing; true when it did. */
  const textStep = useCallback((direction: 'undo' | 'redo'): boolean => {
    const el = focusedTextField();
    const saved = savedValue.current;
    if (!el || !saved || saved.el !== el) return false;
    const dirty = el.value !== saved.value;
    if (direction === 'undo' && dirty) {
      document.execCommand('undo');
      saved.nativeUndone = true;
      return true;
    }
    if (direction === 'redo' && saved.nativeUndone) {
      document.execCommand('redo');
      if (el.value === saved.value) saved.nativeUndone = false;
      return true;
    }
    return false;
  }, []);

  const command = useCallback(
    (direction: 'undo' | 'redo') => {
      if (!textStep(direction)) void step(direction);
    },
    [step, textStep],
  );

  useEffect(() => {
    const onFocus = () => {
      const el = focusedTextField();
      savedValue.current = el ? { el, value: el.value, nativeUndone: false } : null;
    };
    const off = window.api.on('app.command', ({ command: c }) => command(c));
    // Fallback for key presses that reach the page directly.
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.key.toLowerCase() !== 'z') return;
      e.preventDefault();
      command(e.shiftKey ? 'redo' : 'undo');
    };
    document.addEventListener('focusin', onFocus);
    window.addEventListener('keydown', onKey);
    return () => {
      off();
      document.removeEventListener('focusin', onFocus);
      window.removeEventListener('keydown', onKey);
    };
  }, [command]);

  const registerFlush = useCallback((fn: () => Promise<void>) => {
    flushes.current.add(fn);
    return () => {
      flushes.current.delete(fn);
    };
  }, []);

  const markSaved = useCallback((saved: Record<string, unknown>) => {
    const el = focusedTextField();
    if (!el) return;
    const text = savedFieldText(saved, el.closest('[data-field]')?.getAttribute('data-field'));
    if (text === undefined) return;
    const cur = savedValue.current;
    if (cur && cur.el === el) {
      cur.value = text;
      if (el.value === text) cur.nativeUndone = false;
    } else {
      savedValue.current = { el, value: text, nativeUndone: false };
    }
  }, []);

  const value = useMemo<Undo>(
    () => ({
      record,
      undo: () => step('undo'),
      redo: () => step('redo'),
      ...snapshot,
      notice,
      registerFlush,
      markSaved,
    }),
    [record, step, notice, registerFlush, markSaved, snapshot],
  );

  return <UndoContext.Provider value={value}>{children}</UndoContext.Provider>;
}

export function useUndo(): Undo {
  const u = useContext(UndoContext);
  if (!u) throw new Error('useUndo needs an UndoProvider.');
  return u;
}
