/**
 * Prepared change sets (CC-4, Manuscript wins): a list of field changes to
 * entries, beats, or chapter strands that would make the bible match the
 * chapter. Claude prepares them; code checks every one before it is stored
 * or applied (CC-3): the entry exists, the field is one a person may edit
 * (never the manuscript itself, MS-5), the value passes the entry's schema,
 * and any entry it points to exists. A change that fails is kept apart with
 * the reason and never applied.
 */
import {
  ENTRY_COLLECTIONS,
  entrySchemas,
  entryTitle,
  isEntryCollection,
  manifests,
} from '../../schema';
import type { EntryCollection, FieldSpec, ChangeSetItem } from '../../schema';
import type { StoryDate } from '../../schema/common';
import { formatStoryDate } from '../dates';
import { deepEqual, isPlainObject } from '../paths';
import type { Doc } from '../paths';
import type { TimelineData } from '../timeline';

/** Collections a change set may write: the bible, not the app's own records. */
export const CHANGE_SET_COLLECTIONS: EntryCollection[] = ENTRY_COLLECTIONS.filter(
  (c) => c !== 'findings',
);

/** Fields a change set never writes: the manuscript is read only (MS-5), and import bookkeeping. */
const NEVER = new Set([
  'manuscriptText',
  'manuscriptSource',
  'sourceFile',
  'sourceRef',
  'summaryOutOfDate',
]);

const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** A change as Claude writes it: the value as JSON text, the way import proposals carry fields. */
export interface ChangeOut {
  collection: string;
  id: string;
  field: string;
  value: string;
}

export interface ChangeProblem {
  summary: string;
  reason: string;
}

export function findEntry(data: TimelineData, collection: string, id: string): Doc | undefined {
  return data.all(collection).find((d) => d._id === id && !d.deletedAt);
}

/** The collection a live entry is in, or null. */
export function collectionOf(data: TimelineData, id: string): EntryCollection | null {
  for (const c of ENTRY_COLLECTIONS) if (findEntry(data, c, id)) return c;
  return null;
}

/** A field path: `name`, or `strands.<strand ID>.<name>` on a chapter. */
function specFor(
  collection: EntryCollection,
  field: string,
): { spec: FieldSpec; strandId: string | null } | string {
  const parts = field.split('.');
  if (parts.length === 1) {
    const spec = manifests[collection].find((s) => s.name === field);
    if (!spec) return `${field} is not a field of ${collection}`;
    if (spec.kind === 'system' || spec.derived || NEVER.has(field)) {
      return `${field} is not a field a change set may write`;
    }
    return { spec, strandId: null };
  }
  const [head, strandId, name] = parts;
  if (collection === 'chapters' && parts.length === 3 && head === 'strands' && strandId && name) {
    const strands = manifests.chapters.find((s) => s.name === 'strands');
    const spec = strands?.fields?.find((s) => s.name === name);
    if (!spec || spec.kind === 'system') return `${name} is not a field of a strand`;
    return { spec, strandId };
  }
  return `${field} is not a field path a change set may write`;
}

/** Parse the value Claude gave: JSON text, or the bare text when it is not JSON. */
export function parseValue(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** The entry with one change applied, or why it cannot be. Pure. */
function applyOne(doc: Doc, collection: EntryCollection, change: ChangeSetItem): Doc | string {
  const found = specFor(collection, change.field);
  if (typeof found === 'string') return found;
  if (found.strandId === null) return { ...doc, [change.field]: change.value };
  const strands = Array.isArray(doc.strands) ? doc.strands.filter(isPlainObject) : [];
  const i = strands.findIndex((s) => s.id === found.strandId);
  if (i < 0) return `the chapter has no strand ${found.strandId}`;
  const next = strands.map((s, j) => (j === i ? { ...s, [found.spec.name]: change.value } : s));
  return { ...doc, strands: next };
}

function targetsOf(spec: FieldSpec, value: unknown): string[] {
  if (spec.kind === 'ref') return typeof value === 'string' && value ? [value] : [];
  if (spec.kind === 'refs' || spec.kind === 'refPair') {
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  }
  return [];
}

/**
 * Check one change against the read model, given the changes before it in
 * the same set (they compose). Returns the problem in plain words, or null.
 */
export function changeProblem(
  data: TimelineData,
  change: ChangeSetItem,
  earlier: readonly ChangeSetItem[] = [],
): string | null {
  if (
    !isEntryCollection(change.collection) ||
    !CHANGE_SET_COLLECTIONS.includes(change.collection)
  ) {
    return `${change.collection} is not a part of the bible a change set may write`;
  }
  const c = change.collection;
  const stored = findEntry(data, c, change.id);
  if (!stored) return `there is no ${c} entry ${change.id}`;
  const found = specFor(c, change.field);
  if (typeof found === 'string') return found;
  let doc: Doc = stored;
  for (const e of earlier) {
    if (e.collection !== c || e.id !== change.id) continue;
    const next = applyOne(doc, c, e);
    if (typeof next !== 'string') doc = next;
  }
  const before = fieldValue(doc, change.field);
  if (deepEqual(before ?? null, change.value ?? null)) return 'the bible already holds this value';
  const next = applyOne(doc, c, change);
  if (typeof next === 'string') return next;
  const parsed = entrySchemas[c].safeParse(next);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return `the value does not fit the field (${issue?.message ?? 'invalid'})`;
  }
  for (const t of targetsOf(found.spec, change.value)) {
    const targets = found.spec.target ?? [];
    const ok = targets.includes('*')
      ? collectionOf(data, t) !== null
      : targets.some((tc) => !!findEntry(data, tc, t));
    if (!ok) return `it points to ${t}, which is not in the bible`;
  }
  return null;
}

