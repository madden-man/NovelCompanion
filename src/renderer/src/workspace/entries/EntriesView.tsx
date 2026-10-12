import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useWriteGuard } from '../../connection';
import {
  ENTRIES_COLLECTIONS,
  ENTRIES_TABS,
  entryKinds,
  filterEntries,
  firstLine,
  isEntriesTab,
  kindKeyOf,
} from '../../../../shared/domain/entries';
import type {
  EntriesCollection,
  EntriesRow,
  EntriesTab,
  EntryKind,
  EntryStatus,
} from '../../../../shared/domain/entries';
import { entryTitle } from '../../../../shared/schema';
import type { EntryCollection } from '../../../../shared/schema';
import { call } from '../../api';
import { CultureView, GlossaryTable, PlacesView, RomanizationView } from '../culture';
import { useEntries } from '../data';
import { EmbeddedEditor, EntryPane, UndoPanel } from '../editor';
import { NewEntryForm } from '../views';
import { Zh } from '../Zh';
import './entries.css';

type Open = (collection: EntryCollection, id: string) => void;

const TAB_LABELS: Record<EntriesTab, string> = {
  entries: 'Entries',
  culture: 'Culture by year',
  places: 'Place tree',
  romanization: 'Romanization',
  glossary: 'Glossary table',
};

const STATUSES: { value: EntryStatus; label: string }[] = [
  { value: 'canon', label: 'Canon' },
  { value: 'planned', label: 'Planned' },
  { value: 'idea', label: 'Idea' },
];

const isListed = (c: EntryCollection): c is EntriesCollection =>
  (ENTRIES_COLLECTIONS as readonly string[]).includes(c);

const tabKey = (bible: string) => `novel-companion.entries-tab.${bible}`;

function readTab(bible: string): EntriesTab {
  try {
    const v = window.localStorage.getItem(tabKey(bible));
    return isEntriesTab(v) ? v : 'entries';
  } catch {
    return 'entries';
  }
}

function writeTab(bible: string, tab: EntriesTab): void {
  try {
    window.localStorage.setItem(tabKey(bible), tab);
  } catch {
    // The tab is a convenience; without storage the screen opens on Entries.
  }
}

/**
 * KB-5: one Entries screen. Facts, cultural entries, places, glossary terms,
 * themes, open questions, and custom entries in one list, newest first, with
 * kind chips, a status filter, and a search box; the ED-1 editor beside it.
 * Culture by year, Place tree, Romanization, and Glossary table are tabs,
 * and the open tab is remembered for the bible.
 */
export function EntriesView(props: { onOpen: Open }) {
  const [bible, setBible] = useState<string | null>(null);
  const [tab, setTabState] = useState<EntriesTab | null>(null);
  const tabRefs = useRef<Partial<Record<EntriesTab, HTMLButtonElement | null>>>({});
  const baseId = useId();

  useEffect(() => {
    let live = true;
    void call('bible.current', {})
      .then((r) => {
        if (!live) return;
        const id = r.bible?.id ?? '';
        setBible(id);
        setTabState(readTab(id));
      })
      .catch(() => {
        if (live) setTabState('entries');
      });
    return () => {
      live = false;
    };
  }, []);

  const setTab = (next: EntriesTab, focus = false) => {
    setTabState(next);
    if (bible !== null) writeTab(bible, next);
    if (focus) tabRefs.current[next]?.focus();
  };

  const onTabKey = (e: ReactKeyboardEvent, i: number) => {
    const last = ENTRIES_TABS.length - 1;
    let next: number | null = null;
    if (e.key === 'ArrowRight') next = i === last ? 0 : i + 1;
    else if (e.key === 'ArrowLeft') next = i === 0 ? last : i - 1;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = last;
    const target = next === null ? undefined : ENTRIES_TABS[next];
    if (!target) return;
    e.preventDefault();
    setTab(target, true);
  };

  const shown = tab ?? 'entries';
  return (
    <div className="entries-area" data-testid="entries-view" data-tab={tab ?? ''}>
      <div className="entries-tabs" role="tablist" aria-label="Entries screens">
        {ENTRIES_TABS.map((t, i) => (
          <button
            key={t}
            ref={(el) => {
              tabRefs.current[t] = el;
            }}
            type="button"
            role="tab"
            id={`${baseId}-tab-${t}`}
            aria-selected={shown === t}
            aria-controls={`${baseId}-panel`}
            tabIndex={shown === t ? 0 : -1}
            onClick={() => setTab(t)}
            onKeyDown={(e) => onTabKey(e, i)}
          >
            {TAB_LABELS[t]}
          </button>
        ))}
      </div>
      <div
        id={`${baseId}-panel`}
        role="tabpanel"
        aria-labelledby={`${baseId}-tab-${shown}`}
        className={`entries-panel${shown === 'entries' ? ' list' : ' wide'}`}
      >
        {tab === null ? (
          <p className="entries-wide" aria-live="polite">
            Loading.
          </p>
        ) : tab === 'entries' ? (
          <EntriesList onOpen={props.onOpen} />
        ) : (
          <TabWithInspector key={tab} tab={tab} onOpen={props.onOpen} />
        )}
      </div>
    </div>
  );
}

