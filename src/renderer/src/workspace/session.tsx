import { useEffect, useId, useRef, useState } from 'react';
import { createCommand } from '../../../shared/domain/undoRunner';
import { stopLogData } from '../../../shared/domain/sessionLog';
import { entryTitle } from '../../../shared/schema';
import type { Response } from '../../../shared/ipc';
import { call, plainError } from '../api';
import { useEntries, useStore } from './data';
import { useFocusTrap } from './focusTrap';
import { useUndo } from './undo';

/**
 * SL-1: closing the window or quitting asks "Where did you stop?". A note
 * becomes a session log entry. An empty answer still closes, and "Keep
 * working" cancels the close.
 */
export function StopPrompt() {
  const [open, setOpen] = useState(false);
  useEffect(() => window.api.on('app.closeRequested', () => setOpen(true)), []);
  return open ? <StopDialog onCancel={() => setOpen(false)} /> : null;
}

function StopDialog({ onCancel }: { onCancel: () => void }) {
  const undo = useUndo();
  const chapters = useEntries('chapters');
  const [stoppedAt, setStoppedAt] = useState('');
  const [chapterId, setChapterId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const ids = { title: useId(), text: useId(), chapter: useId() };
  useFocusTrap(dialogRef);
  useEffect(() => area.current?.focus(), []);

  const cancel = () => {
    void call('app.confirmClose', { proceed: false });
    onCancel();
  };

  const finish = async (save: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await undo.flush();
      const data = save ? stopLogData({ stoppedAt, chapterId }, new Date()) : null;
      if (data) {
        const { entry } = await call('entry.create', { collection: 'sessionLogs', data });
        undo.record(createCommand('sessionLogs', entry._id, entryTitle(entry)));
      }
      await call('app.confirmClose', { proceed: true });
    } catch (e) {
      setError(plainError(e));
      setBusy(false);
    }
  };

  const hasNote = stoppedAt.trim() !== '';
  return (
    <div
      className="overlay"
      onKeyDown={(e) => {
        if (e.key === 'Escape') cancel();
      }}
    >
      <div
        ref={dialogRef}
        className="dialog stack stop-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={ids.title}
        data-testid="stop-prompt"
      >
        <h2 id={ids.title}>Where did you stop?</h2>
        <div className="field">
          <label htmlFor={ids.text}>Where did you stop?</label>
          <textarea
            id={ids.text}
            ref={area}
            rows={4}
            value={stoppedAt}
            onChange={(e) => setStoppedAt(e.target.value)}
            placeholder="For example, halfway through the kitchen scene, Iris about to open the box."
          />
        </div>
        <div className="field">
          <label htmlFor={ids.chapter}>Chapter (optional)</label>
          <select id={ids.chapter} value={chapterId} onChange={(e) => setChapterId(e.target.value)}>
            <option value="">No chapter</option>
            {[...chapters]
              .sort((a, b) => Number(a.readingOrder ?? 0) - Number(b.readingOrder ?? 0))
              .map((c) => (
                <option key={c._id} value={c._id}>
                  {`Chapter ${String(c.readingOrder)}: ${entryTitle(c)}`}
                </option>
              ))}
          </select>
        </div>
        {error && (
          <p className="callout crit" role="alert">
            {error}
          </p>
        )}
        <div className="row">
          <button
            type="button"
            className="btn primary"
            disabled={busy}
            onClick={() => void finish(true)}
          >
            {hasNote ? 'Save note and quit' : 'Quit without a note'}
          </button>
          {error && (
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => void finish(false)}
            >
              Quit without saving
            </button>
          )}
          <button type="button" className="btn" disabled={busy} onClick={cancel}>
            Keep working
          </button>
        </div>
      </div>
    </div>
  );
}

type Latest = NonNullable<Response<'sessionLog.latest'>['log']>;

/**
 * SL-1: the newest "where I stopped" note, shown first when a bible opens.
 * The dashboard (M7) replaces this panel.
 */
export function LaunchPanel() {
  const { version } = useStore();
  const [log, setLog] = useState<Latest | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (loaded) return;
    let live = true;
    void call('sessionLog.latest', {})
      .then((r) => {
        if (live) setLog(r.log);
      })
      .catch(() => undefined)
      .finally(() => {
        if (live) setLoaded(true);
      });
    return () => {
      live = false;
    };
  }, [loaded, version]);
  if (!log || dismissed) return null;
  return (
    <section
      className="panel stack tight launch-panel"
      aria-label="Last session"
      data-testid="launch-panel"
    >
      <span className="eyebrow">Where you stopped, {log.date}</span>
      <p data-testid="launch-note">{log.stoppedAt || log.notes}</p>
      {log.chapter && <p className="example-note">Chapter: {log.chapter}</p>}
      <div className="row">
        <button type="button" className="btn small" onClick={() => setDismissed(true)}>
          Start working
        </button>
      </div>
    </section>
  );
}
