import { useCallback, useEffect, useId, useState } from 'react';
import type { FormEvent } from 'react';
import type { Response } from '../../../shared/ipc';
import { call, plainError } from '../api';
import { formatTime } from './format';
import { ImportView } from './importer';

type Status = Response<'drive.status'>;
type Check = Response<'drive.check'>;
type Browse = Response<'drive.browse'>;
type Link = Response<'drive.links'>['links'][number];
type Opened = Response<'drive.open'>['file'];

const KIND_LABEL = {
  folder: 'Folder',
  workbook: 'Spreadsheet',
  document: 'Document',
  other: 'Not supported',
} as const;

const STATE_LABEL = {
  changed: 'Changed',
  new: 'Not imported yet',
  missing: 'No longer in Drive',
  unchanged: 'Up to date',
} as const;

function useDriveStatus() {
  const [status, setStatus] = useState<Status | null>(null);
  const reload = useCallback(() => {
    call('drive.status', {})
      .then(setStatus)
      .catch(() => setStatus(null));
  }, []);
  useEffect(reload, [reload]);
  return { status, setStatus, reload };
}

/**
 * ST-1, GD-1, GD-5: the Drive connection in Settings. The client ID and
 * secret go to the keychain through main; the page never sees a token.
 */
export function DriveConnection(props: { onChange?: (s: Status) => void }) {
  const { status, setStatus } = useDriveStatus();
  const [clientId, setClientId] = useState('');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const idField = useId();
  const secretField = useId();

  const act = async (fn: () => Promise<Status>) => {
    setBusy(true);
    setError(null);
    try {
      const s = await fn();
      setStatus(s);
      props.onChange?.(s);
    } catch (e) {
      setError(plainError(e));
    } finally {
      setBusy(false);
    }
  };

  if (!status) return <p>Loading.</p>;
  const showForm = !status.clientConfigured || editing;
  return (
    <div className="panel stack" data-testid="drive-connection">
      <h3>Google Drive</h3>
      <p>
        Drive is optional. With it, you can import Word, Excel, Google Docs, and Google Sheets files
        from Drive and export the bible to a Drive folder. Everything else works without it.
      </p>
      {error && (
        <p className="callout crit" role="alert" data-testid="drive-error">
          {error}
        </p>
      )}
      <p data-testid="drive-state">
        {status.connected
          ? `Connected${status.email ? ` as ${status.email}` : ''}. Import reads your Drive files; it never changes them.${status.canExport ? ' Export may create files.' : ''}`
          : status.clientConfigured
            ? 'Not connected.'
            : 'Not set up. Create an OAuth client in Google Cloud (see docs/DRIVE-SETUP.md) and enter it here.'}
      </p>
      {status.clientIdHint && !showForm && (
        <p className="example-note">OAuth client: {status.clientIdHint}</p>
      )}
      {showForm && (
        <form
          className="stack tight"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            void act(async () => {
              const s = await call('drive.setClient', { clientId, clientSecret: secret });
              setClientId('');
              setSecret('');
              setEditing(false);
              return s;
            });
          }}
        >
          <label className="field" htmlFor={idField}>
            OAuth client ID
            <input
              id={idField}
              autoComplete="off"
              spellCheck={false}
              placeholder="…apps.googleusercontent.com"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
            />
          </label>
          <label className="field" htmlFor={secretField}>
            OAuth client secret
            <input
              id={secretField}
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
            />
          </label>
          <p className="example-note">Both are kept in the macOS keychain, never in a file.</p>
          <div className="row">
            <button
              type="submit"
              className="btn primary"
              disabled={busy || !clientId.trim() || !secret.trim()}
            >
              Save the client
            </button>
            {editing && (
              <button type="button" className="btn" onClick={() => setEditing(false)}>
                Cancel
              </button>
            )}
          </div>
        </form>
      )}
      <div className="row">
        {status.clientConfigured && !status.connected && (
          <button
            type="button"
            className="btn primary"
            disabled={busy}
            data-testid="drive-connect"
            onClick={() => void act(() => call('drive.connect', {}))}
          >
            {busy ? 'Waiting for the browser' : 'Connect Google Drive'}
          </button>
        )}
        {status.connected && (
          <button
            type="button"
            className="btn"
            disabled={busy}
            data-testid="drive-disconnect"
            onClick={() => void act(() => call('drive.disconnect', {}))}
          >
            Disconnect
          </button>
        )}
        {status.clientConfigured && !editing && (
          <>
            <button type="button" className="btn" disabled={busy} onClick={() => setEditing(true)}>
              Change the client
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => void act(() => call('drive.clearClient', {}))}
            >
              Remove the client
            </button>
          </>
        )}
      </div>
      {busy && !status.connected && status.clientConfigured && (
        <p aria-live="polite">Finish signing in in your browser, then come back here.</p>
      )}
    </div>
  );
}

