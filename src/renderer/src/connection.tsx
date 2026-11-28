import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { ConnectionStatus } from '../../shared/ipcApp';
import { READ_ONLY_REASON } from '../../shared/ipcApp';
import { call, plainError } from './api';

/**
 * ARCH-6: what the window knows about MongoDB. Every screen reads it here:
 * the banner says what happened and what to do, and while a snapshot is open
 * read-only every write control is disabled with the reason beside it.
 */
interface ConnectionContext {
  status: ConnectionStatus | null;
  refresh(): Promise<void>;
  setStatus(s: ConnectionStatus): void;
}

const Ctx = createContext<ConnectionContext>({
  status: null,
  refresh: async () => undefined,
  setStatus: () => undefined,
});

export function ConnectionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const refresh = useCallback(async () => {
    try {
      setStatus(await call('connection.status', {}));
    } catch {
      // The banner keeps what it had.
    }
  }, []);
  useEffect(() => {
    void call('connection.status', {})
      .then(setStatus)
      .catch(() => undefined);
    const off = window.api.on('connection.changed', setStatus);
    const offBibles = window.api.on('bibles.changed', () => void refresh());
    return () => {
      off();
      offBibles();
    };
  }, [refresh]);
  const value = useMemo(() => ({ status, refresh, setStatus }), [status, refresh]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useConnection = (): ConnectionContext => useContext(Ctx);

/** The element every disabled write control points to with `aria-describedby`. */
export const READ_ONLY_NOTE_ID = 'read-only-reason';

/** ARCH-6: the reason writes are off, or null when they are on. */
export function useReadOnly(): string | null {
  const status = useContext(Ctx).status;
  if (status?.state !== 'readOnly') return null;
  // A58 L1: the phone reads what it stored, with no snapshot; its message says why.
  return status.snapshot ? READ_ONLY_REASON : (status.message ?? READ_ONLY_REASON);
}

/**
 * ARCH-6: spread onto a write control. While a snapshot is open read-only the
 * control is disabled, its tooltip gives the reason, and it is described by
 * the banner that states it.
 */
export function useWriteGuard(): {
  off: boolean;
  tip: { title?: string; 'aria-describedby'?: string };
} {
  const reason = useReadOnly();
  return reason
    ? { off: true, tip: { title: reason, 'aria-describedby': READ_ONLY_NOTE_ID } }
    : { off: false, tip: {} };
}

/** ARCH-6: a group of write controls, all disabled together while read-only. */
export function WriteFieldset(props: { children: ReactNode; className?: string }) {
  const reason = useReadOnly();
  return (
    <fieldset
      className={`write-group${props.className ? ` ${props.className}` : ''}`}
      disabled={reason !== null}
      title={reason ?? undefined}
      aria-describedby={reason ? READ_ONLY_NOTE_ID : undefined}
      data-read-only={reason ? 'true' : undefined}
    >
      {props.children}
    </fieldset>
  );
}

const when = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
};

/**
 * ARCH-6: shown on every screen when MongoDB cannot be reached or a snapshot
 * is open read-only. It says what happened; the buttons are the next steps,
 * and the snapshot button names the bible and the time of the snapshot it opens.
 */
export function ConnectionBanner(props: {
  onOpened?: (bible: { id: string; name: string }) => void;
  /** A57: saves pending edits before the snapshot opens; throws to keep the live bible open. */
  beforeOpen?: () => Promise<void>;
}) {
  const { status, setStatus } = useConnection();
  const [busy, setBusy] = useState<'retry' | 'open' | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!status || status.state === 'connected') return null;

  const retry = async () => {
    setBusy('retry');
    setError(null);
    try {
      const next = await call('connection.retry', {});
      setStatus(next);
      if (next.state === 'unavailable') setError('MongoDB still cannot be reached.');
    } catch (e) {
      setError(plainError(e));
    } finally {
      setBusy(null);
    }
  };
  const open = async () => {
    setBusy('open');
    setError(null);
    try {
      await props.beforeOpen?.();
      const r = await call('connection.openSnapshot', {});
      setStatus(r.status);
      props.onOpened?.(r.bible);
    } catch (e) {
      setError(plainError(e));
    } finally {
      setBusy(null);
    }
  };

  const readOnly = status.state === 'readOnly';
  return (
    <div
      className={`callout ${readOnly ? 'warn' : 'crit'} stack tight connection-banner`}
      role={readOnly ? 'status' : 'alert'}
      data-testid="connection-banner"
      data-state={status.state}
    >
      {readOnly ? (
        <>
          <strong>{status.snapshot ? 'Read-only snapshot' : 'No connection'}</strong>
          <span id={READ_ONLY_NOTE_ID} data-testid="read-only-reason">
            {status.snapshot
              ? `You are looking at the snapshot of ${status.snapshot.name} taken ${when(status.snapshot.takenAt)}. ${READ_ONLY_REASON}`
              : (status.message ?? READ_ONLY_REASON)}
          </span>
        </>
      ) : (
        <>
          <strong>MongoDB cannot be reached</strong>
          <span data-testid="connection-message">{status.message}</span>
        </>
      )}
      <div className="row tight">
        <button
          type="button"
          className="btn small"
          onClick={() => void retry()}
          disabled={busy !== null}
          data-testid="connection-retry"
        >
          {busy === 'retry' ? 'Trying again' : 'Try again'}
        </button>
        {!readOnly && status.snapshot && (
          <button
            type="button"
            className="btn small primary"
            onClick={() => void open()}
            disabled={busy !== null}
            data-testid="open-snapshot"
          >
            {busy === 'open'
              ? 'Opening the snapshot'
              : `Open ${status.snapshot.name} from ${when(status.snapshot.takenAt)} read-only`}
          </button>
        )}
      </div>
      {error && (
        <span role="alert" data-testid="connection-error">
          {error}
        </span>
      )}
    </div>
  );
}
