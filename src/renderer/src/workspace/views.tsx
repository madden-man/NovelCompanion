import { createCommand, restoreCommand } from '../../../shared/domain/undoRunner';
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
import type { Response } from '../../../shared/ipc';
import { blankEntry } from '../../../shared/domain/blank';
import { fieldIssues } from '../../../shared/domain/issues';
import type { FieldIssue } from '../../../shared/domain/issues';
import { filterQuestions, questionCounts } from '../../../shared/domain/questions';
import type { QuestionFilter } from '../../../shared/domain/questions';
import { logsNewestFirst } from '../../../shared/domain/sessionLog';
import { call, plainError } from '../api';
import { useStore } from './data';
import { ListChip } from './listChip';
import type { Entry } from './data';
import { Field } from './fields';
import { Zh } from './Zh';
import { formatTime } from './format';
import { useUndo } from './undo';
import { EntryEditable } from './editable';
import { TypedConfirm } from './housekeeping';

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
  // IP-1, IP-13: every row renames in place; New character takes the name in the list.
  const inPlace = collection === 'characters';
  const rename = renameSpec(collection);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [naming, setNaming] = useState(false);
  return (
    <section className="ws-list" aria-labelledby="list-title">
      <div className="list-head">
        <h2 id="list-title">{heading}</h2>
        <button
          type="button"
          className="btn primary small"
          onClick={inPlace ? () => setNaming(true) : props.onNew}
          disabled={ro.off}
          {...ro.tip}
        >
          New {info.singular.toLowerCase()}
        </button>
      </div>
      {inPlace && naming && (
        <NewCharacterRow
          onCreated={(id) => {
            setNaming(false);
            props.onSelect(id);
          }}
          onCancel={() => setNaming(false)}
        />
      )}
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
              {renaming === entry._id ? (
                <div className="entry-row entry-row-renaming" data-testid="row-rename">
                  <EntryEditable
                    collection={collection}
                    id={entry._id}
                    path={rename.path}
                    label={rename.label}
                    kind="text"
                    allowEmpty={false}
                    autoOpen
                    entry={entry}
                    extraPatch={rename.extraPatch}
                    onClose={() => {
                      const id = entry._id;
                      setRenaming(null);
                      // The row comes back under the caret, so the keyboard carries on from it,
                      // unless the field closed because the writer clicked or tabbed elsewhere.
                      requestAnimationFrame(() => {
                        const at = document.activeElement;
                        if (at && at !== document.body) return;
                        document
                          .querySelector<HTMLElement>(`.entry-row[data-entry-id="${id}"]`)
                          ?.focus();
                      });
                    }}
                  />
                </div>
              ) : (
                <button
                  type="button"
                  className="entry-row"
                  data-entry-id={entry._id}
                  aria-current={props.selected === entry._id ? 'true' : undefined}
                  aria-keyshortcuts="F2"
                  title={!ro.off ? 'Double-click or press F2 to rename' : undefined}
                  onClick={() => props.onSelect(entry._id)}
                  onDoubleClick={!ro.off ? () => setRenaming(entry._id) : undefined}
                  onKeyDown={
                    !ro.off
                      ? (e) => {
                          if (e.key === 'F2') {
                            e.preventDefault();
                            setRenaming(entry._id);
                          }
                        }
                      : undefined
                  }
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
                      <ListChip listId="statuses" id={entry.status} />
                    )}
                    {warnings.length > 0 && (
                      <span className="chip warn-chip" title="Fields with warnings">
                        {warnings.length} {warnings.length === 1 ? 'warning' : 'warnings'}
                      </span>
                    )}
                  </span>
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * IP-13: which field a row's rename writes. A character's full name (the title
 * follows it), a family's or an era's name (a title that holds the old name
 * follows it), and every other entry's title.
 */
function renameSpec(collection: EntryCollection): {
  path: string;
  label: string;
  extraPatch?: (next: unknown, entry: Record<string, unknown>) => Record<string, unknown>;
} {
  if (collection === 'characters') {
    return { path: 'names.full', label: 'Full name', extraPatch: (next) => ({ title: next }) };
  }
  if (collection === 'families' || collection === 'eraStates') {
    return {
      path: 'name',
      label: collection === 'families' ? 'Family name' : 'Era name',
      extraPatch: (next, entry) => {
        const old = typeof entry.name === 'string' ? entry.name : '';
        const title = typeof entry.title === 'string' ? entry.title : '';
        if (!title.trim() || title === old) return { title: next };
        return old && title.includes(old) ? { title: title.split(old).join(String(next)) } : {};
      },
    };
  }
  return { path: 'title', label: 'Title' };
}

/**
 * IP-1, SM-1: New character on the Characters list asks for the full name in
 * a row at the top of the list. Enter makes the character (one undo step) and
 * opens its page; Escape or Cancel puts the row away.
 */
function NewCharacterRow(props: { onCreated: (id: string) => void; onCancel: () => void }) {
  const undo = useUndo();
  const nameId = useId();
  const errorId = useId();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const full = name.trim();
    if (!full) {
      setError('A character needs a full name.');
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const data = { ...blankEntry(manifests.characters), title: full, names: { full } };
      const { entry } = await call('entry.create', { collection: 'characters', data });
      undo.record(createCommand('characters', entry._id, entryTitle(entry)));
      props.onCreated(entry._id);
    } catch (err) {
      setError(plainError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="new-row stack tight"
      data-testid="new-entry"
      aria-label="New character"
      onSubmit={(e) => void submit(e)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          props.onCancel();
        }
      }}
    >
      <WriteFieldset className="stack tight">
        <div className="field" data-field="names.full">
          <label htmlFor={nameId}>Full name</label>
          <input
            id={nameId}
            type="text"
            autoComplete="off"
            autoFocus
            value={name}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            onChange={(ev) => setName(ev.target.value)}
          />
          {error && (
            <p id={errorId} className="ed-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <div className="row tight">
          <button type="submit" className="btn primary small" disabled={busy}>
            Create character
          </button>
          <button type="button" className="btn small" onClick={props.onCancel}>
            Cancel
          </button>
        </div>
      </WriteFieldset>
    </form>
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

/**
 * Entries in the trash, newest first, each restorable with its links (ED-5).
 * IP-16: Delete forever per entry (type its title) and Empty trash (type
 * "empty"); both take the revisions with them and are not undo steps.
 */
export function TrashView(props: { onOpen: (collection: EntryCollection, id: string) => void }) {
  const { version } = useStore();
  const undo = useUndo();
  const ro = useWriteGuard();
  const [entries, setEntries] = useState<Response<'trash.list'>['entries'] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [asking, setAsking] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    let live = true;
    void call('trash.list', {}).then((r) => {
      if (live) setEntries(r.entries);
    });
    return () => {
      live = false;
    };
  }, [version, reloads]);

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

  const revisionsWord = (n: number) => (n === 1 ? '1 revision' : `${n} revisions`);
  const purge = async (collection: EntryCollection, id: string, title: string) => {
    const r = await call('entry.purge', { collection, id });
    setAsking(null);
    setDone(
      `Deleted ${title} forever, with ${revisionsWord(r.revisions)}. This is not an undo step.`,
    );
    setReloads((n) => n + 1);
  };
  const empty = async () => {
    const r = await call('trash.empty', {});
    setAsking(null);
    setDone(
      `Emptied the trash: ${r.entries === 1 ? '1 entry' : `${r.entries} entries`} and ${revisionsWord(r.revisions)} deleted forever. This is not an undo step.`,
    );
    setReloads((n) => n + 1);
  };
  const count = entries?.length ?? 0;

  return (
    <section className="ws-wide stack" aria-labelledby="trash-title" data-testid="trash-view">
      <h2 id="trash-title">Trash</h2>
      <p className="lede">
        Deleted entries wait here with their links. Restore one to bring it back as it was. Delete
        forever removes it and its history for good; undo cannot bring it back.
      </p>
      {count > 0 && (
        <div className="stack tight">
          <div className="row">
            <button
              type="button"
              className="btn small danger"
              disabled={ro.off || asking === 'empty'}
              {...ro.tip}
              data-testid="trash-empty-all"
              onClick={() => {
                setDone(null);
                setAsking('empty');
              }}
            >
              Empty trash
            </button>
          </div>
          {asking === 'empty' && (
            <TypedConfirm
              word="empty"
              action={`Delete all ${count === 1 ? '1 entry' : `${count} entries`} forever`}
              testId="trash-empty-confirm"
              onConfirm={empty}
              onCancel={() => setAsking(null)}
            >
              {count === 1 ? '1 entry' : `${count} entries`} and every revision of{' '}
              {count === 1 ? 'it' : 'them'} will be deleted forever. This is not an undo step.
            </TypedConfirm>
          )}
        </div>
      )}
      {done && (
        <p className="callout" role="status" data-testid="trash-notice">
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
          {entries.map(({ collection, entry }) => {
            const key = `${collection}:${entry._id}`;
            const title = entryTitle(entry);
            return (
              <li key={key} data-id={entry._id}>
                <span>
                  <span className="eyebrow">{collectionInfo[collection].singular}</span>{' '}
                  <strong>{title}</strong>{' '}
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
                    onClick={() => void restore(collection, entry._id, title)}
                    disabled={ro.off}
                    {...ro.tip}
                  >
                    Restore {title}
                  </button>
                  <button
                    type="button"
                    className="btn small danger"
                    onClick={() => {
                      setDone(null);
                      setAsking(key);
                    }}
                    disabled={ro.off || asking === key}
                    {...ro.tip}
                  >
                    Delete {title} forever
                  </button>
                </span>
                {asking === key && (
                  <TypedConfirm
                    word={title}
                    action={`Delete ${title} forever`}
                    testId="trash-purge-confirm"
                    onConfirm={() => purge(collection, entry._id, title)}
                    onCancel={() => setAsking(null)}
                  >
                    {title} and every revision of it will be deleted forever. This is not an undo
                    step.
                  </TypedConfirm>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** The Lists screen moved to `listsScreen.tsx` (A47, a47-vocab). */
export { ListsView } from './listsScreen';
