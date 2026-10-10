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
import { call } from '../api';

type Stored = Response<'storyTime.get'>;

interface StoryTime {
  /** The year screens show: the story time, else the current position, else this calendar year. */
  year: number;
  stored: Stored | null;
  /** Set the story time to a year. Screens redraw at once; the value is saved shortly after. */
  setYear(year: number): void;
}

const Ctx = createContext<StoryTime | null>(null);

const SAVE_DELAY_MS = 250;

/**
 * The current story time for the open bible (TM-3). M2 binds the tree's year
 * control to it and shows ages at it on character pages; M3 adds the dialog.
 */
export function StoryTimeProvider({ children }: { children: ReactNode }) {
  const [stored, setStored] = useState<Stored | null>(null);
  const [local, setLocal] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    return () => {
      offTime();
      offChange();
      if (timer.current) clearTimeout(timer.current);
    };
  }, [load]);

  const setYear = useCallback((year: number) => {
    if (!Number.isInteger(year)) return;
    setLocal(year);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      void call('storyTime.set', { time: { year } }).then(setStored);
    }, SAVE_DELAY_MS);
  }, []);

  const value = useMemo<StoryTime>(() => {
    const year = local ?? stored?.time?.year ?? stored?.position.year ?? new Date().getFullYear();
    return { year, stored, setYear };
  }, [local, stored, setYear]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useStoryTime(): StoryTime {
  const v = useContext(Ctx);
  if (!v) throw new Error('useStoryTime needs a StoryTimeProvider.');
  return v;
}
