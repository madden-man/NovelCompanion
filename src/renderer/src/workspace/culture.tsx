import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useWriteGuard } from '../connection';
import { descriptionFor, entriesFor, placeOutline } from '../../../shared/domain/culture';
import { createCommand } from '../../../shared/domain/undoRunner';
import type { Response } from '../../../shared/ipc';
import { entryTitle } from '../../../shared/schema';
import type { EntryCollection } from '../../../shared/schema';
import { call, plainError } from '../api';
import { useEntries, useList, useStore } from './data';
import type { Entry } from './data';
import { InspectorAside } from './inspector';
import type { Inspected } from './inspector';
import { updateWithUndo } from './sessions/common';
import { useStoryTime } from './storyTime';
import { useUndo } from './undo';
import { EraCoverage, NewEntryForm } from './views';
import { Zh, ZhHtml } from './Zh';
import './culture.css';

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

export type CultureTab = 'communities' | 'eras';

const TABS: { tab: CultureTab; label: string }[] = [
  { tab: 'communities', label: 'Communities' },
  { tab: 'eras', label: 'Eras' },
];

/**
 * SM-11: Cultural data. Tab Communities: the cultural entries by community
 * with their years, the ones covering the year highlighted (CU-1), and what
 * applies to a community in a year (CU-2). Tab Eras: the era states, edited
 * in place. An entry picked here opens in the inspector.
 */
