import { createCommand, renameCommand, restoreCommand } from '../../../shared/domain/undoRunner';
import { useEffect, useId, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { collectionInfo, entrySchemas, entryTitle, manifests } from '../../../shared/schema';
import type { EntryCollection } from '../../../shared/schema';
import type { Response, WireList } from '../../../shared/ipc';
import { blankEntry } from '../../../shared/domain/blank';
import { fieldIssues } from '../../../shared/domain/issues';
import type { FieldIssue } from '../../../shared/domain/issues';
import { itemPath } from '../../../shared/domain/lists';
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
  const info = collectionInfo[collection];
  const filterId = useId();

  useEffect(() => {
    let live = true;
    void call('entry.list', { collection, trash: 'exclude' }).then((r) => {
      if (live) setEntries(r.entries);
    });
    return () => {
      live = false;
    };
  }, [collection, version]);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (entries ?? [])
      .filter((e) => !q || entryTitle(e.entry).toLowerCase().includes(q))
      .sort((a, b) => entryTitle(a.entry).localeCompare(entryTitle(b.entry)));
  }, [entries, filter]);

  return (
    <section className="ws-list" aria-labelledby="list-title">
      <div className="list-head">
        <h2 id="list-title">{info.plural}</h2>
        <button type="button" className="btn primary small" onClick={props.onNew}>
          New {info.singular.toLowerCase()}
        </button>
      </div>
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

/** WE-2: gaps and overlaps in the eras from 2025 to 2100. A flag, never a block. */
function EraCoverage() {
  const { version } = useStore();
  const [messages, setMessages] = useState<string[] | null>(null);
  useEffect(() => {
    let live = true;
    void call('timeline.eraCoverage', {}).then((r) => {
      if (live) setMessages(r.messages);
    });
    return () => {
      live = false;
    };
  }, [version]);
  if (messages === null) return null;
  if (messages.length === 0) {
    return (
      <p className="example-note" data-testid="era-coverage-ok">
        The eras cover 2025 to 2100 with no gaps or overlaps.
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
}) {
  const { collection } = props;
  const undo = useUndo();
  const manifest = manifests[collection];
  const required = manifest.filter((s) => s.required && s.kind !== 'system');
  const [draft, setDraft] = useState<Entry>(() => blankEntry(manifest) as Entry);
  const [issues, setIssues] = useState<FieldIssue[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const info = collectionInfo[collection];

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const at = new Date().toISOString();
    const check = entrySchemas[collection].safeParse({
      ...draft,
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
      </form>
    </section>
  );
}

/** Entries in the trash, newest first, each restorable with its links (ED-5). */
export function TrashView(props: { onOpen: (collection: EntryCollection, id: string) => void }) {
  const { version } = useStore();
  const undo = useUndo();
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
      undo.record(
        renameCommand(
          list.label,
          list._id,
          itemId,
          r.from,
          label.trim(),
          list._id.startsWith('choice:') ? label.trim() : itemId,
        ),
      );
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
      await call('lists.addItem', { listId: list._id, label: newLabel, parentId: parent || null });
      setNewLabel('');
      setParent('');
    } catch (err) {
      setMessage({ text: plainError(err), bad: true });
    }
  };

  const remove = async (itemId: string) => {
    setMessage(null);
    try {
      await call('lists.removeItem', { listId: list._id, itemId });
    } catch (e) {
      setMessage({ text: plainError(e), bad: true });
    }
  };

  return (
    <div className="panel stack" data-list={list._id}>
      <h3>{list.label}</h3>
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
      {message && (
        <p className={message.bad ? 'callout crit' : 'callout'} role="status">
          {message.text}
        </p>
      )}
    </div>
  );
}