/** ST-1: settings live here. Other sections are added beside Drive. */
export function DriveSettingsSection() {
  return <DriveConnection />;
}

/**
 * GD-3: on launch, if Drive is connected and files are linked, say which
 * changed. Nothing is imported from here; Review opens the Drive screen.
 */
export function DriveLaunchNotice(props: { onReview: () => void }) {
  const [check, setCheck] = useState<Check | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    let live = true;
    call('drive.status', {})
      .then((s) => (s.connected ? call('drive.check', {}) : null))
      .then((c) => {
        if (live) setCheck(c);
      })
      .catch((e: unknown) => {
        if (live) setFailed(plainError(e));
      });
    return () => {
      live = false;
    };
  }, []);
  if (dismissed) return null;
  if (failed) {
    return (
      <section
        className="panel stack tight launch-panel"
        aria-label="Google Drive changes"
        data-testid="drive-launch-notice"
      >
        <span className="eyebrow">Google Drive</span>
        <p data-testid="drive-launch-summary">
          Linked Drive files were not checked for changes. {failed} If it says to connect again,
          open Settings and click Connect Google Drive.
        </p>
        <div className="row">
          <button
            type="button"
            className="btn small primary"
            onClick={() => {
              setDismissed(true);
              props.onReview();
            }}
          >
            Open Google Drive
          </button>
          <button type="button" className="btn small" onClick={() => setDismissed(true)}>
            Later
          </button>
        </div>
      </section>
    );
  }
  if (!check) return null;
  const pending = check.files.filter((f) => f.state !== 'unchanged').length;
  if (!pending && !check.missingFolders.length) return null;
  return (
    <section
      className="panel stack tight launch-panel"
      aria-label="Google Drive changes"
      data-testid="drive-launch-notice"
    >
      <span className="eyebrow">Google Drive</span>
      <p data-testid="drive-launch-summary">{check.summary}</p>
      <div className="row">
        <button
          type="button"
          className="btn small primary"
          onClick={() => {
            setDismissed(true);
            props.onReview();
          }}
        >
          Review in Google Drive
        </button>
        <button type="button" className="btn small" onClick={() => setDismissed(true)}>
          Later
        </button>
      </div>
    </section>
  );
}

/** GD-2 to GD-4: linked files, their changes, adding more, and export. */
export function DriveView() {
  const { status, setStatus } = useDriveStatus();
  const [reviewing, setReviewing] = useState<Opened | null>(null);
  const [checks, setChecks] = useState(0);

  if (!status) return <p>Loading.</p>;
  if (reviewing) {
    return (
      <div className="stack" data-testid="drive-review">
        <div className="row">
          <button
            type="button"
            className="btn"
            onClick={() => {
              setReviewing(null);
              setChecks((n) => n + 1);
            }}
          >
            Back to Google Drive
          </button>
        </div>
        <ImportView
          key={reviewing.id}
          initialFile={reviewing}
          heading={`Review ${reviewing.name}`}
        />
      </div>
    );
  }
  return (
    <section className="ws-wide stack" aria-labelledby="drive-title" data-testid="drive-view">
      <h2 id="drive-title">Google Drive</h2>
      {!status.connected ? (
        <DriveConnection onChange={setStatus} />
      ) : (
        <>
          <p className="lede">
            Connected{status.email ? ` as ${status.email}` : ''}. Link the files and folders this
            bible draws on. A check shows what changed in Drive; nothing changes here until you
            review and approve it.
          </p>
          <LinkedFiles key={checks} onReview={setReviewing} />
          <DriveExport status={status} onStatus={setStatus} />
        </>
      )}
    </section>
  );
}

