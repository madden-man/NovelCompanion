import { useEffect, useState } from 'react';
import type { PhoneKeyStatus } from '../../../shared/ipcPwa';
import { call, plainError } from '../api';
import './phoneKey.css';

/**
 * A58 (PH-15): the phone key on the Mac, a keychain item. Shown masked, with
 * Copy, which puts the whole key on the clipboard from main (the page never
 * holds it), and Make a key while none is set. The site's `NC_PHONE_KEY` is
 * set by hand to the same key; the Mac never sets it.
 */
export function PhoneKeySettings() {
  const [status, setStatus] = useState<PhoneKeyStatus | null>(null);
  const [note, setNote] = useState<{ text: string; bad: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    call('phoneKey.status', {}).then(setStatus, (e: unknown) =>
      setNote({ text: plainError(e), bad: true }),
    );
  }, []);
  const act = async (what: 'make' | 'copy') => {
    setBusy(true);
    setNote(null);
    try {
      if (what === 'make') setStatus(await call('phoneKey.make', {}));
      else {
        const r = await call('phoneKey.copy', {});
        setNote(
          r.ok ? { text: 'Copied.', bad: false } : { text: 'Nothing was copied.', bad: true },
        );
      }
    } catch (e) {
      setNote({ text: plainError(e), bad: true });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack" data-testid="phone-key-settings">
      <h3>Phone</h3>
      <div className="panel stack tight">
        <div className="row phone-key-row">
          <h4>Phone key</h4>
          {status && (
            <code className="phone-key-masked" data-testid="phone-key-masked">
              {status.masked ?? 'None'}
            </code>
          )}
          {status?.set ? (
            <button
              type="button"
              className="btn small"
              disabled={busy}
              onClick={() => void act('copy')}
              data-testid="phone-key-copy"
            >
              Copy
            </button>
          ) : (
            status && (
              <button
                type="button"
                className="btn small primary"
                disabled={busy}
                onClick={() => void act('make')}
                data-testid="phone-key-make"
              >
                Make a key
              </button>
            )
          )}
        </div>
        {note && (
          <p
            className={note.bad ? 'callout crit' : 'example-note'}
            role="status"
            data-testid="phone-key-note"
          >
            {note.text}
          </p>
        )}
      </div>
    </div>
  );
}
