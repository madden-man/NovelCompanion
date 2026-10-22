import type { Channel, Request, Response } from './ipc';
import type { Op, UndoCommand } from './domain/undoRunner';
import type { BibleNumbers, BibleTemplates, CultureUnit } from './schema/settings';

/**
 * ED-3: undo commands for the writes that are not entry writes: tree
 * positions, list items, and settings kept in the bible's meta. Each step is a
 * `run` op over the IPC channels, with a check that reports in plain words
 * why it cannot apply when the value changed since, so an undo never writes
 * an old value over a newer one (ARCHITECTURE rule 5).
 */

export type Invoke = <C extends Channel>(channel: C, request: Request<C>) => Promise<Response<C>>;

export interface TreePosition {
  x: number;
  y: number;
  loose?: boolean;
}

/** One person's move: where they were and where they went (null when not stored). */
export interface TreeMove {
  id: string;
  before: TreePosition | null;
  after: TreePosition | null;
}

const samePlace = (a: TreePosition | null | undefined, b: TreePosition | null | undefined) => {
  if (!a || !b) return !a && !b;
  return a.x === b.x && a.y === b.y && Boolean(a.loose) === Boolean(b.loose);
};

/** A step that puts each person at `to` when each is still at `expect` (FT-11). */
function treeOp(
  invoke: Invoke,
  moves: readonly { id: string; expect: TreePosition | null; to: TreePosition | null }[],
  nameOf: (id: string) => string,
): Op {
  const positions = async () => (await invoke('tree.get', {})).positions ?? {};
  return {
    kind: 'run',
    check: async () => {
      const cur = await positions();
      const moved = moves.find((m) => !samePlace(cur[m.id], m.expect));
      return moved ? `${nameOf(moved.id)} was moved since` : null;
    },
    apply: async () => {
      const to = new Map(moves.map((m) => [m.id, m.to]));
      const next: Record<string, TreePosition> = {};
      for (const [id, p] of Object.entries(await positions())) {
        if (!to.has(id)) next[id] = p;
      }
      for (const [id, p] of to) if (p) next[id] = p;
      await invoke('tree.savePositions', { positions: next });
    },
  };
}

/** FT-11, ED-3: a drag, a nudge, or a tidy of the tree, as one step. */
export function treeMoveCommand(
  label: string,
  invoke: Invoke,
  moves: readonly TreeMove[],
  nameOf: (id: string) => string,
): UndoCommand {
  return {
    label,
    undo: [
      treeOp(
        invoke,
        moves.map((m) => ({ id: m.id, expect: m.after, to: m.before })),
        nameOf,
      ),
    ],
    redo: [
      treeOp(
        invoke,
        moves.map((m) => ({ id: m.id, expect: m.before, to: m.after })),
        nameOf,
      ),
    ],
  };
}

/** The moves between two whole layouts, for Tidy: only the people whose place changed. */
export function treeMoves(
  before: Record<string, TreePosition> | null,
  after: Record<string, TreePosition>,
): TreeMove[] {
  const ids = new Set([...Object.keys(before ?? {}), ...Object.keys(after)]);
  const moves: TreeMove[] = [];
  for (const id of ids) {
    const from = before?.[id] ?? null;
    const to = after[id] ?? null;
    if (!samePlace(from, to)) moves.push({ id, before: from, after: to });
  }
  return moves;
}

export interface ListItemRef {
  id: string;
  label: string;
  parentId: string | null;
  /** a47-model: the colour and extra values an undo puts back with the item. */
  color?: string | null;
  extra?: Record<string, string | number>;
}

async function listItem(invoke: Invoke, listId: string, label: string) {
  const { lists } = await invoke('lists.get', {});
  return lists.find((l) => l._id === listId)?.items.find((i) => i.label === label);
}

/** Add an item back, when nothing of that name is in the list now. */
function addItemOp(invoke: Invoke, listLabel: string, listId: string, item: ListItemRef): Op {
  return {
    kind: 'run',
    check: async () =>
      (await listItem(invoke, listId, item.label))
        ? `${item.label} is already in ${listLabel}`
        : null,
    apply: async () => {
      await invoke('lists.addItem', {
        listId,
        label: item.label,
        parentId: item.parentId,
        id: item.id,
        ...(item.color !== undefined ? { color: item.color } : {}),
        ...(item.extra ? { extra: item.extra } : {}),
      });
    },
  };
}

