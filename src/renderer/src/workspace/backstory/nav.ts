import { useEffect, useRef } from 'react';

/**
 * Opening Backstory on a person from anywhere in the window (SM-10's "Their
 * backstory" button, and the end-to-end tests): a window event the workspace
 * answers by showing the Backstory screen with that person picked. A50: with
 * a moment, on that moment's person with the moment open.
 */
export const OPEN_BACKSTORY = 'nc:open-backstory';

export function openBackstory(characterId?: string, momentId?: string): void {
  // Self-contained (the event name is written out) so a test can run it in the window as is.
  window.dispatchEvent(
    new CustomEvent('nc:open-backstory', { detail: { characterId, momentId, at: Date.now() } }),
  );
}

/**
 * The workspace's side: called with the person to pick (or undefined for none),
 * when the request was made, so the same person asked for twice is picked twice,
 * and the moment to open, if any.
 */
export function useOpenBackstory(
  handler: (characterId: string | undefined, at: number, momentId: string | undefined) => void,
): void {
  const ref = useRef(handler);
  useEffect(() => {
    ref.current = handler;
  });
  useEffect(() => {
    const on = (e: Event) => {
      const detail = (e as CustomEvent<{ characterId?: unknown; at?: unknown; momentId?: unknown }>)
        .detail;
      ref.current(
        typeof detail?.characterId === 'string' ? detail.characterId : undefined,
        typeof detail?.at === 'number' ? detail.at : Date.now(),
        typeof detail?.momentId === 'string' ? detail.momentId : undefined,
      );
    };
    window.addEventListener(OPEN_BACKSTORY, on);
    return () => window.removeEventListener(OPEN_BACKSTORY, on);
  }, []);
}
