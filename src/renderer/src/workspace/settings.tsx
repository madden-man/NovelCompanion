import { useEffect, useId, useState } from 'react';
import { CLAUDE_FEATURES, DEFAULT_MODELS, FEATURE_INFO } from '../../../shared/claude';
import type { ClaudeFeature } from '../../../shared/claude';
import type { Response } from '../../../shared/ipc';
import { call, plainError } from '../api';
import { Disclosure } from './claude';
import { APPEARANCES } from '../../../shared/ipcApp';
import type { Appearance, MongoSettingsWire } from '../../../shared/ipcApp';
import { applyAppearance } from '../appearance';
import { WriteFieldset, useConnection } from '../connection';
import { RomanizationSystems } from './romanizationSystems';
import { BibleVocabularySettings, ClaudeInstructionsSettings } from './settingsGroups';

type Models = Response<'claude.models'>;
type ClaudeStatus = Response<'claude.status'>;

/** NF-3: a setting that could not be read says so, in place of "Loading" that never ends. */
function LoadFailed(props: { what: string; error: string; testId: string }) {
  return (
    <p className="callout crit" role="alert" data-testid={props.testId}>
      {props.what} could not be read. {props.error}
    </p>
  );
}

/**
 * Settings (ST-1), one screen: Claude (the API key, masked and replace only,
 * and the model per feature), this bible's romanization systems and snapshot
 * count, the MongoDB connection (masked, replace only, tested before the app
 * switches to it), and appearance. Per-bible settings live in the bible's meta
 * through the one write path; app-wide ones in the app's data folder; every
 * secret in the keychain (ARCH-5).
 */
export function SettingsView() {
  return (
    <section className="ws-wide stack" aria-labelledby="settings-title" data-testid="settings-view">
      <h2 id="settings-title">Settings</h2>
      <ClaudeSettings />
      <BibleSettings />
      <div className="stack" data-testid="mongo-settings-section">
        <h3>MongoDB connection</h3>
        <div className="panel stack tight">
          <MongoSettings />
        </div>
      </div>
      <AppearanceSettings />
    </section>
  );
}

/** ST-1: settings kept in the open bible (GL-1 romanization, BK-1 snapshot count). */
function BibleSettings() {
  return (
    <div className="stack" data-testid="bible-settings">
      <h3>This bible</h3>
      <WriteFieldset className="stack">
        <RomanizationSettings />
        <SnapshotSettings />
      </WriteFieldset>
      <BibleVocabularySettings />
    </div>
  );
}

function RomanizationSettings() {
  return (
    <div className="panel stack tight">
      <h4>Romanization system for each language</h4>
      <p className="example-note">
        Glossary terms that do not follow their language&apos;s system are flagged.
      </p>
      <RomanizationSystems testId="settings-romanization" />
    </div>
  );
}

function SnapshotSettings() {
  const [keep, setKeep] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const [note, setNote] = useState<{ text: string; bad: boolean } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const id = useId();
  useEffect(() => {
    call('snapshot.list', {}).then(
      (r) => {
        setKeep(r.keep);
        setDraft(String(r.keep));
      },
      (e: unknown) => setFailed(plainError(e)),
    );
  }, []);
  const save = async () => {
    const n = Number(draft);
    if (keep === null || n === keep) return;
    if (!Number.isInteger(n) || n < 1 || n > 1000) {
      setNote({ text: 'Keep a whole number of snapshots from 1 to 1000.', bad: true });
      return;
    }
    try {
      const r = await call('snapshot.keep', { keep: n });
      setKeep(r.keep);
      setNote({ text: `Saved. The newest ${r.keep} snapshots are kept.`, bad: false });
    } catch (e) {
      setNote({ text: plainError(e), bad: true });
    }
  };
  if (keep === null && failed) {
    return (
      <LoadFailed what="The snapshot setting" error={failed} testId="settings-snapshots-failed" />
    );
  }
  if (keep === null) return <p>Loading the snapshot setting.</p>;
  return (
    <div className="panel stack tight" data-testid="settings-snapshots">
      <h4>Snapshots</h4>
      <div className="field">
        <label htmlFor={id}>Snapshots to keep</label>
        <input
          id={id}
          type="number"
          min={1}
          max={1000}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => void save()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save();
          }}
          data-testid="settings-snapshot-keep"
        />
      </div>
      <p className="example-note">
        A snapshot is taken every day, before every import, restore, and bulk change, and when you
        ask. Older ones beyond this number are deleted.
      </p>
      {note && (
        <p className={note.bad ? 'callout crit' : 'example-note'} role="status">
          {note.text}
        </p>
      )}
    </div>
  );
}