/** Culture by year, Place tree, Romanization, Glossary table: an entry opens in the inspector. */
function TabWithInspector(props: { tab: Exclude<EntriesTab, 'entries'>; onOpen: Open }) {
  const [open, setOpen] = useState<{ collection: EntryCollection; id: string } | null>(null);
  const onOpen: Open = (collection, id) => setOpen({ collection, id });
  return (
    <>
      <div className="entries-wide">
        {props.tab === 'culture' && <CultureView onOpen={onOpen} />}
        {props.tab === 'places' && <PlacesView onOpen={onOpen} />}
        {props.tab === 'romanization' && <RomanizationView onOpen={onOpen} />}
        {props.tab === 'glossary' && <GlossaryTable onOpen={onOpen} />}
      </div>
      <aside
        className="inspector ws-inspector entries-inspector"
        aria-label="Inspector"
        data-testid="inspector"
      >
        <span className="eyebrow">Inspector</span>
        {open ? (
          <>
            <button type="button" className="btn small" onClick={() => setOpen(null)}>
              Close the editor
            </button>
            <EmbeddedEditor key={`${open.collection}:${open.id}`} {...open} />
          </>
        ) : (
          <p className="example-note">Pick an entry here to edit it in the inspector.</p>
        )}
        <UndoPanel />
      </aside>
    </>
  );
}

type Pane =
  | { kind: 'none' }
  | { kind: 'entry'; collection: EntriesCollection; id: string }
  | { kind: 'pick' }
  | { kind: 'new'; entryKind: EntryKind };

