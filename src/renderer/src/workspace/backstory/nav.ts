import { useEffect, useRef } from 'react';

/**
 * Opening Backstory on a person from anywhere in the window (SM-10's "Their
 * backstory" button, and the end-to-end tests): a window event the workspace
 * answers by showing the Backstory screen with that person picked.
 */
export const OPEN_BACKSTORY = 'nc:open-backstory';

export function openBackstory(characterId?: string): void {
  window.dispatchEvent(new CustomEvent(OPEN_BACKSTORY, { detail: { characterId } }));
}

/** The workspace's side: called with the person to pick, or undefined for none. */
export function useOpenBackstory(handler: (characterId: string | undefined) => void): void {
  const ref = useRef(handler);
  useEffect(() => {
    ref.current = handler;
  });
  useEffect(() => {
    const on = (e: Event) => {
      const detail = (e as CustomEvent<{ characterId?: unknown }>).detail;
      ref.current(typeof detail?.characterId === 'string' ? detail.characterId : undefined);
    };
    window.addEventListener(OPEN_BACKSTORY, on);
    return () => window.removeEventListener(OPEN_BACKSTORY, on);
  }, []);
}