/**
 * ST-1, ARCH-5: the MongoDB connection string, shown masked and replaced
 * only. A new string is tested before it is stored, and the app switches to
 * it only when the test passes. Shown on the launch screen too, when MongoDB
 * cannot be reached and no bible is open.
 */
export function MongoSettings() {
  const [mongo, setMongo] = useState<MongoSettingsWire | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState<'test' | 'replace' | null>(null);
  const [note, setNote] = useState<{ text: string; bad: boolean } | null>(null);
  const { refresh } = useConnection();
  const ids = { input: useId(), hint: useId() };
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    call('mongo.status', {}).then(setMongo, (e: unknown) => setFailed(plainError(e)));
  }, []);

  const test = async () => {
    setBusy('test');
    setNote(null);
    try {
      const r = await call('mongo.test', draft.trim() ? { uri: draft } : {});
      setNote({ text: r.message, bad: !r.ok });
    } catch (e) {
      setNote({ text: plainError(e), bad: true });
    } finally {
      setBusy(null);
    }
  };
  const replace = async () => {
    setBusy('replace');
    setNote(null);
    try {
      const r = await call('mongo.replace', { uri: draft });
      setMongo(r.mongo);
      setNote({ text: r.message, bad: !r.ok });
      if (r.ok) {
        setDraft('');
        await refresh();
      }
    } catch (e) {
      setNote({ text: plainError(e), bad: true });
    } finally {
      setBusy(null);
    }
  };

  if (!mongo && failed) {
    return (
      <LoadFailed what="The MongoDB connection setting" error={failed} testId="mongo-failed" />
    );
  }
  if (!mongo) return <p>Loading the MongoDB connection.</p>;
  return (
    <div className="stack tight" data-testid="mongo-settings">
      <p data-testid="mongo-status">
        {mongo.set
          ? `A connection string is stored in ${mongo.where}: ${mongo.masked ?? ''}`
          : `No connection string is stored in ${mongo.where}.`}
      </p>
      <form
        className="stack tight"
        onSubmit={(e) => {
          e.preventDefault();
          void replace();
        }}
      >
        <label htmlFor={ids.input}>
          {mongo.set ? 'Replace the connection string' : 'Paste the connection string'}
        </label>
        <input
          id={ids.input}
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="mongodb+srv://…"
          aria-describedby={ids.hint}
          data-testid="mongo-input"
        />
        <div className="row tight">
          <button
            type="button"
            className="btn"
            onClick={() => void test()}
            disabled={busy !== null || (!draft.trim() && !mongo.set)}
            data-testid="mongo-test"
          >
            {busy === 'test' ? 'Testing the connection' : 'Test connection'}
          </button>
          <button
            type="submit"
            className="btn primary"
            disabled={busy !== null || !draft.trim()}
            data-testid="mongo-replace"
          >
            {busy === 'replace' ? 'Testing, then switching' : 'Replace connection'}
          </button>
        </div>
      </form>
      {note && (
        <p className={note.bad ? 'callout crit' : 'callout'} role="status" data-testid="mongo-note">
          {note.text}
        </p>
      )}
      <p id={ids.hint} className="example-note">
        Test connection checks the string you pasted, or the stored one when the box is empty, and
        saves nothing. Replace connection tests the new string first and switches to it only when it
        connects. The app shows only the start of the string and the end of the cluster address.
      </p>
    </div>
  );
}