/** Take an item out, when it is still there under that name. */
function removeItemOp(invoke: Invoke, listLabel: string, listId: string, item: ListItemRef): Op {
  return {
    kind: 'run',
    check: async () =>
      (await listItem(invoke, listId, item.label))
        ? null
        : `${item.label} is no longer in ${listLabel}`,
    apply: async () => {
      const found = await listItem(invoke, listId, item.label);
      await invoke('lists.removeItem', { listId, itemId: found?.id ?? item.id });
    },
  };
}

/** ED-8, ED-3: an item added to a list; undo takes it out again. */
export function listAddCommand(
  invoke: Invoke,
  listLabel: string,
  listId: string,
  item: ListItemRef,
): UndoCommand {
  return {
    label: `Added ${item.label} to ${listLabel}`,
    undo: [removeItemOp(invoke, listLabel, listId, item)],
    redo: [addItemOp(invoke, listLabel, listId, item)],
  };
}

/** ED-8, ED-3: an item removed from a list; undo puts it back. */
export function listRemoveCommand(
  invoke: Invoke,
  listLabel: string,
  listId: string,
  item: ListItemRef,
): UndoCommand {
  return {
    label: `Removed ${item.label} from ${listLabel}`,
    undo: [addItemOp(invoke, listLabel, listId, item)],
    redo: [removeItemOp(invoke, listLabel, listId, item)],
  };
}

/** A settings step: apply `to` while the stored value still reads `expect`. */
function settingOp<T>(
  read: () => Promise<T>,
  same: (a: T, b: T) => boolean,
  expect: T,
  write: (to: T) => Promise<unknown>,
  to: T,
  changedText: string,
): Op {
  return {
    kind: 'run',
    check: async () => (same(await read(), expect) ? null : changedText),
    apply: async () => {
      await write(to);
    },
  };
}

/** GL-1, ED-3: the romanization system chosen for a language. */
export function romanizationCommand(
  invoke: Invoke,
  languageLabel: string,
  languageId: string,
  from: string | null,
  to: string | null,
): UndoCommand {
  const read = async () =>
    (await invoke('romanization.get', {})).languages.find((l) => l.id === languageId)?.systemId ??
    null;
  const write = (systemId: string | null) => invoke('romanization.set', { languageId, systemId });
  const same = (a: string | null, b: string | null) => (a ?? '') === (b ?? '');
  const changed = `the romanization system for ${languageLabel} changed since`;
  return {
    label: `Changed the romanization system for ${languageLabel}`,
    undo: [settingOp(read, same, to, write, from, changed)],
    redo: [settingOp(read, same, from, write, to, changed)],
  };
}

export interface BriefSettings {
  window: number;
  budget: number;
}

/** SB-2, ED-3: the brief's world events window and size budget. */
export function briefSettingsCommand(
  invoke: Invoke,
  before: BriefSettings,
  after: BriefSettings,
): UndoCommand {
  const read = () => invoke('brief.settings.get', {});
  const write = (to: BriefSettings) =>
    invoke('brief.settings.set', { window: to.window, budget: to.budget });
  const same = (a: BriefSettings, b: BriefSettings) =>
    a.window === b.window && a.budget === b.budget;
  const what =
    before.window !== after.window && before.budget !== after.budget
      ? 'the brief settings'
      : before.window !== after.window
        ? 'the world events window'
        : 'the brief size budget';
  const changed = `${what} changed since`;
  return {
    label: `Changed ${what}`,
    undo: [settingOp(read, same, after, write, before, changed)],
    redo: [settingOp(read, same, before, write, after, changed)],
  };
}

