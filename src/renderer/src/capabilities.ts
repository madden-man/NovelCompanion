import { useSyncExternalStore } from 'react';
import type { Channel } from '../../shared/ipc';

/**
 * A58 (PH-5): which channels this client may use. The desktop may use every
 * channel, so before anything is known every control shows; the web build
 * sets the phone's channels before the first render (`presetCapabilities`),
 * so no desk control ever flashes on the phone. The first use asks
 * `app.capabilities` once and keeps the answer.
 */
let known: ReadonlySet<string> | null = null;
/** Channels the client answers itself, added to whatever the other side answers. */
let local: readonly string[] = [];
let asked = false;
const listeners = new Set<() => void>();

/** The web build: what the phone may use before the function answers, and what it answers itself. */
export function presetCapabilities(channels: readonly string[], answeredHere: readonly string[]) {
  local = answeredHere;
  known = new Set([...channels, ...answeredHere]);
  for (const fn of [...listeners]) fn();
}

function ask(): void {
  if (asked) return;
  asked = true;
  window.api.invoke('app.capabilities', {}).then(
    ({ channels }) => {
      known = new Set([...channels, ...local]);
      for (const fn of [...listeners]) fn();
    },
    () => {
      // Kept as it was: everything on the desk, the preset on the phone.
    },
  );
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  ask();
  return () => listeners.delete(fn);
}

/** PH-5: a test for "may this client use the channel", for drawing a control or not. */
export function useCapabilities(): (channel: Channel) => boolean {
  const set = useSyncExternalStore(subscribe, () => known);
  return (channel) => set === null || set.has(channel);
}
