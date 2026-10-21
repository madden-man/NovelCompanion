import { useEffect, useId, useMemo, useState } from 'react';
import { useWriteGuard } from '../connection';
import { descriptionFor, placeOutline } from '../../../shared/domain/culture';
import type { Response } from '../../../shared/ipc';
import { entryTitle } from '../../../shared/schema';
import type { EntryCollection } from '../../../shared/schema';
import { call, plainError } from '../api';
import { useEntries, useList, useStore } from './data';
import { useStoryTime } from './storyTime';
import { Zh, ZhHtml } from './Zh';

type Open = (collection: EntryCollection, id: string) => void;

function YearField(props: {
  id: string;
  label: string;
  value: number;
  onChange: (n: number) => void;
}) {
  return (
    <div className="field year-field">
      <label htmlFor={props.id}>{props.label}</label>
      <input
        id={props.id}
        type="number"
        value={props.value}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isInteger(n) && Math.abs(n) <= 10000) props.onChange(n);
        }}
      />
    </div>
  );
}

function span(start: unknown, end: unknown): string {
  const s = typeof start === 'number' ? start : null;
  const e = typeof end === 'number' ? end : null;
  if (s === null && e === null) return 'any year';
  if (e === null) return `from ${s}`;
  if (s === null) return `until ${e}`;
  return `${s} to ${e}`;
}

