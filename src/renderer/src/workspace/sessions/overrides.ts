/**
 * SB-9, IP-2 (a47-desk): entries taken out of (or put back into) a selection
 * before any brief is written. Relevant to Session and the Start session
 * preview share them, keyed by the section, so what is removed on the desk is
 * left out of the brief Start session writes. Kept for the app session only.
 */
import { useCallback, useMemo, useSyncExternalStore } from 'react';

export interface Overrides {
  add: string[];
  remove: string[];
}

const EMPTY: Overrides = { add: [], remove: [] };
const store = new Map<string, Overrides>();
const listeners = new Set<() => void>();

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};

function put(key: string, next: Overrides) {
  if (!next.add.length && !next.remove.length) store.delete(key);
  else store.set(key, next);
  for (const fn of listeners) fn();
}

/** The overrides of a section, and Remove, Keep and Clear over them. */
export function useOverrides(input: unknown): {
  overrides: Overrides;
  remove: (id: string) => void;
  keep: (id: string) => void;
  clear: () => void;
} {
  const key = input ? JSON.stringify(input) : '';
  const overrides = useSyncExternalStore(subscribe, () => (key && store.get(key)) || EMPTY);
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
