import { useEffect, useId, useState } from 'react';
import { ENTRY_COLLECTIONS, collectionInfo, entryTitle } from '../../../shared/schema';
import type { EntryCollection } from '../../../shared/schema';
import type { Request, Response } from '../../../shared/ipc';
import { call, plainError } from '../api';
import { useEntries, useList, useStore } from './data';
import { Zh } from './Zh';

type Hit = Response<'search.query'>['hits'][number];

const LIMIT = 50;

const intOrNull = (t: string): number | null => (/^-?\d{1,5}$/.test(t.trim()) ? Number(t) : null);

/**
 * SR-1, SR-2: one search box over every entry, chapter text, and saved
 * briefs, in English and Chinese, with filters by section, status,
 * provenance, family, place, tag, and a year range.
 */
export function SearchView(props: {
  query: string;
  onQuery: (q: string) => void;
  onOpen: (collection: EntryCollection, id: string) => void;
}) {
  const { query } = props;
  const { version } = useStore();
  const families = useEntries('families');
  const places = useEntries('places');
  const tags = useList('tags');
  const [section, setSection] = useState('');
  const [status, setStatus] = useState('');
  const [provenance, setProvenance] = useState('');
  const [familyId, setFamilyId] = useState('');
  const [placeId, setPlaceId] = useState('');
  const [tag, setTag] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const ids = {
    q: useId(),
    section: useId(),
    status: useId(),
    prov: useId(),
    family: useId(),
    place: useId(),
    tag: useId(),
    from: useId(),
    to: useId(),
  };

  useEffect(() => {
    if (!query.trim()) return;
    let live = true;
    const filters: NonNullable<Request<'search.query'>['filters']> = {
      ...(section ? { sections: [section as EntryCollection] } : {}),
      ...(status ? { status: [status as 'canon' | 'planned' | 'idea'] } : {}),
      ...(provenance ? { provenance: [provenance as 'researched' | 'invented'] } : {}),
      ...(familyId ? { familyId } : {}),
      ...(placeId ? { placeId } : {}),
      ...(tag ? { tag } : {}),
      ...(intOrNull(from) !== null ? { yearFrom: intOrNull(from) } : {}),
      ...(intOrNull(to) !== null ? { yearTo: intOrNull(to) } : {}),
    };
    call('search.query', { query, filters, limit: LIMIT })
      .then((r) => {
        if (!live) return;
        setHits(r.hits);
        setTotal(r.total);
        setError(null);
      })
      .catch((e: unknown) => {
        if (live) setError(plainError(e));
      });
    return () => {
      live = false;
    };
  }, [query, section, status, provenance, familyId, placeId, tag, from, to, version]);

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
        </div>
        <div className="field">
          <label htmlFor={ids.status}>Status</label>
          <select id={ids.status} value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Any status</option>
            <option value="canon">Canon</option>
            <option value="planned">Planned</option>
            <option value="idea">Idea</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor={ids.prov}>Provenance</label>
          <select id={ids.prov} value={provenance} onChange={(e) => setProvenance(e.target.value)}>
            <option value="">Any provenance</option>
            <option value="researched">Researched</option>
            <option value="invented">Invented</option>
          </select>
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
        <div className="field">
          <label htmlFor={ids.tag}>Tag</label>
          <select id={ids.tag} value={tag} onChange={(e) => setTag(e.target.value)}>
            <option value="">Any tag</option>
            {(tags?.items ?? []).map((t) => (
              <option key={t.id} value={t.label}>
                {t.label}
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
      {!query.trim() ? (
        <p className="example-note">Type to search every entry, chapter text, and brief.</p>
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
                    {h.status && <span className={`chip ${h.status}`}>{h.status}</span>}
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
    </section>
  );
}