/** A field's current value on an entry, strand fields included. */
export function fieldValue(doc: Doc, field: string): unknown {
  const parts = field.split('.');
  if (parts.length === 3 && parts[0] === 'strands') {
    const strands = Array.isArray(doc.strands) ? doc.strands.filter(isPlainObject) : [];
    return strands.find((s) => s.id === parts[1])?.[parts[2] ?? ''];
  }
  return doc[field];
}

/**
 * Check every change Claude prepared, in order. Valid ones become stored
 * change set items; the rest are reported with the reason (CC-3).
 */
export function checkChangeSet(
  data: TimelineData,
  changes: readonly ChangeOut[],
): { valid: ChangeSetItem[]; rejected: ChangeProblem[] } {
  const valid: ChangeSetItem[] = [];
  const rejected: ChangeProblem[] = [];
  for (const c of changes) {
    const item: ChangeSetItem = {
      collection: c.collection,
      id: c.id,
      field: c.field,
      value: parseValue(c.value),
    };
    const problem = changeProblem(data, item, valid);
    if (problem) {
      rejected.push({ summary: `${c.collection} ${c.id} ${c.field}: ${c.value}`, reason: problem });
    } else valid.push(item);
  }
  return { valid, rejected };
}

/**
 * The patches that apply a change set: one per entry, each with the stored
 * entry it starts from. Throws a plain error when a change no longer
 * applies (the bible changed since the check).
 */
export function changeSetPatches(
  data: TimelineData,
  changes: readonly ChangeSetItem[],
): { collection: EntryCollection; id: string; before: Doc; patch: Doc }[] {
  const out = new Map<
    string,
    { collection: EntryCollection; id: string; before: Doc; doc: Doc; fields: Set<string> }
  >();
  const done: ChangeSetItem[] = [];
  for (const change of changes) {
    const problem = changeProblem(data, change, done);
    if (problem) {
      throw new Error(
        `The change to ${change.collection} ${change.id} (${change.field}) no longer applies: ${problem}. Check alignment again for a fresh change set.`,
      );
    }
    done.push(change);
    const c = change.collection as EntryCollection;
    const k = `${c}:${change.id}`;
    const stored = findEntry(data, c, change.id) as Doc;
    const cur = out.get(k) ?? {
      collection: c,
      id: change.id,
      before: stored,
      doc: stored,
      fields: new Set<string>(),
    };
    cur.doc = applyOne(cur.doc, c, change) as Doc;
    cur.fields.add(change.field.split('.')[0] ?? change.field);
    out.set(k, cur);
  }
  return [...out.values()].map((e) => ({
    collection: e.collection,
    id: e.id,
    before: e.before,
    patch: Object.fromEntries([...e.fields].map((f) => [f, e.doc[f]])),
  }));
}

/** A value as the diff table shows it. */
export function showValue(spec: FieldSpec | undefined, v: unknown): string {
  if (v === null || v === undefined || v === '') return '(empty)';
  if (spec?.kind === 'storyDate' && isPlainObject(v)) return formatStoryDate(v as StoryDate);
  if (Array.isArray(v))
    return v.length ? v.map((x) => showValue(undefined, x)).join(', ') : '(none)';
  if (isPlainObject(v)) {
    if ('year' in v || 'unknown' in v) return formatStoryDate(v as StoryDate);
    return JSON.stringify(v);
  }
  return String(v);
}

export interface ChangeRow {
  collection: string;
  id: string;
  entry: string;
  field: string;
  label: string;
  before: string;
  after: string;
}

/** CC-4: the change set as a before and after diff, against the bible as it is now. */
export function describeChangeSet(
  data: TimelineData,
  changes: readonly ChangeSetItem[],
): ChangeRow[] {
  return changes.map((ch) => {
    const c = isEntryCollection(ch.collection) ? ch.collection : null;
    const doc = c ? findEntry(data, c, ch.id) : undefined;
    const found = c ? specFor(c, ch.field) : 'unknown';
    const spec = typeof found === 'string' ? undefined : found.spec;
    const strand =
      typeof found !== 'string' && found.strandId && doc
        ? (Array.isArray(doc.strands) ? doc.strands.filter(isPlainObject) : []).find(
            (s) => s.id === found.strandId,
          )
        : undefined;
    const label = spec
      ? strand
        ? `${str(strand.label) || 'Strand'} strand: ${spec.label}`
        : spec.label
      : ch.field;
    return {
      collection: ch.collection,
      id: ch.id,
      entry: doc ? entryTitle(doc) : ch.id,
      field: ch.field,
      label,
      before: showValue(spec, doc ? fieldValue(doc, ch.field) : undefined),
      after: showValue(spec, ch.value),
    };
  });
}
