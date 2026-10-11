import { useEffect, useId, useState } from 'react';
import { CLAUDE_FEATURES, DEFAULT_MODELS, FEATURE_INFO } from '../../../shared/claude';
import type { ClaudeFeature } from '../../../shared/claude';
import type { Response } from '../../../shared/ipc';
import { call, plainError } from '../api';
import { Disclosure, useClaudeStatus } from './claude';
import { DriveSettingsSection } from './drive';

type Models = Response<'claude.models'>;

/**
 * Settings (ST-1). This milestone adds the Claude section: the Anthropic API
 * key, kept in the macOS keychain and never shown in full (ARCH-4, ARCH-5),
 * the model per feature from the live models list (DB-4), and what Claude
 * sends to Anthropic (AI-6). M9 adds the Google Drive connection below it;
 * the other settings arrive in M10.
 */
export function SettingsView() {
  return (
    <section className="ws-wide stack" aria-labelledby="settings-title" data-testid="settings-view">
      <h2 id="settings-title">Settings</h2>
      <ClaudeSettings />
      <DriveSettingsSection />
    </section>
  );
}

function ClaudeSettings() {
  const [status, setStatus] = useClaudeStatus();
  const [models, setModels] = useState<Models | null>(null);
  const [draft, setDraft] = useState('');
  const [note, setNote] = useState<{ text: string; bad: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const ids = { heading: useId(), key: useId() };
  const keySet = status?.key.set ?? false;

  useEffect(() => {
    let live = true;
    void call('claude.models', {}).then((m) => {
      if (live) setModels(m);
    });
    return () => {
      live = false;
    };
  }, [keySet]);

  const save = async () => {
    setBusy(true);
    setNote(null);
    try {
      const res = await call('claude.setKey', { key: draft });
      setStatus(res.status);
      setNote({ text: res.message, bad: !res.ok });
      if (res.ok) setDraft('');
    } catch (e) {
      setNote({ text: plainError(e), bad: true });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setNote(null);
    setStatus(await call('claude.clearKey', {}));
    setNote({ text: 'The key was removed from the keychain.', bad: false });
  };

  const setModel = async (feature: ClaudeFeature, model: string) => {
    setStatus(await call('claude.setModel', { feature, model }));
  };

  if (!status) return <p>Loading the Claude settings.</p>;
  const choices = (current: string) => {
    const list = models?.models ?? [];
    return list.some((m) => m.id === current)
      ? list
      : [{ id: current, displayName: current }, ...list];
  };

  return (
    <div className="stack" aria-labelledby={ids.heading} data-testid="claude-settings">
      <h3 id={ids.heading}>Claude</h3>
      <div className="panel stack tight">
        <h4>Anthropic API key</h4>
        <p data-testid="claude-key-status">
          {status.key.set
            ? `A key is stored in the macOS keychain: ${status.key.masked ?? ''}`
            : 'No key is stored. Claude features need one.'}
        </p>
        <form
          className="stack tight"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <label htmlFor={ids.key}>{status.key.set ? 'Replace the key' : 'Paste your key'}</label>
          <input
            id={ids.key}
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="sk-ant-…"
            data-testid="claude-key-input"
          />
          <div className="row tight">
            <button
              type="submit"
              className="btn primary"
              disabled={busy || !draft.trim()}
              data-testid="claude-key-save"
            >
              {busy ? 'Checking the key' : 'Save key'}
            </button>
            {status.key.set && (
              <button type="button" className="btn" onClick={() => void remove()}>
                Remove key
              </button>
            )}
          </div>
        </form>
        {note && (
          <p
            className={note.bad ? 'callout crit' : 'callout'}
            role="status"
            data-testid="claude-key-note"
          >
            {note.text}
          </p>
        )}
        <p className="example-note">
          Create a key in the Anthropic Console under API keys. The app keeps it in the keychain and
          shows only its start and end.
        </p>
      </div>
      <div className="panel stack tight">
        <h4>Model for each feature</h4>
        {models?.message && <p className="example-note">{models.message}</p>}
        {CLAUDE_FEATURES.map((f) => (
          <ModelSelect
            key={f}
            feature={f}
            value={status.models[f] ?? DEFAULT_MODELS[f]}
            choices={choices(status.models[f] ?? DEFAULT_MODELS[f])}
            onChange={(m) => void setModel(f, m)}
          />
        ))}
      </div>
      <Disclosure confirmedAt={status.acknowledgedAt} />
    </div>
  );
}

function ModelSelect(props: {
  feature: ClaudeFeature;
  value: string;
  choices: { id: string; displayName: string }[];
  onChange(model: string): void;
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>
        {FEATURE_INFO[props.feature].label}
        {props.value === DEFAULT_MODELS[props.feature] ? ' (default)' : ''}
      </label>
      <select
        id={id}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        data-testid={`claude-model-${props.feature}`}
      >
        {props.choices.map((m) => (
          <option key={m.id} value={m.id}>
            {m.displayName} ({m.id})
          </option>
        ))}
      </select>
    </div>
  );
}
