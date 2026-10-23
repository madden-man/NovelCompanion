import { useReadOnly } from '../connection';
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
import type { Response } from '../../../shared/ipc';
import type { StoryTimeValue } from '../../../shared/storyTime';
import { call } from '../api';

type Stored = Response<'storyTime.get'>;

export interface StoryTime {
  /** The year screens show: the story time, else the current position, else this calendar year. */
  year: number;
  /** The full story time as set: a year or a full date, and the chapter and strand (TM-1). */
  time: StoryTimeValue | null;
  stored: Stored | null;
  /** Set the story time to a year, keeping the chapter and strand. Screens redraw at once; the value is saved shortly after. */
  setYear(year: number): void;
  /** Set the whole story time. It writes no entry (TM-5). */
  set(value: StoryTimeValue): void;
  /** Save a pending change now, for actions that read the stored story time. */
  flush(): Promise<void>;
  /** The Story Time dialog (TM-1). */
  dialogOpen: boolean;
  openDialog(): void;
  closeDialog(): void;
}

const Ctx = createContext<StoryTime | null>(null);

const SAVE_DELAY_MS = 250;

/**
 * The current story time for the open bible (TM-3): one shared store that the
 * tree year control, the timeline cursor, the year view, character pages, the
 * status bar, and the session selection all read.
 */
export function StoryTimeProvider({ children }: { children: ReactNode }) {
  const [stored, setStored] = useState<Stored | null>(null);
  const [local, setLocal] = useState<StoryTimeValue | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentRef = useRef<StoryTimeValue | null>(null);

  const load = useCallback(() => {
    void call('storyTime.get', {}).then((r) => {
      setStored(r);
      if (!timer.current) setLocal(null);
    });
  }, []);

  useEffect(() => {
    load();
    const offTime = window.api.on('storyTime.changed', load);
    // The current position moves when a chapter is marked written.
    const offChange = window.api.on('bible.changed', (e) => {
      if (e.collection === 'chapters') load();
    });
    const offCommand = window.api.on('app.command', ({ command }) => {
      if (command === 'storyTime') setDialogOpen(true);
    });
    // Fallback for a Cmd+T that reaches the page directly.
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      if (e.key.toLowerCase() !== 't') return;
      e.preventDefault();
      setDialogOpen(true);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      offTime();
      offChange();
      offCommand();
      window.removeEventListener('keydown', onKey);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [load]);

  const pending = useRef<StoryTimeValue | null>(null);
  // ARCH-6: in a read-only snapshot the story time moves on screen but is not saved anywhere.
  const readOnly = useReadOnly() !== null;
  const save = useCallback(
    async (value: StoryTimeValue) => {
      if (readOnly) return;
      setStored(await call('storyTime.set', { time: value }));
    },
    [readOnly],
  );

  const set = useCallback(
    (value: StoryTimeValue) => {
      if (!Number.isInteger(value.year)) return;
      setLocal(value);
      currentRef.current = value;
      pending.current = value;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        pending.current = null;
        void save(value);
      }, SAVE_DELAY_MS);
    },
    [save],
  );

  const flush = useCallback(async () => {
    const value = pending.current;
    if (!value) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    pending.current = null;
    await save(value);
  }, [save]);

  const current = local ?? stored?.time ?? null;
  useEffect(() => {
    currentRef.current = current;
  }, [current]);

  const setYear = useCallback(
    (year: number) => {
      const c = currentRef.current;
      set({
        year,
        ...(c?.chapterId ? { chapterId: c.chapterId } : {}),
        ...(c?.chapterId && c.strandId ? { strandId: c.strandId } : {}),
      });
    },
    [set],
  );

  // Stable, so the dialog's open effect (focus and select the year box) runs once,
  // not after every keystroke that changes the time (NF-2: typing 2041 gave 1).
  const openDialog = useCallback(() => setDialogOpen(true), []);
  // Closing writes any year still waiting on the save delay first, so nothing set after the
  // dialog is gone (the Writing picker, a test seam) is overwritten by a late write.
  const closeDialog = useCallback(() => {
    void flush().finally(() => setDialogOpen(false));
  }, [flush]);
  const value = useMemo<StoryTime>(() => {
    const year = current?.year ?? stored?.position.year ?? new Date().getFullYear();
    return {
      year,
      time: current,
      stored,
      setYear,
      set,
      flush,
      dialogOpen,
      openDialog,
      closeDialog,
    };
  }, [current, stored, setYear, set, flush, dialogOpen, openDialog, closeDialog]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useStoryTime(): StoryTime {
  const v = useContext(Ctx);
  if (!v) throw new Error('useStoryTime needs a StoryTimeProvider.');
  return v;
}

/** "2040", or "2040-03-14" for a full date. */
export function formatMoment(t: { year: number; month?: number; day?: number }): string {
  if (t.month === undefined) return String(t.year);
  const mm = String(t.month).padStart(2, '0');
  return t.day === undefined
    ? `${t.year}-${mm}`
    : `${t.year}-${mm}-${String(t.day).padStart(2, '0')}`;
}