export function CulturalDataView(props: { tab: CultureTab; onTab: (tab: CultureTab) => void }) {
  const [inspected, setInspected] = useState<Inspected | null>(null);
  const [creating, setCreating] = useState<{ communityId: string } | null>(null);
  const refs = useRef<Partial<Record<CultureTab, HTMLButtonElement | null>>>({});
  const baseId = useId();
  const onOpen: Open = (collection, id) => {
    setCreating(null);
    setInspected({ collection, id });
  };
  const onKey = (e: ReactKeyboardEvent, i: number) => {
    let next: number | null = null;
    if (e.key === 'ArrowRight') next = i + 1;
    else if (e.key === 'ArrowLeft') next = i - 1;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = TABS.length - 1;
    if (next === null) return;
    e.preventDefault();
    const target = TABS[(next + TABS.length) % TABS.length]?.tab;
    if (!target) return;
    props.onTab(target);
    refs.current[target]?.focus();
  };
  return (
    <>
      <div className="ws-wide-area" data-testid="cultural-data" data-tab={props.tab}>
        <div className="ws-wide stack">
          <h2 id={`${baseId}-title`}>Cultural data</h2>
          <div className="screen-tabs" role="tablist" aria-labelledby={`${baseId}-title`}>
            {TABS.map((t, i) => (
              <button
                key={t.tab}
                ref={(el) => {
                  refs.current[t.tab] = el;
                }}
                type="button"
                role="tab"
                id={`${baseId}-tab-${t.tab}`}
                aria-selected={props.tab === t.tab}
                aria-controls={`${baseId}-panel`}
                tabIndex={props.tab === t.tab ? 0 : -1}
                onClick={() => props.onTab(t.tab)}
                onKeyDown={(e) => onKey(e, i)}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div
            id={`${baseId}-panel`}
            role="tabpanel"
            aria-labelledby={`${baseId}-tab-${props.tab}`}
          >
            {props.tab === 'communities' ? (
              <CultureView
                onOpen={onOpen}
                onNew={(communityId) => {
                  setInspected(null);
                  setCreating({ communityId });
                }}
              />
            ) : (
              <ErasView />
            )}
          </div>
        </div>
      </div>
      <InspectorAside
        open={inspected}
        onClose={() => setInspected(null)}
        hint="Pick a cultural entry to edit it here."
      >
        {creating ? (
          <NewEntryForm
            key={creating.communityId}
            collection="culturalEntries"
            preset={creating.communityId ? { communityId: creating.communityId } : undefined}
            onCreated={(id) => onOpen('culturalEntries', id)}
            onCancel={() => setCreating(null)}
          />
        ) : undefined}
      </InspectorAside>
    </>
  );
}

/**
 * CU-1, CU-2: what applies to a community in a year, then every cultural
 * entry by community with its years, the ones covering that year marked.
 * The year starts at the story year.
 */
export function CultureView(props: { onOpen: Open; onNew?: (communityId: string) => void }) {
  const story = useStoryTime();
  const communities = useList('communities');
  const entries = useEntries('culturalEntries');
  const ro = useWriteGuard();
  const [community, setCommunity] = useState('');
  const [year, setYear] = useState(story.year);
  const ids = { community: useId(), year: useId() };
  const items = communities?.items ?? [];
  const shown = community ? items.filter((c) => c.id === community) : items;
  const label = (id: unknown) => items.find((c) => c.id === id)?.label ?? String(id ?? '');
  const applies = useMemo(
    () => new Set(shown.flatMap((c) => entriesFor(entries, c.id, year).map((e) => e._id))),
    [entries, shown, year],
  );
  const result = useMemo(
    () => shown.flatMap((c) => entriesFor(entries, c.id, year)),
    [entries, shown, year],
  );
  const byCommunity = useMemo(
    () =>
      shown.map((c) => ({
        id: c.id,
        label: c.label,
        rows: entries
          .filter((e) => e.communityId === c.id)
          .sort(
            (a, b) =>
              Number(a.startYear ?? -Infinity) - Number(b.startYear ?? -Infinity) ||
              entryTitle(a).localeCompare(entryTitle(b)),
          ),
      })),
    [entries, shown],
  );

  return (
    <section className="stack" aria-label="Communities" data-testid="culture-view">
      <p className="lede">
        Traditions by community and by the years they apply to. Pick a community and a year to see
        what applies; edit an entry in the inspector.
      </p>
      <div className="tree-toolbar">
        <div className="field">
          <label htmlFor={ids.community}>Community</label>
          <select
            id={ids.community}
            value={community}
            onChange={(e) => setCommunity(e.target.value)}
          >
            <option value="">Every community</option>
            {items.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
        <YearField id={ids.year} label="Year" value={year} onChange={setYear} />
        {props.onNew && (
          <button
            type="button"
            className="btn primary small"
            disabled={ro.off || items.length === 0}
            {...ro.tip}
            onClick={() => props.onNew?.(community || items[0]?.id || '')}
          >
            New entry
          </button>
        )}
      </div>
      {items.length === 0 ? (
        <p className="example-note">Add a community on the Lists screen first.</p>
      ) : (
        <>
          <h3>{community ? `${label(community)} in ${year}` : `Every community in ${year}`}</h3>
          {result.length === 0 ? (
            <p className="example-note" data-testid="culture-empty">
              No entries apply {community ? 'to this community ' : ''}in {year}.
            </p>
          ) : (
            <ul className="stack-list culture-results" data-testid="culture-results">
              {result.map((e) => (
                <li key={e._id} className="panel stack tight" data-entry={e._id}>
                  <div className="row tight">
                    <strong>
                      <Zh text={entryTitle(e)} />
                    </strong>
                    {!community && <span className="chip">{label(e.communityId)}</span>}
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
          <h3>Every entry by community</h3>
          <div className="stack" data-testid="culture-communities">
            {byCommunity.map((c) => (
              <section
                key={c.id}
                className="stack tight"
                aria-label={c.label}
                data-community={c.id}
              >
                <h4>{c.label}</h4>
                {c.rows.length === 0 ? (
                  <p className="example-note">No entries for {c.label} yet.</p>
                ) : (
                  <ul className="entry-list culture-rows">
                    {c.rows.map((e) => {
                      const on = applies.has(e._id);
                      return (
                        <li key={e._id}>
                          <button
                            type="button"
                            className={`entry-row culture-row${on ? ' applies' : ''}`}
                            data-id={e._id}
                            data-applies={on ? 'true' : 'false'}
                            onClick={() => props.onOpen('culturalEntries', e._id)}
                          >
                            <span className="entry-title">
                              <Zh text={entryTitle(e)} actions={false} />
                            </span>
                            <span className="row tight">
                              <span className="chip">{span(e.startYear, e.endYear)}</span>
                              {on && <span className="chip time">in {year}</span>}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

/** WE-2, SM-4: the era states, each edited in place: name, start and end year, and body. */
function ErasView() {
  const eras = useEntries('eraStates');
  const story = useStoryTime();
  const undo = useUndo();
  const ro = useWriteGuard();
  const [error, setError] = useState<string | null>(null);
  const [fresh, setFresh] = useState<string | null>(null);
  const rows = useMemo(
    () => [...eras].sort((a, b) => Number(a.startYear ?? 0) - Number(b.startYear ?? 0)),
    [eras],
  );

  const save = async (id: string, patch: Record<string, unknown>, label: string) => {
    setError(null);
    try {
      await updateWithUndo(undo, 'eraStates', id, patch, label);
    } catch (e) {
      setError(plainError(e));
    }
  };

  const create = async () => {
    setError(null);
    const last = rows[rows.length - 1];
    const start = last ? Number(last.endYear) + 1 : story.year;
    try {
      const { entry } = await call('entry.create', {
        collection: 'eraStates',
        data: {
          title: 'New era',
          name: 'New era',
          startYear: start,
          endYear: start + 9,
          status: 'idea',
        },
      });
      undo.record(createCommand('eraStates', entry._id, entryTitle(entry)));
      setFresh(entry._id);
    } catch (e) {
      setError(plainError(e));
    }
  };

  return (
    <section className="stack" aria-label="Eras" data-testid="eras-view">
      <p className="lede">
        The state of the world in each era. Edit a field and leave it to save; each change is one
        undo step.
      </p>
      <EraCoverage />
      <div className="row">
        <button
          type="button"
          className="btn primary small"
          onClick={() => void create()}
          disabled={ro.off}
          {...ro.tip}
        >
          New era
        </button>
      </div>
      {error && (
        <p className="callout crit" role="alert">
          {error}
        </p>
      )}
      {rows.length === 0 ? (
        <p className="example-note">No eras yet.</p>
      ) : (
        <ul className="era-list">
          {rows.map((e) => (
            <EraRow
              key={e._id}
              era={e}
              current={Number(e.startYear) <= story.year && story.year <= Number(e.endYear)}
              autoFocus={fresh === e._id}
              disabled={ro.off}
              onSave={(patch, label) => void save(e._id, patch, label)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function EraRow(props: {
  era: Entry;
  current: boolean;
  autoFocus: boolean;
  disabled: boolean;
  onSave: (patch: Record<string, unknown>, label: string) => void;
}) {
  const { era } = props;
  const name = String(era.name ?? '');
  const ids = { name: useId(), start: useId(), end: useId(), body: useId() };
  type Key = 'name' | 'start' | 'end' | 'body';
  const stored: Record<Key, string> = {
    name,
    start: String(era.startYear ?? ''),
    end: String(era.endYear ?? ''),
    body: String(era.body ?? ''),
  };
  const [draft, setDraft] = useState(stored);
  /** Fields typed in and not yet committed: a change from elsewhere never overwrites them. */
  const dirty = useRef(new Set<Key>());
  const storedKey = JSON.stringify(stored);
  const [seen, setSeen] = useState(storedKey);
  if (seen !== storedKey) {
    // Adjusted during render: a save, an undo or another writer changed the era.
    setSeen(storedKey);
    setDraft((d) => {
      const next = { ...d };
      for (const k of Object.keys(stored) as Key[]) if (!dirty.current.has(k)) next[k] = stored[k];
      return next;
    });
  }
  const edit = (key: Key, value: string) => {
    dirty.current.add(key);
    setDraft((d) => ({ ...d, [key]: value }));
  };
  const year = (t: string) => (/^-?\d{1,5}$/.test(t.trim()) ? Number(t) : null);
  const commit = (key: Key) => {
    dirty.current.delete(key);
    const v = draft[key];
    if (key === 'name') {
      if (v.trim() && v !== name) props.onSave({ name: v.trim(), title: v.trim() }, 'Era name');
      else setDraft((d) => ({ ...d, name }));
    } else if (key === 'start' || key === 'end') {
      const field = key === 'start' ? 'startYear' : 'endYear';
      const n = year(v);
      if (n !== null && n !== era[field]) {
        props.onSave({ [field]: n }, key === 'start' ? 'Start year' : 'End year');
      } else if (n === null) setDraft((d) => ({ ...d, [key]: String(era[field] ?? '') }));
    } else if (v !== String(era.body ?? '')) props.onSave({ body: v }, 'Era description');
  };
  const input = (key: 'start' | 'end') => ({
    value: draft[key],
    onChange: (ev: { target: { value: string } }) => edit(key, ev.target.value),
    onBlur: () => commit(key),
    onKeyDown: (ev: ReactKeyboardEvent) => {
      if (ev.key === 'Enter') commit(key);
    },
  });
  return (
    <li
      className={`panel stack tight era-row${props.current ? ' current' : ''}`}
      data-era={era._id}
      aria-current={props.current ? 'date' : undefined}
    >
      <fieldset className="write-group stack tight" disabled={props.disabled}>
        <div className="row era-head">
          <div className="field">
            <label htmlFor={ids.name}>Era name</label>
            <input
              id={ids.name}
              value={draft.name}
              autoFocus={props.autoFocus}
              onChange={(ev) => edit('name', ev.target.value)}
              onBlur={() => commit('name')}
              onKeyDown={(ev) => {
                if (ev.key === 'Enter') commit('name');
              }}
            />
          </div>
          <div className="field year-field">
            <label htmlFor={ids.start}>Start year</label>
            <input id={ids.start} className="num" inputMode="numeric" {...input('start')} />
          </div>
          <div className="field year-field">
            <label htmlFor={ids.end}>End year</label>
            <input id={ids.end} className="num" inputMode="numeric" {...input('end')} />
          </div>
          {props.current && <span className="chip time">story year</span>}
        </div>
        <div className="field">
          <label htmlFor={ids.body}>What the world is like</label>
          <textarea
            id={ids.body}
            rows={4}
            value={draft.body}
            onChange={(ev) => edit('body', ev.target.value)}
            onBlur={() => commit('body')}
          />
        </div>
      </fieldset>
    </li>
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
        <div className="table-wrap glossary-wrap">
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
