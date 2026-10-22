/**
 * A47 Settings groups for the open bible (IP-10, IP-11, IP-12, IP-14, IP-15,
 * IP-16): the numbers, the cultural time unit, the templates, the default
 * eras, Claude's instructions, and removing old revisions. Every value is an
 * `Editable` that saves on Enter or a pick, each change one undo step.
 */
import { useCallback, useEffect, useId, useState } from 'react';
import {
  CULTURE_UNITS,
  DEFAULT_BRIEF_HEADINGS,
  DEFAULT_LINK_TYPE_LABELS,
  DEFAULT_NUMBERS,
  DEFAULT_TEMPLATES,
} from '../../../shared/schema/settings';
import type { BibleNumbers, BibleTemplates, CultureUnit } from '../../../shared/schema/settings';
import type { ClaudeInstructionWire } from '../../../shared/claude';
import {
  claudeInstructionsCommand,
  cultureUnitCommand,
  eraDefaultsCommand,
  numberSettingCommand,
  templateCommand,
} from '../../../shared/undoCommands';
import type { EraDefaultRow } from '../../../shared/undoCommands';
import { call, plainError } from '../api';
import { WriteFieldset, useWriteGuard } from '../connection';
import { useBibleSettings } from './bibleSettings';
import { useUndo } from './undo';
import { Editable } from './editable';
import './vocab.css';

type Note = { text: string; bad: boolean } | null;

/** Changes after every undo, redo or new step, for values no event reports (instructions). */
function useStepKey(): string {
  const { history } = useUndo();
  return `${history.undo.length}:${history.redo.length}`;
}

function NoteLine({ note, testId }: { note: Note; testId?: string }) {
  if (!note) return null;
  return (
    <p
      className={note.bad ? 'callout crit' : 'example-note'}
      role={note.bad ? 'alert' : 'status'}
      data-testid={testId}
    >
      {note.text}
    </p>
  );
}

// ---------- IP-11: numbers ----------

const NUMBER_FIELDS: {
  key: keyof BibleNumbers;
  label: string;
  min: number;
  max: number;
  hint: string;
}[] = [
  {
    key: 'timelineStart',
    label: 'First year of the timeline',
    min: -10000,
    max: 10000,
    hint: 'Both grids start here.',
  },
  {
    key: 'timelineEnd',
    label: 'Last year of the timeline',
    min: -10000,
    max: 10000,
    hint: 'Both grids end here.',
  },
  {
    key: 'windowBefore',
    label: 'World window, years before',
    min: 0,
    max: 200,
    hint: 'Years before the story year the world window and the brief take in.',
  },
  {
    key: 'windowAfter',
    label: 'World window, years after',
    min: 0,
    max: 200,
    hint: 'Years after the story year the world window and the brief look ahead.',
  },
  {
    key: 'pickerReach',
    label: 'Picker reach in years',
    min: 0,
    max: 100,
    hint: 'Years either side of a moment the Relevant world events picker reaches.',
  },
  {
    key: 'autosaveMs',
    label: 'Autosave delay in milliseconds',
    min: 100,
    max: 750,
    hint: 'How long a box waits after the last key before it saves.',
  },
];

export function NumbersSettings() {
  const settings = useBibleSettings();
  const undo = useUndo();
  const ro = useWriteGuard();
  const save = useCallback(
    async (key: keyof BibleNumbers, next: number | null) => {
      await undo.flush();
      const before = settings.numbers[key];
      const after = next ?? DEFAULT_NUMBERS[key];
      if (before === after) return;
      await call('settings.set', { numbers: { [key]: after } });
      undo.record(numberSettingCommand(call, key, before, after));
    },
    [settings.numbers, undo],
  );
  const [failed, setFailed] = useState<Note>(null);
  return (
    <div className="panel stack tight" data-testid="settings-numbers">
      <h4>Numbers</h4>
      <p className="example-note">
        Leave a box empty, or press Reset, to go back to the default shown beside it.
      </p>
      <div className="settings-grid">
        {NUMBER_FIELDS.map((f) => {
          const value = settings.numbers[f.key];
          const fallback = DEFAULT_NUMBERS[f.key];
          return (
            <NumberRow
              key={f.key}
              field={f}
              value={value}
              fallback={fallback}
              disabled={ro.off}
              onSave={(next) => save(f.key, next)}
              onReset={() =>
                save(f.key, fallback).then(
                  () => setFailed(null),
                  (e: unknown) => setFailed({ text: plainError(e), bad: true }),
                )
              }
            />
          );
        })}
      </div>
      <NoteLine note={failed} />
    </div>
  );
}

