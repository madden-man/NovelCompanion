/**
 * IP-1: one line per stored value. `EntryEditable` edits a field of an entry
 * through the write path with one undo step; `useEditableSave` and
 * `valueCommand` do the same for a value that is not an entry field (a
 * setting, the scene outline), through a `run` step; `useListAddNew` and
 * `useEntryAddNew` are the "Add new..." of a select or a chip row.
 */
import { useCallback, useEffect, useState } from 'react';
import { entrySchemas, entryTitle, manifests, withoutDerived } from '../../../../shared/schema';
import type { EntryCollection } from '../../../../shared/schema';
import type { WireList } from '../../../../shared/ipc';
import { blankEntry } from '../../../../shared/domain/blank';
import { fieldIssues } from '../../../../shared/domain/issues';
import { getPath } from '../../../../shared/domain/paths';
import type { Doc } from '../../../../shared/domain/paths';
import { createCommand, editCommand } from '../../../../shared/domain/undoRunner';
import type { Op, UndoCommand } from '../../../../shared/domain/undoRunner';
import type { FieldWarning } from '../../../../shared/domain/warnings';
import { listAddCommand } from '../../../../shared/undoCommands';
import { call } from '../../api';
import { useReadOnly } from '../../connection';
import { useList, useStore } from '../data';
import type { Entry } from '../data';
import { useUndo } from '../undo';
import { Editable } from './Editable';
import type { EditableCommonProps, EditableKindProps } from './Editable';
import { fieldLabel, mergeCommands, patchForPath } from './model';
import type { AddedItem, EditableKind, EditableOption, SaveInfo } from './model';

type Undo = ReturnType<typeof useUndo>;

/** A save that cannot be stored, in the plain words shown at the field (ED-10). */
export class EditableError extends Error {}

export interface SaveEntryFieldOptions {
  collection: EntryCollection;
  id: string;
  /** A dotted field path, `birth` or `names.full`. */
  path: string;
  value: unknown;
  /** The undo step's noun; the manifest label when not given. */
  label?: string;
  /** Fields that follow this one, such as the title following the full name. */
  extraPatch?: (next: unknown, entry: Doc) => Doc;
  /** The item Add new made on the way; its step joins this one. */
  added?: AddedItem;
}

/**
 * Write one field of an entry and record it as one undo step (ED-3): pending
 * autosaves land first, the schema is checked so a value it refuses is
 * explained at the field and nothing is sent (ED-10), and the focused field's
 * saved text moves to the stored value (`undo.markSaved`).
 */
export async function saveEntryField(
  undo: Undo,
  o: SaveEntryFieldOptions,
): Promise<{ entry: Entry; warnings: FieldWarning[] }> {
  await undo.flush();
  const before = (await call('entry.get', { collection: o.collection, id: o.id })).entry as Entry;
  const patch = { ...patchForPath(before, o.path, o.value), ...o.extraPatch?.(o.value, before) };
  const check = entrySchemas[o.collection].safeParse(
    withoutDerived(o.collection, { ...before, ...patch }),
  );
  if (!check.success) {
    const top = o.path.split('.')[0] ?? o.path;
    const issues = fieldIssues(check.error.issues);
    const mine =
      issues.find((i) => i.path === o.path) ??
      issues.find((i) => i.path === top || i.path.startsWith(`${top}.`)) ??
      issues[0];
    throw new EditableError(mine?.message ?? 'This value cannot be stored.');
  }
  const r = await call('entry.update', { collection: o.collection, id: o.id, patch });
  const after = r.entry as Entry;
  const label = o.label ?? fieldLabel(o.collection, o.path);
  const step = editCommand(
    `Changed ${label} on ${entryTitle(after)}`,
    o.collection,
    o.id,
    before,
    after,
  );
  const changed = step.redo.some((op) => op.kind === 'update' && Object.keys(op.patch).length > 0);
  const added = o.added?.command;
  if (added && changed) undo.record(mergeCommands(step.label, added, step));
  else if (added) undo.record(added);
  else if (changed) undo.record(step);
  undo.markSaved(after);
  return { entry: after, warnings: r.warnings as FieldWarning[] };
}

/** One entry, read through the write path and read again whenever the bible changes. */
export function useEntryDoc(collection: EntryCollection, id: string): Entry | null {
  const { version } = useStore();
  const [doc, setDoc] = useState<Entry | null>(null);
  useEffect(() => {
    let live = true;
    call('entry.get', { collection, id })
      .then((r) => {
        if (live) setDoc(r.entry as Entry);
      })
      .catch(() => {
        if (live) setDoc(null);
      });
    return () => {
      live = false;
    };
  }, [collection, id, version]);
  return doc;
}

