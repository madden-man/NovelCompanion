import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import { UndoManager, stepNotice } from '../../../shared/domain/undoRunner';
import { plainErrorMessage } from '../../../shared/errors';
import type { Op, UndoCommand, UndoIO } from '../../../shared/domain/undoRunner';
import { undoIO } from '../../../shared/undoIO';
import { questionCommand } from '../../../shared/domain/phoneQuestions';
import { savedFieldText } from '../../../shared/domain/undoText';
import { call, callIn, setWorkspaceBible, writesSettled } from '../api';
import { entryChainsSettled } from './editable/chains';

export type { Op, UndoCommand };

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
  /** The last thing undo or redo did, or why it could not, or the last `toast`. */
  notice: string | null;
  /** A57: true while the notice is a toast that offers Undo; `UndoNotice` draws the button. */
  noticeUndo: boolean;
  /**
   * A57: say what was just done in the status bar, with an Undo button that
   * steps the history back once (in place of "Cmd+Z brings it back" sentences).
   * Call it after `record`: a later `record` takes the button away, so it never
   * undoes a different step from the one the toast names. `undo: false` shows
   * the words alone.
   */
  toast(text: string, opts?: { undo?: boolean }): void;
  /**
   * Editors register a flush so a pending autosave lands before an undo. A
   * flush resolves to what it could not save, in a few words, or nothing.
   */
  registerFlush(fn: Flush): () => void;
  /** Write every pending autosave now, for example before the app closes. */
  flush(): Promise<void>;
  /**
   * Editors call this after a save with the stored entry. The focused field's
   * saved value changes only when that field belongs to the saved entry, and
   * then to the stored value, so typing elsewhere stays undoable (ED-3).
   */
  markSaved(saved: Record<string, unknown>): void;
  /** A57: the bible this workspace was opened on; its writes carry it (`callIn`). */
  bible: string | null;
  /**
   * A57: true while this workspace is mounted and its bible is the open one.
   * A timer, a retry or a write on leaving goes ahead only while it is true.
   */
  live(): boolean;
}

/** A registered flush: resolves to what it could not save as a string, else to anything. */
export type Flush = () => Promise<unknown>;

const UndoContext = createContext<Undo | null>(null);

let openBibleFlush: (() => Promise<string[]>) | null = null;

/** The longest a bible switch waits for pending writes before it gives up and stays. */
export const SWITCH_SAVE_LIMIT_MS = 12_000;

/** A57: the pending edits could not all be stored, so the other bible did not open. */
export class NotSavedError extends Error {
  override name = 'NotSavedError';
}

/** A57: what a switch says when a write was still out when the wait ran out. */
export const STILL_SAVING = 'Not saved: a change was still being written when the wait ran out.';

/**
 * A57: save every pending edit of the open bible and wait for every write in
 * flight, at most `SWITCH_SAVE_LIMIT_MS`. Every path that opens another bible
 * (the header switcher, the Bibles screen, Import as a new bible, Restore, the
 * read-only snapshot) awaits this first and stays where it is when it throws:
 * the `NotSavedError` says what was not saved and why.
 */
