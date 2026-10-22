import { useEffect, useRef } from 'react';

/**
 * IP-5: opening the Outline on a chapter from anywhere in the window (a strand
 * row in the Story time dialog): a window event the workspace answers by
 * showing the Outline, which then scrolls the chapter's bar into view and
 * focuses it. The chapter waits here until the Outline is on screen to take it.
 */
export const OPEN_OUTLINE = 'nc:open-outline';

let waiting: string | null = null;

export function openOutline(chapterId: string): void {
  waiting = chapterId;
  window.dispatchEvent(new CustomEvent(OPEN_OUTLINE, { detail: { chapterId } }));
}

/** The chapter the Outline should show, or null when none is waiting. */
export function waitingOutlineFocus(): string | null {
  return waiting;
}

/** The Outline has shown it. */
export function clearOutlineFocus(): void {
  waiting = null;
}

/** Called with the chapter to show whenever something asks for the Outline. */
export function useOpenOutline(handler: (chapterId: string) => void): void {
  const ref = useRef(handler);
  useEffect(() => {
    ref.current = handler;
  });
  useEffect(() => {
    const on = (e: Event) => {
      const id = (e as CustomEvent<{ chapterId?: unknown }>).detail?.chapterId;
      if (typeof id === 'string') ref.current(id);
    };
    window.addEventListener(OPEN_OUTLINE, on);
    return () => window.removeEventListener(OPEN_OUTLINE, on);
  }, []);
}
