import { useCallback, useEffect, useRef, useState } from 'react';
import {
  collectionInfo,
  editableFields,
  entrySchemas,
  entryTitle,
  manifests,
} from '../../../shared/schema';
import type { EntryCollection } from '../../../shared/schema';
import type { Response } from '../../../shared/ipc';
import { patchBetween } from '../../../shared/domain/diff';
import { fieldIssues, labelPath } from '../../../shared/domain/issues';
import type { FieldIssue } from '../../../shared/domain/issues';
import type { FieldWarning } from '../../../shared/domain/warnings';
import { call, plainError } from '../api';
import type { Entry } from './data';
import { Field } from './fields';
import { formatTime } from './format';
import { HistoryDrawer } from './history';
import { useUndo } from './undo';

export type SaveStatus = 'loading' | 'saved' | 'pending' | 'saving' | 'error' | 'missing';

type Backlink = Response<'entry.get'>['backlinks'][number];

/** Debounce for autosave, and the longest a change may wait while typing goes on (ED-2). */
export const AUTOSAVE_DEBOUNCE_MS = 500;
export const AUTOSAVE_MAX_WAIT_MS = 900;

/**
 * Autosave for one entry (ED-2): every change updates the draft at once and
 * is written 500 ms after the last keystroke, and never more than 900 ms after
 * the first unsaved one. Each save becomes one undo command (ED-3).
 */
function useAutosave(collection: EntryCollection, id: string) {
  const undo = useUndo();
  const [draft, setDraft] = useState<Entry | null>(null);
  const [warnings, setWarnings] = useState<FieldWarning[]>([]);
  const [backlinks, setBacklinks] = useState<Backlink[]>([]);
  const [issues, setIssues] = useState<FieldIssue[]>([]);
  const [status, setStatus] = useState<SaveStatus>('loading');
  const [error, setError] = useState<string | null>(null);
  const saved = useRef<Entry | null>(null);
  const current = useRef<Entry | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const firstPending = useRef<number | null>(null);
  const inflight = useRef<Promise<void> | null>(null);

  const [reloads, setReloads] = useState(0);
  const reload = useCallback(() => setReloads((n) => n + 1), []);

  useEffect(() => {
    let live = true;
    call('entry.get', { collection, id })
      .then((r) => {
        if (!live) return;
        saved.current = r.entry as Entry;
        current.current = r.entry as Entry;
        setDraft(r.entry as Entry);
        setWarnings(r.warnings);
        setBacklinks(r.backlinks);
        setIssues([]);
        setError(null);
        setStatus('saved');
      })
      .catch(() => {
        if (live) setStatus('missing');
      });
    return () => {
      live = false;
    };
  }, [collection, id, reloads]);

  const save = useCallback(async (): Promise<void> => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (inflight.current) await inflight.current;
    // Loop so changes typed while a save was in flight go out next.
    for (;;) {
      const base = saved.current;
      const target = current.current;
      if (!base || !target) return;
      const { forward, backward } = patchBetween(base, target);
      if (Object.keys(forward).length === 0) {
        firstPending.current = null;
        setStatus('saved');
        return;
      }
      const check = entrySchemas[collection].safeParse(target);
      if (!check.success) {
        setIssues(fieldIssues(check.error.issues));
        setStatus('error');
        setError(null);
        return;
      }
      setIssues([]);
      setStatus('saving');
      const run = call('entry.update', { collection, id, patch: forward }).then(
        (r) => {
          const entry = r.entry as Entry;
          saved.current = entry;
          setWarnings(r.warnings);
          setError(null);
          const labels = Object.keys(forward).map((k) => labelPath(manifests[collection], k));
          undo.record({
            label: `Changed ${labels.join(', ')} on ${entryTitle(entry)}`,
            undo: [{ kind: 'update', collection, id, patch: backward }],
            redo: [{ kind: 'update', collection, id, patch: forward }],
          });
          if (current.current === target) {
            current.current = entry;
            setDraft(entry);
            firstPending.current = null;
            setStatus('saved');
          } else {
            setStatus('pending');
          }
          return true;
        },
        (e: unknown) => {
          setError(plainError(e));
          setStatus('error');
          return false;
        },
      );
      inflight.current = run.then(() => undefined);
      const ok = await run;
      inflight.current = null;
      if (!ok || current.current === saved.current) return;
    }
  }, [collection, id, undo]);

  const setField = useCallback(
    (name: string, value: unknown) => {
      if (!current.current) return;
      const next = { ...current.current, [name]: value } as Entry;
      current.current = next;
      setDraft(next);
      setStatus('pending');
      const now = Date.now();
      firstPending.current ??= now;
      const waited = now - firstPending.current;
      const delay = Math.max(0, Math.min(AUTOSAVE_DEBOUNCE_MS, AUTOSAVE_MAX_WAIT_MS - waited));
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void save(), delay);
    },
    [save],
  );

  const flush = useCallback(async () => {
    if (timer.current || inflight.current) await save();
  }, [save]);

  useEffect(() => undo.registerFlush(flush), [undo, flush]);

  // Save what is pending when the editor closes.
  useEffect(
    () => () => {
      if (timer.current) void save();
    },
    [save],
  );

  // Another writer (undo, a restore, a rename) changed something: reload when nothing is pending.
  useEffect(
    () =>
      window.api.on('bible.changed', () => {
        if (!timer.current && !inflight.current && current.current === saved.current) reload();
      }),
    [reload],
  );

  return { draft, warnings, backlinks, issues, status, error, setField, flush, reload };
}