/** A41, ED-3: a community's description, one step per save. */
export function communityNoteCommand(
  invoke: Invoke,
  communityLabel: string,
  communityId: string,
  from: string,
  to: string,
): UndoCommand {
  const read = async () => (await invoke('community.notes.get', {})).notes[communityId] ?? '';
  const write = (text: string) => invoke('community.notes.set', { communityId, text });
  const same = (a: string, b: string) => a.trim() === b.trim();
  const changed = `the description of ${communityLabel} changed since`;
  return {
    label: `Changed the description of ${communityLabel}`,
    undo: [settingOp(read, same, to, write, from, changed)],
    redo: [settingOp(read, same, from, write, to, changed)],
  };
}

/**
 * A41, A42: a community removed with its lines, as one step. Undo puts the
 * community back in the list and restores every line from the trash; redo
 * trashes the lines again and takes the community out.
 */
export function communityRemoveCommand(
  invoke: Invoke,
  listLabel: string,
  listId: string,
  item: ListItemRef,
  lines: readonly { id: string }[],
): UndoCommand {
  const n = lines.length;
  const restore: Op[] = lines.map((l) => ({
    kind: 'restore',
    collection: 'culturalEntries',
    id: l.id,
  }));
  const trash: Op[] = lines.map((l) => ({
    kind: 'delete',
    collection: 'culturalEntries',
    id: l.id,
  }));
  return {
    label:
      n === 0
        ? `Removed ${item.label} from ${listLabel}`
        : `Removed ${item.label} and its ${n === 1 ? 'line' : `${n} lines`}`,
    undo: [addItemOp(invoke, listLabel, listId, item), ...restore],
    redo: [...trash, removeItemOp(invoke, listLabel, listId, item)],
  };
}

// ---------- a47-model: list order and parents, item looks, bible settings, era defaults ----------

async function listItems(invoke: Invoke, listId: string) {
  const { lists } = await invoke('lists.get', {});
  return lists.find((l) => l._id === listId)?.items ?? [];
}

/** IP-8, ED-3: an item moved in its list; undo puts it back where it was. */
export function listMoveCommand(
  invoke: Invoke,
  listLabel: string,
  listId: string,
  item: { id: string; label: string },
  from: number,
  to: number,
): UndoCommand {
  const op = (expect: number, index: number): Op => ({
    kind: 'run',
    check: async () => {
      const at = (await listItems(invoke, listId)).findIndex((i) => i.id === item.id);
      if (at < 0) return `${item.label} is no longer in ${listLabel}`;
      return at === expect ? null : `${item.label} was moved since`;
    },
    apply: async () => {
      await invoke('lists.move', { listId, itemId: item.id, index });
    },
  });
  return {
    label: `Moved ${item.label} in ${listLabel}`,
    undo: [op(to, from)],
    redo: [op(from, to)],
  };
}

/** IP-8, ED-3: an item put under another (or at the top, null); undo puts it back. */
export function listParentCommand(
  invoke: Invoke,
  listLabel: string,
  listId: string,
  item: { id: string; label: string },
  from: string | null,
  to: string | null,
): UndoCommand {
  const op = (expect: string | null, parentId: string | null): Op => ({
    kind: 'run',
    check: async () => {
      const found = (await listItems(invoke, listId)).find((i) => i.id === item.id);
      if (!found) return `${item.label} is no longer in ${listLabel}`;
      return found.parentId === expect ? null : `${item.label} was moved since`;
    },
    apply: async () => {
      await invoke('lists.setParent', { listId, itemId: item.id, parentId });
    },
  });
  return {
    label: `Moved ${item.label} in ${listLabel}`,
    undo: [op(to, from)],
    redo: [op(from, to)],
  };
}

export interface ItemLook {
  color: string | null;
  extra: Record<string, string | number>;
}

/** IP-9, IP-10, ED-3: an item recoloured, or its kind or ages changed; undo puts the old look back. */
export function listLookCommand(
  invoke: Invoke,
  listLabel: string,
  listId: string,
  item: { id: string; label: string },
  before: ItemLook,
  after: ItemLook,
): UndoCommand {
  const same = (a: ItemLook, b: ItemLook) =>
    a.color === b.color && JSON.stringify(a.extra) === JSON.stringify(b.extra);
  const op = (expect: ItemLook, to: ItemLook): Op => ({
    kind: 'run',
    check: async () => {
      const found = (await listItems(invoke, listId)).find((i) => i.id === item.id);
      if (!found) return `${item.label} is no longer in ${listLabel}`;
      return same({ color: found.color, extra: found.extra }, expect)
        ? null
        : `${item.label} was changed since`;
    },
    apply: async () => {
      // Keys the old look lacks are removed; the rest are set.
      const extra: Record<string, string | number | null> = { ...to.extra };
      for (const k of Object.keys(expect.extra)) if (!(k in to.extra)) extra[k] = null;
      await invoke('lists.setItem', { listId, itemId: item.id, color: to.color, extra });
    },
  });
  return {
    label: `Changed ${item.label} in ${listLabel}`,
    undo: [op(after, before)],
    redo: [op(before, after)],
  };
}

