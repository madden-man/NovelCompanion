import { useEffect, useId, useState } from 'react';
import type { FormEvent } from 'react';
import { BIBLE_SLUG_RULE, BibleSlug, slugify } from '../../../shared/bible';
import { SNAPSHOT_REASON_LABELS } from '../../../shared/domain/snapshots';
import type { Response } from '../../../shared/ipc';
import { call, plainError } from '../api';
import { formatTime } from './format';

type Snapshots = Response<'snapshot.list'>;

const total = (counts: Record<string, number>) => Object.values(counts).reduce((n, c) => n + c, 0);

/** Backups (BK-1 to BK-3): snapshots to take and restore, and the whole-bible JSON file. */
export function BackupsView() {
  const [data, setData] = useState<Snapshots | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [keep, setKeep] = useState('30');
  const keepId = useId();

  const [loads, setLoads] = useState(0);
  useEffect(() => {
    let live = true;
    call('snapshot.list', {})
      .then((r) => {
        if (!live) return;
        setData(r);
        setKeep(String(r.keep));
      })
      .catch((e: unknown) => {
        if (live) setError(plainError(e));
      });
    return () => {
      live = false;
    };
  }, [loads]);

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

  return (
    <section className="ws-wide stack" aria-labelledby="backups-title" data-testid="backups-view">
      <h2 id="backups-title">Backups</h2>
      <p className="lede">
        A snapshot is a full copy of this bible saved on this computer. The app takes one on the
        first launch of each day, before every import, restore, and bulk change, and whenever you
        ask.
      </p>
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

      <div className="panel stack">
        <h3>Snapshots</h3>
        <div className="row">
          <button
            type="button"
            className="btn primary"
            disabled={busy}
            data-testid="snapshot-take"
            onClick={() =>
              void act(async () => {
                const r = await call('snapshot.take', {});
                return `Snapshot taken at ${formatTime(r.snapshot.takenAt)}.`;
              })
            }
          >
            Take a snapshot now
          </button>
          <form
            className="row"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              void act(async () => {
                const r = await call('snapshot.keep', { keep: Number(keep) });
                return `Keeping the last ${r.keep} snapshots.`;
              });
            }}
          >
            <label className="field narrow" htmlFor={keepId}>
              Snapshots to keep
              <input
                id={keepId}
                type="number"
                min={1}
                max={1000}
                value={keep}
                onChange={(e) => setKeep(e.target.value)}
              />
            </label>
            <button type="submit" className="btn" disabled={busy}>
              Save the number
            </button>
          </form>
        </div>
        {data === null ? (
          <p>Loading.</p>
        ) : data.snapshots.length === 0 ? (
          <p className="example-note">No snapshots yet.</p>
        ) : (
          <div className="table-scroll">
            <table className="snapshot-table" data-testid="snapshot-list">
              <thead>
                <tr>
                  <th scope="col">Taken</th>
                  <th scope="col">Why</th>
                  <th scope="col">Documents</th>
                  <th scope="col">Restore</th>
                </tr>
              </thead>
              <tbody>
                {data.snapshots.map((s) => (
                  <tr key={s.id} data-testid="snapshot-row" data-id={s.id}>
                    <th scope="row">{formatTime(s.takenAt)}</th>
                    <td>
                      {SNAPSHOT_REASON_LABELS[s.reason]}
                      {s.label ? `: ${s.label}` : ''}
                    </td>
                    <td>{total(s.counts)}</td>
                    <td>
                      {confirm === s.id ? (
                        <span className="row tight">
                          <button
                            type="button"
                            className="btn small danger"
                            disabled={busy}
                            data-testid="snapshot-confirm"
                            onClick={() =>
                              void act(async () => {
                                setConfirm(null);
                                await call('snapshot.restore', { id: s.id });
                                return null;
                              })
                            }
                          >
                            Replace this bible with it
                          </button>
                          <button
                            type="button"
                            className="btn small"
                            onClick={() => setConfirm(null)}
                          >
                            Cancel
                          </button>
                        </span>
                      ) : (
                        <button
                          type="button"
                          className="btn small"
                          disabled={busy}
                          data-testid="snapshot-restore"
                          onClick={() => setConfirm(s.id)}
                        >
                          Restore
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="example-note">
          Restoring replaces every entry, list, and setting in this bible. A snapshot of the present
          state is taken first, so you can go back.
        </p>
      </div>

      <div className="panel stack">
        <h3>Export the whole bible</h3>
        <p>
          Writes every entry, link, revision, list, and setting to one JSON file. The file can be
          loaded into an empty bible with nothing lost.
        </p>
        <div className="row">
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
            Export to a JSON file
          </button>
        </div>
      </div>

      <LoadBibleFile onDone={(m) => setMessage(m)} onError={setError} />
    </section>
  );
}

function LoadBibleFile(props: {
  onDone: (m: string) => void;
  onError: (m: string | null) => void;
}) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [edited, setEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const shown = edited ? slug : slugify(name);
  const valid = BibleSlug.safeParse(shown).success;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    props.onError(null);
    setBusy(true);
    try {
      const r = await call('backup.import', { slug: shown, name });
      if (r.bible) {
        await call('bible.open', { slug: r.bible.id });
        props.onDone(`Loaded ${total(r.counts)} documents into the new bible ${r.bible.name}.`);
      }
    } catch (err) {
      props.onError(plainError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="panel stack"
      onSubmit={(e) => void submit(e)}
      aria-labelledby="load-file-title"
    >
      <h3 id="load-file-title">Load an exported bible into a new bible</h3>
      <p>Choose a file made by Export. It becomes a new bible, so nothing here is replaced.</p>
      <div className="row">
        <label className="field">
          Name of the new bible
          <input value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
        <label className="field">
          ID
          <input
            value={shown}
            aria-describedby="load-slug-rule"
            onChange={(e) => {
              setEdited(true);
              setSlug(e.target.value);
            }}
          />
        </label>
      </div>
      <p id="load-slug-rule" className="example-note">
        {BIBLE_SLUG_RULE}
      </p>
      <div className="row">
        <button
          type="submit"
          className="btn"
          data-testid="backup-import"
          disabled={busy || !name.trim() || !valid}
        >
          Choose a file and load it
        </button>
      </div>
    </form>
  );
}
