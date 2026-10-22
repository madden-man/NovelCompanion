/**
 * IP-1: the pure side of `Editable`. Each kind reads the text a writer typed
 * into the value it stores, or says in plain words why it cannot; the Add
 * new flow of a select or a chip row is a small state machine; and an entry
 * field path becomes the top-level patch the write path takes. No React and
 * no DOM here, so unit tests cover it directly.
 */
import { dateText, formatStoryDate, isKnown, parseDateText } from '../../../../shared/domain/dates';
import type { DateBox } from '../../../../shared/domain/dates';
import { isPlainObject } from '../../../../shared/domain/paths';
import type { Doc } from '../../../../shared/domain/paths';
import type { UndoCommand } from '../../../../shared/domain/undoRunner';
import { manifests } from '../../../../shared/schema';
import type { EntryCollection, FieldSpec, StoryDate } from '../../../../shared/schema';
import { labelPath } from '../../../../shared/domain/issues';

export type EditableKind = 'text' | 'year' | 'number' | 'rich' | 'select' | 'chips' | 'date';

/** The value each kind holds. */
export interface EditableValues {
  text: string;
  year: number | null;
  number: number | null;
  rich: string;
  select: string | null;
  chips: string[];
  date: StoryDate | null;
}

/** One choice of a select or a chip row: the stored ID and the words shown. */
export interface EditableOption {
  value: string;
  label: string;
}

/**
 * What `onAddNew` hands back: the new item's ID, and the undo step that made
 * it, which the save folds into its own step so the writer sees one.
 */
export interface AddedItem {
  id: string;
  label: string;
  command?: UndoCommand;
}

