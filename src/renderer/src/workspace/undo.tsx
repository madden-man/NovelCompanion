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

/**
 * A text box Cmd+Z can step through before the app's history (ED-3): a native
 * input or text area, or a rich text box (A44) that registers itself.
 */
export interface TextTarget {
  /** The box's current text, as it would be saved. */
  value(): string;
  /** Step the box's own history; true when it did. */
  undo(): boolean;
  redo(): boolean;
}

const richTargets = new WeakMap<Element, TextTarget>();

/** A rich text box registers its editable element; the return value unregisters it. */
export function registerTextTarget(el: Element, target: TextTarget): () => void {
  richTargets.set(el, target);
  return () => {
    if (richTargets.get(el) === target) richTargets.delete(el);
  };
}

/** What a text box inside `scope` holds now, typed text included, or undefined when it has none. */
export function textBoxValue(scope: Element | null | undefined): string | undefined {
  if (!scope) return undefined;
  const rich = scope.querySelector('[role="textbox"]');
  const target = rich ? richTargets.get(rich) : undefined;
  if (target) return target.value();
  return scope.querySelector('textarea')?.value;
}

function nativeTarget(el: HTMLInputElement | HTMLTextAreaElement): TextTarget {
  return {
    value: () => el.value,
    undo: () => {
      document.execCommand('undo');
      return true;
    },
    redo: () => {
      document.execCommand('redo');
      return true;
    },
  };
}

/** The focused text box: its element and how to read and step it. */
function focusedTextTarget(): { el: Element; target: TextTarget } | null {
  const el = document.activeElement;
  if (!el) return null;
  const rich = richTargets.get(el);
  if (rich) return { el, target: rich };
  if (el instanceof HTMLTextAreaElement) return { el, target: nativeTarget(el) };
  if (
    el instanceof HTMLInputElement &&
    !['checkbox', 'radio', 'button', 'submit'].includes(el.type)
  ) {
    return { el, target: nativeTarget(el) };
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
  /** Write every pending autosave now, for example before the app closes. */
  flush(): Promise<void>;
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
 * browser's own text undo, or a rich text box's own history, A44); everywhere
 * else they step through the app's history.
 */
export function UndoProvider({ children }: { children: ReactNode }) {
  const manager = useRef(new UndoManager());
  const flushes = useRef(new Set<() => Promise<void>>());
  const busy = useRef(Promise.resolve());
  /** The value the focused text field held when it was focused or last saved. */
  const savedValue = useRef<{ el: Element; value: string; nativeUndone: boolean } | null>(null);
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
    const focused = focusedTextTarget();
    const saved = savedValue.current;
    if (!focused || !saved || saved.el !== focused.el) return false;
    const { target } = focused;
    const dirty = target.value() !== saved.value;
    if (direction === 'undo' && dirty && target.undo()) {
      saved.nativeUndone = true;
      return true;
    }
    if (direction === 'redo' && saved.nativeUndone && target.redo()) {
      if (target.value() === saved.value) saved.nativeUndone = false;
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
      const f = focusedTextTarget();
      savedValue.current = f ? { el: f.el, value: f.target.value(), nativeUndone: false } : null;
    };
    const off = window.api.on('app.command', ({ command: c }) => {
      if (c === 'undo' || c === 'redo') command(c);
    });
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
    const f = focusedTextTarget();
    if (!f) return;
    const { el, target } = f;
    const text = savedFieldText(saved, el.closest('[data-field]')?.getAttribute('data-field'));
    if (text === undefined) return;
    const cur = savedValue.current;
    if (cur && cur.el === el) {
      cur.value = text;
      if (target.value() === text) cur.nativeUndone = false;
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
      flush: flushAll,
      markSaved,
    }),
    [record, step, notice, registerFlush, flushAll, markSaved, snapshot],
  );

  return <UndoContext.Provider value={value}>{children}</UndoContext.Provider>;
}

export function useUndo(): Undo {
  const u = useContext(UndoContext);
  if (!u) throw new Error('useUndo needs an UndoProvider.');
  return u;
}
