import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { collectionInfo } from '../../../shared/schema';
import type { EntryCollection } from '../../../shared/schema';
import type { Response } from '../../../shared/ipc';
import { call } from '../api';
import { useStore } from './data';

type Hit = Response<'search.query'>['hits'][number];

/** Search the bible as the query changes. */
export function useSearch(query: string | null, collections?: EntryCollection[]): Hit[] {
  const [hits, setHits] = useState<Hit[]>([]);
  const key = collections?.join(',') ?? '';
  useEffect(() => {
    if (query === null || !query.trim()) return;
    let live = true;
    const cs = key ? (key.split(',') as EntryCollection[]) : undefined;
    void call('search.query', { query, limit: 8, ...(cs ? { collections: cs } : {}) }).then((r) => {
      if (live) setHits(r.hits);
    });
    return () => {
      live = false;
    };
  }, [query, key]);
  return query === null || !query.trim() ? [] : hits;
}

type Found = Response<'entry.lookup'>['entries'][number];

const EMPTY = new Map<string, Found>();

/** Titles for IDs that may live in any section. */
export function useLookup(ids: readonly string[]): Map<string, Found> {
  const { version } = useStore();
  const [found, setFound] = useState<Map<string, Found>>(new Map());
  const key = [...new Set(ids)].sort().join('|');
  useEffect(() => {
    if (!key) return;
    let live = true;
    const list = key.split('|');
    void call('entry.lookup', { ids: list }).then((r) => {
      if (live) setFound(new Map(r.entries.map((e) => [e.id, e])));
    });
    return () => {
      live = false;
    };
  }, [key, version]);
  return key ? found : EMPTY;
}

/** A list of search results the keyboard can move through. */
export function PickerList(props: {
  hits: Hit[];
  active: number;
  onPick: (hit: Hit) => void;
  id: string;
  query: string;
}) {
  const { hits, active, onPick, id, query } = props;
  return (
    <div className="picker" id={id} role="listbox" aria-label="Matching entries">
      {hits.length === 0 ? (
        <p className="example-note">
          {query.trim() ? 'No entries match.' : 'Type a few letters to search.'}
        </p>
      ) : (
        hits.map((h, i) => (
          <button
            key={`${h.collection}:${h.id}`}
            type="button"
            role="option"
            aria-selected={i === active}
            className={i === active ? 'active' : undefined}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onPick(h)}
          >
            <span className="picker-kind">{collectionInfo[h.collection].singular}</span>
            <span>{h.title}</span>
          </button>
        ))
      )}
    </div>
  );
}

/** Arrow keys, Enter, and Escape for a picker. Returns true when it used the key. */
export function pickerKeys(
  e: KeyboardEvent,
  hits: Hit[],
  active: number,
  setActive: (n: number) => void,
  onPick: (h: Hit) => void,
  onClose: () => void,
): boolean {
  if (e.key === 'ArrowDown' && hits.length) {
    setActive((active + 1) % hits.length);
  } else if (e.key === 'ArrowUp' && hits.length) {
    setActive((active - 1 + hits.length) % hits.length);
  } else if (e.key === 'Enter' && hits[active]) {
    onPick(hits[active]);
  } else if (e.key === 'Escape') {
    onClose();
  } else {
    return false;
  }
  e.preventDefault();
  return true;
}

/** A search box that picks one entry from any section, or from the given ones. */
export function EntryPicker(props: {
  label: string;
  onPick: (id: string, collection: EntryCollection) => void;
  collections?: EntryCollection[];
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const hits = useSearch(open ? query : null, props.collections);
  const listId = useId();
  const inputId = useId();
  const ref = useRef<HTMLInputElement>(null);
  const pick = (h: Hit) => {
    props.onPick(h.id, h.collection);
    setQuery('');
    setOpen(false);
    ref.current?.focus();
  };
  return (
    <div className="entry-picker">
      <label htmlFor={inputId} className="sr-only">
        {props.label}
      </label>
      <input
        id={inputId}
        ref={ref}
        type="search"
        placeholder={props.label}
        value={query}
        aria-controls={listId}
        aria-expanded={open}
        autoComplete="off"
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          setActive(0);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => pickerKeys(e, hits, active, setActive, pick, () => setOpen(false))}
      />
      {open && query.trim() !== '' && (
        <PickerList hits={hits} active={active} onPick={pick} id={listId} query={query} />
      )}
    </div>
  );
}
