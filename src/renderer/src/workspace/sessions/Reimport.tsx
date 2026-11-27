/**
 * IP-18 (a47-desk): Re-import a chapter from its linked manuscript, from any
 * screen that shows the chapter. It reads the linked file again, shows the
 * same line diff the Manuscript tab shows, and Apply stores the text through
 * the importer (MS-1, MS-4). The app never writes to the manuscript, and an
 * import is not an undo step (A40).
 */
import { useState } from 'react';
import type { Response } from '../../../../shared/ipc';
import { useWriteGuard } from '../../connection';
import { call, plainError } from '../../api';
import type { Entry } from '../data';

type Read = Response<'manuscript.read'>;
type DiffLine = Read['diff'][number];

/**
 * A57: the lock that marks the manuscript text as read only, on the
 * Manuscript tab and beside Re-import, in place of a sentence saying so.
 */
export function LockIcon() {
  return (
    <svg
      className="ms-lock"
      viewBox="0 0 16 16"
      width="12"
      height="12"
      aria-hidden="true"
      focusable="false"
      data-testid="ms-lock"
    >
      <rect x="3" y="7" width="10" height="7" rx="1.5" fill="currentColor" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" fill="none" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

/** The changed lines of a manuscript read, as the Manuscript tab shows them (MS-4). */
export function ManuscriptDiff({ diff }: { diff: readonly DiffLine[] }) {
  return (
    <table className="diff-table" data-testid="manuscript-diff">
      <tbody>
        {diff
          .filter((d) => d.kind !== 'same')
          .map((d, i) => (
            <tr key={i} className={`ms-${d.kind}`} data-kind={d.kind}>
              <td className="num">{d.line}</td>
              <td>{d.kind === 'added' ? 'added' : 'removed'}</td>
              <td>{d.kind === 'removed' ? <del>{d.text}</del> : <ins>{d.text}</ins>}</td>
            </tr>
          ))}
      </tbody>
    </table>
  );
}

/**
 * IP-18: the Re-import button for a chapter with a linked manuscript, and
 * the comparison it opens under it. Draws nothing for a chapter never
 * imported. `onApplied` gets the stored chapter.
 */
export function Reimport(props: { chapter: Entry; onApplied?: (entry: Entry) => void }) {
  const { chapter } = props;
  const ro = useWriteGuard();
  const [read, setRead] = useState<Read | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const source = typeof chapter.manuscriptSource === 'string' ? chapter.manuscriptSource : '';
  if (!source) return null;
  const file = typeof chapter.sourceFile === 'string' ? chapter.sourceFile : '';

  const reimport = async () => {
    setError(null);
    setNote(null);
    setBusy(true);
    try {
      const r = await call('manuscript.read', { chapterId: chapter._id });
      setRead(r.token ? r : null);
    } catch (e) {
      setError(plainError(e));
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!read?.token) return;
    setBusy(true);
    try {
      const before = (await call('entry.get', { collection: 'chapters', id: chapter._id }))
        .entry as Entry;
      const r = await call('manuscript.apply', {
        token: read.token,
        baseModifiedAt: String(before.modifiedAt),
      });
      setNote(
        read.summaryOutOfDate ? 'Imported. The summary may be out of date now.' : 'Imported.',
      );
      setRead(null);
      props.onApplied?.(r.entry as Entry);
    } catch (e) {
      setError(plainError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="reimport stack tight" data-testid="reimport" aria-label="Manuscript">
      <div className="row tight">
        <span className="row tight">
          <LockIcon />
          Manuscript{file ? `: ${file}` : ''}
        </span>
        <button
          type="button"
          className="btn small"
          disabled={busy || ro.off}
          {...ro.tip}
          onClick={() => void reimport()}
        >
          Re-import
        </button>
        {busy && <span role="status">Reading the manuscript.</span>}
      </div>
      {error && (
        <p className="callout crit" role="alert">
          {error}
        </p>
      )}
      {note && (
        <p className="callout" role="status" data-testid="reimport-note">
          {note}
        </p>
      )}
      {read && (
        <div className="sunken stack" data-testid="reimport-compare">
          <span className="eyebrow">
            {read.name}:{' '}
            {read.changed
              ? `${read.added} lines added, ${read.removed} removed`
              : 'no change from the text in the bible'}
          </span>
          {read.changed && <ManuscriptDiff diff={read.diff} />}
          {read.summaryOutOfDate && (
            <p className="callout warn">The summary will be marked as possibly out of date.</p>
          )}
          <div className="row tight">
            <button
              type="button"
              className="btn primary small"
              disabled={busy || (!read.changed && source === read.source)}
              onClick={() => void apply()}
            >
              Apply
            </button>
            <button type="button" className="btn small" onClick={() => setRead(null)}>
              Discard
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