/** CU-1, CU-2: pick a community and a year; see the cultural entries that apply. */
export function CultureView(props: { onOpen: Open }) {
  const { version } = useStore();
  const story = useStoryTime();
  const communities = useList('communities');
  const [community, setCommunity] = useState('');
  const [year, setYear] = useState(story.year);
  const [result, setResult] = useState<Response<'culture.entriesFor'>['entries'] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ids = { community: useId(), year: useId() };
  const chosen = community || communities?.items[0]?.id || '';

  useEffect(() => {
    if (!chosen) return;
    let live = true;
    call('culture.entriesFor', { communityId: chosen, year })
      .then((r) => {
        if (live) {
          setResult(r.entries);
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (live) setError(plainError(e));
      });
    return () => {
      live = false;
    };
  }, [chosen, year, version]);

  return (
    <section className="ws-wide stack" aria-labelledby="culture-title" data-testid="culture-view">
      <h2 id="culture-title">Culture by year</h2>
      <p className="lede">
        Pick a community and a year to see the traditions that apply. Edit one to change it, or make
        a new cultural entry on the Entries tab.
      </p>
      <div className="tree-toolbar">
        <div className="field">
          <label htmlFor={ids.community}>Community</label>
          <select id={ids.community} value={chosen} onChange={(e) => setCommunity(e.target.value)}>
            {(communities?.items ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
        <YearField id={ids.year} label="Year" value={year} onChange={setYear} />
      </div>
      {error && (
        <p className="callout crit" role="alert">
          {error}
        </p>
      )}
      {!chosen ? (
        <p className="example-note">Add a community on the Lists screen first.</p>
      ) : result === null ? (
        <p aria-live="polite">Loading.</p>
      ) : result.length === 0 ? (
        <p className="example-note" data-testid="culture-empty">
          No entries apply to this community in {year}.
        </p>
      ) : (
        <ul className="stack-list culture-results" data-testid="culture-results">
          {result.map((e) => (
            <li key={e._id} className="panel stack tight" data-entry={e._id}>
              <div className="row tight">
                <strong>
                  <Zh text={entryTitle(e)} />
                </strong>
                <span className="chip">{span(e.startYear, e.endYear)}</span>
                {typeof e.status === 'string' && (
                  <span className={`chip ${e.status}`}>{e.status}</span>
                )}
              </div>
              {typeof e.body === 'string' && e.body && <ZhHtml html={e.body} />}
              <button
                type="button"
                className="btn small"
                onClick={() => props.onOpen('culturalEntries', e._id)}
              >
                Edit {entryTitle(e)}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** PC-1: places nested under the places they sit in, each with its description for a chosen year. */
export function PlacesView(props: { onOpen: Open }) {
  const story = useStoryTime();
  const places = useEntries('places');
  const [year, setYear] = useState(story.year);
  const yearId = useId();
  const nodes = useMemo(() => placeOutline(places), [places]);
  const byId = new Map(places.map((p) => [p._id, p]));

  return (
    <section className="ws-wide stack" aria-labelledby="places-title" data-testid="places-view">
      <h2 id="places-title">Place tree</h2>
      <p className="lede">
        Places sit inside larger places. Each shows its description for the year you pick. Pick a
        place to set its parent and its descriptions by year.
      </p>
      <YearField id={yearId} label="Year" value={year} onChange={setYear} />
      {nodes.length === 0 ? (
        <p className="example-note">No places yet.</p>
      ) : (
        <ul className="place-tree">
          {nodes.map((n) => {
            const place = byId.get(n.id);
            const d = place ? descriptionFor(place as never, year) : null;
            return (
              <li
                key={n.id}
                style={{ paddingLeft: n.depth * 20 }}
                data-place={n.id}
                data-depth={n.depth}
              >
                <button
                  type="button"
                  className="link-btn"
                  onClick={() => props.onOpen('places', n.id)}
                >
                  <Zh text={n.title || 'Untitled'} actions={false} />
                </button>
                <span className="place-desc" data-testid="place-description">
                  {d ? (
                    <Zh text={d.text} />
                  ) : (
                    <span className="example-note">No description for {year}.</span>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** GL-1: one romanization system per language, and the terms that do not follow it. */
export function RomanizationView(props: { onOpen: Open }) {
  const ro = useWriteGuard();
  const { version } = useStore();
  const [data, setData] = useState<Response<'romanization.get'> | null>(null);
  const [terms, setTerms] = useState<Response<'entry.list'>['entries']>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void call('romanization.get', {}).then((r) => {
      if (live) setData(r);
    });
    void call('entry.list', { collection: 'glossaryTerms', trash: 'exclude' }).then((r) => {
      if (live) setTerms(r.entries);
    });
    return () => {
      live = false;
    };
  }, [version]);

  const choose = async (languageId: string, systemId: string) => {
    setError(null);
    try {
      setData(await call('romanization.set', { languageId, systemId: systemId || null }));
    } catch (e) {
      setError(plainError(e));
    }
  };

  const flagged = terms.filter((t) => t.warnings.some((w) => w.code === 'romanization-system'));

  return (
    <section
      className="ws-wide stack"
      aria-labelledby="roman-title"
      data-testid="romanization-view"
    >
      <h2 id="roman-title">Romanization</h2>
      <p className="lede">
        Each language uses one romanization system. Glossary terms that do not follow it are
        flagged, and they still save.
      </p>
      {error && (
        <p className="callout crit" role="alert">
          {error}
        </p>
      )}
      <div className="stack tight">
        {(data?.languages ?? []).map((l) => (
          <div className="field" key={l.id}>
            <label htmlFor={`roman-${l.id}`}>{l.label}</label>
            <select
              id={`roman-${l.id}`}
              value={l.systemId ?? ''}
              disabled={ro.off}
              {...ro.tip}
              onChange={(e) => void choose(l.id, e.target.value)}
            >
              <option value="">No system</option>
              {data?.systems.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
            {l.note && (
              <p className="callout" role="note" data-testid="romanization-no-checker">
                {l.note}
              </p>
            )}
          </div>
        ))}
      </div>
      <p className="example-note">Add or rename systems on the Lists screen.</p>
      <h3>Terms that do not follow their system</h3>
      {flagged.length === 0 ? (
        <p className="example-note" data-testid="romanization-ok">
          Every glossary term follows its language&apos;s system.
        </p>
      ) : (
        <ul className="stack-list" data-testid="romanization-flagged">
          {flagged.map(({ entry, warnings }) => (
            <li key={entry._id} data-term={entry._id}>
              <button
                type="button"
                className="link-btn"
                onClick={() => props.onOpen('glossaryTerms', entry._id)}
              >
                <Zh text={entryTitle(entry)} actions={false} />
              </button>{' '}
              <span>{warnings.find((w) => w.code === 'romanization-system')?.message}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** GL-1, GL-3: every glossary term in one table. Hovering or focusing the characters shows the meaning. */
export function GlossaryTable(props: { onOpen: Open }) {
  const terms = useEntries('glossaryTerms');
  const languages = useList('languages');
  const label = (id: unknown) =>
    languages?.items.find((l) => l.id === id)?.label ?? String(id ?? '');
  const rows = useMemo(
    () => [...terms].sort((a, b) => String(a.characters).localeCompare(String(b.characters))),
    [terms],
  );
  return (
    <section
      className="ws-wide stack"
      aria-labelledby="glossary-table-title"
      data-testid="glossary-table"
    >
      <h2 id="glossary-table-title">Glossary table</h2>
      <p className="lede">
        Every term with its characters, romanization, language, and meaning. Hover over the
        characters or focus them with the keyboard for the meaning.
      </p>
      {rows.length === 0 ? (
        <p className="example-note">No glossary terms yet.</p>
      ) : (
        <div className="table-wrap">
          <table className="compact">
            <thead>
              <tr>
                <th scope="col">Characters</th>
                <th scope="col">Romanization</th>
                <th scope="col">Language</th>
                <th scope="col">Meaning</th>
                <th scope="col">Open</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t._id} data-term={t._id}>
                  <td>
                    <Zh text={String(t.characters ?? '')} />
                  </td>
                  <td>{String(t.romanization ?? '')}</td>
                  <td>{label(t.language)}</td>
                  <td>{String(t.meaning ?? '')}</td>
                  <td>
                    <button
                      type="button"
                      className="btn small"
                      onClick={() => props.onOpen('glossaryTerms', t._id)}
                    >
                      Edit {String(t.characters ?? '')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
