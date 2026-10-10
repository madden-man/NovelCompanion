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
import type { EntryCollection } from '../../../shared/schema';
import { entryTitle } from '../../../shared/schema';
import type { WireEntry, WireList } from '../../../shared/ipc';
import { call } from '../api';

export type Entry = WireEntry & Record<string, unknown>;

interface Store {
  /** Live entries of a collection, loaded on first use and kept fresh by change events. */
  entries(c: EntryCollection): Entry[] | undefined;
  request(c: EntryCollection): void;
  lists: WireList[];
  /** Bumps on every change in the bible, so views can reload what they show. */
  version: number;
  titleOf(id: string): string;
}

const StoreContext = createContext<Store | null>(null);

/** Entries and lists of the open bible for pickers, labels, and lists (renderer cache). */
export function DataProvider({ children }: { children: ReactNode }) {
  const [cache, setCache] = useState<Partial<Record<EntryCollection, Entry[]>>>({});
  const [lists, setLists] = useState<WireList[]>([]);
  const [version, setVersion] = useState(0);
  const wanted = useRef(new Set<EntryCollection>());

  const load = useCallback((c: EntryCollection) => {
    void call('entry.list', { collection: c, trash: 'exclude' }).then((r) =>
      setCache((prev) => ({ ...prev, [c]: r.entries.map((e) => e.entry as Entry) })),
    );
  }, []);

  const loadLists = useCallback(() => {
    void call('lists.get', {}).then((r) => setLists(r.lists));
  }, []);

  useEffect(() => {
    loadLists();
    const offChange = window.api.on('bible.changed', (e) => {
      const c = e.collection as EntryCollection;
      if (wanted.current.has(c)) load(c);
      setVersion((v) => v + 1);
      loadLists();
    });
    const offLists = window.api.on('lists.changed', () => {
      loadLists();
      setVersion((v) => v + 1);
    });
    return () => {
      offChange();
      offLists();
    };
  }, [load, loadLists]);

  const request = useCallback(
    (c: EntryCollection) => {
      if (wanted.current.has(c)) return;
      wanted.current.add(c);
      load(c);
    },
    [load],
  );

  const store = useMemo<Store>(() => {
    const byId = new Map<string, Entry>();
    for (const list of Object.values(cache)) for (const e of list ?? []) byId.set(e._id, e);
    return {
      entries: (c) => cache[c],
      request,
      lists,
      version,
      titleOf: (id) => (byId.has(id) ? entryTitle(byId.get(id)) : id),
    };
  }, [cache, request, lists, version]);

  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}

export function useStore(): Store {
  const s = useContext(StoreContext);
  if (!s) throw new Error('useStore needs a DataProvider.');
  return s;
}

/** The live entries of one collection; asks the store to load it. */
export function useEntries(c: EntryCollection): Entry[] {
  const store = useStore();
  useEffect(() => store.request(c), [store, c]);
  return store.entries(c) ?? [];
}

export function useList(listId: string | undefined): WireList | undefined {
  const { lists } = useStore();
  return lists.find((l) => l._id === listId);
}
