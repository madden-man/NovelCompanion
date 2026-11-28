/**
 * The Lists screen (ED-8, A47 IP-8 to IP-12): every list the bible keeps, each
 * item a row of fields. Items move by their grip, with a drag or Alt+Up and
 * Alt+Down on the focused row (A57), a
 * hierarchical list takes a parent in place, a name renames on Enter, moment
 * kinds carry a colour, its contrast on the grid, and a weight (A51), age
 * groups their ages, families their colour, eras their years. Each change is
 * one undo step.
 */
import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { WireList } from '../../../shared/ipc';
import { renameCommand } from '../../../shared/domain/undoRunner';
import {
  isUnder,
  itemPath,
  kindContrast,
  kindWeight,
  listColorCss,
} from '../../../shared/domain/lists';
import type { MomentKindWeight } from '../../../shared/domain/lists';
import {
  listAddCommand,
  listLookCommand,
  listMoveCommand,
  listParentCommand,
  listRemoveCommand,
} from '../../../shared/undoCommands';
import type { ItemLook } from '../../../shared/undoCommands';
import { call, plainError } from '../api';
import { WriteFieldset, useWriteGuard } from '../connection';
import { useStore } from './data';
import { useUndo } from './undo';
import { Editable, EntryEditable, mergeCommands, saveEntryField, useListAddNew } from './editable';
import type { SaveInfo } from './editable';
import { typedNumber } from './editable/model';
import { ListSelect } from './listSelect';
import { ColourBox } from './colourBox';
import { usePhone } from '../phone';
import { useHoldLift } from './phone/holdLift';
import './vocab.css';
import './entries.css';
import './phoneMore.css';

type Item = WireList['items'][number];
type Note = { text: string; bad: boolean } | null;

const WEIGHT_LABELS: Record<MomentKindWeight, string> = {
  plain: 'Plain marker',
  big: 'Large marker',
};
const WEIGHT_OPTIONS = (['plain', 'big'] as const).map((w) => ({
  value: w,
  label: WEIGHT_LABELS[w],
}));

/** A ratio to one decimal, never rounded up to 3 when it is under 3. */
function ratioText(r: number): string {
  const t = Math.round(r * 10) / 10;
  return `${(r < 3 && t >= 3 ? 2.9 : t).toFixed(1)}:1`;
}

/**
 * A51 (NF-2): a moment kind colour's contrast against the light and the dark
 * grid, in the text tokens, with a note when either is under 3:1. Nothing for
 * a kind with no colour.
 */
function KindContrastReadout({ color }: { color: string | null | undefined }) {
  const c = kindContrast(color);
  if (!c) return null;
  const notes = [
    ...(c.hardOnLight ? ['Hard to see on the light grid'] : []),
    ...(c.hardOnDark ? ['Hard to see on the dark grid'] : []),
  ];
  return (
    <span
      className="vocab-contrast"
      data-testid="item-contrast"
      title="How well the colour stands out on the light and the dark grid"
    >
      <span className="vocab-contrast-word">Contrast</span>{' '}
      <span data-testid="item-contrast-ratios">
        Light {ratioText(c.light)}, Dark {ratioText(c.dark)}
      </span>
      {notes.map((n) => (
        <span key={n} className="vocab-contrast-note" data-testid="item-contrast-note">
          {n}
        </span>
      ))}
    </span>
  );
}

/** Lists whose items sit under one another. */
const HIERARCHICAL = new Set(['eventCategories']);
/** Lists whose items carry a colour on this screen. */
const COLOURED = new Set(['momentKinds']);

/** Every editable list, with rename, reorder, add, and remove (ED-8, IP-8). */
export function ListsView() {
  const { lists } = useStore();
  return (
    <section className="ws-wide stack" aria-labelledby="lists-title" data-testid="lists-view">
      <h2 id="lists-title">Lists</h2>
      <div className="lists-grid">
        {lists.map((l) =>
          l._id === 'families' ? (
            <FamiliesPanel key={l._id} list={l} />
          ) : l._id === 'eraRanges' ? (
            <ErasPanel key={l._id} list={l} />
          ) : (
            <ListPanel key={l._id} list={l} />
          ),
        )}
      </div>
    </section>
  );
}

