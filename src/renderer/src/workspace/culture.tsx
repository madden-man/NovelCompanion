import { Fragment, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useWriteGuard } from '../connection';
import {
  decadeGroups,
  decadeLabel,
  decadeOf,
  decadeSpan,
  decadesFor,
  descriptionFor,
  placeOutline,
  spanInDecade,
} from '../../../shared/domain/culture';
import type { DecadeGroup } from '../../../shared/domain/culture';
import { createCommand, deleteCommand, renameCommand } from '../../../shared/domain/undoRunner';
import {
  communityNoteCommand,
  communityRemoveCommand,
  listAddCommand,
  romanizationCommand,
} from '../../../shared/undoCommands';
import type { Response } from '../../../shared/ipc';
import { DEMOGRAPHIC_OPTIONS } from '../../../shared/schema/world';
import { entryTitle } from '../../../shared/schema';
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
import { useBibleSettings } from './bibleSettings';

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

export type CultureTab = 'communities' | 'eras';

const TABS: { tab: CultureTab; label: string }[] = [
  { tab: 'communities', label: 'Communities' },
  { tab: 'eras', label: 'Eras' },
];

/**
 * SM-11: Cultural data. Tab Communities: one community at a time, its
 * description, and its cultural lines for the story year's decade by age
 * group, edited in place (A41, A42). Tab Eras: the era states, edited in place.
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
          {props.tab === 'communities' ? <CommunityView /> : <ErasView />}
        </div>
      </div>
    </div>
  );
}

/**
 * A41, A42, CU-3: one community at a time. Its description, then its lines
 * for the story year's decade (the year control at the top moves it),
 * grouped by age group. Every line edits where it sits; its age group and
 * decade are selects at the end of the row. Every change is one undo step
 * (ED-3), and Undo is in the top bar (A43).
 */
export function CommunityView() {
  const story = useStoryTime();
  const communities = useList('communities');
  const entries = useEntries('culturalEntries');
  const eras = useEntries('eraStates');
  const undo = useUndo();
  const ro = useWriteGuard();
  const { version } = useStore();
  const items = communities?.items ?? [];
  const listLabel = communities?.label ?? 'Communities';
  const [picked, setPicked] = useState('');
  const chosen = items.find((c) => c.id === picked) ?? items[0] ?? null;
  const decade = decadeOf(story.year);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [confirmRemove, setConfirmRemove] = useState(false);
  const ids = { community: useId(), newName: useId() };
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

  const decades = useMemo(() => decadesFor(entries, eras, story.year), [entries, eras, story.year]);
  const groups = useMemo(
    () => (chosen ? decadeGroups(entries, chosen.id, decade) : []),
    [entries, chosen, decade],
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

  const addCommunity = (e: FormEvent) => {
    e.preventDefault();
    const label = newName.trim();
    if (!label) return;
    void run(async () => {
      const { item } = await call('lists.addItem', {
        listId: 'communities',
        label,
        parentId: null,
      });
      undo.record(listAddCommand(call, listLabel, 'communities', item));
      setNewName('');
      setPicked(item.id);
    });
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
          status: 'idea',
          communityId: chosen.id,
          demographic: group.demographic,
          ...decadeSpan(decade),
        },
      });
      undo.record(createCommand('culturalEntries', entry._id, entryTitle(entry)));
    });

  const edit = (id: string, patch: Record<string, unknown>, label: string) =>
    run(async () => {
      await updateWithUndo(undo, 'culturalEntries', id, patch, label);
    });

  const remove = (e: Entry) =>
    run(async () => {
      const title = entryTitle(e);
      await call('entry.delete', { collection: 'culturalEntries', id: e._id });
      undo.record(deleteCommand('culturalEntries', e._id, title));
      setNotice(`Removed ${title}. Cmd+Z brings it back.`);
    });

  return (
    <section className="stack" aria-label="Communities" data-testid="culture-view">
      <p className="lede">
        What a community is like, and what its people do in the story year&apos;s decade, by age
        group. Move the year at the top to see another decade.
      </p>
      <div className="tree-toolbar cu-toolbar">
        <div className="field">
          <label htmlFor={ids.community}>Community</label>
          <select
            id={ids.community}
            value={chosen?.id ?? ''}
            onChange={(e) => {
              setPicked(e.target.value);
              setConfirmRemove(false);
            }}
            disabled={items.length === 0}
          >
            {items.length === 0 && <option value="">No communities yet</option>}
            {items.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
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
        <form className="field cu-new-community" onSubmit={addCommunity}>
          <label htmlFor={ids.newName}>New community</label>
          <span className="row tight">
            <input
              id={ids.newName}
              value={newName}
              maxLength={200}
              disabled={ro.off}
              {...ro.tip}
              onChange={(e) => setNewName(e.target.value)}
            />
            <button
              type="submit"
              className="btn small"
              disabled={ro.off || !newName.trim()}
              {...ro.tip}
            >
              Add community
            </button>
          </span>
        </form>
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
            {chosen.label} in the {decadeLabel(decade)}
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
                        decade={decade}
                        decades={decades}
                        disabled={ro.off}
                        onEdit={(patch, label) => void edit(e._id, patch, label)}
                        onRemove={() => void remove(e)}
                      />
                    ))}
                  </ul>
                )}
                <AddLine
                  group={g}
                  decade={decade}
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
  decade: number;
  disabled: boolean;
  tip: { title?: string; 'aria-describedby'?: string };
  onAdd: (title: string) => Promise<void>;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const label = `New line for ${props.group.label.toLowerCase()} in the ${decadeLabel(props.decade)}`;
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
 * A42: one cultural line. The text and its note edit directly and save when
 * the field is left; the age group and the decade are selects at the end of
 * the row; Remove moves it to the trash (undo brings it back).
 */
