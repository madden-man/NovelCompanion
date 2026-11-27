import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  CLAUDE_FEATURES,
  DEFAULT_MODELS,
  FEATURE_INFO,
  keyStatusLine,
  looksLikeKey,
} from '../../../shared/claude';
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
import './settings.css';

/** Where the Anthropic Console lists API keys (an allowlisted host, `src/main/links.ts`). */
const KEYS_URL = 'https://console.anthropic.com/settings/keys';
/** BK-1: the snapshot count a bible keeps until it is changed (`Repository.snapshotKeep`). */
const DEFAULT_SNAPSHOT_KEEP = 30;

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
        <h3>MongoDB</h3>
        <div className="panel stack tight">
          <MongoSettings title={<h4>Connection string</h4>} />
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
      <RomanizationSystems testId="settings-romanization" />
    </div>
  );
}

/** BK-1: the snapshot count, a sentence with one digits-only field that saves when it is left. */
function SnapshotSettings() {
  const [keep, setKeep] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const [note, setNote] = useState<{ text: string; bad: boolean } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    // A58 (PH-8, PH-10): read again after a change elsewhere, unless the field holds typing.
    const load = () => {
      if (document.activeElement?.getAttribute('data-testid') === 'settings-snapshot-keep') return;
      call('snapshot.list', {}).then(
        (r) => {
          setKeep(r.keep);
          setDraft(String(r.keep));
        },
        (e: unknown) => setFailed(plainError(e)),
      );
    };
    load();
    const offs = [window.api.on('settings.changed', load), window.api.on('bible.reloaded', load)];
    return () => offs.forEach((off) => off());
  }, []);
  const save = async (raw: string) => {
    if (keep === null) return;
    // The field takes digits only; an empty box puts the stored number back.
    const n = raw === '' ? keep : Math.min(1000, Math.max(1, Number(raw)));
    setDraft(String(n));
    if (n === keep) return;
    try {
      const r = await call('snapshot.keep', { keep: n });
      setKeep(r.keep);
      setDraft(String(r.keep));
      setNote({ text: `Keeping the newest ${r.keep}.`, bad: false });
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
      <div className="row tight">
        <span className="number-sentence">
          <span className="lab">Keep the newest</span>
          <input
            className="keep-input"
            type="text"
            inputMode="numeric"
            maxLength={4}
            aria-label="Snapshots to keep"
            value={draft}
            onChange={(e) => setDraft(e.target.value.replace(/\D/g, '').slice(0, 4))}
            onBlur={() => void save(draft)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void save(draft);
            }}
            data-testid="settings-snapshot-keep"
          />
          <span className="lab">snapshots</span>
        </span>
        {keep !== DEFAULT_SNAPSHOT_KEEP && (
          <button
            type="button"
            className="btn small reset-chip"
            aria-label={`Reset snapshots to keep to ${DEFAULT_SNAPSHOT_KEEP}`}
            onClick={() => void save(String(DEFAULT_SNAPSHOT_KEEP))}
          >
            <span aria-hidden="true">↺</span> {DEFAULT_SNAPSHOT_KEEP}
          </button>
        )}
      </div>
      {note && (
        <p className={note.bad ? 'callout crit' : 'example-note'} role="status">
          {note.text}
        </p>
      )}
    </div>
  );
}

type ConnState = 'ok' | 'unchecked' | 'bad' | 'busy' | 'none';

/** A57: a connection's state as a dot and a masked value. Never a full key or string. */
function ConnStatus(props: { state: ConnState; text: string; testId: string }) {
  return (
    <span
      className="conn-status"
      data-state={props.state}
      role="status"
      aria-live="polite"
      data-testid={props.testId}
    >
      <span className="dot" aria-hidden="true" />
      {props.text}
    </span>
  );
}

interface PasteTest {
  draft: string;
  setDraft(v: string): void;
  busy: boolean;
  /** Test a value; `again` tests it even when it was the last one tried. */
  run(value: string, again?: boolean): void;
  /** Leaving the field: tests a new value only, and only one of the right shape. */
  leave(value: string): void;
}

/**
 * A57: a secret that tests itself. A paste, Enter, or leaving the field with
 * something new in it runs `test`; the field clears once the value is stored.
 * A value given while a test runs is tested when that one returns, so the
 * last paste always wins. The value lives only in this state and the
 * password field, never in a log.
 */
function usePasteTest(
  test: (value: string) => Promise<boolean>,
  shaped: (value: string) => boolean = () => true,
): PasteTest {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const tried = useRef<string | null>(null);
  const running = useRef<string | null>(null);
  const queued = useRef<string | null>(null);
  const run = (raw: string, again = false) => {
    const value = raw.trim();
    if (!value) return;
    if (running.current !== null) {
      if (value !== running.current) queued.current = value;
      return;
    }
    if (!again && value === tried.current) return;
    tried.current = value;
    running.current = value;
    setBusy(true);
    void test(value)
      .then((ok) => {
        if (ok) {
          // A newer paste in the field stays there for its own test.
          setDraft((d) => (d.trim() === value ? '' : d));
          tried.current = null;
        }
      })
      .finally(() => {
        running.current = null;
        const next = queued.current;
        queued.current = null;
        if (next !== null && next !== value) run(next, true);
        else setBusy(false);
      });
  };
  const leave = (raw: string) => {
    if (shaped(raw.trim())) run(raw);
  };
  return { draft, setDraft, busy, run, leave };
}