export async function saveBeforeSwitch(): Promise<void> {
  const work = (async () => {
    const problems: string[] = openBibleFlush ? await openBibleFlush() : [];
    do {
      await entryChainsSettled();
      problems.push(...(await writesSettled()));
    } while (await entryChainsSettled());
    return problems;
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<'late'>((resolve) => {
    timer = setTimeout(() => resolve('late'), SWITCH_SAVE_LIMIT_MS);
  });
  try {
    const r = await Promise.race([work, limit]);
    if (r === 'late') throw new NotSavedError(STILL_SAVING);
    const unique = [...new Set(r)];
    if (unique.length) throw new NotSavedError(unique.join(' '));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Session undo and redo (ED-3): at least 50 steps, Cmd+Z and Shift+Cmd+Z.
 * Inside a text field holding unsaved typing, the keys undo the typing (the
 * browser's own text undo, or a rich text box's own history, A44); everywhere
 * else they step through the app's history.
 */
export function UndoProvider({ children, bible }: { children: ReactNode; bible?: string }) {
  const manager = useRef(new UndoManager());
  /** Undo writes go through the same IPC channels as every other write, from this bible. */
  const io = useMemo<UndoIO>(() => undoIO((c, r) => callIn(bible, c, r)), [bible]);
  const flushes = useRef(new Set<Flush>());
  /** A57: this workspace's writes are the window's while it is mounted. */
  const alive = useRef(false);
  useLayoutEffect(() => {
    alive.current = true;
    setWorkspaceBible(bible ?? null);
    return () => {
      alive.current = false;
      setWorkspaceBible(null, bible ?? undefined);
    };
  }, [bible]);
  const live = useCallback(() => alive.current, []);
  const busy = useRef(Promise.resolve());
  /** The value the focused text field held when it was focused or last saved. */
  const savedValue = useRef<{ el: Element; value: string; nativeUndone: boolean } | null>(null);
  const [snapshot, setSnapshot] = useState(() => ({
    canUndo: false,
    canRedo: false,
    history: { undo: [] as UndoCommand[], redo: [] as UndoCommand[] },
  }));
  const [notice, setNoticeText] = useState<{ text: string; undo: boolean } | null>(null);
  const setNotice = useCallback(
    (text: string | null) => setNoticeText(text === null ? null : { text, undo: false }),
    [],
  );
  const toast = useCallback(
    (text: string, opts?: { undo?: boolean }) =>
      setNoticeText({ text, undo: (opts?.undo ?? true) && manager.current.stack.canUndo }),
    [],
  );
  const refresh = useCallback(() => {
    const s = manager.current.stack;
    setSnapshot({ canUndo: s.canUndo, canRedo: s.canRedo, history: s.history() });
  }, []);

  const record = useCallback(
    (cmd: UndoCommand) => {
      manager.current.record(cmd);
      // A toast's Undo names the step before this one; it goes, the words stay.
      setNoticeText((n) => (n?.undo ? { text: n.text, undo: false } : n));
      refresh();
    },
    [refresh],
  );

  const flushAll = useCallback(async () => {
    for (const f of [...flushes.current]) await f();
  }, []);
  /** Every flush runs, even after one fails; the list says what each could not save. */
  const flushForSwitch = useCallback(async () => {
    const problems: string[] = [];
    for (const f of [...flushes.current]) {
      try {
        const left = await f();
        if (typeof left === 'string' && left) problems.push(left);
      } catch (e) {
        problems.push(plainErrorMessage(e));
      }
    }
    return problems;
  }, []);
  useEffect(() => {
    openBibleFlush = flushForSwitch;
    return () => {
      if (openBibleFlush === flushForSwitch) openBibleFlush = null;
    };
  }, [flushForSwitch]);

  const step = useCallback(
    (direction: 'undo' | 'redo') => {
      // Steps run one after another, so fast key presses replay in order.
      busy.current = busy.current.then(async () => {
        // Whatever one step throws, the queue goes on: a later Cmd+Z still runs.
        try {
          await flushAll();
          const r = await manager.current.step(direction, io);
          setNotice(stepNotice(direction, r));
        } catch (e) {
          setNotice(`Could not ${direction}: ${plainErrorMessage(e)}`);
        }
        refresh();
      });
      return busy.current;
    },
    [flushAll, refresh, setNotice, io],
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

  // A56 (FN-7): a question the phone answered, resolved, took back or asked is one step.
  // The steps wait in main until this bible's history takes them: on mount (the first pull
  // on open, or the one after a reload, can run before this listens) and whenever a pull
  // says it made some. A claimed step is always recorded, even if this unmounted meanwhile.
  useEffect(() => {
    if (!bible) return;
    const claim = () =>
      void call('notebook.claimSteps', { bible }).then(
        ({ steps }) => {
          for (const s of steps) record(questionCommand(s));
        },
        () => undefined,
      );
    claim();
    return window.api.on('notebook.questions', (e) => {
      if (e.bible === bible) claim();
    });
  }, [bible, record]);

  const registerFlush = useCallback((fn: Flush) => {
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
      notice: notice?.text ?? null,
      noticeUndo: notice?.undo ?? false,
      toast,
      registerFlush,
      flush: flushAll,
      markSaved,
      bible: bible ?? null,
      live,
    }),
    [record, step, notice, toast, registerFlush, flushAll, markSaved, snapshot, bible, live],
  );

  return <UndoContext.Provider value={value}>{children}</UndoContext.Provider>;
}

/**
 * A57: the status bar's notice: what the last undo, redo or toast said, and
 * for a toast an Undo button with its key shown on it.
 */
export function UndoNotice() {
  const undo = useUndo();
  if (!undo.notice) return null;
  return (
    <>
      <span data-testid="undo-notice">{undo.notice}</span>
      {undo.noticeUndo && (
        <button
          type="button"
          className="btn small"
          data-testid="undo-notice-undo"
          onClick={() => void undo.undo()}
        >
          Undo <kbd>Cmd Z</kbd>
        </button>
      )}
    </>
  );
}

export function useUndo(): Undo {
  const u = useContext(UndoContext);
  if (!u) throw new Error('useUndo needs an UndoProvider.');
  return u;
}
