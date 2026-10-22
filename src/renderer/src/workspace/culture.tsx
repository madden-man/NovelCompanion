import { Fragment, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useWriteGuard } from '../connection';
import {
  ageGroupOptions,
  decadeGroups,
  decadesFor,
  demographicOf,
  descriptionFor,
  placeOutline,
  spanInDecade,
  unitLabel,
  unitOf,
  unitSpan,
} from '../../../shared/domain/culture';
import type { AgeGroupOption, DecadeGroup } from '../../../shared/domain/culture';
import type { CultureUnit } from '../../../shared/schema/settings';
import { createCommand, deleteCommand, renameCommand } from '../../../shared/domain/undoRunner';
import {
  communityNoteCommand,
  communityRemoveCommand,
  cultureUnitCommand,
} from '../../../shared/undoCommands';
import type { Response } from '../../../shared/ipc';
import { entryTitle, manifests } from '../../../shared/schema';
import { blankEntry } from '../../../shared/domain/blank';
import { call, plainError } from '../api';
import { useEntries, useList, useStore } from './data';
import type { Entry } from './data';
import { updateWithUndo } from './sessions/common';
import { useStoryTime } from './storyTime';
import { useUndo } from './undo';
import { RowEditor } from './rowEditor';
import type { Picked } from './rowEditor';
import { InlineName } from './outline/InlineName';
import { Zh } from './Zh';
import { RichText } from './richText/RichText';
import { MarkdownView } from './richText/MarkdownView';
import './culture.css';
import { ListSelect } from './listSelect';
import { RomanizationSystems } from './romanizationSystems';
import { useBibleSettings, useDefaultStatus } from './bibleSettings';
import {
  Editable,
  EntryEditable,
  listOptions,
  saveEntryField,
  useEditableSave,
  useListAddNew,
} from './editable';
import type { SaveInfo } from './editable';

function YearField(props: {
  id: string;
  label: string;
  value: number;
  onChange: (n: number) => void;
}) {
  return (
    <div className="field year-field">
      <label htmlFor={props.id}>{props.label}</label>
      <input
        id={props.id}
        type="number"
        value={props.value}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isInteger(n) && Math.abs(n) <= 10000) props.onChange(n);
        }}
      />
    </div>
  );
}

export type CultureTab = 'communities' | 'eras' | 'places' | 'glossary';

const TABS: { tab: CultureTab; label: string }[] = [
  { tab: 'communities', label: 'Communities' },
  { tab: 'eras', label: 'Eras' },
  { tab: 'places', label: 'Places' },
  { tab: 'glossary', label: 'Glossary' },
];

/**
 * SM-11: Cultural data. Tab Communities: one community at a time, its
 * description, and its cultural lines for a unit of years by age group,
 * edited in place (A41, A42, IP-10). Tab Eras: the era states, edited in
 * place. Tabs Places and Glossary (IP-13): the place tree and the glossary
 * table, the same components the App menu opens.
 */