export function SaveState({ status, error }: { status: SaveStatus; error: string | null }) {
  const text =
    status === 'saved'
      ? 'Saved'
      : status === 'saving'
        ? 'Saving'
        : status === 'pending'
          ? 'Saving soon'
          : status === 'loading'
            ? 'Loading'
            : status === 'missing'
              ? 'Not found'
              : `Not saved${error ? `: ${error}` : '. Fix the marked fields.'}`;
  return (
    <span className={`autosave ${status}`} data-testid="autosave" role="status" aria-live="polite">
      {text}
    </span>
  );
}

/** The editor in the middle and the inspector on the right for one entry. */
export function EntryPane(props: {
  collection: EntryCollection;
  id: string;
  onOpen: (collection: EntryCollection, id: string) => void;
  onClosed: () => void;
}) {
  const { collection, id } = props;
  const ed = useAutosave(collection, id);
  const undo = useUndo();
  const [showHistory, setShowHistory] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<Response<'entry.linkedFrom'> | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const info = collectionInfo[collection];
  const manifest = manifests[collection];
  const draft = ed.draft;

  const onMention = (targetId: string) => {
    const links = Array.isArray(draft?.links)
      ? (draft.links as { targetId: string; kind: string }[])
      : [];
    if (!links.some((l) => l.targetId === targetId)) {
      ed.setField('links', [...links, { targetId, kind: 'mention' }]);
    }
  };

  const askDelete = async () => {
    setActionError(null);
    await ed.flush();
    setConfirmDelete(await call('entry.linkedFrom', { id }));
  };

  const doDelete = async () => {
    try {
      await call('entry.delete', { collection, id });
      undo.record({
        label: `Moved ${entryTitle(draft ?? undefined)} to the trash`,
        undo: [{ kind: 'restore', collection, id }],
        redo: [{ kind: 'delete', collection, id }],
      });
      setConfirmDelete(null);
      ed.reload();
    } catch (e) {
      setActionError(plainError(e));
    }
  };

  const doRestore = async () => {
    try {
      await call('entry.restore', { collection, id });
      undo.record({
        label: `Restored ${entryTitle(draft ?? undefined)} from the trash`,
        undo: [{ kind: 'delete', collection, id }],
        redo: [{ kind: 'restore', collection, id }],
      });
      ed.reload();
    } catch (e) {
      setActionError(plainError(e));
    }
  };

  if (ed.status === 'missing') {
    return (
      <div className="ws-editor">
        <p className="callout warn">This entry no longer exists.</p>
        <button type="button" className="btn" onClick={props.onClosed}>
          Back to the list
        </button>
      </div>
    );
  }
  if (!draft) {
    return (
      <div className="ws-editor">
        <p aria-live="polite">Loading the entry.</p>
      </div>
    );
  }
  const inTrash = Boolean(draft.deletedAt);
  const messages = { warnings: ed.warnings, issues: ed.issues };

  return (
    <>
      <section
        className="ws-editor"
        aria-labelledby="editor-title"
        data-testid="editor"
        data-entry-id={id}
      >
        <header className="editor-head">
          <div className="stack tight">
            <span className="eyebrow">{info.singular}</span>
            <h2 id="editor-title">{entryTitle(draft)}</h2>
          </div>
          <SaveState status={ed.status} error={ed.error} />
        </header>
        {inTrash && (
          <p className="callout warn" role="status">
            This entry is in the trash. Restore it to bring it back with its links.
          </p>
        )}
        <form className="editor-fields" onSubmit={(e) => e.preventDefault()}>
          {editableFields(manifest).map((spec) => (
            <Field
              key={spec.name}
              spec={spec}
              value={draft[spec.name]}
              path={spec.name}
              messages={messages}
              root={draft}
              onMention={onMention}
              onChange={(v) => ed.setField(spec.name, v)}
            />
          ))}
        </form>
      </section>
      <aside className="inspector ws-inspector" aria-label="Inspector" data-testid="inspector">
        <span className="eyebrow">Inspector</span>
        <div className="stack">
          <h3>{entryTitle(draft)}</h3>
          <SaveState status={ed.status} error={ed.error} />
          {ed.warnings.length > 0 && (
            <p className="callout warn" data-testid="warning-count">
              {ed.warnings.length === 1
                ? '1 field has a warning. It still saved.'
                : `${ed.warnings.length} fields have warnings. They still saved.`}
            </p>
          )}
          <UndoPanel />
          <div className="stack tight">
            <span className="eyebrow">Linked from</span>
            <Backlinks backlinks={ed.backlinks} onOpen={props.onOpen} />
          </div>
          <dl className="kv">
            <dt>Created</dt>
            <dd>{formatTime(draft.createdAt)}</dd>
            <dt>Last changed</dt>
            <dd>{formatTime(draft.modifiedAt)}</dd>
          </dl>
          <div className="row">
            <button type="button" className="btn" onClick={() => setShowHistory(true)}>
              History
            </button>
            {inTrash ? (
              <button type="button" className="btn" onClick={() => void doRestore()}>
                Restore from trash
              </button>
            ) : (
              <button type="button" className="btn danger" onClick={() => void askDelete()}>
                Move to trash
              </button>
            )}
          </div>
          {actionError && (
            <p className="callout crit" role="alert">
              {actionError}
            </p>
          )}
          {confirmDelete && (
            <div className="panel stack confirm" role="dialog" aria-label="Move to trash">
              <strong>Move {entryTitle(draft)} to the trash?</strong>
              {confirmDelete.count === 0 ? (
                <p>Nothing links here.</p>
              ) : (
                <>
                  <p data-testid="linked-count">
                    {confirmDelete.count === 1
                      ? '1 entry links here. Its link is kept and works again if you restore this entry.'
                      : `${confirmDelete.count} entries link here. Their links are kept and work again if you restore this entry.`}
                  </p>
                  <ul className="backlink-list">
                    {confirmDelete.entries.map((b, i) => (
                      <li key={i}>
                        {collectionInfo[b.collection].singular}: {b.title}{' '}
                        <span className="example-note">({b.kind})</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              <div className="row">
                <button type="button" className="btn danger" onClick={() => void doDelete()}>
                  Move to trash
                </button>
                <button type="button" className="btn" onClick={() => setConfirmDelete(null)}>
                  Keep it
                </button>
              </div>
            </div>
          )}
        </div>
      </aside>
      {showHistory && (
        <HistoryDrawer
          collection={collection}
          id={id}
          title={entryTitle(draft)}
          beforeRestore={ed.flush}
          onClose={() => setShowHistory(false)}
        />
      )}
    </>
  );
}

function Backlinks(props: {
  backlinks: Backlink[];
  onOpen: (collection: EntryCollection, id: string) => void;
}) {
  const { backlinks } = props;
  if (backlinks.length === 0) return <p className="example-note">Nothing links here yet.</p>;
  const seen = new Set<string>();
  const unique = backlinks.filter((b) => {
    const k = `${b.collection}:${b.id}:${b.kind}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return (
    <ul className="backlink-list" data-testid="linked-from">
      {unique.map((b) => (
        <li key={`${b.collection}:${b.id}:${b.kind}`}>
          <button
            type="button"
            className="link-btn"
            onClick={() => props.onOpen(b.collection, b.id)}
          >
            {collectionInfo[b.collection].singular}: {b.title}
          </button>{' '}
          <span className="link-kind">{b.kind}</span>
        </li>
      ))}
    </ul>
  );
}

/** Undo and redo buttons with the session history, newest first (ED-3). */
export function UndoPanel() {
  const undo = useUndo();
  const items = [
    ...undo.history.redo.map((c) => ({ label: c.label, redo: true })).reverse(),
    ...undo.history.undo.map((c) => ({ label: c.label, redo: false })),
  ];
  return (
    <div className="stack tight undo-panel">
      <div className="row">
        <button
          type="button"
          className="btn small"
          disabled={!undo.canUndo}
          onClick={() => void undo.undo()}
          title="Cmd+Z"
        >
          Undo
        </button>
        <button
          type="button"
          className="btn small"
          disabled={!undo.canRedo}
          onClick={() => void undo.redo()}
          title="Shift+Cmd+Z"
        >
          Redo
        </button>
      </div>
      {undo.notice && (
        <p className="example-note" role="status" data-testid="undo-notice">
          {undo.notice}
        </p>
      )}
      <span className="eyebrow">Changes this session (newest first)</span>
      <ul className="stack-list" data-testid="undo-history">
        {items.length === 0 ? (
          <li className="empty">No changes yet. The last 100 are kept.</li>
        ) : (
          items.map((it, i) => (
            <li key={i} className={it.redo ? 'redo' : undefined}>
              {it.redo ? `Undone: ${it.label}` : it.label}
            </li>
          ))
        )}
      </ul>
    </div>
  );
}
