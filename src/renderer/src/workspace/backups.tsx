import { useWriteGuard } from '../connection';
import { useEffect, useState } from 'react';
import { SNAPSHOT_REASON_LABELS } from '../../../shared/domain/snapshots';
import type { Response } from '../../../shared/ipc';
import { call, plainError } from '../api';
import { formatTime } from './format';
import { ConfirmLine } from './housekeeping';
import './backups.css';

type Snapshots = Response<'snapshot.list'>;
type Snapshot = Snapshots['snapshots'][number];

const total = (counts: Record<string, number>) => Object.values(counts).reduce((n, c) => n + c, 0);

/** Backups (BK-1 to BK-3): snapshots to take and restore, and the whole-bible JSON file. */
export function BackupsView() {
  const ro = useWriteGuard();
  const [data, setData] = useState<Snapshots | null>(null);
  const [bible, setBible] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<Snapshot | null>(null);

  const [loads, setLoads] = useState(0);
  useEffect(() => {
    let live = true;
    call('snapshot.list', {})
      .then((r) => {
        if (live) setData(r);
      })
      .catch((e: unknown) => {
        if (live) setError(plainError(e));
      });
    return () => {
      live = false;
    };
  }, [loads]);
  useEffect(() => {
    call('bible.current', {}).then(
      (r) => setBible(r.bible?.name ?? null),
      () => undefined,
    );
  }, []);

  const act = async (fn: () => Promise<string | null>) => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      setMessage(await fn());
      setLoads((n) => n + 1);
    } catch (e) {
      setError(plainError(e));
    } finally {
      setBusy(false);
    }
  };

  const restore = async (s: Snapshot) => {
    setError(null);
    setMessage(null);
    await call('snapshot.restore', { id: s.id });
    setConfirm(null);
    setLoads((n) => n + 1);
  };

  return (
    <section className="ws-wide stack" aria-labelledby="backups-title" data-testid="backups-view">
      <div className="row backups-head">
        <h2 id="backups-title">Backups</h2>
        <div className="row tight">
          <button
            type="button"
            className="btn primary"
            disabled={busy || ro.off}
            {...ro.tip}
            data-testid="snapshot-take"
            onClick={() =>
              void act(async () => {
                const r = await call('snapshot.take', {});
                return `Snapshot taken at ${formatTime(r.snapshot.takenAt)}.`;
              })
            }
          >
            Snapshot now
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy}
            data-testid="backup-export"
            onClick={() =>
              void act(async () => {
                const r = await call('backup.export', {});
                return r.path ? `Exported ${total(r.counts)} documents to ${r.path}.` : null;
              })
            }
          >
            Export…
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy || ro.off}
            {...ro.tip}
            data-testid="backup-import"
            onClick={() =>
              void act(async () => {
                const r = await call('backup.import', {});
                if (!r.bible) return null;
                await call('bible.open', { slug: r.bible.id });
                return `Loaded ${total(r.counts)} documents into the new bible ${r.bible.name}.`;
              })
            }
          >
            Import as a new bible…
          </button>
        </div>
      </div>
      {error && (
        <p className="callout crit" role="alert">
          {error}
        </p>
      )}
      {message && (
        <p className="callout" role="status" data-testid="backups-message">
          {message}
        </p>
      )}

      {data === null ? (
        <p>Loading.</p>
      ) : data.snapshots.length === 0 ? (
        <p>No snapshots yet.</p>
      ) : (
        <div className="table-scroll">
          <table className="snapshot-table" data-testid="snapshot-list">
            <thead>
              <tr>
                <th scope="col">Taken</th>
                <th scope="col">Why</th>
                <th scope="col">Documents</th>
                <th scope="col">
                  <span className="sr-only">Restore</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data.snapshots.map((s) => (
                <tr
                  key={s.id}
                  data-testid="snapshot-row"
                  data-id={s.id}
                  aria-current={confirm?.id === s.id ? 'true' : undefined}
                >
                  <th scope="row">{formatTime(s.takenAt)}</th>
                  <td>
                    {SNAPSHOT_REASON_LABELS[s.reason]}
                    {s.label ? `: ${s.label}` : ''}
                  </td>
                  <td>{total(s.counts)}</td>
                  <td>
                    <button
                      type="button"
                      className="btn small"
                      disabled={busy || ro.off}
                      {...ro.tip}
                      aria-label={`Restore the snapshot from ${formatTime(s.takenAt)}`}
                      data-testid="snapshot-restore"
                      onClick={() => setConfirm(s)}
                    >
                      Restore
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {confirm && !ro.off && (
        <ConfirmLine
          key={confirm.id}
          action="Replace"
          keep="Cancel"
          testId="snapshot-confirm"
          onConfirm={() => restore(confirm)}
          onCancel={() => setConfirm(null)}
        >
          <strong>
            Replace {bible ?? confirm.name ?? 'this bible'} with the snapshot from{' '}
            {formatTime(confirm.takenAt)}?
          </strong>{' '}
          Everything in it now is replaced. The present state is snapshotted first.
        </ConfirmLine>
      )}
    </section>
  );
}