/** Rename an item of any list (stored or derived) as one undo step; the note says what changed. */
async function renameItem(
  undo: ReturnType<typeof useUndo>,
  list: WireList,
  itemId: string,
  label: string,
): Promise<string> {
  const to = label.trim();
  const r = await call('lists.rename', { listId: list._id, itemId, label: to });
  undo.record(renameCommand(list.label, list._id, itemId, r.from, to, itemId));
  return r.updated > 1
    ? `Renamed. ${r.updated} entries were updated.`
    : r.updated === 1 && !list.derived
      ? 'Renamed. 1 entry was updated.'
      : 'Renamed. Every entry shows the new name.';
}

const usageText = (n: number) => (n === 1 ? 'used once' : `used ${n} times`);

const lookOf = (i: Item): ItemLook => ({ color: i.color ?? null, extra: { ...i.extra } });

/** One stored list: rows of fields, a grip on each that drags or takes Alt+arrows, an add row at the foot. */
function ListPanel({ list }: { list: WireList }) {
  const undo = useUndo();
  const ro = useWriteGuard();
  const [message, setMessage] = useState<Note>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  /** A57: the row whose grip Enter or Space picked up; the arrows move it until it is put down. */
  const [picked, setPicked] = useState<string | null>(null);
  const hierarchical = HIERARCHICAL.has(list._id);
  const coloured = COLOURED.has(list._id);
  const isAges = list._id === 'ageGroups';
  const isMomentKinds = list._id === 'momentKinds';
  const asDoc = { _id: list._id, label: list.label, items: list.items };
  const addParent = useListAddNew(list._id);
  const listRef = useRef<HTMLUListElement>(null);
  /** After a move from the keyboard, the focus stays on the moved item's grip (A57). */
  const [moved, setMoved] = useState<{ id: string; dir: 'up' | 'down' } | null>(null);
  useEffect(() => {
    if (!moved || !listRef.current) return;
    const row = listRef.current.querySelector(`[data-item="${CSS.escape(moved.id)}"]`);
    row?.querySelector<HTMLElement>('[data-testid="drag-handle"]')?.focus({ preventScroll: true });
  }, [moved, list.items]);

  const fail = (e: unknown) => setMessage({ text: plainError(e), bad: true });
  // A58 U6 (PH-35): on the phone the grip lifts its row after a hold; the drop is one step.
  const phone = usePhone();
  const lift = useHoldLift({
    disabled: !phone || ro.off,
    onDrop: (id, to) => {
      const item = list.items.find((i) => i.id === id);
      if (item) void move(item, to, null);
    },
  });

  const move = async (item: Item, index: number, dir: 'up' | 'down' | null) => {
    setMessage(null);
    try {
      const r = await call('lists.move', { listId: list._id, itemId: item.id, index });
      if (r.from === r.to) return;
      const step = listMoveCommand(call, list.label, list._id, item, r.from, r.to);
      undo.record(dir ? { ...step, label: `Moved ${item.label} ${dir}` } : step);
      if (dir) setMoved({ id: item.id, dir });
    } catch (e) {
      fail(e);
    }
  };

  const setLook = async (item: Item, change: Partial<ItemLook>) => {
    const before = lookOf(item);
    const after: ItemLook = {
      color: change.color === undefined ? before.color : change.color,
      extra: change.extra ?? before.extra,
    };
    const extra: Record<string, string | number | null> = { ...after.extra };
    for (const k of Object.keys(before.extra)) if (!(k in after.extra)) extra[k] = null;
    const { item: saved } = await call('lists.setItem', {
      listId: list._id,
      itemId: item.id,
      ...(change.color !== undefined ? { color: after.color } : {}),
      extra,
    });
    undo.record(
      listLookCommand(call, list.label, list._id, item, before, {
        color: saved.color ?? null,
        extra: saved.extra ?? {},
      }),
    );
  };

  const setExtra = (item: Item, key: string, value: string | number | null) => {
    const extra = Object.fromEntries(Object.entries(item.extra).filter(([k]) => k !== key));
    if (value !== null) extra[key] = value;
    return setLook(item, { extra });
  };

  /** The new parent; with Add new, the item it made joins this step (one undo for both). */
  const setParent = async (item: Item, parentId: string | null, info: SaveInfo = {}) => {
    const r = await call('lists.setParent', { listId: list._id, itemId: item.id, parentId });
    const step =
      r.from !== r.to ? listParentCommand(call, list.label, list._id, item, r.from, r.to) : null;
    const added = info.added?.command;
    const both = step && added ? mergeCommands(step.label, added, step) : (step ?? added);
    if (both) undo.record(both);
  };

  const remove = async (item: Item) => {
    setMessage(null);
    try {
      await call('lists.removeItem', { listId: list._id, itemId: item.id });
      undo.record(
        listRemoveCommand(call, list.label, list._id, {
          id: item.id,
          label: item.label,
          parentId: item.parentId,
          color: item.color ?? null,
          extra: item.extra,
        }),
      );
      // A57: the status bar says it, with Undo.
      undo.toast(`Removed ${item.label} from ${list.label}.`);
    } catch (e) {
      fail(e);
    }
  };

  const drop = (target: Item) => {
    const id = dragging;
    setDragging(null);
    setOver(null);
    const item = list.items.find((i) => i.id === id);
    if (!item || item.id === target.id) return;
    void move(
      item,
      list.items.findIndex((i) => i.id === target.id),
      null,
    );
  };

  /** Items an item may sit under: anything but itself and what is under it. */
  const parentChoices = (item: Item) =>
    list.items
      .filter((i) => !isUnder(list.items, i.id, item.id))
      .map((i) => ({ value: i.id, label: itemPath(asDoc, i.id) }));

  const last = list.items.length - 1;
  return (
    <div className="panel stack" data-list={list._id}>
      <h3>{list.label}</h3>
      <WriteFieldset className="stack tight">
        {list.items.length === 0 ? (
          <p className="example-note">No items yet.</p>
        ) : (
          <ul className="list-items vocab-items" ref={listRef}>
            {list.items.map((item, index) => (
              <li
                key={item.id}
                className={`vocab-row${over === item.id ? ' drop-target' : ''}${dragging === item.id || picked === item.id ? ' dragging' : ''}${lift.lifted?.id === item.id ? ' lifted' : ''}`}
                data-item={item.id}
                style={
                  lift.lifted?.id === item.id
                    ? { transform: `translateY(${lift.lifted.dy}px)` }
                    : undefined
                }
                onKeyDown={(e) => {
                  // A57: Alt+Up and Alt+Down move the row from anywhere in it but an open field.
                  if (!e.altKey || e.metaKey || e.ctrlKey || ro.off) return;
                  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
                  if ((e.target as Element).closest('input, select, textarea, [role="textbox"]')) {
                    return;
                  }
                  e.preventDefault();
                  const dir = e.key === 'ArrowUp' ? 'up' : 'down';
                  const to = dir === 'up' ? index - 1 : index + 1;
                  if (to < 0 || to > last) return;
                  void move(item, to, dir);
                }}
                onDragOver={(e) => {
                  if (!dragging) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                  if (over !== item.id) setOver(item.id);
                }}
                onDragLeave={() => setOver((o) => (o === item.id ? null : o))}
                onDrop={(e) => {
                  e.preventDefault();
                  drop(item);
                }}
              >
                <span
                  className="drag-handle"
                  draggable={!ro.off && !phone}
                  {...lift.grip(item.id, index)}
                  role="button"
                  tabIndex={ro.off ? -1 : 0}
                  aria-label={`Move ${item.label}`}
                  aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                  aria-disabled={ro.off || undefined}
                  aria-pressed={picked === item.id}
                  data-testid="drag-handle"
                  onKeyDown={(e) => {
                    if (ro.off || e.altKey || e.metaKey || e.ctrlKey) return;
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setPicked((p) => (p === item.id ? null : item.id));
                    } else if (picked === item.id && e.key === 'Escape') {
                      e.preventDefault();
                      e.stopPropagation();
                      setPicked(null);
                    } else if (
                      picked === item.id &&
                      (e.key === 'ArrowUp' || e.key === 'ArrowDown')
                    ) {
                      e.preventDefault();
                      const dir = e.key === 'ArrowUp' ? 'up' : 'down';
                      const to = dir === 'up' ? index - 1 : index + 1;
                      if (to >= 0 && to <= last) void move(item, to, dir);
                    }
                  }}
                  onBlur={(e) => {
                    // A move re-orders the rows and may blur the grip with nowhere to go;
                    // only a focus that goes elsewhere puts the row down.
                    if (e.relatedTarget) setPicked((p) => (p === item.id ? null : p));
                  }}
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', item.id);
                    setDragging(item.id);
                  }}
                  onDragEnd={() => {
                    setDragging(null);
                    setOver(null);
                  }}
                >
                  ⋮⋮
                </span>
                {coloured && (
                  <ColourBox
                    label={`Colour of ${item.label}`}
                    value={item.color ?? null}
                    disabled={ro.off}
                    testId="item-colour"
                    onPick={(hex) => setLook(item, { color: hex })}
                  />
                )}
                {isMomentKinds && <KindContrastReadout color={item.color} />}
                <span className="vocab-name">
                  {!coloured && listColorCss(item.color) && (
                    <span
                      className="vocab-swatch"
                      style={{ background: listColorCss(item.color) ?? undefined }}
                      aria-hidden="true"
                    />
                  )}
                  <Editable
                    kind="text"
                    label={`Name of ${item.label}`}
                    value={item.label}
                    allowEmpty={false}
                    testId="item-name"
                    display={hierarchical ? () => itemPath(asDoc, item.id) : undefined}
                    onSave={async (next) => {
                      setMessage(null);
                      setMessage({ text: await renameItem(undo, list, item.id, next), bad: false });
                    }}
                  />
                </span>
                {isMomentKinds && (
                  <Editable
                    kind="select"
                    label={`Weight of ${item.label}`}
                    value={kindWeight(item)}
                    options={WEIGHT_OPTIONS}
                    testId="item-weight"
                    onSave={(next) => setExtra(item, 'weight', next === 'big' ? 'big' : null)}
                  />
                )}
                {isAges && (
                  <span className="row tight vocab-ages">
                    <Editable
                      kind="number"
                      label={`From age of ${item.label}`}
                      value={typeof item.extra.from === 'number' ? item.extra.from : null}
                      allowEmpty
                      integer
                      min={0}
                      max={150}
                      placeholder="from any age"
                      testId="item-from"
                      display={(s) => `from ${s}`}
                      onSave={(next) => setExtra(item, 'from', next)}
                    />
                    <Editable
                      kind="number"
                      label={`To age of ${item.label}`}
                      value={typeof item.extra.to === 'number' ? item.extra.to : null}
                      allowEmpty
                      integer
                      min={0}
                      max={150}
                      placeholder="to any age"
                      testId="item-to"
                      display={(s) => `to ${s}`}
                      onSave={(next) => setExtra(item, 'to', next)}
                    />
                  </span>
                )}
                {hierarchical && (
                  <Editable
                    kind="select"
                    label={`What ${item.label} sits under`}
                    value={item.parentId}
                    options={parentChoices(item)}
                    allowEmpty
                    emptyLabel="At the top"
                    placeholder="At the top"
                    testId="item-parent"
                    onAddNew={addParent}
                    display={(s) => (item.parentId ? `under ${s}` : s)}
                    onSave={(next, info) => setParent(item, next, info)}
                  />
                )}
                <span className="example-note vocab-usage">{usageText(item.usage)}</span>
                <span className="row tight vocab-actions">
                  <button
                    type="button"
                    className="btn small danger"
                    aria-label={`Remove ${item.label}`}
                    onClick={() => void remove(item)}
                  >
                    Remove
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
        <AddRow list={list} onMessage={setMessage} />
      </WriteFieldset>
      {message && (
        <p className={message.bad ? 'callout crit' : 'callout'} role="status">
          {message.text}
        </p>
      )}
    </div>
  );
}

/** The foot of a list: a name, and for some lists a parent or ages. */
function AddRow(props: { list: WireList; onMessage: (n: Note) => void }) {
  const { list } = props;
  const undo = useUndo();
  const [label, setLabel] = useState('');
  const [parent, setParent] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const ids = { add: useId(), parent: useId(), from: useId(), to: useId() };
  const hierarchical = HIERARCHICAL.has(list._id);
  const isAges = list._id === 'ageGroups';
  const phone = usePhone();

  const add = async (e: FormEvent) => {
    e.preventDefault();
    props.onMessage(null);
    const extra: Record<string, string | number> = {};
    if (isAges && from.trim()) extra.from = Number(from);
    if (isAges && to.trim()) extra.to = Number(to);
    try {
      const { item } = await call('lists.addItem', {
        listId: list._id,
        label,
        parentId: parent || null,
        ...(Object.keys(extra).length ? { extra } : {}),
      });
      undo.record(listAddCommand(call, list.label, list._id, item));
      setLabel('');
      setParent('');
      setFrom('');
      setTo('');
    } catch (err) {
      props.onMessage({ text: plainError(err), bad: true });
    }
  };

  return (
    <form className="row tight vocab-add" onSubmit={(e) => void add(e)}>
      <label className="sr-only" htmlFor={ids.add}>
        New item for {list.label}
      </label>
      <input
        id={ids.add}
        value={label}
        placeholder={`Add to ${list.label}`}
        onChange={(e) => setLabel(e.target.value)}
      />
      {hierarchical && (
        <>
          <label className="sr-only" htmlFor={ids.parent}>
            Inside
          </label>
          <ListSelect
            id={ids.parent}
            listId={list._id}
            value={parent}
            emptyLabel="At the top"
            onChange={(v) => setParent(v ?? '')}
          />
        </>
      )}
      {isAges && (
        <>
          <label htmlFor={ids.from}>From age</label>
          <input
            id={ids.from}
            className="num"
            inputMode="numeric"
            value={from}
            onChange={(e) => {
              const v = typedNumber('number', e.target.value, { integer: true, min: 0 });
              if (v !== null) setFrom(v);
            }}
          />
          <label htmlFor={ids.to}>To age</label>
          <input
            id={ids.to}
            className="num"
            inputMode="numeric"
            value={to}
            onChange={(e) => {
              const v = typedNumber('number', e.target.value, { integer: true, min: 0 });
              if (v !== null) setTo(v);
            }}
          />
        </>
      )}
      <button
        type="submit"
        className="btn small"
        aria-label={`Add to ${list.label}`}
        disabled={!label.trim()}
      >
        {/* A58 U6: the phone has no Enter key to show, so the button says what it does. */}
        {phone ? 'Add' : <kbd>Enter</kbd>}
      </button>
    </form>
  );
}

/** IP-12: families, each with its colour and a name that renames in place. */
function FamiliesPanel({ list }: { list: WireList }) {
  const undo = useUndo();
  const ro = useWriteGuard();
  const [message, setMessage] = useState<Note>(null);
  return (
    <div className="panel stack" data-list={list._id}>
      <h3>{list.label}</h3>
      <WriteFieldset className="stack tight">
        {list.items.length === 0 ? (
          <p className="example-note">No families yet.</p>
        ) : (
          <ul className="list-items vocab-items">
            {list.items.map((item) => (
              <li key={item.id} className="vocab-row" data-item={item.id}>
                <ColourBox
                  label={`Colour of ${item.label}`}
                  value={item.color ?? null}
                  disabled={ro.off}
                  testId="item-colour"
                  onPick={async (hex) => {
                    await saveEntryField(undo, {
                      collection: 'families',
                      id: item.id,
                      path: 'color',
                      value: hex,
                      label: 'Display color',
                    });
                  }}
                />
                <span className="vocab-name">
                  <Editable
                    kind="text"
                    label={`Name of ${item.label}`}
                    value={item.label}
                    allowEmpty={false}
                    testId="item-name"
                    onSave={async (next) => {
                      setMessage({ text: await renameItem(undo, list, item.id, next), bad: false });
                    }}
                  />
                </span>
                <span className="example-note vocab-usage">{usageText(item.usage)}</span>
              </li>
            ))}
          </ul>
        )}
      </WriteFieldset>
      {message && (
        <p className={message.bad ? 'callout crit' : 'callout'} role="status">
          {message.text}
        </p>
      )}
    </div>
  );
}

/** WE-2, IP-12: era names with their first and last years, each a field. */
function ErasPanel({ list }: { list: WireList }) {
  const undo = useUndo();
  const [message, setMessage] = useState<Note>(null);
  return (
    <div className="panel stack" data-list={list._id}>
      <h3>{list.label}</h3>
      <WriteFieldset className="stack tight">
        {list.items.length === 0 ? (
          <p className="example-note">No eras yet.</p>
        ) : (
          <ul className="list-items vocab-items">
            {list.items.map((item) => (
              <li key={item.id} className="vocab-row" data-item={item.id}>
                <span className="vocab-name">
                  <Editable
                    kind="text"
                    label={`Name of ${item.label}`}
                    value={item.label}
                    allowEmpty={false}
                    testId="item-name"
                    onSave={async (next) => {
                      setMessage({ text: await renameItem(undo, list, item.id, next), bad: false });
                    }}
                  />
                </span>
                <span className="row tight vocab-years">
                  <EntryEditable
                    collection="eraStates"
                    id={item.id}
                    path="startYear"
                    kind="year"
                    label="Start year"
                    testId="era-start"
                    display={(s) => `from ${s}`}
                  />
                  <EntryEditable
                    collection="eraStates"
                    id={item.id}
                    path="endYear"
                    kind="year"
                    label="End year"
                    testId="era-end"
                    display={(s) => `to ${s}`}
                  />
                </span>
                <span className="example-note vocab-usage">{usageText(item.usage)}</span>
              </li>
            ))}
          </ul>
        )}
      </WriteFieldset>
      {message && (
        <p className={message.bad ? 'callout crit' : 'callout'} role="status">
          {message.text}
        </p>
      )}
    </div>
  );
}