/** Extra facts a save receives: the item Add new made on the way, if any. */
export interface SaveInfo {
  added?: AddedItem;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

/** The sentinel value of the "Add new..." choice in a select or a chip picker. */
export const ADD_NEW = '\u0000add-new';
export const ADD_NEW_LABEL = 'Add new...';

/** Text: kept as typed, apart from trailing spaces; empty is refused when `allowEmpty` is false. */
export function parseText(text: string, allowEmpty = true): Parsed<string> {
  const v = text.replace(/\s+$/u, '');
  if (!allowEmpty && v.trim() === '') return { ok: false, message: 'Cannot be empty.' };
  return { ok: true, value: v };
}

/** A year: digits only, with an optional minus sign, from -10000 to 10000. */
export function parseYear(text: string, allowEmpty = false): Parsed<number | null> {
  const t = text.trim();
  if (t === '') {
    return allowEmpty
      ? { ok: true, value: null }
      : { ok: false, message: 'Needs a year. Write it as digits, for example 2045.' };
  }
  if (!/^-?\d+$/.test(t)) {
    return { ok: false, message: `${t} is not a year. Write it as digits, for example 2045.` };
  }
  const year = Number(t);
  if (year < -10000 || year > 10000) {
    return { ok: false, message: `${year} is outside the years the app keeps (-10000 to 10000).` };
  }
  return { ok: true, value: year };
}

/** A number: digits, an optional minus sign, and a decimal point unless `integer`. */
export function parseNumber(
  text: string,
  opts: { allowEmpty?: boolean; integer?: boolean; min?: number; max?: number } = {},
): Parsed<number | null> {
  const t = text.trim();
  if (t === '') {
    return opts.allowEmpty
      ? { ok: true, value: null }
      : { ok: false, message: 'Needs a number. Write it as digits.' };
  }
  const re = opts.integer ? /^-?\d+$/ : /^-?(\d+(\.\d*)?|\.\d+)$/;
  if (!re.test(t)) {
    return {
      ok: false,
      message: opts.integer
        ? `${t} is not a whole number. Write it as digits.`
        : `${t} is not a number. Write it as digits.`,
    };
  }
  const n = Number(t);
  if (opts.min !== undefined && n < opts.min) {
    return { ok: false, message: `${t} is too small. The smallest is ${opts.min}.` };
  }
  if (opts.max !== undefined && n > opts.max) {
    return { ok: false, message: `${t} is too large. The largest is ${opts.max}.` };
  }
  return { ok: true, value: n };
}

/** A one-box date (SM-1): the parser and its "could not read" words from `dates.ts`. */
export function parseDate(text: string, box: DateBox): Parsed<StoryDate | null> {
  return parseDateText(text, box);
}

/** The text a closed field shows, or '' when it holds nothing (the placeholder shows then). */
export function shownText(
  kind: EditableKind,
  value: unknown,
  options: readonly EditableOption[] = [],
): string {
  switch (kind) {
    case 'text':
    case 'rich':
      return typeof value === 'string' ? value : '';
    case 'year':
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
    case 'date':
      return isKnown(value as StoryDate | null) ? formatStoryDate(value as StoryDate) : '';
    case 'select': {
      if (typeof value !== 'string' || value === '') return '';
      return options.find((o) => o.value === value)?.label ?? value;
    }
    case 'chips': {
      const ids = Array.isArray(value) ? value.map(String) : [];
      return ids.map((id) => options.find((o) => o.value === id)?.label ?? id).join(', ');
    }
  }
}

/** The text an opened field starts with. */
export function draftText(kind: EditableKind, value: unknown): string {
  if (kind === 'date') return dateText(value as StoryDate | null);
  if (kind === 'select' || kind === 'chips') return '';
  return shownText(kind, value);
}

/** Options a chip picker offers for a query: unpicked ones whose label holds the words. */
export function chipChoices(
  options: readonly EditableOption[],
  picked: readonly string[],
  query: string,
): EditableOption[] {
  const q = query.trim().toLowerCase();
  return options.filter(
    (o) => !picked.includes(o.value) && (!q || o.label.toLowerCase().includes(q)),
  );
}

/**
 * The Add new flow of a select or a chip row. `choosing` is the open select or
 * picker; picking Add new moves to `naming`, where the field takes the new
 * item's label; Enter there moves to `adding` while `onAddNew` runs, then
 * `saving` while the value that picks it is written. A failure goes back to
 * `naming` with the message, keeping the typed label.
 */
export type AddNewState =
  | { step: 'closed' }
  | { step: 'choosing'; query: string }
  | { step: 'naming'; label: string; error: string | null }
  | { step: 'adding'; label: string }
  | { step: 'saving'; label: string; added: AddedItem }
  | { step: 'done'; added: AddedItem };

export type AddNewAction =
  | { type: 'open' }
  | { type: 'query'; query: string }
  | { type: 'pickAddNew'; label?: string }
  | { type: 'label'; label: string }
  | { type: 'submit' }
  | { type: 'added'; added: AddedItem }
  | { type: 'saved' }
  | { type: 'failed'; message: string }
  | { type: 'cancel' };

export function addNewReducer(state: AddNewState, action: AddNewAction): AddNewState {
  switch (action.type) {
    case 'open':
      return { step: 'choosing', query: '' };
    case 'query':
      return state.step === 'choosing' ? { step: 'choosing', query: action.query } : state;
    case 'pickAddNew': {
      const label = action.label ?? (state.step === 'choosing' ? state.query : '');
      return { step: 'naming', label: label.trim(), error: null };
    }
    case 'label':
      return state.step === 'naming' ? { ...state, label: action.label, error: null } : state;
    case 'submit':
      if (state.step !== 'naming') return state;
      if (!state.label.trim()) {
        return { ...state, error: 'Write a name for the new item first.' };
      }
      return { step: 'adding', label: state.label.trim() };
    case 'added':
      return state.step === 'adding'
        ? { step: 'saving', label: state.label, added: action.added }
        : state;
    case 'saved':
      return state.step === 'saving' ? { step: 'done', added: state.added } : state;
    case 'failed':
      if (state.step === 'adding' || state.step === 'saving') {
        return { step: 'naming', label: state.label, error: action.message };
      }
      return state;
    case 'cancel':
      return { step: 'closed' };
  }
}

/**
 * The top-level patch that sets one dotted field path on an entry. The write
 * path takes whole top-level fields, so `names.full` becomes the `names`
 * object with `full` replaced and its other keys kept.
 */
export function patchForPath(entry: Doc, path: string, value: unknown): Doc {
  const [head, ...rest] = path.split('.');
  if (!head) throw new Error('A field path needs a name.');
  if (rest.length === 0) return { [head]: value };
  return { [head]: setIn(entry[head], rest, value) };
}

function setIn(container: unknown, keys: string[], value: unknown): unknown {
  const [k, ...more] = keys;
  if (k === undefined) return value;
  if (Array.isArray(container) || (/^\d+$/.test(k) && !isPlainObject(container))) {
    const arr = Array.isArray(container) ? [...(container as unknown[])] : [];
    const i = Number(k);
    arr[i] = setIn(arr[i], more, value);
    return arr;
  }
  const obj = isPlainObject(container) ? { ...container } : {};
  obj[k] = setIn(obj[k], more, value);
  return obj;
}

/**
 * Two steps the writer made as one (an item added on the way, then the field
 * that picks it): redo runs them in order, undo in reverse, under one label.
 */
export function mergeCommands(label: string, first: UndoCommand, then: UndoCommand): UndoCommand {
  return {
    label,
    redo: [...first.redo, ...then.redo],
    undo: [...then.undo, ...first.undo],
  };
}

/** The label of a field path from the manifest: its own label, "Full name" for `names.full`. */
export function fieldLabel(collection: EntryCollection, path: string): string {
  let specs: readonly FieldSpec[] | undefined = manifests[collection];
  let label = path;
  for (const part of path.split('.')) {
    if (/^\d+$/.test(part)) continue;
    const spec: FieldSpec | undefined = specs?.find((s) => s.name === part);
    if (!spec) return labelPath(manifests[collection], path);
    label = spec.label;
    specs = spec.fields;
  }
  return label;
}