function LineRow(props: {
  entry: Entry;
  decade: number;
  decades: readonly number[];
  disabled: boolean;
  onEdit: (patch: Record<string, unknown>, label: string) => void;
  onRemove: () => void;
}) {
  const { entry: e } = props;
  const title = entryTitle(e);
  const ids = { text: useId(), group: useId(), decade: useId() };
  type Key = 'text' | 'note';
  const stored: Record<Key, string> = { text: title, note: String(e.body ?? '') };
  const [draft, setDraft] = useState(stored);
  const [dirty, setDirty] = useState<ReadonlySet<Key>>(new Set());
  const storedKey = JSON.stringify(stored);
  const [seen, setSeen] = useState(storedKey);
  if (seen !== storedKey) {
    // Adjusted during render: a save, an undo or another writer changed the line.
    setSeen(storedKey);
    setDraft((d) => {
      const next = { ...d };
      for (const k of Object.keys(stored) as Key[]) if (!dirty.has(k)) next[k] = stored[k];
      return next;
    });
  }
  const set = (key: Key, value: string) => {
    setDirty((prev) => new Set(prev).add(key));
    setDraft((d) => ({ ...d, [key]: value }));
  };
  const undirty = (key: Key) =>
    setDirty((prev) => {
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  const commit = (key: Key) => {
    undirty(key);
    const v = draft[key];
    if (key === 'text') {
      if (v.trim() && v.trim() !== title) props.onEdit({ title: v.trim() }, 'Text');
      else setDraft((d) => ({ ...d, text: title }));
    } else if (v !== stored.note) props.onEdit({ body: v }, 'Note');
  };
  const span = spanInDecade(e, props.decade);
  const hasNote = stored.note.trim() !== '';
  const lineDecade = typeof e.startYear === 'number' ? decadeOf(e.startYear) : props.decade;
  const decadeOptions = props.decades.includes(lineDecade)
    ? props.decades
    : [...props.decades, lineDecade].sort((a, b) => a - b);
  const group = typeof e.demographic === 'string' ? e.demographic : 'all';
  return (
    <li className="cu-line" data-id={e._id} data-demographic={group}>
      <div className="row tight cu-line-head">
        <input
          id={ids.text}
          className="cu-line-text"
          aria-label={`Text of ${title}`}
          value={draft.text}
          maxLength={500}
          disabled={props.disabled}
          data-testid="line-text"
          onChange={(ev) => set('text', ev.target.value)}
          onBlur={() => commit('text')}
          onKeyDown={(ev) => {
            if (ev.key === 'Enter') {
              ev.preventDefault();
              commit('text');
            } else if (ev.key === 'Escape') {
              ev.preventDefault();
              undirty('text');
              setDraft((d) => ({ ...d, text: title }));
            }
          }}
        />
        {span && (
          <span className="chip time" data-testid="line-span">
            {span}
          </span>
        )}
        <select
          id={ids.group}
          className="cu-line-select"
          aria-label={`Age group of ${title}`}
          value={group}
          disabled={props.disabled}
          data-testid="line-group"
          onChange={(ev) => props.onEdit({ demographic: ev.target.value }, 'Age group')}
        >
          {DEMOGRAPHIC_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <select
          id={ids.decade}
          className="cu-line-select"
          aria-label={`Decade of ${title}`}
          value={lineDecade}
          disabled={props.disabled}
          data-testid="line-decade"
          onChange={(ev) => props.onEdit(decadeSpan(Number(ev.target.value)), 'Decade')}
        >
          {decadeOptions.map((d) => (
            <option key={d} value={d}>
              {decadeLabel(d)}
            </option>
          ))}
        </select>
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
      {hasNote && (
        <RichText
          mode="inline"
          className="cu-note"
          label={`Note on ${title}`}
          value={draft.note}
          disabled={props.disabled}
          testId="line-note"
          onChange={(md) => set('note', md)}
          onBlur={() => commit('note')}
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
          status: 'idea',
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
 * PC-1: places nested under the places they sit in, each with its description
 * for a chosen year. A43: a picked place opens its editor in place, under its row.
 */
export function PlacesView() {
  const story = useStoryTime();
  const [open, setOpen] = useState<Picked | null>(null);
  const places = useEntries('places');
  const [year, setYear] = useState(story.year);
  const yearId = useId();
  const nodes = useMemo(() => placeOutline(places), [places]);
  const byId = new Map(places.map((p) => [p._id, p]));

  return (
    <section className="ws-wide stack" aria-labelledby="places-title" data-testid="places-view">
      <h2 id="places-title">Place tree</h2>
      <p className="lede">
        Places sit inside larger places. Each shows its description for the year you pick. Pick a
        place to set its parent and its descriptions by year; its editor opens under it.
      </p>
      <YearField id={yearId} label="Year" value={year} onChange={setYear} />
      {nodes.length === 0 ? (
        <p className="example-note">No places yet.</p>
      ) : (
        <ul className="place-tree">
          {nodes.map((n) => {
            const place = byId.get(n.id);
            const d = place ? descriptionFor(place as never, year) : null;
            return (
              <li
                key={n.id}
                style={{ paddingLeft: n.depth * 20 }}
                data-place={n.id}
                data-depth={n.depth}
              >
                <button
                  type="button"
                  className="link-btn"
                  aria-expanded={open?.id === n.id}
                  onClick={() =>
                    setOpen(open?.id === n.id ? null : { collection: 'places', id: n.id })
                  }
                >
                  <Zh text={n.title || 'Untitled'} actions={false} />
                </button>
                <span className="place-desc" data-testid="place-description">
                  {d ? (
                    <Zh text={d.text} />
                  ) : (
                    <span className="example-note">No description for {year}.</span>
                  )}
                </span>
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
  const ro = useWriteGuard();
  const [open, setOpen] = useState<Picked | null>(null);
  const undo = useUndo();
  const { version } = useStore();
  const [data, setData] = useState<Response<'romanization.get'> | null>(null);
  const [terms, setTerms] = useState<Response<'entry.list'>['entries']>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void call('romanization.get', {}).then((r) => {
      if (live) setData(r);
    });
    void call('entry.list', { collection: 'glossaryTerms', trash: 'exclude' }).then((r) => {
      if (live) setTerms(r.entries);
    });
    return () => {
      live = false;
    };
  }, [version]);

  const choose = async (languageId: string, systemId: string) => {
    setError(null);
    const language = data?.languages.find((l) => l.id === languageId);
    const from = language?.systemId ?? null;
    const to = systemId || null;
    try {
      setData(await call('romanization.set', { languageId, systemId: to }));
      if ((from ?? '') !== (to ?? '')) {
        undo.record(romanizationCommand(call, language?.label ?? languageId, languageId, from, to));
      }
    } catch (e) {
      setError(plainError(e));
    }
  };

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
        flagged, and they still save.
      </p>
      {error && (
        <p className="callout crit" role="alert">
          {error}
        </p>
      )}
      <div className="stack tight">
        {(data?.languages ?? []).map((l) => (
          <div className="field" key={l.id}>
            <label htmlFor={`roman-${l.id}`}>{l.label}</label>
            <select
              id={`roman-${l.id}`}
              value={l.systemId ?? ''}
              disabled={ro.off}
              {...ro.tip}
              onChange={(e) => void choose(l.id, e.target.value)}
            >
              <option value="">No system</option>
              {data?.systems.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
            {l.note && (
              <p className="callout" role="note" data-testid="romanization-no-checker">
                {l.note}
              </p>
            )}
          </div>
        ))}
      </div>
      <p className="example-note">Add or rename systems on the Lists screen.</p>
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
 * characters shows the meaning. A43: Edit opens the term's editor in a row
 * under its own.
 */
export function GlossaryTable() {
  const terms = useEntries('glossaryTerms');
  const [open, setOpen] = useState<Picked | null>(null);
  const languages = useList('languages');
  const label = (id: unknown) =>
    languages?.items.find((l) => l.id === id)?.label ?? String(id ?? '');
  const rows = useMemo(
    () => [...terms].sort((a, b) => String(a.characters).localeCompare(String(b.characters))),
    [terms],
  );
  return (
    <section
      className="ws-wide stack"
      aria-labelledby="glossary-table-title"
      data-testid="glossary-table"
    >
      <h2 id="glossary-table-title">Glossary table</h2>
      <p className="lede">
        Every term with its characters, romanization, language, and meaning. Hover over the
        characters or focus them with the keyboard for the meaning.
      </p>
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
              {rows.map((t) => (
                <Fragment key={t._id}>
                  <tr data-term={t._id}>
                    <td>
                      <Zh text={String(t.characters ?? '')} />
                    </td>
                    <td>{String(t.romanization ?? '')}</td>
                    <td>{label(t.language)}</td>
                    <td>
                      <MarkdownView text={String(t.meaning ?? '')} inline />
                    </td>
                    <td>
                      <button
                        type="button"
                        className="btn small"
                        aria-expanded={open?.id === t._id}
                        onClick={() =>
                          setOpen(
                            open?.id === t._id ? null : { collection: 'glossaryTerms', id: t._id },
                          )
                        }
                      >
                        Edit {String(t.characters ?? '')}
                      </button>
                    </td>
                  </tr>
                  {open?.id === t._id && (
                    <tr className="row-editor-tr">
                      <td colSpan={5}>
                        <RowEditor open={open} onClose={() => setOpen(null)} testId="term-editor" />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