/** What each per-bible number is called in an undo label (IP-11). */
export const NUMBER_LABELS: Record<keyof BibleNumbers, string> = {
  timelineStart: 'the first year of the timeline',
  timelineEnd: 'the last year of the timeline',
  windowBefore: 'the years before the story year',
  windowAfter: 'the years after the story year',
  pickerReach: 'the reach of the events picker',
  autosaveMs: 'the autosave delay',
};

/** IP-11, ED-3: one of the bible's numbers, one step per change. */
export function numberSettingCommand(
  invoke: Invoke,
  field: keyof BibleNumbers,
  before: number,
  after: number,
): UndoCommand {
  const read = async () => (await invoke('settings.get', {})).numbers[field];
  const write = (to: number) => invoke('settings.set', { numbers: { [field]: to } });
  const what = NUMBER_LABELS[field];
  const changed = `${what} changed since`;
  return {
    label: `Changed ${what}`,
    undo: [settingOp(read, (a, b) => a === b, after, write, before, changed)],
    redo: [settingOp(read, (a, b) => a === b, before, write, after, changed)],
  };
}

/** IP-10, ED-3: the cultural time unit. */
export function cultureUnitCommand(
  invoke: Invoke,
  before: CultureUnit,
  after: CultureUnit,
): UndoCommand {
  const read = async () => (await invoke('settings.get', {})).cultureUnit;
  const write = (to: CultureUnit) => invoke('settings.set', { cultureUnit: to });
  const changed = 'the cultural time unit changed since';
  return {
    label: 'Changed the cultural time unit',
    undo: [settingOp(read, (a, b) => a === b, after, write, before, changed)],
    redo: [settingOp(read, (a, b) => a === b, before, write, after, changed)],
  };
}

/** IP-14, ED-3: one template (a default title, a strand label, the brief headings, a link label). */
export function templateCommand<K extends keyof BibleTemplates>(
  invoke: Invoke,
  field: K,
  what: string,
  before: BibleTemplates[K],
  after: BibleTemplates[K],
): UndoCommand {
  const read = async () => (await invoke('settings.get', {})).templates[field];
  const write = (to: BibleTemplates[K]) =>
    invoke('settings.set', { templates: { [field]: to } as Partial<BibleTemplates> });
  const same = (a: BibleTemplates[K], b: BibleTemplates[K]) =>
    JSON.stringify(a) === JSON.stringify(b);
  const changed = `${what} changed since`;
  return {
    label: `Changed ${what}`,
    undo: [settingOp(read, same, after, write, before, changed)],
    redo: [settingOp(read, same, before, write, after, changed)],
  };
}

export interface EraDefaultRow {
  name: string;
  startYear: number;
  endYear: number;
}

/** IP-12, ED-3: the default eras for a new bible, as one step per save. */
export function eraDefaultsCommand(
  invoke: Invoke,
  before: readonly EraDefaultRow[],
  after: readonly EraDefaultRow[],
): UndoCommand {
  const read = async () => (await invoke('eraDefaults.get', {})).rows;
  const write = (rows: readonly EraDefaultRow[]) => invoke('eraDefaults.set', { rows: [...rows] });
  const same = (a: readonly EraDefaultRow[], b: readonly EraDefaultRow[]) =>
    JSON.stringify(a) === JSON.stringify(b);
  const changed = 'the default eras changed since';
  return {
    label: 'Changed the default eras',
    undo: [settingOp(read, same, after, write, before, changed)],
    redo: [settingOp(read, same, before, write, after, changed)],
  };
}