/** The value a kind expects, from whatever the entry stores at the path. */
function valueFor(kind: EditableKind, v: unknown): unknown {
  switch (kind) {
    case 'text':
    case 'rich':
      return typeof v === 'string' ? v : '';
    case 'year':
    case 'number':
      return typeof v === 'number' ? v : null;
    case 'select':
      return typeof v === 'string' && v !== '' ? v : null;
    case 'chips':
      return Array.isArray(v) ? v.map(String) : [];
    case 'date':
      return v ?? null;
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type EntryEditableProps = Omit<EditableCommonProps, 'label'> &
  DistributiveOmit<EditableKindProps, 'value' | 'onSave'> & {
    collection: EntryCollection;
    id: string;
    /** A dotted field path: `title`, `birth`, `names.full`, `strands.0.year`. */
    path: string;
    /** The manifest label when not given. */
    label?: string;
    /** The host's copy of the entry, when it has one; otherwise it is read here. */
    entry?: Doc | null;
    extraPatch?: (next: unknown, entry: Doc) => Doc;
    /** The entry's ED-10 warnings, when the host has them; those at `path` show under the field. */
    warnings?: readonly FieldWarning[];
    /** After a save, with the stored entry. */
    onSaved?: (entry: Entry) => void;
  };

/**
 * An entry field as an `Editable`: reads the entry (or takes the host's copy),
 * writes through `entry.update` as one undo step labelled from the manifest,
 * and shows the ED-10 explanation at the field when the schema refuses it.
 */
export function EntryEditable(props: EntryEditableProps) {
  const { collection, id, path, entry: given, extraPatch, warnings, onSaved, ...rest } = props;
  const undo = useUndo();
  const read = useEntryDoc(collection, id);
  const doc = given ?? read;
  const [own, setOwn] = useState<FieldWarning[] | null>(null);
  const label = props.label ?? fieldLabel(collection, path);
  const value = valueFor(props.kind, doc ? getPath(doc, path) : undefined);
  const save = async (next: unknown, info: SaveInfo) => {
    const r = await saveEntryField(undo, {
      collection,
      id,
      path,
      value: next,
      label,
      extraPatch,
      added: info.added,
    });
    setOwn(r.warnings);
    onSaved?.(r.entry);
  };
  const notes = (warnings ?? own ?? [])
    .filter((w) => w.path === path)
    .map((w) => ({ message: w.message, code: w.code }));
  const forward = {
    ...rest,
    label,
    value,
    onSave: save,
    notes: rest.notes ?? notes,
    'data-field': rest['data-field'] ?? path,
  } as Parameters<typeof Editable>[0];
  return <Editable {...forward} />;
}

/**
 * A step for a value outside the entries (ED-3, ARCHITECTURE rule 5): undo
 * writes `before` back while the stored value still reads `after`, redo the
 * other way, each as a `run` op whose check explains a newer change.
 */
export function valueCommand<T>(o: {
  label: string;
  read: () => Promise<T>;
  write: (to: T) => Promise<unknown>;
  before: T;
  after: T;
  same?: (a: T, b: T) => boolean;
  /** Why the step cannot apply when the value changed since, in plain words. */
  changed?: string;
}): UndoCommand {
  const same = o.same ?? ((a: T, b: T) => JSON.stringify(a) === JSON.stringify(b));
  const op = (expect: T, to: T): Op => ({
    kind: 'run',
    check: async () =>
      same(await o.read(), expect) ? null : (o.changed ?? `${o.label} changed since`),
    apply: async () => {
      await o.write(to);
    },
  });
  return { label: o.label, undo: [op(o.after, o.before)], redo: [op(o.before, o.after)] };
}

/**
 * The save for an `Editable` over a value that is not an entry field: runs the
 * write, then records the caller's step (built with `valueCommand` or any
 * `run` op), joined with the step of an item Add new made on the way.
 */
export function useEditableSave<T>(o: {
  value: T;
  write: (next: T) => Promise<unknown>;
  /** The undo step for this change, or null to record none. */
  command: (before: T, after: T) => UndoCommand | null;
}): (next: T, info?: SaveInfo) => Promise<void> {
  const undo = useUndo();
  const { value, write, command } = o;
  return useCallback(
    async (next: T, info: SaveInfo = {}) => {
      await undo.flush();
      await write(next);
      const step = command(value, next);
      const added = info.added?.command;
      if (step && added) undo.record(mergeCommands(step.label, added, step));
      else if (step) undo.record(step);
      else if (added) undo.record(added);
    },
    [undo, value, write, command],
  );
}

/** The items of a list as choices, in the stored order. */
export function listOptions(list: WireList | undefined): EditableOption[] {
  return (list?.items ?? []).map((i) => ({ value: i.id, label: i.label }));
}

/** Entries as choices, by title, for a select or a chip row over references. */
export function entryOptions(entries: readonly Entry[]): EditableOption[] {
  return entries
    .filter((e) => e.deletedAt === undefined)
    .map((e) => ({ value: e._id, label: entryTitle(e) }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** Add new for a select or chips over a list: adds the item, with its undo step. */
export function useListAddNew(
  listId: string,
  parentId: string | null = null,
): (label: string) => Promise<AddedItem> {
  const list = useList(listId);
  const listLabel = list?.label ?? listId;
  // ARCH-6: the field never opens while read-only; this refuses too, with the reason.
  const readOnly = useReadOnly();
  return useCallback(
    async (label: string) => {
      if (readOnly) throw new EditableError(readOnly);
      const { item } = await call('lists.addItem', { listId, label, parentId });
      return {
        id: item.id,
        label: item.label,
        command: listAddCommand(call, listLabel, listId, item),
      };
    },
    [listId, listLabel, parentId, readOnly],
  );
}

/**
 * Add new for a select or chips over entries: creates the entry from the
 * label (the caller says which fields it fills), with its undo step.
 */
export function useEntryAddNew(
  collection: EntryCollection,
  data: (label: string) => Doc,
): (label: string) => Promise<AddedItem> {
  const readOnly = useReadOnly();
  return useCallback(
    async (label: string) => {
      if (readOnly) throw new EditableError(readOnly);
      const { entry } = await call('entry.create', {
        collection,
        data: { ...blankEntry(manifests[collection]), ...data(label) },
      });
      const title = entryTitle(entry);
      return {
        id: entry._id,
        label: title,
        command: createCommand(collection, entry._id, title),
      };
    },
    [collection, data, readOnly],
  );
}
