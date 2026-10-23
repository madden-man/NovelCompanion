import { useEffect, useId, useMemo, useState } from 'react';
import { ENTRY_COLLECTIONS, collectionInfo, entryTitle } from '../../../shared/schema';
import type { EntryCollection } from '../../../shared/schema';
import type { Request, Response } from '../../../shared/ipc';
import { call, plainError } from '../api';
import { useEntries, useStore } from './data';
import { Zh } from './Zh';

type Hit = Response<'search.query'>['hits'][number];

const LIMIT = 50;

const intOrNull = (t: string): number | null => (/^-?\d{1,5}$/.test(t.trim()) ? Number(t) : null);

/**
 * SR-1, SR-2: one search box over every entry and chapter text, in
 * English and Chinese, with filters by section, family, place, and a
 * year range.
 */
export function SearchView(props: {
  query: string;
  onQuery: (q: string) => void;
  onOpen: (collection: EntryCollection, id: string) => void;
  /** SM-6: every section's own list, which left the rail, opens from its Section filter. */
  onOpenSection?: (collection: EntryCollection) => void;
}) {
  const { query } = props;
  const { version } = useStore();
  const families = useEntries('families');
  const places = useEntries('places');
  const [section, setSection] = useState('');
  const [familyId, setFamilyId] = useState('');
  const [placeId, setPlaceId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  /** The hits last returned, with the query key they answer. */
  const [settled, setSettled] = useState<{ key: string; hits: Hit[]; total: number }>({
    key: '',
    hits: [],
    total: 0,
  });
  const [error, setError] = useState<string | null>(null);
  const ids = {
    q: useId(),
    section: useId(),
    family: useId(),
    place: useId(),
    from: useId(),
    to: useId(),
  };

  const filters = useMemo(() => {
    const f: NonNullable<Request<'search.query'>['filters']> = {
      ...(section ? { sections: [section as EntryCollection] } : {}),
      ...(familyId ? { familyId } : {}),
      ...(placeId ? { placeId } : {}),
      ...(intOrNull(from) !== null ? { yearFrom: intOrNull(from) } : {}),
      ...(intOrNull(to) !== null ? { yearTo: intOrNull(to) } : {}),
    };
    return f;
  }, [section, familyId, placeId, from, to]);
  /** Names the query and filters the list on screen must answer. */
  const queryKey = JSON.stringify({ query: query.trim(), filters });

  useEffect(() => {
    if (!query.trim()) return;
    let live = true;
    call('search.query', { query, filters, limit: LIMIT })
      .then((r) => {
        if (!live) return;
        setSettled({ key: queryKey, hits: r.hits, total: r.total });
        setError(null);
      })
      .catch((e: unknown) => {
        if (!live) return;
        setSettled({ key: queryKey, hits: [], total: 0 });
        setError(plainError(e));
      });
    return () => {
      live = false;
    };
  }, [query, filters, queryKey, version]);

  const { hits, total } = settled;
  // A search is in flight until the hits on screen answer the current query and filters.
  const busy = query.trim() !== '' && settled.key !== queryKey;
  const shown = query.trim() ? hits : [];
  const yearBad =
    (from.trim() !== '' && intOrNull(from) === null) ||
    (to.trim() !== '' && intOrNull(to) === null);

  return (
    <section className="ws-wide stack" aria-labelledby="search-title" data-testid="search-view">
      <h2 id="search-title">Search</h2>
      <div className="field">
        <label htmlFor={ids.q}>Search terms</label>
        <input
          id={ids.q}
          type="search"
          value={query}
          placeholder="A name, a word, Chinese characters, or romanization"
          onChange={(e) => props.onQuery(e.target.value)}
        />
      </div>
      <div className="tree-toolbar" role="group" aria-label="Search filters">
        <div className="field">
          <label htmlFor={ids.section}>Section</label>
          <select id={ids.section} value={section} onChange={(e) => setSection(e.target.value)}>
            <option value="">Every section</option>
            {ENTRY_COLLECTIONS.map((c) => (
              <option key={c} value={c}>
                {collectionInfo[c].plural}
              </option>
            ))}
          </select>
          {section && props.onOpenSection && (
            <button
              type="button"
              className="btn small"
              onClick={() => props.onOpenSection?.(section as EntryCollection)}
              data-testid="search-open-section"
            >
              List every {collectionInfo[section as EntryCollection].singular.toLowerCase()}
            </button>
          )}
        </div>
        <div className="field">
          <label htmlFor={ids.family}>Family</label>
          <select id={ids.family} value={familyId} onChange={(e) => setFamilyId(e.target.value)}>
            <option value="">Any family</option>
            {families.map((f) => (
              <option key={f._id} value={f._id}>
                {String(f.name ?? entryTitle(f))}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={ids.place}>Place</label>
          <select id={ids.place} value={placeId} onChange={(e) => setPlaceId(e.target.value)}>
            <option value="">Any place</option>
            {places.map((p) => (
              <option key={p._id} value={p._id}>
                {entryTitle(p)}
              </option>
            ))}
          </select>
        </div>
        <div className="field year-field">
          <label htmlFor={ids.from}>From year</label>
          <input
            id={ids.from}
            className="num"
            inputMode="numeric"
            value={from}
            aria-invalid={from.trim() !== '' && intOrNull(from) === null}
            onChange={(e) => setFrom(e.target.value)}
          />
        </div>
        <div className="field year-field">
          <label htmlFor={ids.to}>To year</label>
          <input
            id={ids.to}
            className="num"
            inputMode="numeric"
            value={to}
            aria-invalid={to.trim() !== '' && intOrNull(to) === null}
            onChange={(e) => setTo(e.target.value)}
          />
        </div>
      </div>
      {yearBad && <p className="callout warn">A year is a whole number, such as 2045.</p>}
      {error && (
        <p className="callout crit" role="alert">
          {error}
        </p>
      )}
      <div
        data-testid="search-region"
        aria-busy={busy ? 'true' : 'false'}
        data-query-key={queryKey}
      >
        {!query.trim() ? (
          <p className="example-note">Type to search every entry and chapter text.</p>
        ) : shown.length === 0 ? (
          <p className="example-note" data-testid="search-empty" role="status">
            Nothing matches.
          </p>
        ) : (
          <>
            <p className="example-note" role="status" data-testid="search-count">
              {total === 1 ? '1 match' : `${total} matches`}
              {total > shown.length ? `, showing the first ${shown.length}` : ''}
            </p>
            <ul className="stack-list search-results" data-testid="search-results">
              {shown.map((h) => (
                <li key={`${h.collection}:${h.id}`}>
                  <button
                    type="button"
                    className="entry-row"
                    data-hit={h.id}
                    onClick={() => props.onOpen(h.collection, h.id)}
                  >
                    <span className="row tight">
                      <span className="eyebrow">{collectionInfo[h.collection].singular}</span>
                      <span className="entry-title">
                        <Zh text={h.title} actions={false} />
                      </span>
                    </span>
                    {h.snippet && (
                      <span className="example-note">
                        <Zh text={h.snippet} actions={false} />
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </section>
  );
}
