/**
 * A47 Settings groups for the open bible (IP-10, IP-11, IP-12, IP-14, IP-15):
 * the numbers, the cultural time unit, the templates, the default eras, and
 * Claude's instructions. Every value is an `Editable`, each change one undo step.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CULTURE_UNITS,
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
import type { UndoCommand } from '../../../shared/domain/undoRunner';
import { call, plainError } from '../api';
import { WriteFieldset, useWriteGuard } from '../connection';
import { useBibleSettings } from './bibleSettings';
import { useUndo } from './undo';
import { Editable } from './editable';
import './vocab.css';
import './settings.css';

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

// IP-11: numbers. A57: each group reads as a sentence of fields and unit words. The save
// delay and the outline version interval are tuning: they left the screen, keep their defaults,
// and a value stored earlier is still read.

type NumberKey = keyof BibleNumbers;
type NumberField = { key: NumberKey; label: string; min: number; max: number };
type SentencePart = string | NumberField;

const NUMBER_GROUPS: { id: string; title: string; parts: SentencePart[] }[] = [
  {
    id: 'timeline',
    title: 'Timeline',
    parts: [
      'From',
      { key: 'timelineStart', label: 'First year of the timeline', min: -10000, max: 10000 },
      'to',
      { key: 'timelineEnd', label: 'Last year of the timeline', min: -10000, max: 10000 },
    ],
  },
  {
    id: 'window',
    title: 'World window',
    parts: [
      { key: 'windowBefore', label: 'World window, years before', min: 0, max: 200 },
      'years back,',
      { key: 'windowAfter', label: 'World window, years after', min: 0, max: 200 },
      'ahead',
    ],
  },
  {
    id: 'reach',
    title: 'Event pickers',
    parts: [
      'Reach',
      { key: 'pickerReach', label: 'Picker reach in years', min: 0, max: 100 },
      'years either side',
    ],
  },
];

const fieldsOf = (parts: SentencePart[]): NumberField[] =>
  parts.filter((p): p is NumberField => typeof p !== 'string');

/** One undo step for several numbers changed together (a group's reset). */
function numbersCommand(
  title: string,
  keys: NumberKey[],
  before: BibleNumbers,
  after: BibleNumbers,
): UndoCommand {
  const parts = keys.map((k) => numberSettingCommand(call, k, before[k], after[k]));
  const [only] = parts;
  if (only && parts.length === 1) return only;
  return {
    label: `Reset the ${title.toLowerCase()}`,
    undo: parts.flatMap((c) => c.undo),
    redo: parts.flatMap((c) => c.redo),
  };
}