function NumberRow(props: {
  field: (typeof NUMBER_FIELDS)[number];
  value: number;
  fallback: number;
  disabled: boolean;
  onSave: (next: number | null) => Promise<void>;
  onReset: () => void;
}) {
  const { field: f } = props;
  const hintId = useId();
  return (
    <>
      <span className="settings-label" aria-hidden="true">
        {f.label}
      </span>
      <span className="settings-value" data-number={f.key}>
        <Editable
          kind="number"
          label={f.label}
          value={props.value}
          allowEmpty
          integer
          min={f.min}
          max={f.max}
          placeholder={`Default ${props.fallback}`}
          testId={`number-${f.key}`}
          onSave={props.onSave}
        />
        <span className="settings-default" id={hintId}>
          Default {props.fallback}. {f.hint}
        </span>
        <button
          type="button"
          className="btn small"
          disabled={props.disabled || props.value === props.fallback}
          onClick={props.onReset}
          aria-describedby={hintId}
        >
          Reset {f.label.toLowerCase()} to {props.fallback}
        </button>
      </span>
    </>
  );
}

// ---------- IP-10: the cultural time unit ----------

const UNIT_LABELS: Record<CultureUnit, string> = {
  decade: 'A decade',
  five: 'Five years',
  one: 'One year',
};

export function CultureUnitSettings() {
  const settings = useBibleSettings();
  const undo = useUndo();
  return (
    <div className="panel stack tight" data-testid="settings-culture-unit">
      <h4>Cultural time unit</h4>
      <p className="example-note">
        The span of years a cultural line covers, and the step of the Cultural data screen.
      </p>
      <div className="settings-grid">
        <span className="settings-label" aria-hidden="true">
          Each cultural line covers
        </span>
        <span className="settings-value">
          <Editable
            kind="select"
            label="Cultural time unit"
            value={settings.cultureUnit}
            options={CULTURE_UNITS.map((u) => ({ value: u, label: UNIT_LABELS[u] }))}
            testId="culture-unit"
            onSave={async (next) => {
              await undo.flush();
              const before = settings.cultureUnit;
              const after = (next ?? 'decade') as CultureUnit;
              if (before === after) return;
              await call('settings.set', { cultureUnit: after });
              undo.record(cultureUnitCommand(call, before, after));
            }}
          />
        </span>
      </div>
    </div>
  );
}

// ---------- IP-14: templates ----------

type TextTemplate = Exclude<keyof BibleTemplates, 'briefHeadings' | 'linkTypeLabels'>;

const TEXT_TEMPLATES: { key: TextTemplate; label: string; what: string }[] = [
  { key: 'chapterTitle', label: 'New chapter title', what: 'the new chapter title' },
  { key: 'sectionTitle', label: 'New section title', what: 'the new section title' },
  { key: 'partTitle', label: 'New part title', what: 'the new part title' },
  { key: 'bookTitle', label: 'New book title', what: 'the new book title' },
  { key: 'eraName', label: 'New era name', what: 'the new era name' },
  { key: 'strandPresent', label: 'Present strand label', what: 'the present strand label' },
  { key: 'strandBackstory', label: 'Backstory strand label', what: 'the backstory strand label' },
];

const LINK_LABEL_NAMES: Record<string, string> = {
  married: 'Married union',
  partnered: 'Partnered union',
  biological: 'Biological parent link',
  adoptive: 'Adoptive parent link',
  step: 'Step parent link',
  guardian: 'Guardian parent link',
};

