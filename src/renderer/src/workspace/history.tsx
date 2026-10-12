import { useEffect, useState } from 'react';
import { useWriteGuard } from '../connection';
import { manifests } from '../../../shared/schema';
import type { EntryCollection } from '../../../shared/schema';
import type { Response } from '../../../shared/ipc';
import { editCommand } from '../../../shared/domain/undoRunner';
import { labelPath } from '../../../shared/domain/issues';
import { formatStoryDate } from '../../../shared/domain/dates';
import { isPlainObject } from '../../../shared/domain/paths';
import { call, plainError } from '../api';
import { formatTime } from './format';
import { useUndo } from './undo';

type Revision = Response<'revisions.list'>['revisions'][number];
type Diff = Response<'revisions.diff'>;

const OP_LABEL: Record<Revision['op'], string> = {
  create: 'Created',
  update: 'Changed',
  softDelete: 'Moved to trash',
  restore: 'Restored from trash',
};

/** A field value in plain text for the side-by-side view. */
export function showValue(v: unknown): string {
  if (v === undefined) return 'Not set';
  if (v === null || v === '') return 'Blank';
  if (Array.isArray(v)) {
    if (v.length === 0) return 'None';
    return v.map((x) => showValue(x)).join('; ');
  }
  if (isPlainObject(v)) {
    if ('year' in v || 'unknown' in v) return formatStoryDate(v as never);
    if ('targetId' in v) return `${String(v.targetId)} (${String(v.kind)})`;
    return Object.entries(v)
      .map(([k, x]) => `${k}: ${showValue(x)}`)
      .join(', ');
  }
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  return String(v);
}

/**
 * Revision history (ED-4): every write to the entry, newest first. Pick one
 * to compare it side by side with the current entry, and restore it.
 */
export function HistoryDrawer(props: {
  collection: EntryCollection;
  id: string;
  title: string;
  beforeRestore: () => Promise<void>;
  onClose: () => void;
}) {
  const { collection, id } = props;
  const undo = useUndo();
  const [revisions, setRevisions] = useState<Revision[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [loadedDiff, setDiff] = useState<Diff | null>(null);
  const diff = selected && loadedDiff?.revision._id === selected ? loadedDiff : null;
  const [error, setError] = useState<string | null>(null);

  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    let live = true;
    void call('revisions.list', { collection, id }).then((r) => {
      if (live) setRevisions(r.revisions);
    });
    return () => {
      live = false;
    };
  }, [collection, id, reloads]);

  useEffect(() => {
    if (!selected) return;
    let live = true;
    void call('revisions.diff', { collection, id, revisionId: selected }).then((d) => {
      if (live) setDiff(d);
    });
    return () => {
      live = false;
    };
  }, [collection, id, selected, reloads]);

  const ro = useWriteGuard();
  const restore = async () => {
    if (!diff) return;
    setError(null);
    try {
      await props.beforeRestore();
      const before = diff.current;
      const { entry } = await call('revisions.restore', {
        collection,
        id,
        revisionId: diff.revision._id,
      });
      undo.record(
        editCommand(
          `Restored the version of ${props.title} from ${formatTime(diff.revision.at)}`,
          collection,
          id,
          before,
          entry,
        ),
      );
      setSelected(null);
      setReloads((n) => n + 1);
    } catch (e) {
      setError(plainError(e));
    }
  };

  return (
    <div className="drawer-overlay" role="presentation" onClick={props.onClose}>
      <aside
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="history-title"
        data-testid="history"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="drawer-head">
          <div>
            <span className="eyebrow">Revision history</span>
            <h2 id="history-title">{props.title}</h2>
          </div>
          <button type="button" className="btn" onClick={props.onClose}>
            Close
          </button>
        </header>
        <div className="drawer-body">
          <ol className="revision-list" aria-label="Revisions, newest first">
            {revisions === null && <li>Loading the history.</li>}
            {revisions?.map((r, i) => (
              <li key={r._id}>
                <button
                  type="button"
                  className="revision"
                  aria-pressed={selected === r._id}
                  onClick={() => setSelected(r._id)}
                >
                  <strong>{i === 0 ? `${OP_LABEL[r.op]} (current)` : OP_LABEL[r.op]}</strong>
                  <span>{formatTime(r.at)}</span>
                  {r.note && <span className="example-note">{r.note}</span>}
                </button>
              </li>
            ))}
          </ol>
          <div className="revision-diff">
            {!diff ? (
              <p className="example-note">
                Pick a revision to compare it with the entry as it is now.
              </p>
            ) : diff.changes.length === 0 ? (
              <>
                <p>This revision matches the entry as it is now.</p>
              </>
            ) : (
              <>
                <table className="diff-table" data-testid="revision-diff">
                  <thead>
                    <tr>
                      <th scope="col">Field</th>
                      <th scope="col">That version</th>
                      <th scope="col">Now</th>
                    </tr>
                  </thead>
                  <tbody>
                    {diff.changes.map((c) => (
                      <tr key={c.path}>
                        <th scope="row">{labelPath(manifests[collection], c.path)}</th>
                        <td>
                          <del>{showValue(c.before)}</del>
                        </td>
                        <td>
                          <ins>{showValue(c.after)}</ins>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="row">
                  <button
                    type="button"
                    className="btn primary"
                    onClick={() => void restore()}
                    disabled={ro.off}
                    {...ro.tip}
                  >
                    Restore this version
                  </button>
                </div>
              </>
            )}
            {error && (
              <p className="callout crit" role="alert">
                {error}
              </p>
            )}
          </div>
        </div>
      </aside>
    </div>
  );
}
