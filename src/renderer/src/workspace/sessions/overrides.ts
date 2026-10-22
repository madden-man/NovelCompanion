/**
 * SB-9, IP-2 (a47-desk): entries taken out of (or put back into) a selection
 * before any brief is written. Relevant to Session and the Start session
 * preview share them, so what is removed on the desk is left out of the
 * brief Start session writes. They belong to one section of one bible: a
 * change of section forgets the others, writing the brief forgets its own,
 * and opening another bible forgets them all. Kept for the app session only.
 */
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';

export interface Overrides {
  add: string[];
  remove: string[];
}

const EMPTY: Overrides = { add: [], remove: [] };
const store = new Map<string, Overrides>();
const listeners = new Set<() => void>();
let bible = '';

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};

const notify = () => {
  for (const fn of listeners) fn();
};

function put(key: string, next: Overrides) {
  if (!next.add.length && !next.remove.length) store.delete(key);
  else store.set(key, next);
  notify();
}

/**
 * The open bible the overrides belong to. The workspace draws it once per
 * bible; a different bible forgets every override of the one before. It runs
 * during render so the screens drawn after it read the new bible's keys.
 */
export function OverridesBible({ id }: { id: string }): null {
  if (bible !== id) {
    bible = id;
    store.clear();
  }
  return null;
}

/** The store key of a section in the open bible, empty when there is no section. */
export const overridesKey = (input: unknown): string =>
  input ? `${bible}|${JSON.stringify(input)}` : '';

/** The overrides of a section, and Remove, Keep and Clear over them. */
export function useOverrides(input: unknown): {
  overrides: Overrides;
  remove: (id: string) => void;
  keep: (id: string) => void;
  clear: () => void;
} {
  const key = overridesKey(input);
  const overrides = useSyncExternalStore(subscribe, () => (key && store.get(key)) || EMPTY);
  // SB-9: removals are for the section in hand; picking another section forgets the rest.
  useEffect(() => {
    if (!key) return;
    let dropped = false;
    for (const k of [...store.keys()]) {
      if (k !== key) {
        store.delete(k);
        dropped = true;
      }
    }
    if (dropped) notify();
  }, [key]);
  const remove = useCallback(
    (id: string) => {
      if (!key) return;
      const o = store.get(key) ?? EMPTY;
      if (o.remove.includes(id)) return;
      put(key, { add: o.add.filter((x) => x !== id), remove: [...o.remove, id] });
    },
    [key],
  );
  const keep = useCallback(
    (id: string) => {
      if (!key) return;
      const o = store.get(key) ?? EMPTY;
      put(key, { add: o.add, remove: o.remove.filter((x) => x !== id) });
    },
    [key],
  );
  const clear = useCallback(() => {
    if (key) put(key, EMPTY);
  }, [key]);
  return useMemo(() => ({ overrides, remove, keep, clear }), [overrides, remove, keep, clear]);
}