export function TemplateSettings() {
  const settings = useBibleSettings();
  const undo = useUndo();
  const t = settings.templates;
  const save = async <K extends keyof BibleTemplates>(
    key: K,
    what: string,
    after: BibleTemplates[K],
  ) => {
    await undo.flush();
    const before = t[key];
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    await call('settings.set', { templates: { [key]: after } as Partial<BibleTemplates> });
    undo.record(templateCommand(call, key, what, before, after));
  };
  return (
    <div className="panel stack tight" data-testid="settings-templates">
      <h4>Templates</h4>
      <p className="example-note">
        The names new things start with. In a title, {'{n}'} is the thing&apos;s number, so
        &quot;Part {'{n}'}&quot; makes &quot;Part 2&quot;.
      </p>
      <div className="settings-grid">
        {TEXT_TEMPLATES.map((f) => (
          <TemplateRow
            key={f.key}
            label={f.label}
            value={t[f.key]}
            fallback={DEFAULT_TEMPLATES[f.key]}
            testId={`template-${f.key}`}
            onSave={(next) => save(f.key, f.what, next)}
          />
        ))}
      </div>
      <h5>Brief section headings</h5>
      <div className="settings-grid" data-testid="template-brief-headings">
        {t.briefHeadings.map((h, i) => (
          <TemplateRow
            key={i}
            label={`Brief heading ${i + 1}`}
            value={h}
            fallback={DEFAULT_BRIEF_HEADINGS[i] ?? ''}
            testId={`template-heading-${i + 1}`}
            onSave={(next) =>
              save(
                'briefHeadings',
                'the brief headings',
                t.briefHeadings.map((x, j) => (j === i ? next : x)),
              )
            }
          />
        ))}
      </div>
      <h5>Family tree legend</h5>
      <div className="settings-grid" data-testid="template-link-labels">
        {Object.keys({ ...DEFAULT_LINK_TYPE_LABELS, ...t.linkTypeLabels }).map((k) => (
          <TemplateRow
            key={k}
            label={LINK_LABEL_NAMES[k] ?? k}
            value={t.linkTypeLabels[k] ?? DEFAULT_LINK_TYPE_LABELS[k] ?? k}
            fallback={DEFAULT_LINK_TYPE_LABELS[k] ?? k}
            testId={`template-link-${k}`}
            onSave={(next) =>
              save('linkTypeLabels', 'the tree legend labels', { ...t.linkTypeLabels, [k]: next })
            }
          />
        ))}
      </div>
    </div>
  );
}

function TemplateRow(props: {
  label: string;
  value: string;
  fallback: string;
  testId: string;
  onSave: (next: string) => Promise<void>;
}) {
  return (
    <>
      <span className="settings-label" aria-hidden="true">
        {props.label}
      </span>
      <span className="settings-value">
        <Editable
          kind="text"
          label={props.label}
          value={props.value}
          allowEmpty={false}
          testId={props.testId}
          onSave={props.onSave}
        />
        {props.value !== props.fallback && (
          <span className="settings-default">Default: {props.fallback}</span>
        )}
      </span>
    </>
  );
}

// ---------- IP-12: default eras for a new bible ----------