/** The list of every kind, its filters, and the editor beside it. */
function EntriesList(props: { onOpen: Open }) {
  const facts = useEntries('facts');
  const cultural = useEntries('culturalEntries');
  const places = useEntries('places');
  const glossary = useEntries('glossaryTerms');
  const themes = useEntries('themes');
  const questions = useEntries('openQuestions');
  const custom = useEntries('customEntries');
  const sections = useEntries('customSections');
  const ro = useWriteGuard();

  const kinds = useMemo(() => entryKinds(sections), [sections]);
  const byKey = useMemo(() => new Map(kinds.map((k) => [k.key, k])), [kinds]);
  /** Kinds turned off; every kind, a new custom section included, starts on. */
  const [off, setOff] = useState<ReadonlySet<string>>(new Set());
  const [status, setStatus] = useState<EntryStatus | null>(null);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<{ query: string; ids: ReadonlySet<string> }>({
    query: '',
    ids: new Set(),
  });
  const [pane, setPane] = useState<Pane>({ kind: 'none' });
  const ids = { status: useId(), search: useId(), title: useId() };

  // SR-1: the search channel also finds what plain text cannot, such as tone-free romanization.
  useEffect(() => {
    const q = query.trim();
    if (!q) return;
    let live = true;
    call('search.query', { query: q, collections: [...ENTRIES_COLLECTIONS], limit: 100 })
      .then((r) => {
        if (live) setHits({ query: q, ids: new Set(r.hits.map((h) => h.id)) });
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [query]);

  const rows = useMemo(() => {
    const all: EntriesRow[] = [];
    const add = (collection: EntriesCollection, list: readonly Record<string, unknown>[]) => {
      for (const entry of list) all.push({ collection, entry });
    };
    add('facts', facts);
    add('culturalEntries', cultural);
    add('places', places);
    add('glossaryTerms', glossary);
    add('themes', themes);
    add('openQuestions', questions);
    add('customEntries', custom);
    const on = new Set(kinds.map((k) => k.key).filter((k) => !off.has(k)));
    const q = query.trim();
    return filterEntries(all, {
      kinds: on,
      status,
      query: q,
      hits: hits.query === q ? hits.ids : undefined,
    });
  }, [
    facts,
    cultural,
    places,
    glossary,
    themes,
    questions,
    custom,
    kinds,
    off,
    status,
    query,
    hits,
  ]);

  const toggle = (key: string) =>
    setOff((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const openHere: Open = (collection, id) => {
    if (isListed(collection)) setPane({ kind: 'entry', collection, id });
    else props.onOpen(collection, id);
  };

  const selectedId = pane.kind === 'entry' ? pane.id : null;
  const inspector = (
    <aside className="inspector ws-inspector" aria-label="Inspector" data-testid="inspector">
      <span className="eyebrow">Inspector</span>
      <UndoPanel />
    </aside>
  );

  return (
    <>
      <section className="ws-list entries-list" aria-labelledby={ids.title}>
        <div className="list-head">
          <h2 id={ids.title}>Entries</h2>
          <button
            type="button"
            className="btn primary small"
            onClick={() => setPane({ kind: 'pick' })}
            disabled={ro.off}
            {...ro.tip}
          >
            New entry
          </button>
        </div>
        <div className="kind-chips" role="group" aria-label="Kinds">
          {kinds.map((k) => (
            <button
              key={k.key}
              type="button"
              className="btn small kind-chip"
              aria-pressed={!off.has(k.key)}
              data-kind={k.key}
              onClick={() => toggle(k.key)}
            >
              {k.plural}
            </button>
          ))}
        </div>
        <div className="field">
          <label htmlFor={ids.status}>Show status</label>
          <select
            id={ids.status}
            value={status ?? ''}
            onChange={(e) => setStatus((e.target.value || null) as EntryStatus | null)}
          >
            <option value="">Every status</option>
            {STATUSES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={ids.search}>Search entries</label>
          <input
            id={ids.search}
            type="search"
            placeholder="Title or text"
            autoComplete="off"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <p className="example-note" aria-live="polite" data-testid="entries-count">
          {rows.length === 1 ? '1 entry' : `${rows.length} entries`}
        </p>
        {rows.length === 0 ? (
          <p className="example-note" data-testid="entries-empty">
            Nothing matches. Turn on more kinds or clear the search.
          </p>
        ) : (
          <ul className="entry-list" data-testid="entries-list">
            {rows.map(({ collection, entry }) => {
              const kind = byKey.get(kindKeyOf(collection, entry));
              const line = firstLine(entry);
              const id = String(entry._id);
              return (
                <li key={`${collection}:${id}`}>
                  <button
                    type="button"
                    className="entry-row entries-row"
                    data-kind={kind?.key ?? collection}
                    data-id={id}
                    aria-current={selectedId === id ? 'true' : undefined}
                    onClick={() => setPane({ kind: 'entry', collection, id })}
                  >
                    <span className="row tight entries-row-head">
                      <span className="entries-kind">{kind?.label ?? 'Custom entry'}</span>
                      {typeof entry.status === 'string' && (
                        <span className={`chip ${entry.status}`}>{entry.status}</span>
                      )}
                    </span>
                    <span className="entry-title">
                      <Zh text={entryTitle(entry)} actions={false} />
                    </span>
                    {line && (
                      <span className="entries-line">
                        <Zh text={line} actions={false} />
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      {pane.kind === 'entry' ? (
        <EntryPane
          key={`${pane.collection}:${pane.id}`}
          collection={pane.collection}
          id={pane.id}
          onOpen={openHere}
          onClosed={() => setPane({ kind: 'none' })}
        />
      ) : pane.kind === 'pick' ? (
        <>
          <KindPicker
            kinds={kinds}
            onPick={(k) => setPane({ kind: 'new', entryKind: k })}
            onCancel={() => setPane({ kind: 'none' })}
          />
          {inspector}
        </>
      ) : pane.kind === 'new' ? (
        <>
          <NewEntryForm
            key={pane.entryKind.key}
            collection={pane.entryKind.collection}
            preset={pane.entryKind.sectionId ? { sectionId: pane.entryKind.sectionId } : undefined}
            onCreated={(id) => {
              const key = pane.entryKind.key;
              setOff((prev) => {
                if (!prev.has(key)) return prev;
                const next = new Set(prev);
                next.delete(key);
                return next;
              });
              setPane({ kind: 'entry', collection: pane.entryKind.collection, id });
            }}
            onCancel={() => setPane({ kind: 'none' })}
          />
          {inspector}
        </>
      ) : (
        <>
          <div className="ws-editor empty-editor stack">
            <p className="lede">Pick an entry to edit it, or make a new one.</p>
          </div>
          {inspector}
        </>
      )}
    </>
  );
}

/** New entry, step one: what kind. One button per kind, custom sections included. */
function KindPicker(props: {
  kinds: EntryKind[];
  onPick: (k: EntryKind) => void;
  onCancel: () => void;
}) {
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => first.current?.focus(), []);
  return (
    <section className="ws-editor" aria-labelledby="kind-pick-title" data-testid="kind-picker">
      <header className="editor-head">
        <div className="stack tight">
          <span className="eyebrow">New entry</span>
          <h2 id="kind-pick-title">What kind of entry?</h2>
        </div>
      </header>
      <div className="kind-pick" role="group" aria-label="Kind of entry">
        {props.kinds.map((k, i) => (
          <button
            key={k.key}
            ref={i === 0 ? first : undefined}
            type="button"
            className="btn"
            onClick={() => props.onPick(k)}
          >
            {k.label}
          </button>
        ))}
      </div>
      <div className="row">
        <button type="button" className="btn" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </section>
  );
}