export function NumbersSettings() {
  const settings = useBibleSettings();
  const undo = useUndo();
  const ro = useWriteGuard();
  const save = useCallback(
    async (key: NumberKey, next: number | null) => {
      await undo.flush();
      const before = settings.numbers[key];
      const after = next ?? DEFAULT_NUMBERS[key];
      if (before === after) return;
      await call('settings.set', { numbers: { [key]: after } });
      undo.record(numberSettingCommand(call, key, before, after));
    },
    [settings.numbers, undo],
  );
  const reset = useCallback(
    async (title: string, keys: NumberKey[]) => {
      await undo.flush();
      const before = settings.numbers;
      const after = { ...before };
      for (const k of keys) after[k] = DEFAULT_NUMBERS[k];
      const changed = keys.filter((k) => before[k] !== after[k]);
      if (!changed.length) return;
      await call('settings.set', {
        numbers: Object.fromEntries(changed.map((k) => [k, after[k]])),
      });
      undo.record(numbersCommand(title, changed, before, after));
    },
    [settings.numbers, undo],
  );
  const [failed, setFailed] = useState<Note>(null);
  return (
    <div className="panel stack tight" data-testid="settings-numbers">
      <h4>Numbers</h4>
      <div className="settings-grid">
        {NUMBER_GROUPS.map((g) => {
          const fields = fieldsOf(g.parts);
          const changed = fields.some((f) => settings.numbers[f.key] !== DEFAULT_NUMBERS[f.key]);
          const defaults = fields.map((f) => DEFAULT_NUMBERS[f.key]);
          return (
            <NumberSentence
              key={g.id}
              id={g.id}
              title={g.title}
              parts={g.parts}
              values={settings.numbers}
              changed={changed}
              defaults={defaults}
              disabled={ro.off}
              onSave={save}
              onReset={() =>
                reset(
                  g.title,
                  fields.map((f) => f.key),
                ).then(
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

/** The reset button of a changed setting: it shows the value it puts back. */
function ResetChip(props: { label: string; shown: string; disabled?: boolean; onClick(): void }) {
  return (
    <button
      type="button"
      className="btn small reset-chip"
      disabled={props.disabled}
      aria-label={props.label}
      onClick={props.onClick}
    >
      <span aria-hidden="true">↺</span> {props.shown}
    </button>
  );
}

function NumberSentence(props: {
  id: string;
  title: string;
  parts: SentencePart[];
  values: BibleNumbers;
  changed: boolean;
  defaults: number[];
  disabled: boolean;
  onSave: (key: NumberKey, next: number | null) => Promise<void>;
  onReset: () => void;
}) {
  return (
    <>
      <span className="settings-label" aria-hidden="true">
        {props.title}
      </span>
      <span className="settings-value" data-group={props.id}>
        <span className="number-sentence">
          {props.parts.map((p, i) =>
            typeof p === 'string' ? (
              <span key={i} className="lab">
                {p}
              </span>
            ) : (
              <span key={p.key} data-number={p.key}>
                <Editable
                  kind="number"
                  label={p.label}
                  value={props.values[p.key]}
                  allowEmpty
                  integer
                  min={p.min}
                  max={p.max}
                  placeholder={String(DEFAULT_NUMBERS[p.key])}
                  testId={`number-${p.key}`}
                  onSave={(next) => props.onSave(p.key, next)}
                />
              </span>
            ),
          )}
        </span>
        {props.changed && (
          <ResetChip
            label={`Reset ${props.title.toLowerCase()} to ${props.defaults.join(' and ')}`}
            shown={props.defaults.join(', ')}
            disabled={props.disabled}
            onClick={props.onReset}
          />
        )}
      </span>
    </>
  );
}

// IP-10: the cultural time unit

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

// IP-14: templates

type TextTemplate = Exclude<keyof BibleTemplates, 'linkTypeLabels'>;

const TEXT_TEMPLATES: { key: TextTemplate; label: string; what: string }[] = [
  { key: 'chapterTitle', label: 'New chapter title', what: 'the new chapter title' },
  { key: 'sectionTitle', label: 'New section title', what: 'the new section title' },
  { key: 'partTitle', label: 'New part title', what: 'the new part title' },
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

/** What a title template makes for the second of its kind: "Part {n}" makes "Part 2". */
const example = (template: string) => template.replaceAll('{n}', '2');

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
        {props.value.includes('{n}') && (
          <span className="template-preview" aria-label={`For example ${example(props.value)}`}>
            {example(props.value)}
          </span>
        )}
        {props.value !== props.fallback && (
          <ResetChip
            label={`Reset ${props.label.toLowerCase()} to ${props.fallback}`}
            shown={props.fallback}
            onClick={() => void props.onSave(props.fallback)}
          />
        )}
      </span>
    </>
  );
}

// IP-12: default eras for a new bible

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
      {rows.length === 0 ? (
        <p>No default eras</p>
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
              `Added ${t.eraName}, ${nextStart} to ${nextStart + 9}.`,
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

// IP-15: Claude's instructions

function LockIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      <rect x="2" y="5" width="8" height="6" rx="1" fill="currentColor" />
      <path d="M4 5V3.5a2 2 0 0 1 4 0V5" fill="none" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

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
  // A58 (PH-8, PH-10): read again after a change elsewhere, unless a field here holds typing.
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const again = () => {
      const el = document.activeElement;
      const typing =
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        (el instanceof HTMLElement && el.isContentEditable);
      if (!(typing && box.current?.contains(el))) load();
    };
    const offs = [window.api.on('settings.changed', again), window.api.on('bible.reloaded', again)];
    return () => offs.forEach((off) => off());
  }, [load]);

  if (!items) return <NoteLine note={note} />;
  return (
    <div className="panel stack tight" data-testid="settings-instructions" ref={box}>
      <h4>Instructions for each feature</h4>
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
            {i.text !== null && (
              <button
                type="button"
                className="btn small"
                disabled={ro.off}
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
            )}
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
          <span className="instruction-footer-label instruction-lock">
            <LockIcon />
            Shared rules, always sent
          </span>
          <pre className="instruction-footer" data-testid={`instructions-footer-${i.feature}`}>
            {i.footer}
          </pre>
        </section>
      ))}
      <NoteLine note={note} />
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
    </WriteFieldset>
  );
}
