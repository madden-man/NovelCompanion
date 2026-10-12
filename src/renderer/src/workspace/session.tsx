import { useReadOnly } from '../connection';
import { useEffect, useId, useRef, useState } from 'react';
import { createCommand } from '../../../shared/domain/undoRunner';
import { stopLogData, stopPromptLabel } from '../../../shared/domain/sessionLog';
import { entryTitle } from '../../../shared/schema';
import { call, plainError } from '../api';
import { useEntries } from './data';
import { useFocusTrap } from './focusTrap';
import { useUndo } from './undo';

/**
 * SL-1: closing the window or quitting asks "Where did you stop?". A note
 * becomes a session log entry. An empty answer still closes, and "Keep
 * working" cancels the close.
 */
export function StopPrompt() {
  const [open, setOpen] = useState<{ quitting: boolean } | null>(null);
  // ARCH-6: a read-only snapshot has nowhere to save the note, so main never asks (and neither does this).
  const readOnly = useReadOnly() !== null;
  useEffect(() => window.api.on('app.closeRequested', ({ quitting }) => setOpen({ quitting })), []);
  return open && !readOnly ? (
    <StopDialog quitting={open.quitting} onCancel={() => setOpen(null)} />
  ) : null;
}

function StopDialog({ quitting, onCancel }: { quitting: boolean; onCancel: () => void }) {
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
  useEffect(() => {
    area.current?.focus();
    // Tell main the prompt is up, so it waits for the person instead of timing out.
    void call('app.closePromptShown', {});
  }, []);

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
            {stopPromptLabel(hasNote, quitting)}
          </button>
          {error && (
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => void finish(false)}
            >
              {quitting ? 'Quit without saving' : 'Close without saving'}
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
