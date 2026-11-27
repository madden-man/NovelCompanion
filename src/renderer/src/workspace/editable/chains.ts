import type { EntryCollection } from '../../../../shared/schema';

const entryChains = new Map<string, Promise<unknown>>();

/**
 * One write to an entry at a time (ED-2, IP-1). Main reads an entry before it
 * writes it, so two writes to the same entry in flight together can refuse one
 * of them; the autosave and every in-place save of an entry queue here.
 */
export function onEntryChain<T>(
  collection: EntryCollection,
  id: string,
  write: () => Promise<T>,
): Promise<T> {
  const key = `${collection}/${id}`;
  const next = (entryChains.get(key) ?? Promise.resolve()).then(write);
  const tail = next.then(
    () => undefined,
    () => undefined,
  );
  entryChains.set(key, tail);
  void tail.then(() => {
    if (entryChains.get(key) === tail) entryChains.delete(key);
  });
  return next;
}

/**
 * A57: wait until no entry has a write queued or running. True when it had to
 * wait, so a caller can look again for writes the queue sent meanwhile.
 */
export async function entryChainsSettled(): Promise<boolean> {
  let waited = false;
  while (entryChains.size > 0) {
    waited = true;
    await Promise.all([...entryChains.values()]);
  }
  return waited;
}