/** A57: the paste-and-test field, used by Settings and the launch screen alike. */
function PasteField(props: {
  label: string;
  placeholder: string;
  paste: PasteTest;
  testId: string;
  children?: ReactNode;
}) {
  const { paste } = props;
  return (
    <form
      className="row tight conn-field"
      onSubmit={(e) => {
        e.preventDefault();
        paste.run(paste.draft, true);
      }}
    >
      <input
        type="password"
        autoComplete="off"
        spellCheck={false}
        aria-label={props.label}
        placeholder={props.placeholder}
        value={paste.draft}
        aria-busy={paste.busy}
        readOnly={paste.busy}
        onChange={(e) => paste.setDraft(e.target.value)}
        onPaste={(e) => {
          const text = e.clipboardData.getData('text').trim();
          if (!text) return;
          e.preventDefault();
          paste.setDraft(text);
          paste.run(text, true);
        }}
        onBlur={() => paste.leave(paste.draft)}
        data-testid={props.testId}
      />
      {props.children}
    </form>
  );
}

/**
 * ST-1, ARCH-5: the MongoDB connection string, shown masked and replaced
 * only. A57: a pasted string is tested at once (`mongo.replace` tests first,
 * stores it in the keychain and switches only when it connects); the result
 * is the status line or the real error. The launch screen shows the same
 * field when MongoDB cannot be reached and no bible is open.
 */
export function MongoSettings(props: { title?: ReactNode }) {
  const [mongo, setMongo] = useState<MongoSettingsWire | null>(null);
  const [note, setNote] = useState<{ text: string; bad: boolean } | null>(null);
  const { status, refresh } = useConnection();
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    call('mongo.status', {}).then(setMongo, (e: unknown) => setFailed(plainError(e)));
  }, []);
  const paste = usePasteTest(async (uri) => {
    setNote(null);
    try {
      const r = await call('mongo.replace', { uri });
      setMongo(r.mongo);
      setNote({ text: r.message, bad: !r.ok });
      if (r.ok) await refresh();
      return r.ok;
    } catch (e) {
      setNote({ text: plainError(e), bad: true });
      return false;
    }
  });

  if (!mongo && failed) {
    return (
      <LoadFailed what="The MongoDB connection setting" error={failed} testId="mongo-failed" />
    );
  }
  if (!mongo) return <p>Loading the MongoDB connection.</p>;
  const masked = mongo.masked ?? '';
  const state = status?.state;
  const [dot, text]: [ConnState, string] = paste.busy
    ? ['busy', 'Testing']
    : !mongo.set
      ? ['none', 'No connection string']
      : state === 'connected'
        ? ['ok', `Connected · ${masked}`]
        : state === 'readOnly'
          ? ['bad', `Offline · ${masked}`]
          : state === 'unavailable'
            ? ['bad', `Not reachable · ${masked}`]
            : ['none', masked];
  const label = mongo.set ? 'Paste a new connection string to switch' : 'Paste a connection string';
  return (
    <div className="stack tight" data-testid="mongo-settings">
      <div className="row conn-head">
        {props.title}
        <ConnStatus state={dot} text={text} testId="mongo-status" />
      </div>
      <PasteField label={label} placeholder={label} paste={paste} testId="mongo-input" />
      {note && (
        <p className={note.bad ? 'callout crit' : 'callout'} role="status" data-testid="mongo-note">
          {note.text}
        </p>
      )}
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
  const [note, setNote] = useState<{ text: string; bad: boolean } | null>(null);
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
        // ST-1: a live list checked the key, so a key saved unchecked reads Connected now.
        if (m.live) {
          call('claude.status', {}).then(
            (s) => live && setStatus(s),
            () => undefined,
          );
        }
      },
      (e: unknown) => {
        if (live) setModelsFailed(plainError(e));
      },
    );
    return () => {
      live = false;
    };
  }, [keySet, status?.key.masked]);

  // ARCH-4: `claude.setKey` checks the key with Anthropic and stores it only when it is not rejected.
  const paste = usePasteTest(async (key) => {
    setNote(null);
    try {
      const res = await call('claude.setKey', { key });
      setStatus(res.status);
      setNote({ text: res.message, bad: !res.ok });
      return res.ok;
    } catch (e) {
      setNote({ text: plainError(e), bad: true });
      return false;
    }
  }, looksLikeKey);

  const getKey = async () => {
    const r = await call('app.openExternal', { url: KEYS_URL });
    if (!r.ok) setNote({ text: r.message, bad: true });
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
        <div className="row conn-head">
          <h4 id={ids.key}>Anthropic API key</h4>
          <ConnStatus {...keyStatusLine(status.key, paste.busy)} testId="claude-key-status" />
        </div>
        <PasteField
          label={status.key.set ? 'Paste a new Anthropic key' : 'Paste an Anthropic key'}
          placeholder={status.key.set ? 'Paste a new key to replace it' : 'Paste an Anthropic key'}
          paste={paste}
          testId="claude-key-input"
        >
          <button
            type="button"
            className="btn"
            onClick={() => void getKey()}
            data-testid="claude-get-key"
          >
            Get a key <span aria-hidden="true">↗</span>
          </button>
          {status.key.set && (
            <button type="button" className="btn" onClick={() => void remove()}>
              Remove key
            </button>
          )}
        </PasteField>
        {note && (
          <p
            className={note.bad ? 'callout crit' : 'callout'}
            role="status"
            data-testid="claude-key-note"
          >
            {note.text}
          </p>
        )}
      </div>
      <div className="panel stack tight">
        <h4>Model for each feature</h4>
        {status.key.set && models?.message && <p className="example-note">{models.message}</p>}
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
