import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { RpcCallError } from './transport';
import type { WebTransport } from './transport';
import './keyGate.css';

/**
 * A58 (PH-16, PH-17): with no phone key kept, the app is one field with
 * Paste and nothing else. A refused key is not kept and the field says so;
 * an accepted one is kept and the app opens. Any later 401 forgets the key
 * and brings this screen back, unmounting the app, so nothing of the bible
 * stays on screen.
 */
export function KeyGate(props: { transport: WebTransport; children: ReactNode }) {
  const { transport } = props;
  const [signedIn, setSignedIn] = useState(() => transport.hasKey());
  useEffect(() => transport.onSignedOut(() => setSignedIn(false)), [transport]);
  if (signedIn) return <>{props.children}</>;
  return <PasteKey transport={transport} onAccepted={() => setSignedIn(true)} />;
}

function PasteKey(props: { transport: WebTransport; onAccepted: () => void }) {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const tryKey = async (raw: string) => {
    const key = raw.trim();
    if (!key || busy) return;
    setBusy(true);
    setRefused(null);
    try {
      await props.transport.signIn(key);
      props.onAccepted();
    } catch (e) {
      setDraft('');
      setRefused(e instanceof Error ? e.message : String(e));
      if (!(e instanceof RpcCallError) || e.code === 'key') input.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  const paste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      setDraft(text.trim());
      await tryKey(text);
    } catch {
      input.current?.focus();
    }
  };

  return (
    <main className="key-gate" data-testid="key-gate">
      <form
        className="key-gate-form"
        onSubmit={(e) => {
          e.preventDefault();
          void tryKey(draft);
        }}
      >
        <input
          ref={input}
          type="password"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          aria-label="Phone key"
          placeholder="Phone key"
          value={draft}
          aria-invalid={refused !== null}
          aria-describedby={refused ? 'key-gate-refused' : undefined}
          aria-busy={busy}
          readOnly={busy}
          onChange={(e) => setDraft(e.target.value)}
          onPaste={(e) => {
            const text = e.clipboardData.getData('text').trim();
            if (!text) return;
            e.preventDefault();
            setDraft(text);
            void tryKey(text);
          }}
          data-testid="key-input"
        />
        <button
          type="button"
          className="btn primary"
          disabled={busy}
          onClick={() => void paste()}
          data-testid="key-paste"
        >
          Paste
        </button>
      </form>
      {refused && (
        <p
          id="key-gate-refused"
          className="key-gate-refused"
          role="alert"
          data-testid="key-refused"
        >
          {refused}
        </p>
      )}
    </main>
  );
}