function LinkedFiles(props: { onReview: (f: Opened) => void }) {
  const [links, setLinks] = useState<Link[] | null>(null);
  const [check, setCheck] = useState<Check | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(plainError(e));
    } finally {
      setBusy(false);
    }
  };
  const refresh = () =>
    run(async () => {
      setLinks((await call('drive.links', {})).links);
      setCheck(await call('drive.check', {}));
    });
  useEffect(() => {
    // Once on mount; the Check button refreshes after that.
    let live = true;
    Promise.all([call('drive.links', {}), call('drive.check', {})])
      .then(([l, c]) => {
        if (!live) return;
        setLinks(l.links);
        setCheck(c);
      })
      .catch((e: unknown) => {
        if (live) setError(plainError(e));
      });
    return () => {
      live = false;
    };
  }, []);

  return (
    <div className="panel stack" data-testid="drive-linked">
      <h3>Linked files</h3>
      {error && (
        <p className="callout crit" role="alert">
          {error}
        </p>
      )}
      {links && links.length === 0 && (
        <p className="example-note">Nothing linked yet. Add files or folders from Drive.</p>
      )}
      {links && links.length > 0 && (
        <ul className="stack tight" data-testid="drive-links">
          {links.map((l) => (
            <li key={l.id} className="row" data-testid="drive-link">
              <span>
                {l.name} <span className="chip">{KIND_LABEL[l.kind]}</span>
              </span>
              <button
                type="button"
                className="btn small"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    setLinks((await call('drive.unlink', { id: l.id })).links);
                    setCheck(await call('drive.check', {}));
                  })
                }
              >
                Unlink {l.name}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="row">
        <button
          type="button"
          className="btn primary"
          disabled={busy}
          data-testid="drive-check"
          onClick={() => void refresh()}
        >
          Check for changes
        </button>
        <button type="button" className="btn" onClick={() => setAdding((a) => !a)}>
          {adding ? 'Close the Drive browser' : 'Add files or folders from Drive'}
        </button>
      </div>
      {check && check.summary && (
        <p role="status" data-testid="drive-summary">
          {check.summary} Checked {formatTime(check.checkedAt)}.
        </p>
      )}
      {check && check.missingFolders.length > 0 && (
        <p className="callout warn">
          Linked folders no longer in Drive: {check.missingFolders.join(', ')}.
        </p>
      )}
      {check && check.files.length > 0 && (
        <div className="table-scroll">
          <table data-testid="drive-files">
            <thead>
              <tr>
                <th scope="col">File</th>
                <th scope="col">State</th>
                <th scope="col">Changed in Drive</th>
                <th scope="col">Action</th>
              </tr>
            </thead>
            <tbody>
              {check.files.map((f) => (
                <tr key={f.fileId} data-testid="drive-file" data-state={f.state}>
                  <th scope="row">{f.name}</th>
                  <td>{STATE_LABEL[f.state]}</td>
                  <td>{f.modifiedTime ? formatTime(f.modifiedTime) : ''}</td>
                  <td>
                    {f.state !== 'missing' && (
                      <span className="row tight">
                        <button
                          type="button"
                          className="btn small"
                          disabled={busy}
                          data-testid="drive-review-file"
                          onClick={() =>
                            void run(async () => {
                              const { file } = await call('drive.open', { fileId: f.fileId });
                              props.onReview(file);
                            })
                          }
                        >
                          {f.state === 'new' ? 'Import' : 'Review changes'}
                        </button>
                        {(f.state === 'changed' || f.state === 'new') && f.modifiedTime && (
                          <button
                            type="button"
                            className="btn small"
                            disabled={busy}
                            onClick={() =>
                              void run(async () => {
                                await call('drive.markSeen', {
                                  fileId: f.fileId,
                                  modifiedTime: f.modifiedTime ?? '',
                                });
                                setCheck(await call('drive.check', {}));
                              })
                            }
                          >
                            Mark as reviewed
                          </button>
                        )}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {adding && (
        <DriveBrowser
          linked={new Set(links?.map((l) => l.id) ?? [])}
          onLinked={(next) => {
            setLinks(next);
            void call('drive.check', {}).then(setCheck);
          }}
        />
      )}
    </div>
  );
}

function DriveBrowser(props: { linked: Set<string>; onLinked: (links: Link[]) => void }) {
  const [place, setPlace] = useState<'myDrive' | 'shared'>('myDrive');
  const [trail, setTrail] = useState<{ id: string; name: string }[]>([]);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [loaded, setLoaded] = useState<{ key: string; data: Browse } | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const searchId = useId();
  const folderId = trail.at(-1)?.id ?? null;
  const key = JSON.stringify([folderId, place, query]);
  const data = loaded?.key === key ? loaded.data : null;

  useEffect(() => {
    let live = true;
    call('drive.browse', { folderId, place, search: query })
      .then((r) => {
        if (live) setLoaded({ key: JSON.stringify([folderId, place, query]), data: r });
      })
      .catch((e: unknown) => {
        if (live) setError(plainError(e));
      });
    return () => {
      live = false;
    };
  }, [folderId, place, query]);

  const toggle = (id: string) =>
    setChosen((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="stack" data-testid="drive-browser">
      <div className="row">
        <button
          type="button"
          className="btn small"
          aria-pressed={place === 'myDrive' && !query}
          onClick={() => {
            setPlace('myDrive');
            setTrail([]);
            setQuery('');
            setSearch('');
          }}
        >
          My Drive
        </button>
        <button
          type="button"
          className="btn small"
          aria-pressed={place === 'shared' && !query}
          onClick={() => {
            setPlace('shared');
            setTrail([]);
            setQuery('');
            setSearch('');
          }}
        >
          Shared with me
        </button>
        <form
          className="row tight"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            setTrail([]);
            setQuery(search);
          }}
        >
          <label className="sr-only" htmlFor={searchId}>
            Search Drive by name
          </label>
          <input
            id={searchId}
            type="search"
            placeholder="Search Drive by name"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <button type="submit" className="btn small">
            Search
          </button>
        </form>
      </div>
      {trail.length > 0 && (
        <nav aria-label="Folder path" className="row tight">
          <button type="button" className="btn small" onClick={() => setTrail([])}>
            {place === 'shared' ? 'Shared with me' : 'My Drive'}
          </button>
          {trail.map((t, i) => (
            <button
              key={t.id}
              type="button"
              className="btn small"
              onClick={() => setTrail(trail.slice(0, i + 1))}
            >
              {t.name}
            </button>
          ))}
        </nav>
      )}
      {error && (
        <p className="callout crit" role="alert">
          {error}
        </p>
      )}
      {!data ? (
        <p>Loading.</p>
      ) : data.items.length === 0 ? (
        <p className="example-note">Nothing here.</p>
      ) : (
        <ul className="stack tight" data-testid="drive-items">
          {data.items.map((item) => {
            const linkable = item.kind !== 'other';
            const already = props.linked.has(item.id);
            return (
              <li key={item.id} className="row" data-testid="drive-item">
                <label className="row tight">
                  <input
                    type="checkbox"
                    disabled={!linkable || already}
                    checked={already || chosen.has(item.id)}
                    onChange={() => toggle(item.id)}
                  />
                  {item.name}
                </label>
                <span className="chip">{KIND_LABEL[item.kind]}</span>
                {already && <span className="chip">Linked</span>}
                {item.kind === 'folder' && (
                  <button
                    type="button"
                    className="btn small"
                    onClick={() => {
                      setQuery('');
                      setTrail([...trail, { id: item.id, name: item.name }]);
                    }}
                  >
                    Open {item.name}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <div className="row">
        <button
          type="button"
          className="btn primary"
          disabled={busy || chosen.size === 0}
          data-testid="drive-link-selected"
          onClick={() => {
            setBusy(true);
            setError(null);
            call('drive.link', { ids: [...chosen] })
              .then((r) => {
                setChosen(new Set());
                props.onLinked(r.links);
              })
              .catch((e: unknown) => setError(plainError(e)))
              .finally(() => setBusy(false));
          }}
        >
          Link {chosen.size === 1 ? 'the chosen item' : `${chosen.size} chosen items`}
        </button>
      </div>
      <p className="example-note">
        A linked folder covers every Word, Excel, Google Docs, and Google Sheets file inside it,
        including files added later.
      </p>
    </div>
  );
}

/** GD-4: the whole bible to a Drive folder as Markdown and JSON. */
function DriveExport(props: { status: Status; onStatus: (s: Status) => void }) {
  const [folders, setFolders] = useState<{ id: string; name: string }[] | null>(null);
  const [folderId, setFolderId] = useState('');
  const [newName, setNewName] = useState('Novel Companion exports');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Response<'drive.export'> | null>(null);
  const folderField = useId();
  const nameField = useId();
  const { canExport } = props.status;

  useEffect(() => {
    if (!canExport) return;
    call('drive.exportFolders', {})
      .then((r) => {
        setFolders(r.folders);
        setFolderId((id) => id || r.folders[0]?.id || '');
      })
      .catch((e: unknown) => setError(plainError(e)));
  }, [canExport]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(plainError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel stack" data-testid="drive-export">
      <h3>Export to Drive</h3>
      <p>
        Writes the whole bible to a new dated folder: one Markdown file per entry, in a folder per
        section, and one JSON file that loads back into an empty bible with nothing lost. Earlier
        exports are never overwritten.
      </p>
      {error && (
        <p className="callout crit" role="alert">
          {error}
        </p>
      )}
      {!canExport ? (
        <>
          <p>
            Export needs one more permission: to create files in Drive. The app can then see only
            the files it creates.
          </p>
          <div className="row">
            <button
              type="button"
              className="btn"
              disabled={busy}
              data-testid="drive-allow-export"
              onClick={() =>
                void run(async () => props.onStatus(await call('drive.allowExport', {})))
              }
            >
              {busy ? 'Waiting for the browser' : 'Allow export'}
            </button>
          </div>
        </>
      ) : (
        <>
          {folders && folders.length > 0 && (
            <label className="field" htmlFor={folderField}>
              Export folder
              <select
                id={folderField}
                value={folderId}
                onChange={(e) => setFolderId(e.target.value)}
              >
                {folders.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <form
            className="row"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              void run(async () => {
                const { folder } = await call('drive.createExportFolder', { name: newName });
                setFolders((f) => [...(f ?? []), folder]);
                setFolderId(folder.id);
              });
            }}
          >
            <label className="field" htmlFor={nameField}>
              New export folder
              <input id={nameField} value={newName} onChange={(e) => setNewName(e.target.value)} />
            </label>
            <button type="submit" className="btn" disabled={busy || !newName.trim()}>
              Make the folder
            </button>
          </form>
          <p className="example-note">
            New folders go at the top of My Drive. You can move one anywhere in Drive afterwards and
            exports keep going to it.
          </p>
          <div className="row">
            <button
              type="button"
              className="btn primary"
              disabled={busy || !folderId}
              data-testid="drive-export-now"
              onClick={() =>
                void run(async () => setDone(await call('drive.export', { folderId })))
              }
            >
              {busy ? 'Exporting' : 'Export the whole bible'}
            </button>
          </div>
        </>
      )}
      {done && (
        <p className="callout" role="status" data-testid="drive-export-done">
          Exported {done.entries} entries in {done.sections} sections ({done.files} files) to{' '}
          {done.folder.name}.{' '}
          {done.folder.url && (
            <button
              type="button"
              className="btn small"
              onClick={() => void call('app.openExternal', { url: done.folder.url ?? '' })}
            >
              Open in Drive
            </button>
          )}
        </p>
      )}
    </div>
  );
}
