import { createCommand, renameCommand, restoreCommand } from '../../../shared/domain/undoRunner';
import { listAddCommand, listRemoveCommand } from '../../../shared/undoCommands';
import { WriteFieldset, useWriteGuard } from '../connection';
import { useEffect, useId, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import {
  collectionInfo,
  entrySchemas,
  entryTitle,
  manifests,
  withoutDerived,
} from '../../../shared/schema';
import type { EntryCollection } from '../../../shared/schema';
import type { Response, WireList } from '../../../shared/ipc';
import { blankEntry } from '../../../shared/domain/blank';
import { fieldIssues } from '../../../shared/domain/issues';
import type { FieldIssue } from '../../../shared/domain/issues';
import { itemPath } from '../../../shared/domain/lists';
import { filterQuestions, questionCounts } from '../../../shared/domain/questions';
import type { QuestionFilter } from '../../../shared/domain/questions';
import { logsNewestFirst } from '../../../shared/domain/sessionLog';
import { call, plainError } from '../api';
import { useStore } from './data';
import type { Entry } from './data';
import { Field } from './fields';
import { Zh } from './Zh';
import { formatTime } from './format';
import { useUndo } from './undo';

type Listed = Response<'entry.list'>['entries'][number];

/** The entries of one section, with a filter and a button to make a new one. */
export function EntryList(props: {
  collection: EntryCollection;
  selected: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
}) {
  const { collection } = props;
  const { version } = useStore();
  const [entries, setEntries] = useState<Listed[] | null>(null);
  const [filter, setFilter] = useState('');
  const [state, setState] = useState<QuestionFilter>('all');
  const info = collectionInfo[collection];
  const filterId = useId();
  const stateId = useId();
  const heading = info.plural;

  useEffect(() => {
    let live = true;
    void call('entry.list', { collection, trash: 'exclude' }).then((r) => {
      if (live) setEntries(r.entries);
    });
    return () => {
      live = false;
    };
  }, [collection, version]);

  const counts = useMemo(() => questionCounts((entries ?? []).map((e) => e.entry)), [entries]);
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    let rows = entries ?? [];
    if (collection === 'openQuestions') {
      const keep = new Set(
        filterQuestions(
          rows.map((r) => r.entry),
          state,
        ).map((e) => e._id),
      );
      rows = rows.filter((r) => keep.has(r.entry._id));
    }
    rows = rows.filter((e) => !q || entryTitle(e.entry).toLowerCase().includes(q));
    if (collection === 'sessionLogs') {
      const order = new Map(logsNewestFirst(rows.map((r) => r.entry)).map((e, i) => [e._id, i]));
      return rows.sort((a, b) => (order.get(a.entry._id) ?? 0) - (order.get(b.entry._id) ?? 0));
    }
    return rows.sort((a, b) => entryTitle(a.entry).localeCompare(entryTitle(b.entry)));
  }, [entries, filter, state, collection]);

  const ro = useWriteGuard();
  return (
    <section className="ws-list" aria-labelledby="list-title">
      <div className="list-head">
        <h2 id="list-title">{heading}</h2>
        <button
          type="button"
          className="btn primary small"
          onClick={props.onNew}
          disabled={ro.off}
          {...ro.tip}
        >
          New {info.singular.toLowerCase()}
        </button>
      </div>
      {collection === 'openQuestions' && (
        <div className="field">
          <label htmlFor={stateId}>Show questions</label>
          <select
            id={stateId}
            value={state}
            onChange={(e) => setState(e.target.value as QuestionFilter)}
          >
            <option value="all">All ({counts.open + counts.decided})</option>
            <option value="open">Open ({counts.open})</option>
            <option value="decided">Decided ({counts.decided})</option>
          </select>
        </div>
      )}
      {collection === 'eraStates' && <EraCoverage />}
      <label htmlFor={filterId} className="sr-only">
        Filter {info.plural.toLowerCase()}
      </label>
      <input
        id={filterId}
        type="search"
        placeholder={`Filter ${info.plural.toLowerCase()}`}
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      {entries === null ? (
        <p aria-live="polite">Loading.</p>
      ) : shown.length === 0 ? (
        <p className="example-note">
          {entries.length === 0 ? `No ${info.plural.toLowerCase()} yet.` : 'Nothing matches.'}
        </p>
      ) : (
        <ul className="entry-list" data-testid="entry-list">
          {shown.map(({ entry, warnings }) => (
            <li key={entry._id}>
              <button
                type="button"
                className="entry-row"
                aria-current={props.selected === entry._id ? 'true' : undefined}
                onClick={() => props.onSelect(entry._id)}
              >
                <span className="entry-title">
                  <Zh text={entryTitle(entry)} actions={false} />
                </span>
                <span className="row tight">
                  {collection === 'openQuestions' && (
                    <span className="chip" data-state={String(entry.state ?? 'open')}>
                      {entry.state === 'decided' ? 'decided' : 'open'}
                    </span>
                  )}
                  {typeof entry.status === 'string' && (
                    <span className={`chip ${entry.status}`}>{entry.status}</span>
                  )}
                  {warnings.length > 0 && (
                    <span className="chip warn-chip" title="Fields with warnings">
                      {warnings.length} {warnings.length === 1 ? 'warning' : 'warnings'}
                    </span>
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** WE-2: gaps and overlaps in the eras across the bible's timeline (IP-11). A flag, never a block. */
export function EraCoverage() {
  const { version } = useStore();
  const [messages, setMessages] = useState<string[] | null>(null);
  const [span, setSpan] = useState({ from: 2025, to: 2100 }); // a47-model
  useEffect(() => {
    let live = true;
    void call('timeline.eraCoverage', {}).then((r) => {
      if (!live) return;
      setMessages(r.messages);
      setSpan({ from: r.coverage.from, to: r.coverage.to });
    });
    return () => {
      live = false;
    };
  }, [version]);
  if (messages === null) return null;
  if (messages.length === 0) {
    return (
      <p className="example-note" data-testid="era-coverage-ok">
        The eras cover {span.from} to {span.to} with no gaps or overlaps.
      </p>
    );
  }
  return (
    <div className="callout warn stack tight" role="status" data-testid="era-coverage">
      <strong>Era coverage</strong>
      {messages.map((m) => (
        <span key={m}>{m}</span>
      ))}
      <span>These are flags only. Every era still saves.</span>
    </div>
  );
}

/** A form with the fields a new entry must have; everything else is edited after (ED-1). */
export function NewEntryForm(props: {
  collection: EntryCollection;
  onCreated: (id: string) => void;
  onCancel: () => void;
  /** Fields already decided. They are not asked for. */
  preset?: Record<string, unknown>;
}) {
  const { collection, preset } = props;
  const undo = useUndo();
  const manifest = manifests[collection];
  // SM-1: a new character asks for the full name only; the title follows it and the birth starts unknown.
  const isCharacter = collection === 'characters';
  const required = isCharacter
    ? []
    : manifest.filter((s) => s.required && s.kind !== 'system' && !(preset && s.name in preset));
  const [draft, setDraft] = useState<Entry>(
    () => ({ ...blankEntry(manifest), ...preset }) as Entry,
  );
  const fullNameId = useId();
  const fullName = isCharacter
    ? String((draft.names as { full?: string } | undefined)?.full ?? '')
    : '';
  const setFullName = (v: string) =>
    setDraft((d) => ({ ...d, title: v, names: { ...(d.names as object), full: v } }));
  const [issues, setIssues] = useState<FieldIssue[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const info = collectionInfo[collection];

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const at = new Date().toISOString();
    const check = entrySchemas[collection].safeParse({
      ...withoutDerived(collection, draft),
      _id: 'NEW',
      createdAt: at,
      modifiedAt: at,
    });
    if (!check.success) {
      setIssues(fieldIssues(check.error.issues));
      return;
    }
    setIssues([]);
    setBusy(true);
    try {
      const { entry } = await call('entry.create', { collection, data: draft });
      undo.record(createCommand(collection, entry._id, entryTitle(entry)));
      props.onCreated(entry._id);
    } catch (err) {
      setError(plainError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="ws-editor" aria-labelledby="new-title">
      <header className="editor-head">
        <div className="stack tight">
          <span className="eyebrow">New entry</span>
          <h2 id="new-title">New {info.singular.toLowerCase()}</h2>
        </div>
      </header>
      <p className="example-note">
        Fill in what this entry needs to exist. Every other field is editable once it is made.
      </p>
      <form className="editor-fields" onSubmit={(e) => void submit(e)} data-testid="new-entry">
        <WriteFieldset>
          {isCharacter && (
            <div className="field" data-field="names.full">
              <label htmlFor={fullNameId}>Full name</label>
              <input
                id={fullNameId}
                type="text"
                autoComplete="off"
                value={fullName}
                aria-invalid={issues.some((i) => i.path.startsWith('names') || i.path === 'title')}
                onChange={(ev) => setFullName(ev.target.value)}
              />
              {issues.some((i) => i.path.startsWith('names') || i.path === 'title') && (
                <p className="ed-error" role="alert">
                  A character needs a full name.
                </p>
              )}
            </div>
          )}
          {required.map((spec) => (
            <Field
              key={spec.name}
              spec={spec}
              value={draft[spec.name]}
              path={spec.name}
              messages={{ warnings: [], issues }}
              root={draft}
              onMention={() => undefined}
              onChange={(v) => setDraft((d) => ({ ...d, [spec.name]: v }))}
            />
          ))}
          {error && (
            <p className="callout crit" role="alert">
              {error}
            </p>
          )}
          <div className="row">
            <button type="submit" className="btn primary" disabled={busy}>
              Create {info.singular.toLowerCase()}
            </button>
            <button type="button" className="btn" onClick={props.onCancel}>
              Cancel
            </button>
          </div>
        </WriteFieldset>
      </form>
    </section>
  );
}

/** Entries in the trash, newest first, each restorable with its links (ED-5). */
export function TrashView(props: { onOpen: (collection: EntryCollection, id: string) => void }) {
  const { version } = useStore();
  const undo = useUndo();
  const ro = useWriteGuard();
  const [entries, setEntries] = useState<Response<'trash.list'>['entries'] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void call('trash.list', {}).then((r) => {
      if (live) setEntries(r.entries);
    });
    return () => {
      live = false;
    };
  }, [version]);

  const restore = async (collection: EntryCollection, id: string, title: string) => {
    setError(null);
    try {
      await call('entry.restore', { collection, id });
      const { count } = await call('entry.linkedFrom', { id });
      undo.record(restoreCommand(collection, id, title));
      setDone(
        `${title} is back${count ? `, with ${count} ${count === 1 ? 'entry' : 'entries'} linking to it` : ''}.`,
      );
    } catch (e) {
      setError(plainError(e));
    }
  };

  return (
    <section className="ws-wide stack" aria-labelledby="trash-title">
      <h2 id="trash-title">Trash</h2>
      <p className="lede">
        Deleted entries wait here with their links. Restore one to bring it back as it was.
      </p>
      {done && (
        <p className="callout" role="status">
          {done}
        </p>
      )}
      {error && (
        <p className="callout crit" role="alert">
          {error}
        </p>
      )}
      {entries === null ? (
        <p>Loading.</p>
      ) : entries.length === 0 ? (
        <p className="example-note" data-testid="trash-empty">
          The trash is empty.
        </p>
      ) : (
        <ul className="trash-list" data-testid="trash-list">
          {entries.map(({ collection, entry }) => (
            <li key={`${collection}:${entry._id}`}>
              <span>
                <span className="eyebrow">{collectionInfo[collection].singular}</span>{' '}
                <strong>{entryTitle(entry)}</strong>{' '}
                <span className="example-note">moved {formatTime(entry.deletedAt)}</span>
              </span>
              <span className="row tight">
                <button
                  type="button"
                  className="btn small"
                  onClick={() => props.onOpen(collection, entry._id)}
                >
                  Open
                </button>
                <button
                  type="button"
                  className="btn small primary"
                  onClick={() => void restore(collection, entry._id, entryTitle(entry))}
                  disabled={ro.off}
                  {...ro.tip}
                >
                  Restore {entryTitle(entry)}
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Every editable list, with rename, add, and remove (ED-8). */
export function ListsView() {
  const { lists } = useStore();
  return (
    <section className="ws-wide stack" aria-labelledby="lists-title">
      <h2 id="lists-title">Lists</h2>
      <p className="lede">
        Types, communities, tags, family names, section names, and eras. Renaming an item updates
        every entry that uses it.
      </p>
      <div className="lists-grid">
        {lists.map((l) => (
          <ListPanel key={l._id} list={l} />
        ))}
      </div>
    </section>
  );
}

function ListPanel({ list }: { list: WireList }) {
  const undo = useUndo();
  const [editing, setEditing] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [parent, setParent] = useState('');
  const [message, setMessage] = useState<{ text: string; bad: boolean } | null>(null);
  const addId = useId();
  const parentId = useId();
  const hierarchical = list._id === 'eventCategories';
  const asDoc = { _id: list._id, label: list.label, items: list.items };

  const rename = async (itemId: string) => {
    setMessage(null);
    try {
      const r = await call('lists.rename', { listId: list._id, itemId, label });
      undo.record(renameCommand(list.label, list._id, itemId, r.from, label.trim(), itemId));
      setMessage({
        text:
          r.updated > 0
            ? `Renamed. ${r.updated} ${r.updated === 1 ? 'entry was' : 'entries were'} updated.`
            : 'Renamed. Every entry shows the new name.',
        bad: false,
      });
      setEditing(null);
    } catch (e) {
      setMessage({ text: plainError(e), bad: true });
    }
  };

  const add = async (e: FormEvent) => {
    e.preventDefault();
    setMessage(null);
    try {
      const { item } = await call('lists.addItem', {
        listId: list._id,
        label: newLabel,
        parentId: parent || null,
      });
      undo.record(listAddCommand(call, list.label, list._id, item));
      setNewLabel('');
      setParent('');
    } catch (err) {
      setMessage({ text: plainError(err), bad: true });
    }
  };

  const remove = async (itemId: string) => {
    setMessage(null);
    const item = list.items.find((i) => i.id === itemId);
    try {
      await call('lists.removeItem', { listId: list._id, itemId });
      if (item) {
        undo.record(
          listRemoveCommand(call, list.label, list._id, {
            id: item.id,
            label: item.label,
            parentId: item.parentId,
          }),
        );
      }
    } catch (e) {
      setMessage({ text: plainError(e), bad: true });
    }
  };

  return (
    <div className="panel stack" data-list={list._id}>
      <h3>{list.label}</h3>
      <WriteFieldset className="stack tight">
        {list.items.length === 0 ? (
          <p className="example-note">No items yet.</p>
        ) : (
          <ul className="list-items">
            {list.items.map((item) => (
              <li key={item.id}>
                {editing === item.id ? (
                  <form
                    className="row tight"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void rename(item.id);
                    }}
                  >
                    <label className="sr-only" htmlFor={`rename-${list._id}-${item.id}`}>
                      New name for {item.label}
                    </label>
                    <input
                      id={`rename-${list._id}-${item.id}`}
                      value={label}
                      autoFocus
                      onChange={(e) => setLabel(e.target.value)}
                    />
                    <button type="submit" className="btn small primary" disabled={!label.trim()}>
                      Save name
                    </button>
                    <button type="button" className="btn small" onClick={() => setEditing(null)}>
                      Cancel
                    </button>
                  </form>
                ) : (
                  <div className="row tight item-row">
                    <span className="item-label">
                      {hierarchical ? itemPath(asDoc, item.id) : item.label}
                    </span>
                    {item.detail && <span className="example-note">{item.detail}</span>}
                    <span className="example-note">
                      {item.usage === 1 ? 'used once' : `used ${item.usage} times`}
                    </span>
                    <button
                      type="button"
                      className="btn small"
                      aria-label={`Rename ${item.label}`}
                      onClick={() => {
                        setEditing(item.id);
                        setLabel(item.label);
                      }}
                    >
                      Rename
                    </button>
                    {!list.fixedItems && (
                      <button
                        type="button"
                        className="btn small danger"
                        aria-label={`Remove ${item.label}`}
                        onClick={() => void remove(item.id)}
                      >
                        Remove
                      </button>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {!list.fixedItems && (
          <form className="row tight" onSubmit={(e) => void add(e)}>
            <label className="sr-only" htmlFor={addId}>
              New item for {list.label}
            </label>
            <input
              id={addId}
              value={newLabel}
              placeholder="New item"
              onChange={(e) => setNewLabel(e.target.value)}
            />
            {hierarchical && (
              <>
                <label className="sr-only" htmlFor={parentId}>
                  Inside
                </label>
                <select id={parentId} value={parent} onChange={(e) => setParent(e.target.value)}>
                  <option value="">At the top</option>
                  {list.items.map((i) => (
                    <option key={i.id} value={i.id}>
                      Inside {itemPath(asDoc, i.id)}
                    </option>
                  ))}
                </select>
              </>
            )}
            <button type="submit" className="btn small" disabled={!newLabel.trim()}>
              Add to {list.label}
            </button>
          </form>
        )}
      </WriteFieldset>
      {message && (
        <p className={message.bad ? 'callout crit' : 'callout'} role="status">
          {message.text}
        </p>
      )}
    </div>
  );
}