export function CulturalDataView(props: { tab: CultureTab; onTab: (tab: CultureTab) => void }) {
  const refs = useRef<Partial<Record<CultureTab, HTMLButtonElement | null>>>({});
  const baseId = useId();
  const onKey = (e: ReactKeyboardEvent, i: number) => {
    let next: number | null = null;
    if (e.key === 'ArrowRight') next = i + 1;
    else if (e.key === 'ArrowLeft') next = i - 1;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = TABS.length - 1;
    if (next === null) return;
    e.preventDefault();
    const target = TABS[(next + TABS.length) % TABS.length]?.tab;
    if (!target) return;
    props.onTab(target);
    refs.current[target]?.focus();
  };
  return (
    <div className="ws-wide-area" data-testid="cultural-data" data-tab={props.tab}>
      <div className="ws-wide stack">
        <h2 id={`${baseId}-title`}>Cultural data</h2>
        <div className="screen-tabs" role="tablist" aria-labelledby={`${baseId}-title`}>
          {TABS.map((t, i) => (
            <button
              key={t.tab}
              ref={(el) => {
                refs.current[t.tab] = el;
              }}
              type="button"
              role="tab"
              id={`${baseId}-tab-${t.tab}`}
              aria-selected={props.tab === t.tab}
              aria-controls={`${baseId}-panel`}
              tabIndex={props.tab === t.tab ? 0 : -1}
              onClick={() => props.onTab(t.tab)}
              onKeyDown={(e) => onKey(e, i)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div id={`${baseId}-panel`} role="tabpanel" aria-labelledby={`${baseId}-tab-${props.tab}`}>
          {props.tab === 'communities' && <CommunityView />}
          {props.tab === 'eras' && <ErasView />}
          {props.tab === 'places' && <PlacesView embedded />}
          {props.tab === 'glossary' && <GlossaryTable embedded />}
        </div>
      </div>
    </div>
  );
}

const UNIT_OPTIONS: { value: CultureUnit; label: string }[] = [
  { value: 'decade', label: 'A decade' },
  { value: 'five', label: 'Five years' },
  { value: 'one', label: 'One year' },
];

/** "Portland in the 2040s", "Portland in 2045 to 2049", "Portland in 2045". */
function unitHeading(start: number, unit: CultureUnit): string {
  return unit === 'decade' ? `the ${unitLabel(start, unit)}` : unitLabel(start, unit);
}

/**
 * A41, A42, CU-3, IP-10: one community at a time. Its description, then its
 * lines for one unit of years (a decade, five years or one year, as the
 * bible's settings say), grouped by the age groups list. The stepper starts
 * at the story year's unit and moves on its own; Back to the story year
 * returns. Every line edits where it sits: its text, community, age group
 * and years are fields, and "Add a note" opens a note box. Every change is
 * one undo step (ED-3, IP-6), and Undo is in the top bar (A43).
 */
export function CommunityView() {
  const statusOf = useDefaultStatus();
  const story = useStoryTime();
  const { cultureUnit: unit } = useBibleSettings();
  const communities = useList('communities');
  const ageList = useList('ageGroups');
  const entries = useEntries('culturalEntries');
  const eras = useEntries('eraStates');
  const undo = useUndo();
  const ro = useWriteGuard();
  const { version } = useStore();
  const items = communities?.items ?? [];
  const listLabel = communities?.label ?? 'Communities';
  const [picked, setPicked] = useState('');
  /** The community shown before Add new picked a new one; undoing the add goes back to it. */
  const [before, setBefore] = useState('');
  const chosen =
    items.find((c) => c.id === picked) ?? items.find((c) => c.id === before) ?? items[0] ?? null;
  /** A year inside the unit the stepper shows; null follows the story year. */
  const [at, setAt] = useState<number | null>(null);
  const storyUnit = unitOf(story.year, unit);
  const start = unitOf(at ?? story.year, unit);
  const size = unitSpan(start, unit).endYear - start + 1;
  const ageGroups = useMemo(() => ageGroupOptions(ageList), [ageList]);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const ids = { community: useId() };
  const keepButton = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    let live = true;
    void call('community.notes.get', {}).then((r) => {
      if (live) setNotes(r.notes);
    });
    return () => {
      live = false;
    };
  }, [version]);
  useEffect(() => {
    if (confirmRemove) keepButton.current?.focus();
  }, [confirmRemove]);

  const units = useMemo(() => decadesFor(entries, eras, start, unit), [entries, eras, start, unit]);
  const groups = useMemo(
    () => (chosen ? decadeGroups(entries, chosen.id, start, unit, ageGroups) : []),
    [entries, chosen, start, unit, ageGroups],
  );
  const mine = useMemo(
    () => (chosen ? entries.filter((e) => e.communityId === chosen.id && !e.deletedAt) : []),
    [entries, chosen],
  );

  const run = async (fn: () => Promise<void>) => {
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(plainError(err));
    }
  };

  const renameCommunity = (next: string) =>
    run(async () => {
      if (!chosen) return;
      const r = await call('lists.rename', {
        listId: 'communities',
        itemId: chosen.id,
        label: next,
      });
      undo.record(
        renameCommand(listLabel, 'communities', chosen.id, r.from, next.trim(), chosen.id),
      );
    });

  /** A42: the community and every line of it go, as one undo step. */
  const removeCommunity = () =>
    run(async () => {
      if (!chosen) return;
      const lines = mine.map((e) => ({ id: e._id }));
      for (const l of lines)
        await call('entry.delete', { collection: 'culturalEntries', id: l.id });
      await call('lists.removeItem', { listId: 'communities', itemId: chosen.id });
      undo.record(
        communityRemoveCommand(
          call,
          listLabel,
          'communities',
          { id: chosen.id, label: chosen.label, parentId: chosen.parentId },
          lines,
        ),
      );
      setConfirmRemove(false);
      setPicked('');
      setNotice(
        lines.length === 0
          ? `Removed ${chosen.label}. Cmd+Z brings it back.`
          : `Removed ${chosen.label} and its ${lines.length === 1 ? 'line' : `${lines.length} lines`}. Cmd+Z brings them back.`,
      );
    });

  const saveNote = (text: string) =>
    run(async () => {
      if (!chosen) return;
      const from = notes[chosen.id] ?? '';
      const r = await call('community.notes.set', { communityId: chosen.id, text });
      setNotes(r.notes);
      if (from.trim() !== text.trim()) {
        undo.record(communityNoteCommand(call, chosen.label, chosen.id, from, text));
      }
    });

  const addLine = (group: DecadeGroup<Entry>, title: string) =>
    run(async () => {
      if (!chosen) return;
      const { entry } = await call('entry.create', {
        collection: 'culturalEntries',
        data: {
          title,
          status: statusOf('idea'),
          communityId: chosen.id,
          demographic: group.demographic,
          ...unitSpan(start, unit),
        },
      });
      undo.record(createCommand('culturalEntries', entry._id, entryTitle(entry)));
    });

  const remove = (e: Entry) =>
    run(async () => {
      const title = entryTitle(e);
      await call('entry.delete', { collection: 'culturalEntries', id: e._id });
      undo.record(deleteCommand('culturalEntries', e._id, title));
      setNotice(`Removed ${title}. Cmd+Z brings it back.`);
    });

  const saveUnit = useEditableSave<string | null>({
    value: unit,
    write: (next) => call('settings.set', { cultureUnit: next as CultureUnit }),
    command: (before, after) =>
      before === after || !after
        ? null
        : cultureUnitCommand(call, before as CultureUnit, after as CultureUnit),
  });

  const step = (by: -1 | 1) => setAt(start + by * size);
  const prev = unitLabel(start - size, unit);
  const next = unitLabel(start + size, unit);

  return (
    <section className="stack" aria-label="Communities" data-testid="culture-view">
      <p className="lede">
        What a community is like, and what its people do in each span of years, by age group. Step
        through the years with Previous and Next; the story year does not move.
      </p>
      <div className="tree-toolbar cu-toolbar">
        <div className="field">
          <label htmlFor={ids.community}>Community</label>
          <ListSelect
            listId="communities"
            id={ids.community}
            value={chosen?.id ?? ''}
            emptyLabel={items.length === 0 ? 'No communities yet' : undefined}
            joinAdd
            testId="community-select"
            onChange={(next, added) => {
              // IP-8: Add new made the community; recording it here keeps the add one step.
              if (added) undo.record(added);
              setBefore(added ? (chosen?.id ?? '') : '');
              setPicked(next ?? '');
              setConfirmRemove(false);
            }}
          />
        </div>
        {chosen && (
          <div className="row tight cu-manage" role="group" aria-label={`Manage ${chosen.label}`}>
            <InlineName
              key={chosen.id}
              value={chosen.label}
              label={`Name of ${chosen.label}`}
              disabled={ro.off}
              className="btn small"
              testId="community-rename"
              onSave={(next) => void renameCommunity(next)}
            >
              Rename
            </InlineName>
            <button
              type="button"
              className="btn small danger"
              disabled={ro.off}
              {...ro.tip}
              data-testid="community-remove"
              onClick={() => setConfirmRemove(true)}
            >
              Remove
            </button>
          </div>
        )}
      </div>
      <div className="row tight cu-stepper" role="group" aria-label="Years shown">
        <button
          type="button"
          className="btn small"
          aria-label={`Previous: ${prev}`}
          data-testid="culture-prev"
          onClick={() => step(-1)}
        >
          Previous
        </button>
        <strong className="cu-unit" aria-live="polite" data-testid="culture-unit">
          {unitLabel(start, unit)}
        </strong>
        <button
          type="button"
          className="btn small"
          aria-label={`Next: ${next}`}
          data-testid="culture-next"
          onClick={() => step(1)}
        >
          Next
        </button>
        {start !== storyUnit && (
          <button
            type="button"
            className="btn small"
            data-testid="culture-to-story"
            onClick={() => setAt(null)}
          >
            Back to the story year, {unitLabel(storyUnit, unit)}
          </button>
        )}
        <span className="cu-unit-setting">
          <Editable
            kind="select"
            label="Step by"
            showLabel
            value={unit}
            options={UNIT_OPTIONS}
            testId="culture-step-by"
            onSave={saveUnit}
          />
        </span>
      </div>
      {confirmRemove && chosen && (
        <div
          className="panel stack confirm"
          role="dialog"
          aria-label={`Remove ${chosen.label}`}
          data-testid="community-confirm"
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return;
            e.preventDefault();
            e.stopPropagation();
            setConfirmRemove(false);
          }}
        >
          <strong>
            {mine.length === 0
              ? `Remove ${chosen.label}?`
              : `Remove ${chosen.label} and its ${mine.length === 1 ? 'line' : `${mine.length} lines`}? They go to the trash.`}
          </strong>
          <p>Its description goes too. Undo brings everything back.</p>
          <div className="row tight">
            <button
              ref={keepButton}
              type="button"
              className="btn small"
              onClick={() => setConfirmRemove(false)}
            >
              Keep it
            </button>
            <button
              type="button"
              className="btn small danger"
              onClick={() => void removeCommunity()}
            >
              Remove {chosen.label}
            </button>
          </div>
        </div>
      )}
      {error && (
        <p className="callout crit" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="example-note" role="status" data-testid="culture-notice">
          {notice}
        </p>
      )}
      {!chosen ? (
        <p className="example-note" data-testid="culture-no-community">
          Add a community to start: San Francisco, Jinan, a church, a family.
        </p>
      ) : (
        <>
          <CommunityNote
            key={chosen.id}
            community={chosen.label}
            stored={notes[chosen.id] ?? ''}
            disabled={ro.off}
            onSave={(text) => void saveNote(text)}
          />
          <h3 data-testid="culture-heading">
            {chosen.label} in {unitHeading(start, unit)}
          </h3>
          <div className="stack cu-groups" data-testid="culture-groups">
            {groups.map((g) => (
              <section
                key={g.demographic}
                className="panel stack tight cu-group"
                aria-label={g.label}
                data-demographic={g.demographic}
              >
                <h4>{g.label}</h4>
                {g.rows.length > 0 && (
                  <ul className="cu-lines">
                    {g.rows.map((e) => (
                      <LineRow
                        key={e._id}
                        entry={e}
                        start={start}
                        unit={unit}
                        units={units}
                        ageGroups={ageGroups}
                        disabled={ro.off}
                        onRemove={() => void remove(e)}
                      />
                    ))}
                  </ul>
                )}
                <AddLine
                  group={g}
                  span={unitHeading(start, unit)}
                  disabled={ro.off}
                  tip={ro.tip}
                  onAdd={(title) => addLine(g, title)}
                />
              </section>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

/** A41: what a community is like overall, saved when the field is left. */
function CommunityNote(props: {
  community: string;
  stored: string;
  disabled: boolean;
  onSave: (text: string) => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState(props.stored);
  const [dirty, setDirty] = useState(false);
  const [seen, setSeen] = useState(props.stored);
  if (seen !== props.stored) {
    // Adjusted during render: a save, an undo, or another writer changed the description.
    setSeen(props.stored);
    if (!dirty) setDraft(props.stored);
  }
  const commit = () => {
    setDirty(false);
    if (draft.trim() !== props.stored.trim()) props.onSave(draft);
  };
  return (
    <div className="field cu-about">
      <span id={id}>About {props.community}</span>
      <RichText
        labelledBy={id}
        value={draft}
        disabled={props.disabled}
        placeholder="What this community is like overall: who belongs, what they value, how it changes."
        testId="community-note"
        onChange={(md) => {
          setDirty(true);
          setDraft(md);
        }}
        onBlur={commit}
      />
    </div>
  );
}

/** A41: the add row under an age group: type a line and press Enter. */
function AddLine(props: {
  group: DecadeGroup<Entry>;
  /** "the 2040s", "2045 to 2049", "2045". */
  span: string;
  disabled: boolean;
  tip: { title?: string; 'aria-describedby'?: string };
  onAdd: (title: string) => Promise<void>;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const label = `New line for ${props.group.label.toLowerCase()} in ${props.span}`;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const title = text.trim();
    if (!title || busy) return;
    setBusy(true);
    try {
      await props.onAdd(title);
      setText('');
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="row tight cu-add" onSubmit={(e) => void submit(e)}>
      <input
        aria-label={label}
        placeholder="Add a line and press Enter"
        value={text}
        maxLength={500}
        disabled={props.disabled || busy}
        {...props.tip}
        onChange={(e) => setText(e.target.value)}
      />
      <button
        type="submit"
        className="btn small"
        disabled={props.disabled || busy || !text.trim()}
        {...props.tip}
      >
        Add
      </button>
    </form>
  );
}

/**
 * A42, IP-1, IP-10: one cultural line. Its text, community, age group and
 * years are fields that look like text until picked; the community and age
 * group selects end with "Add new...". A line with no note has "Add a note",
 * which opens the note box under it; the note saves as one undo step (IP-6).
 * Remove moves it to the trash (undo brings it back).
 */
function LineRow(props: {
  entry: Entry;
  start: number;
  unit: CultureUnit;
  units: readonly number[];
  ageGroups: readonly AgeGroupOption[];
  disabled: boolean;
  onRemove: () => void;
}) {
  const { entry: e, unit } = props;
  const undo = useUndo();
  const communities = useList('communities');
  const addCommunity = useListAddNew('communities');
  const addAgeGroup = useListAddNew('ageGroups');
  const [noting, setNoting] = useState(false);
  const title = entryTitle(e);
  const span = spanInDecade(e, props.start, unit);
  const hasNote = String(e.body ?? '').trim() !== '';
  const lineUnit = typeof e.startYear === 'number' ? unitOf(e.startYear, unit) : props.start;
  const unitOptions = (
    props.units.includes(lineUnit) ? props.units : [...props.units, lineUnit].sort((a, b) => a - b)
  ).map((u) => ({ value: String(u), label: unitLabel(u, unit) }));
  const group = demographicOf(e, props.ageGroups);
  const groupOptions = props.ageGroups.map((g) => ({ value: g.value, label: g.label }));
  const saveYears = async (next: string | null, info: SaveInfo) => {
    if (next === null) return;
    const span = unitSpan(Number(next), unit);
    await saveEntryField(undo, {
      collection: 'culturalEntries',
      id: e._id,
      path: 'startYear',
      value: span.startYear,
      label: 'Years',
      extraPatch: () => ({ endYear: span.endYear }),
      added: info.added,
    });
  };
  return (
    <li className="cu-line" data-id={e._id} data-demographic={group}>
      <div className="row tight cu-line-head">
        <EntryEditable
          collection="culturalEntries"
          id={e._id}
          entry={e}
          path="title"
          kind="text"
          label={`Text of ${title}`}
          allowEmpty={false}
          disabled={props.disabled}
          className="cu-line-text"
          testId="line-text"
        />
        {span && (
          <span className="chip time" data-testid="line-span">
            {span}
          </span>
        )}
        <EntryEditable
          collection="culturalEntries"
          id={e._id}
          entry={e}
          path="communityId"
          kind="select"
          label={`Community of ${title}`}
          options={listOptions(communities)}
          onAddNew={addCommunity}
          disabled={props.disabled}
          className="cu-line-select"
          testId="line-community"
        />
        <Editable
          kind="select"
          label={`Age group of ${title}`}
          value={group}
          options={groupOptions}
          onAddNew={addAgeGroup}
          disabled={props.disabled}
          className="cu-line-select"
          testId="line-group"
          data-field="demographic"
          onSave={async (next, info) => {
            await saveEntryField(undo, {
              collection: 'culturalEntries',
              id: e._id,
              path: 'demographic',
              value: next ?? 'all',
              label: 'Age group',
              added: info.added,
            });
          }}
        />
        <Editable
          kind="select"
          label={`Years of ${title}`}
          value={String(lineUnit)}
          options={unitOptions}
          disabled={props.disabled}
          className="cu-line-select"
          testId="line-unit"
          data-field="startYear"
          onSave={saveYears}
        />
        {!hasNote && !noting && (
          <button
            type="button"
            className="btn small"
            aria-label={`Add a note to ${title}`}
            disabled={props.disabled}
            data-testid="line-add-note"
            onClick={() => setNoting(true)}
          >
            Add a note
          </button>
        )}
        <button
          type="button"
          className="btn small danger"
          aria-label={`Remove ${title}`}
          disabled={props.disabled}
          onClick={props.onRemove}
        >
          Remove
        </button>
      </div>
      {(hasNote || noting) && (
        <EntryEditable
          collection="culturalEntries"
          id={e._id}
          entry={e}
          path="body"
          kind="rich"
          label={`Note on ${title}`}
          placeholder="Add a note"
          disabled={props.disabled}
          className="cu-note"
          testId="line-note"
          autoOpen={noting && !hasNote}
          onClose={() => setNoting(false)}
        />
      )}
    </li>
  );
}

/**
 * WE-2, SM-4: the era of the story year, edited in place: name, start and end year, and body.
 * The year control at the top moves it. An era stays on screen while its years are edited,
 * until the story year changes, so a new end year never pulls the row away mid-edit.
 */
function ErasView() {
  const eras = useEntries('eraStates');
  const { templates } = useBibleSettings();
  const statusOf = useDefaultStatus();
  const story = useStoryTime();
  const undo = useUndo();
  const ro = useWriteGuard();
  const [error, setError] = useState<string | null>(null);
  const [fresh, setFresh] = useState<string | null>(null);
  const year = story.year;
  const covers = (e: Entry) => Number(e.startYear) <= year && year <= Number(e.endYear);
  const sorted = useMemo(
    () => [...eras].sort((a, b) => Number(a.startYear ?? 0) - Number(b.startYear ?? 0)),
    [eras],
  );
  const currentIds = sorted.filter(covers).map((e) => e._id);
  const [kept, setKept] = useState<{ year: number; ids: ReadonlySet<string> }>({
    year,
    ids: new Set(currentIds),
  });
  if (kept.year !== year) {
    // Adjusted during render: the story year moved, so start over from its eras.
    setKept({ year, ids: new Set(currentIds) });
    setFresh(null);
  } else if (currentIds.some((id) => !kept.ids.has(id))) {
    setKept({ year, ids: new Set([...kept.ids, ...currentIds]) });
  }
  const rows = sorted.filter(
    (e) => covers(e) || (kept.year === year && kept.ids.has(e._id)) || e._id === fresh,
  );
  const covering = sorted.filter(covers);

  const save = async (id: string, patch: Record<string, unknown>, label: string) => {
    setError(null);
    try {
      await updateWithUndo(undo, 'eraStates', id, patch, label);
    } catch (e) {
      setError(plainError(e));
    }
  };

  /** With no era for the story year the new one fills the gap around it; otherwise it follows the last. */
  const create = async () => {
    setError(null);
    let start: number;
    let end: number;
    if (covering.length === 0) {
      const before = sorted.filter((e) => Number(e.endYear) < year).at(-1);
      const after = sorted.find((e) => Number(e.startYear) > year);
      start = before ? Math.max(Number(before.endYear) + 1, year - 9) : year;
      end = after ? Number(after.startYear) - 1 : start + 9;
    } else {
      start = Number(sorted.at(-1)?.endYear ?? year) + 1;
      end = start + 9;
    }
    try {
      const { entry } = await call('entry.create', {
        collection: 'eraStates',
        data: {
          title: templates.eraName,
          name: templates.eraName,
          startYear: start,
          endYear: end,
          status: statusOf('idea'),
        },
      });
      undo.record(createCommand('eraStates', entry._id, entryTitle(entry)));
      setFresh(entry._id);
    } catch (e) {
      setError(plainError(e));
    }
  };

  return (
    <section className="stack" aria-label="Eras" data-testid="eras-view">
      <p className="lede">
        The state of the world in the story year&apos;s era. Move the year at the top to see another
        era. Edit a field and leave it to save; each change is one undo step.
      </p>
      {covering.length === 0 && (
        <p className="callout warn" role="status" data-testid="era-gap">
          No era covers {year}. This is a flag only; every era still saves.
        </p>
      )}
      {covering.length > 1 && (
        <p className="callout warn" role="status" data-testid="era-overlap">
          {covering.length} eras cover {year}. Their years overlap. This is a flag only; every era
          still saves.
        </p>
      )}
      <div className="row">
        <button
          type="button"
          className="btn primary small"
          onClick={() => void create()}
          disabled={ro.off}
          {...ro.tip}
        >
          {covering.length === 0 ? `New era for ${year}` : 'New era'}
        </button>
        <span className="example-note">
          {sorted.length} {sorted.length === 1 ? 'era' : 'eras'} in all
        </span>
      </div>
      {error && (
        <p className="callout crit" role="alert">
          {error}
        </p>
      )}
      {rows.length > 0 && (
        <ul className="era-list">
          {rows.map((e) => (
            <EraRow
              key={e._id}
              era={e}
              current={covers(e)}
              autoFocus={fresh === e._id}
              disabled={ro.off}
              onSave={(patch, label) => void save(e._id, patch, label)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function EraRow(props: {
  era: Entry;
  current: boolean;
  autoFocus: boolean;
  disabled: boolean;
  onSave: (patch: Record<string, unknown>, label: string) => void;
}) {
  const { era } = props;
  const name = String(era.name ?? '');
  const ids = { name: useId(), start: useId(), end: useId(), body: useId() };
  type Key = 'name' | 'start' | 'end' | 'body';
  const stored: Record<Key, string> = {
    name,
    start: String(era.startYear ?? ''),
    end: String(era.endYear ?? ''),
    body: String(era.body ?? ''),
  };
  const [draft, setDraft] = useState(stored);
  /** Fields typed in and not yet committed: a change from elsewhere never overwrites them. */
  const [dirty, setDirty] = useState<ReadonlySet<Key>>(new Set());
  const storedKey = JSON.stringify(stored);
  const [seen, setSeen] = useState(storedKey);
  if (seen !== storedKey) {
    // Adjusted during render: a save, an undo or another writer changed the era.
    setSeen(storedKey);
    setDraft((d) => {
      const next = { ...d };
      for (const k of Object.keys(stored) as Key[]) if (!dirty.has(k)) next[k] = stored[k];
      return next;
    });
  }
  const edit = (key: Key, value: string) => {
    setDirty((prev) => new Set(prev).add(key));
    setDraft((d) => ({ ...d, [key]: value }));
  };
  const year = (t: string) => (/^-?\d{1,5}$/.test(t.trim()) ? Number(t) : null);
  const commit = (key: Key) => {
    setDirty((prev) => {
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
    const v = draft[key];
    if (key === 'name') {
      if (v.trim() && v !== name) props.onSave({ name: v.trim(), title: v.trim() }, 'Era name');
      else setDraft((d) => ({ ...d, name }));
    } else if (key === 'start' || key === 'end') {
      const field = key === 'start' ? 'startYear' : 'endYear';
      const n = year(v);
      if (n !== null && n !== era[field]) {
        props.onSave({ [field]: n }, key === 'start' ? 'Start year' : 'End year');
      } else if (n === null) setDraft((d) => ({ ...d, [key]: String(era[field] ?? '') }));
    } else if (v !== String(era.body ?? '')) props.onSave({ body: v }, 'Era description');
  };
  const input = (key: 'start' | 'end') => ({
    value: draft[key],
    onChange: (ev: { target: { value: string } }) => edit(key, ev.target.value),
    onBlur: () => commit(key),
    onKeyDown: (ev: ReactKeyboardEvent) => {
      if (ev.key === 'Enter') commit(key);
    },
  });
  return (
    <li
      className={`panel stack tight era-row${props.current ? ' current' : ''}`}
      data-era={era._id}
      aria-current={props.current ? 'date' : undefined}
    >
      <fieldset className="write-group stack tight" disabled={props.disabled}>
        <div className="row era-head">
          <div className="field">
            <label htmlFor={ids.name}>Era name</label>
            <input
              id={ids.name}
              value={draft.name}
              autoFocus={props.autoFocus}
              onChange={(ev) => edit('name', ev.target.value)}
              onBlur={() => commit('name')}
              onKeyDown={(ev) => {
                if (ev.key === 'Enter') commit('name');
              }}
            />
          </div>
          <div className="field year-field">
            <label htmlFor={ids.start}>Start year</label>
            <input id={ids.start} className="num" inputMode="numeric" {...input('start')} />
          </div>
          <div className="field year-field">
            <label htmlFor={ids.end}>End year</label>
            <input id={ids.end} className="num" inputMode="numeric" {...input('end')} />
          </div>
          {props.current && <span className="chip time">story year</span>}
        </div>
        <div className="field">
          <span id={ids.body}>What the world is like</span>
          <RichText
            labelledBy={ids.body}
            value={draft.body}
            disabled={props.disabled}
            onChange={(md) => edit('body', md)}
            onBlur={() => commit('body')}
          />
        </div>
      </fieldset>
    </li>
  );
}

/**
 * A form that makes a new entry from one typed name (IP-13): type it and
 * press Enter or the button. The entry is one undo step.
 */
function NewByName(props: {
  label: string;
  button: string;
  testId: string;
  onCreate: (name: string) => Promise<void>;
}) {
  const ro = useWriteGuard();
  const id = useId();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const name = text.trim();
    if (!name || busy) return;
    setBusy(true);
    setError(null);
    try {
      await props.onCreate(name);
      setText('');
    } catch (err) {
      setError(plainError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="stack tight" onSubmit={(e) => void submit(e)} data-testid={props.testId}>
      <div className="row tight cu-add">
        <label htmlFor={id} className="sr-only">
          {props.label}
        </label>
        <input
          id={id}
          placeholder={props.label}
          value={text}
          maxLength={200}
          disabled={ro.off || busy}
          {...ro.tip}
          onChange={(e) => setText(e.target.value)}
        />
        <button
          type="submit"
          className="btn small"
          disabled={ro.off || busy || !text.trim()}
          {...ro.tip}
        >
          {props.button}
        </button>
      </div>
      {error && (
        <p className="callout crit" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

/**
 * PC-1: places nested under the places they sit in, each with its description
 * for a chosen year. IP-13: each name renames in place, and New place adds
 * one at the top level. A43: Edit opens the place's editor in place, under
 * its row, for its parent and its descriptions by year. The App menu's Place
 * tree and the Places tab of Cultural data (`embedded`) are this one view.
 */
export function PlacesView(props: { embedded?: boolean } = {}) {
  const story = useStoryTime();
  const undo = useUndo();
  const statusOf = useDefaultStatus();
  const ro = useWriteGuard();
  const [open, setOpen] = useState<Picked | null>(null);
  const places = useEntries('places');
  const [year, setYear] = useState(story.year);
  const yearId = useId();
  const titleId = useId();
  const nodes = useMemo(() => placeOutline(places), [places]);
  const byId = new Map(places.map((p) => [p._id, p]));
  const Heading = props.embedded ? 'h3' : 'h2';

  const create = async (name: string) => {
    const { entry } = await call('entry.create', {
      collection: 'places',
      data: { ...blankEntry(manifests.places), title: name, status: statusOf('idea') },
    });
    undo.record(createCommand('places', entry._id, entryTitle(entry)));
  };

  return (
    <section
      className={props.embedded ? 'stack' : 'ws-wide stack'}
      aria-labelledby={titleId}
      data-testid="places-view"
    >
      <Heading id={titleId}>{props.embedded ? 'Places' : 'Place tree'}</Heading>
      <p className="lede">
        Places sit inside larger places. Each shows its description for the year you pick. Click a
        name to rename it; Edit opens its parent and its descriptions by year under it.
      </p>
      <YearField id={yearId} label="Year" value={year} onChange={setYear} />
      <NewByName
        label="Name of a new place"
        button="New place"
        testId="new-place"
        onCreate={create}
      />
      {nodes.length === 0 ? (
        <p className="example-note">No places yet.</p>
      ) : (
        <ul className="place-tree">
          {nodes.map((n) => {
            const place = byId.get(n.id);
            const d = place ? descriptionFor(place as never, year) : null;
            const name = n.title || 'Untitled';
            return (
              <li
                key={n.id}
                style={{ paddingLeft: n.depth * 20 }}
                data-place={n.id}
                data-depth={n.depth}
              >
                <EntryEditable
                  collection="places"
                  id={n.id}
                  entry={place ?? null}
                  path="title"
                  kind="text"
                  label={`Name of ${name}`}
                  allowEmpty={false}
                  disabled={ro.off}
                  className="place-name"
                  testId="place-name"
                  display={(t) => <Zh text={t || 'Untitled'} actions={false} />}
                />{' '}
                <span className="place-desc" data-testid="place-description">
                  {d ? (
                    <Zh text={d.text} />
                  ) : (
                    <span className="example-note">No description for {year}.</span>
                  )}
                </span>{' '}
                <button
                  type="button"
                  className="btn small"
                  aria-expanded={open?.id === n.id}
                  onClick={() =>
                    setOpen(open?.id === n.id ? null : { collection: 'places', id: n.id })
                  }
                >
                  Edit {name}
                </button>
                {open?.id === n.id && (
                  <RowEditor open={open} onClose={() => setOpen(null)} testId="place-editor" />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** GL-1: one romanization system per language, and the terms that do not follow it, each opening in place (A43). */
export function RomanizationView() {
  const [open, setOpen] = useState<Picked | null>(null);
  const { version } = useStore();
  const [terms, setTerms] = useState<Response<'entry.list'>['entries']>([]);

  useEffect(() => {
    let live = true;
    void call('entry.list', { collection: 'glossaryTerms', trash: 'exclude' }).then((r) => {
      if (live) setTerms(r.entries);
    });
    return () => {
      live = false;
    };
  }, [version]);

  const flagged = terms.filter((t) => t.warnings.some((w) => w.code === 'romanization-system'));

  return (
    <section
      className="ws-wide stack"
      aria-labelledby="roman-title"
      data-testid="romanization-view"
    >
      <h2 id="roman-title">Romanization</h2>
      <p className="lede">
        Each language uses one romanization system. Glossary terms that do not follow it are
        flagged, and they still save. Add new... on a language&apos;s select adds a system.
      </p>
      <RomanizationSystems testId="romanization-systems" />
      <h3>Terms that do not follow their system</h3>
      {flagged.length === 0 ? (
        <p className="example-note" data-testid="romanization-ok">
          Every glossary term follows its language&apos;s system.
        </p>
      ) : (
        <ul className="stack-list" data-testid="romanization-flagged">
          {flagged.map(({ entry, warnings }) => (
            <li key={entry._id} data-term={entry._id}>
              <button
                type="button"
                className="link-btn"
                aria-expanded={open?.id === entry._id}
                onClick={() =>
                  setOpen(
                    open?.id === entry._id ? null : { collection: 'glossaryTerms', id: entry._id },
                  )
                }
              >
                <Zh text={entryTitle(entry)} actions={false} />
              </button>{' '}
              <span>{warnings.find((w) => w.code === 'romanization-system')?.message}</span>
              {open?.id === entry._id && (
                <RowEditor open={open} onClose={() => setOpen(null)} testId="term-editor" />
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * GL-1, GL-3: every glossary term in one table. Hovering or focusing the
 * characters shows the meaning. IP-13: the term, its romanization, its
 * language and its meaning edit in place (one undo step each), and New term
 * adds one. A43: Edit opens the term's editor in a row under its own, for
 * every other field. The App menu's Glossary table and the Glossary tab of
 * Cultural data (`embedded`) are this one view.
 */
export function GlossaryTable(props: { embedded?: boolean } = {}) {
  const terms = useEntries('glossaryTerms');
  const undo = useUndo();
  const statusOf = useDefaultStatus();
  const ro = useWriteGuard();
  const [open, setOpen] = useState<Picked | null>(null);
  const languages = useList('languages');
  const addLanguage = useListAddNew('languages');
  const titleId = useId();
  const Heading = props.embedded ? 'h3' : 'h2';
  const rows = useMemo(
    () => [...terms].sort((a, b) => String(a.characters).localeCompare(String(b.characters))),
    [terms],
  );
  /** The title follows the characters while it still matches them (the title is what lists show). */
  const titleFollows = (next: unknown, entry: Record<string, unknown>) =>
    !entry.title || entry.title === entry.characters ? { title: next } : {};

  const create = async (characters: string) => {
    const language = languages?.items[0]?.id;
    if (!language) throw new Error('Add a language on the Lists screen first.');
    const { entry } = await call('entry.create', {
      collection: 'glossaryTerms',
      data: {
        ...blankEntry(manifests.glossaryTerms),
        title: characters,
        characters,
        language,
        status: statusOf('idea'),
      },
    });
    undo.record(createCommand('glossaryTerms', entry._id, entryTitle(entry)));
  };

  return (
    <section
      className={props.embedded ? 'stack' : 'ws-wide stack'}
      aria-labelledby={titleId}
      data-testid="glossary-table"
    >
      <Heading id={titleId}>{props.embedded ? 'Glossary' : 'Glossary table'}</Heading>
      <p className="lede">
        Every term with its characters, romanization, language, and meaning. Click a value to change
        it. Hover over the characters or focus them with the keyboard for the meaning.
      </p>
      <NewByName
        label="Characters of a new term"
        button="New term"
        testId="new-term"
        onCreate={create}
      />
      {rows.length === 0 ? (
        <p className="example-note">No glossary terms yet.</p>
      ) : (
        <div className="table-wrap glossary-wrap">
          <table className="compact">
            <thead>
              <tr>
                <th scope="col">Characters</th>
                <th scope="col">Romanization</th>
                <th scope="col">Language</th>
                <th scope="col">Meaning</th>
                <th scope="col">Open</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => {
                const chars = String(t.characters ?? '');
                return (
                  <Fragment key={t._id}>
                    <tr data-term={t._id}>
                      <td>
                        <EntryEditable
                          collection="glossaryTerms"
                          id={t._id}
                          entry={t}
                          path="characters"
                          kind="text"
                          label={`Characters of ${chars}`}
                          allowEmpty={false}
                          disabled={ro.off}
                          testId="term-characters"
                          extraPatch={titleFollows}
                          display={(s) => <Zh text={s} actions={false} />}
                        />
                      </td>
                      <td>
                        <EntryEditable
                          collection="glossaryTerms"
                          id={t._id}
                          entry={t}
                          path="romanization"
                          kind="text"
                          label={`Romanization of ${chars}`}
                          placeholder="Add"
                          disabled={ro.off}
                          testId="term-romanization"
                        />
                      </td>
                      <td>
                        <EntryEditable
                          collection="glossaryTerms"
                          id={t._id}
                          entry={t}
                          path="language"
                          kind="select"
                          label={`Language of ${chars}`}
                          options={listOptions(languages)}
                          onAddNew={addLanguage}
                          disabled={ro.off}
                          testId="term-language"
                        />
                      </td>
                      <td>
                        <EntryEditable
                          collection="glossaryTerms"
                          id={t._id}
                          entry={t}
                          path="meaning"
                          kind="rich"
                          layout="inline"
                          label={`Meaning of ${chars}`}
                          placeholder="Add a meaning"
                          disabled={ro.off}
                          testId="term-meaning"
                          display={(s) => <MarkdownView text={s} inline />}
                        />
                      </td>
                      <td>
                        <button
                          type="button"
                          className="btn small"
                          aria-expanded={open?.id === t._id}
                          onClick={() =>
                            setOpen(
                              open?.id === t._id
                                ? null
                                : { collection: 'glossaryTerms', id: t._id },
                            )
                          }
                        >
                          Edit {chars}
                        </button>
                      </td>
                    </tr>
                    {open?.id === t._id && (
                      <tr className="row-editor-tr">
                        <td colSpan={5}>
                          <RowEditor
                            open={open}
                            onClose={() => setOpen(null)}
                            testId="term-editor"
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