const APPEARANCE_LABELS: Record<Appearance, string> = {
  system: 'Match the system',
  light: 'Light',
  dark: 'Dark',
};

/** ST-1: light, dark, or system, applied at once and kept for the next launch. */
function AppearanceSettings() {
  const [value, setValue] = useState<Appearance | null>(null);
  const [error, setError] = useState<string | null>(null);
  const name = useId();
  useEffect(() => {
    call('appearance.get', {}).then(
      (r) => setValue(r.appearance),
      (e: unknown) => setError(plainError(e)),
    );
  }, []);
  const choose = async (next: Appearance) => {
    setValue(next);
    applyAppearance(next);
    try {
      await call('appearance.set', { appearance: next });
      setError(null);
    } catch (e) {
      setError(plainError(e));
    }
  };
  if (!value) {
    return error ? (
      <div className="stack" data-testid="appearance-settings">
        <h3>Appearance</h3>
        <LoadFailed what="The appearance setting" error={error} testId="appearance-failed" />
      </div>
    ) : null;
  }
  return (
    <div className="stack" data-testid="appearance-settings">
      <h3>Appearance</h3>
      <fieldset className="panel stack tight">
        <legend className="sr-only">Appearance</legend>
        {APPEARANCES.map((a) => (
          <label key={a} className="row tight">
            <input
              type="radio"
              name={name}
              value={a}
              checked={value === a}
              onChange={() => void choose(a)}
              data-testid={`appearance-${a}`}
            />
            {APPEARANCE_LABELS[a]}
          </label>
        ))}
      </fieldset>
      {error && (
        <p className="callout crit" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function ClaudeSettings() {
  const [status, setStatus] = useState<ClaudeStatus | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [models, setModels] = useState<Models | null>(null);
  const [modelsFailed, setModelsFailed] = useState<string | null>(null);
  const [modelNote, setModelNote] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [note, setNote] = useState<{ text: string; bad: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const ids = { heading: useId(), key: useId() };
  const keySet = status?.key.set ?? false;

  useEffect(() => {
    let live = true;
    call('claude.status', {}).then(
      (s) => {
        if (live) setStatus(s);
      },
      (e: unknown) => {
        if (live) setFailed(plainError(e));
      },
    );
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    let live = true;
    call('claude.models', {}).then(
      (m) => {
        if (!live) return;
        setModels(m);
        setModelsFailed(null);
      },
      (e: unknown) => {
        if (live) setModelsFailed(plainError(e));
      },
    );
    return () => {
      live = false;
    };
  }, [keySet, status?.key.masked]);

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
    try {
      setStatus(await call('claude.clearKey', {}));
      setNote({ text: 'The key was removed from the keychain.', bad: false });
    } catch (e) {
      setNote({ text: `The key was not removed. ${plainError(e)}`, bad: true });
    }
  };

  const setModel = async (feature: ClaudeFeature, model: string) => {
    setModelNote(null);
    try {
      setStatus(await call('claude.setModel', { feature, model }));
    } catch (e) {
      setModelNote(`The model was not changed. ${plainError(e)}`);
    }
  };

  if (!status && failed) {
    return <LoadFailed what="The Claude settings" error={failed} testId="claude-settings-failed" />;
  }
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
        {modelsFailed && (
          <p className="callout crit" role="alert" data-testid="claude-models-failed">
            The list of models could not be read. {modelsFailed}
          </p>
        )}
        {CLAUDE_FEATURES.map((f) => (
          <ModelSelect
            key={f}
            feature={f}
            value={status.models[f] ?? DEFAULT_MODELS[f]}
            choices={choices(status.models[f] ?? DEFAULT_MODELS[f])}
            onChange={(m) => void setModel(f, m)}
          />
        ))}
        {modelNote && (
          <p className="callout crit" role="alert" data-testid="claude-model-note">
            {modelNote}
          </p>
        )}
      </div>
      <ClaudeInstructionsSettings />
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