export function EraDefaultSettings() {
  const undo = useUndo();
  const ro = useWriteGuard();
  const { templates: t, numbers } = useBibleSettings();
  const [rows, setRows] = useState<EraDefaultRow[] | null>(null);
  const [note, setNote] = useState<Note>(null);
  const load = useCallback(() => {
    call('eraDefaults.get', {}).then(
      (r) => setRows(r.rows),
      (e: unknown) => setNote({ text: plainError(e), bad: true }),
    );
  }, []);
  const steps = useStepKey();
  useEffect(() => {
    load();
    const offs = [window.api.on('lists.changed', load), window.api.on('bible.reloaded', load)];
    return () => {
      for (const off of offs) off();
    };
  }, [load, steps]);

  const write = async (after: EraDefaultRow[]) => {
    await undo.flush();
    const before = rows ?? [];
    const r = await call('eraDefaults.set', { rows: after });
    setRows(r.rows);
    undo.record(eraDefaultsCommand(call, before, r.rows));
  };
  const change = (i: number, patch: Partial<EraDefaultRow>) =>
    write((rows ?? []).map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const run = (p: Promise<void>, done: string) =>
    p.then(
      () => setNote({ text: done, bad: false }),
      (e: unknown) => setNote({ text: plainError(e), bad: true }),
    );

  if (!rows) return <NoteLine note={note} />;
  const lastEnd = rows.at(-1)?.endYear;
  const nextStart = lastEnd === undefined ? numbers.timelineStart : lastEnd + 1;
  return (
    <div className="panel stack tight" data-testid="settings-era-defaults">
      <h4>Default eras for a new bible</h4>
      <p className="example-note">A bible made from here starts with these eras.</p>
      {rows.length === 0 ? (
        <p>No default eras. A new bible starts with none.</p>
      ) : (
        <ol className="era-default-rows">
          {rows.map((r, i) => (
            <li key={`${i}:${r.name}`} data-testid="era-default-row">
              <Editable
                kind="text"
                label={`Name of default era ${i + 1}`}
                value={r.name}
                allowEmpty={false}
                testId="era-default-name"
                onSave={(next) => change(i, { name: next })}
              />
              <Editable
                kind="year"
                label={`First year of ${r.name}`}
                value={r.startYear}
                testId="era-default-start"
                display={(s) => `from ${s}`}
                onSave={(next) => change(i, { startYear: next ?? r.startYear })}
              />
              <Editable
                kind="year"
                label={`Last year of ${r.name}`}
                value={r.endYear}
                testId="era-default-end"
                display={(s) => `to ${s}`}
                onSave={(next) => change(i, { endYear: next ?? r.endYear })}
              />
              <button
                type="button"
                className="btn small danger"
                disabled={ro.off}
                {...ro.tip}
                onClick={() =>
                  void run(
                    write(rows.filter((_, j) => j !== i)),
                    `Removed ${r.name} from the default eras.`,
                  )
                }
              >
                Remove {r.name}
              </button>
            </li>
          ))}
        </ol>
      )}
      <div className="row tight">
        <button
          type="button"
          className="btn small"
          disabled={ro.off}
          {...ro.tip}
          onClick={() =>
            void run(
              write([...rows, { name: t.eraName, startYear: nextStart, endYear: nextStart + 9 }]),
              `Added ${t.eraName}, ${nextStart} to ${nextStart + 9}. Rename it in place.`,
            )
          }
        >
          Add a default era from {nextStart}
        </button>
      </div>
      <NoteLine note={note} />
    </div>
  );
}

// ---------- IP-15: Claude's instructions ----------

export function ClaudeInstructionsSettings() {
  const undo = useUndo();
  const ro = useWriteGuard();
  const [items, setItems] = useState<ClaudeInstructionWire[] | null>(null);
  const [note, setNote] = useState<Note>(null);
  const load = useCallback(() => {
    call('claude.instructions.get', {}).then(
      (r) => setItems(r.instructions),
      (e: unknown) => setNote({ text: plainError(e), bad: true }),
    );
  }, []);

  const set = async (i: ClaudeInstructionWire, text: string | null) => {
    await undo.flush();
    const to = text === null || text.trim() === i.default.trim() ? null : text;
    if ((to ?? '') === (i.text ?? '')) return;
    const r = await call('claude.instructions.set', { feature: i.feature, text: to });
    setItems((all) => all?.map((x) => (x.feature === i.feature ? r.instruction : x)) ?? null);
    undo.record(claudeInstructionsCommand(call, i.feature, i.label, i.text, r.instruction.text));
  };

  // An undo or redo writes the instructions from outside this screen; read them again after one.
  const steps = useStepKey();
  useEffect(load, [load, steps]);

  if (!items) return <NoteLine note={note} />;
  return (
    <div className="panel stack tight" data-testid="settings-instructions">
      <h4>Instructions for each feature</h4>
      <p className="example-note">
        What Claude is told before your material. Edit a box and leave it to save. The shared rules
        under each box are always sent and cannot be changed.
      </p>
      {items.map((i) => (
        <section
          key={i.feature}
          className="stack tight instruction-card"
          data-feature={i.feature}
          aria-label={`Instructions for ${i.label}`}
        >
          <div className="row tight">
            <h5>{i.label}</h5>
            <span className="example-note">{i.text === null ? 'Default' : 'Your own'}</span>
            <button
              type="button"
              className="btn small"
              disabled={ro.off || i.text === null}
              {...ro.tip}
              onClick={() =>
                void set(i, null).then(
                  () => setNote({ text: `Reset the instructions for ${i.label}.`, bad: false }),
                  (e: unknown) => setNote({ text: plainError(e), bad: true }),
                )
              }
            >
              Reset {i.label} to default
            </button>
          </div>
          <Editable
            kind="rich"
            label={`Instructions for ${i.label}`}
            value={i.text ?? i.default}
            allowEmpty
            size="notes"
            testId={`instructions-${i.feature}`}
            onSave={(next) => set(i, next.trim() ? next : null)}
          />
          <span className="instruction-footer-label">Always added after it</span>
          <pre className="instruction-footer" data-testid={`instructions-footer-${i.feature}`}>
            {i.footer}
          </pre>
        </section>
      ))}
      <NoteLine note={note} />
    </div>
  );
}

// ---------- IP-16: remove old revisions for the whole bible ----------

const CONFIRM_WORD = 'remove';

export function PruneRevisionsSettings() {
  const ro = useWriteGuard();
  const ids = { date: useId(), word: useId() };
  const [date, setDate] = useState('');
  const [count, setCount] = useState<number | null>(null);
  const [asking, setAsking] = useState(false);
  const [word, setWord] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>(null);

  const pickDate = (next: string) => {
    setDate(next);
    setCount(null);
    setAsking(false);
    setWord('');
  };
  useEffect(() => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    let live = true;
    call('revisions.prune', { before: date, dryRun: true }).then(
      (r) => {
        if (live) setCount(r.count);
      },
      (e: unknown) => {
        if (live) setNote({ text: plainError(e), bad: true });
      },
    );
    return () => {
      live = false;
    };
  }, [date]);

  const prune = async () => {
    setBusy(true);
    setNote(null);
    try {
      const r = await call('revisions.prune', { before: date, dryRun: false });
      setNote({
        text: `Removed ${r.count} ${r.count === 1 ? 'revision' : 'revisions'} written before ${date}.`,
        bad: false,
      });
      setAsking(false);
      setWord('');
      setCount(0);
    } catch (e) {
      setNote({ text: plainError(e), bad: true });
    } finally {
      setBusy(false);
    }
  };

  const n = count ?? 0;
  const things = `${n} ${n === 1 ? 'revision' : 'revisions'}`;
  return (
    <div className="panel stack tight" data-testid="settings-prune">
      <h4>Revisions</h4>
      <p className="example-note">
        Every change keeps the entry as it was before. Old revisions can go once you no longer need
        them. This cannot be undone; a snapshot is taken first.
      </p>
      <div className="prune-row">
        <div className="field">
          <label htmlFor={ids.date}>Remove revisions older than</label>
          <input
            id={ids.date}
            type="date"
            value={date}
            disabled={ro.off}
            {...ro.tip}
            onChange={(e) => pickDate(e.target.value)}
            data-testid="prune-date"
          />
        </div>
        {count !== null && !asking && (
          <button
            type="button"
            className="btn danger"
            disabled={ro.off || count === 0}
            {...ro.tip}
            onClick={() => setAsking(true)}
          >
            Remove {things}
          </button>
        )}
      </div>
      {count !== null && (
        <p role="status" data-testid="prune-count">
          {count === 0
            ? `No revisions were written before ${date}.`
            : `${things} ${count === 1 ? 'was' : 'were'} written before ${date}.`}
        </p>
      )}
      {asking && (
        <form
          className="prune-row"
          onSubmit={(e) => {
            e.preventDefault();
            if (word.trim().toLowerCase() === CONFIRM_WORD) void prune();
          }}
        >
          <div className="field">
            <label htmlFor={ids.word}>
              Type {CONFIRM_WORD} to remove {things} for good
            </label>
            <input
              id={ids.word}
              value={word}
              autoComplete="off"
              autoFocus
              onChange={(e) => setWord(e.target.value)}
              data-testid="prune-word"
            />
          </div>
          <button
            type="submit"
            className="btn danger"
            disabled={busy || word.trim().toLowerCase() !== CONFIRM_WORD}
          >
            Remove {things} for good
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => {
              setAsking(false);
              setWord('');
            }}
          >
            Keep them
          </button>
        </form>
      )}
      <NoteLine note={note} testId="prune-note" />
    </div>
  );
}

/** The A47 groups of This bible, in the order the screen shows them. */
export function BibleVocabularySettings() {
  return (
    <WriteFieldset className="stack">
      <NumbersSettings />
      <CultureUnitSettings />
      <TemplateSettings />
      <EraDefaultSettings />
      <PruneRevisionsSettings />
    </WriteFieldset>
  );
}
