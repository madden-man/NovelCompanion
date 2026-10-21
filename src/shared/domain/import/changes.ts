import { entrySchemas, entryTitle } from '../../schema';
import type { EntryCollection } from '../../schema';
import { deepEqual, isPlainObject } from '../paths';
import type { Doc } from '../paths';
import { importableFields, isVirtual, readField, writeField } from './fields';
import { existingGridIdentities } from './grid';
import { sheetPrefix } from './source';
import { existingIdentities, identityPaths } from './table';
import type { ListAdd, MapOutput, MappedRow, Mapping, SourceFile } from './types';

/** Who supplied a field's value and when that source was last modified (IM-7). */
export interface SourceRecord {
  path: string;
  ref: string;
  /** The source file's modification time. */
  at: string;
  value: unknown;
  /** Earlier or losing sources for the same field, so a question lists them all. */
  others: { ref: string; at: string; value: unknown }[];
}

/** One source's claim about a field. */
export interface SourceClaim {
  ref: string;
  at: string;
  value: unknown;
  /** True for the value the entry has after the import. */
  kept: boolean;
}

export interface Conflict {
  path: string;
  label: string;
  /** The value the newer source wins with. */
  winner: 'incoming' | 'existing';
  claims: SourceClaim[];
}

export interface FieldDelta {
  path: string;
  label: string;
  before: unknown;
  after: unknown;
  /** `keep` leaves the existing value because it comes from a newer source. */
  outcome: 'apply' | 'keep';
  conflict?: Conflict;
}

export interface ChangeItem {
  id: string;
  kind: 'new' | 'changed';
  collection: EntryCollection;
  entryId: string;
  title: string;
  ref: string;
  /** A new entry as it will be created. */
  data?: Doc;
  /** A changed entry's top level fields after the change, including its new `sourceRef`. */
  patch?: Doc;
  deltas: FieldDelta[];
  /** For a changed entry: its `modifiedAt` when the change was worked out, so a later edit is noticed. */
  baseModifiedAt?: string;
  /** Provenance to write for the fields this change sets. */
  records: SourceRecord[];
  /** Why this change exists, for new entries made as stubs for a name. */
  note?: string;
}

export interface FailedRow {
  where: string;
  ref: string;
  reason: string;
}

export interface ChangeSet {
  items: ChangeItem[];
  unchanged: number;
  failed: FailedRow[];
  listAdds: ListAdd[];
  notes: string[];
}

export interface PlanInput {
  mapping: Mapping;
  output: MapOutput;
  file: SourceFile;
  /** The start of the `sourceRef` of entries from this source; a sheet's by default. */
  prefix?: string;
  /** Live entries of a collection. */
  existing: (collection: EntryCollection) => Doc[];
  /** Source records of an entry, from earlier imports. */
  sources: (entryId: string) => SourceRecord[];
  list: (id: string) =>
    | {
        _id: string;
        label: string;
        items: { id: string; label: string; parentId: string | null }[];
      }
    | undefined;
}

const PLACEHOLDER_TIME = '2000-01-01T00:00:00.000Z';

function replaceIds(value: unknown, map: Map<string, string>): unknown {
  if (typeof value === 'string') return map.get(value) ?? value;
  if (Array.isArray(value)) return value.map((v) => replaceIds(v, map));
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replaceIds(v, map)]));
  }
  return value;
}

function labelFor(path: string, catalog: ReturnType<typeof importableFields>): string {
  return catalog.find((f) => f.path === path)?.label ?? path;
}

/** An entry with the values the import last recorded for it written over its current ones. */
function recordedView(doc: Doc, records: SourceRecord[]): Doc {
  if (records.length === 0) return doc;
  const view = structuredClone(doc);
  for (const r of records) writeField(view, r.path, r.value);
  return view;
}

/** Which existing entries a row may match: those from this sheet or file, or any of the section. */
function candidates(
  mapping: Mapping,
  collection: EntryCollection,
  input: PlanInput,
  prefix: string,
): Doc[] {
  const docs = input.existing(collection);
  if (mapping.matchIn === 'section') return docs;
  // An entry counts as from this source when its `sourceRef` says so, or when an earlier import recorded a field from it
  // (a later source may have taken over the `sourceRef`).
  return docs.filter(
    (d) =>
      (typeof d.sourceRef === 'string' && d.sourceRef.startsWith(prefix)) ||
      input.sources(String(d._id)).some((r) => r.ref.startsWith(prefix)),
  );
}

/**
 * Compare a mapped sheet with the bible (IM-3, IM-7): which rows are new,
 * which change an entry already imported (with the old and new value), and how
 * many are unchanged. When a field's current value came from an earlier source
 * and the new value differs, the source modified most recently wins and the
 * disagreement is recorded for an open question.
 */
export function planChanges(input: PlanInput): ChangeSet {
  const { mapping, output, file } = input;
  const prefix = input.prefix ?? sheetPrefix(file.fileName, mapping.sheet);
  const items: ChangeItem[] = [];
  const failed: FailedRow[] = [];
  let unchanged = 0;
  let n = 0;
  const nextId = () => `c${++n}`;
  const idMap = new Map<string, string>();

  for (const row of output.rows.filter((r) => !r.ok)) {
    failed.push({
      where: row.where,
      ref: row.ref,
      reason: row.reason ?? 'The row could not be read',
    });
  }

  const identityMaps = new Map<string, Map<string, Doc>>();
  const identityFor = (row: MappedRow, recorded: boolean): Map<string, Doc> => {
    const key = `${recorded ? 'r' : 'c'}:${row.collection}:${row.kind}`;
    let map = identityMaps.get(key);
    if (!map) {
      const docs = candidates(mapping, row.collection, input, prefix);
      // The recorded view reads each entry as the import last left it, so a hand edit to an identity field does not hide it.
      const view = recorded
        ? (d: Doc) => recordedView(d, input.sources(String(d._id)))
        : (d: Doc) => d;
      const isGrid = mapping.shape === 'grid' && row.kind === 'entry';
      map = isGrid
        ? existingGridIdentities(docs, input.list(mapping.categoryList), view)
        : existingIdentities(
            docs,
            row.kind === 'heading' || mapping.shape !== 'table'
              ? ['title']
              : identityPaths(mapping),
            view,
            row.collection,
          );
      identityMaps.set(key, map);
    }
    return map;
  };

  // Headings first, so their children can point at an entry that already exists.
  const ordered = [
    ...output.rows.filter((r) => r.ok && r.kind === 'heading'),
    ...output.rows.filter((r) => r.ok && r.kind === 'entry'),
  ];
  const matches = new Map<MappedRow, Doc>();
  const taken = new Set<string>();
  const claim = (row: MappedRow, hit: Doc) => {
    matches.set(row, hit);
    taken.add(String(hit._id));
    if (row.kind === 'heading') idMap.set(row.newId, String(hit._id));
  };
  for (const row of ordered) {
    const hit = identityFor(row, false).get(row.identity);
    if (hit) claim(row, hit);
  }
  // A row that matches nothing by the entry's current values may match by the values the import recorded (IM-3).
  for (const row of ordered) {
    if (matches.has(row)) continue;
    const hit = identityFor(row, true).get(row.identity);
    if (hit && !taken.has(String(hit._id))) claim(row, hit);
  }

  for (const stub of output.stubs) {
    items.push({
      id: nextId(),
      kind: 'new',
      collection: stub.collection,
      entryId: stub.newId,
      title: entryTitle(stub.data),
      ref: stub.ref,
      data: stub.data,
      deltas: [],
      records: [],
      note: 'Made because a cell names it and no entry has that name',
    });
  }

  const catalogFor = (row: MappedRow) => importableFields({ collection: row.collection });

  for (const row of ordered) {
    const existing = matches.get(row);
    if (!existing) {
      const data = replaceIds(row.data, idMap) as Doc;
      items.push({
        id: nextId(),
        kind: 'new',
        collection: row.collection,
        entryId: row.newId,
        title: entryTitle(data),
        ref: row.ref,
        data,
        deltas: [],
        records: Object.entries(row.fields).map(([path, value]) => ({
          path,
          ref: row.ref,
          at: file.modifiedAt,
          value,
          others: [],
        })),
      });
      continue;
    }
    if (row.kind === 'heading') {
      unchanged += 1;
      continue;
    }
    const result = changedItem({
      id: nextId(),
      collection: row.collection,
      existing,
      fields: replaceIds(row.fields, idMap) as Record<string, unknown>,
      ref: row.ref,
      where: row.where,
      file,
      records: input.sources(String(existing._id)),
      catalog: catalogFor(row),
    });
    if (result.kind === 'unchanged') unchanged += 1;
    else if (result.kind === 'failed') failed.push(result.failure);
    else items.push(result.item);
  }
  return { items, unchanged, failed, listAdds: output.listAdds, notes: output.notes };
}

export interface ChangedArgs {
  id: string;
  collection: EntryCollection;
  existing: Doc;
  /** The values the source supplies, by field path. */
  fields: Record<string, unknown>;
  ref: string;
  where: string;
  file: SourceFile;
  records: SourceRecord[];
  catalog: ReturnType<typeof importableFields>;
}

/**
 * The change one source makes to an entry already in the bible: each field
 * whose value differs, with the old and new value, and the newer-source rule
 * applied where the current value came from an earlier source (IM-7).
 */
export function changedItem(
  a: ChangedArgs,
):
  | { kind: 'item'; item: ChangeItem }
  | { kind: 'unchanged' }
  | { kind: 'failed'; failure: FailedRow } {
  const { existing, fields, file, records } = a;
  const catalog = a.catalog;
  const deltas: FieldDelta[] = [];
  for (const [path, incoming] of Object.entries(fields)) {
    const prior = readField(existing, path);
    if (deepEqual(prior, incoming)) continue;
    const rec = records.find((r) => r.path === path);
    // The file still says what it said last time, so a different value on the entry is the person's own edit. It stands (ED-7).
    if (rec && deepEqual(rec.value, incoming)) continue;
    // An earlier import already recorded this very claim (same source, date, and value) as a losing one: nothing new to say.
    if (
      rec?.others.some(
        (o) => o.ref === a.ref && o.at === file.modifiedAt && deepEqual(o.value, incoming),
      )
    )
      continue;
    const label = labelFor(path, catalog);
    const delta: FieldDelta = {
      path,
      label,
      before: prior ?? null,
      after: incoming,
      outcome: 'apply',
    };
    // The value still on the entry came from an earlier source: two sources (or two versions of one) disagree.
    if (rec && deepEqual(rec.value, prior)) {
      const incomingWins = file.modifiedAt >= rec.at;
      delta.outcome = incomingWins ? 'apply' : 'keep';
      delta.conflict = {
        path,
        label,
        winner: incomingWins ? 'incoming' : 'existing',
        claims: [
          ...rec.others.map((o) => ({ ...o, kept: false })),
          { ref: rec.ref, at: rec.at, value: rec.value, kept: !incomingWins },
          { ref: a.ref, at: file.modifiedAt, value: incoming, kept: incomingWins },
        ],
      };
    }
    deltas.push(delta);
  }
  if (deltas.length === 0) return { kind: 'unchanged' };
  const applied = deltas.filter((d) => d.outcome === 'apply');
  const merged: Doc = structuredClone(existing);
  for (const d of applied) writeField(merged, d.path, d.after);
  const patch: Doc = {};
  for (const d of applied) {
    const top = isVirtual(d.path) ? 'strands' : (d.path.split('.')[0] ?? d.path);
    patch[top] = merged[top];
  }
  if (applied.length) patch.sourceRef = a.ref;
  const check = entrySchemas[a.collection].safeParse({
    ...merged,
    ...(applied.length ? { sourceRef: a.ref } : {}),
    createdAt: existing.createdAt ?? PLACEHOLDER_TIME,
    modifiedAt: existing.modifiedAt ?? PLACEHOLDER_TIME,
  });
  if (!check.success) {
    return {
      kind: 'failed',
      failure: {
        where: a.where,
        ref: a.ref,
        reason: `The change would make ${entryTitle(existing)} invalid: ${check.error.issues[0]?.message ?? 'unknown problem'}`,
      },
    };
  }
  return {
    kind: 'item',
    item: {
      id: a.id,
      kind: 'changed',
      collection: a.collection,
      entryId: String(existing._id),
      title: entryTitle(existing),
      ref: a.ref,
      patch,
      deltas,
      ...(typeof existing.modifiedAt === 'string' ? { baseModifiedAt: existing.modifiedAt } : {}),
      records: sourceUpdates(deltas, a.ref, file, records),
    },
  };
}

/** The losing claims with one more added, unless the same ref, date, and value is already listed. */
function withClaim(
  others: SourceRecord['others'],
  claim: SourceRecord['others'][number],
): SourceRecord['others'] {
  if (
    others.some((o) => o.ref === claim.ref && o.at === claim.at && deepEqual(o.value, claim.value))
  )
    return others;
  return [...others, claim].slice(-10);
}

/** The source records to write once a change is approved. */
function sourceUpdates(
  deltas: FieldDelta[],
  ref: string,
  file: SourceFile,
  records: SourceRecord[],
): SourceRecord[] {
  const out: SourceRecord[] = [];
  for (const d of deltas) {
    const prior = records.find((r) => r.path === d.path);
    if (d.outcome === 'apply') {
      out.push({
        path: d.path,
        ref,
        at: file.modifiedAt,
        value: d.after,
        others: prior
          ? withClaim(prior.others, { ref: prior.ref, at: prior.at, value: prior.value })
          : [],
      });
    } else if (prior) {
      out.push({
        ...prior,
        others: withClaim(prior.others, { ref, at: file.modifiedAt, value: d.after }),
      });
    }
  }
  return out;
}

const day = (iso: string) => iso.slice(0, 10);

function shown(value: unknown): string {
  if (value === null || value === undefined || value === '') return 'blank';
  if (typeof value === 'string') return value.length > 200 ? `${value.slice(0, 197)}...` : value;
  if (isPlainObject(value) && typeof value.year === 'number') {
    const parts = [value.year, value.month, value.day].filter((x) => x !== undefined);
    return parts.join('-');
  }
  return JSON.stringify(value);
}

export { shown as shownValue };

/** One line of a conflict question: the field and every claim about it. */
export function conflictLine(c: Conflict, withKept = true): string {
  const claims = c.claims
    .map(
      (k) =>
        `${k.ref} (modified ${day(k.at)}) says ${shown(k.value)}${withKept && k.kept ? ' [kept]' : ''}`,
    )
    .join('; ');
  return `${c.label}: ${claims}.`;
}

/**
 * True when an open question's text already lists this conflict: the same
 * field with the same set of claims, whichever claim was kept.
 */
export function questionCovers(questionText: string, c: Conflict): boolean {
  const want = conflictLine(c, false);
  return questionText.split('\n').some((line) => line.replaceAll(' [kept]', '') === want);
}

/**
 * The question text with this conflict's line brought up to date: the line for
 * the same field is replaced, or the line is added when the field is new to the
 * question. Null when the text already lists exactly these claims.
 */
export function questionWithConflict(questionText: string, c: Conflict): string | null {
  if (questionCovers(questionText, c)) return null;
  const lines = questionText.split('\n');
  const prefix = `${c.label}: `;
  const at = lines.findIndex((l, i) => i > 0 && l.startsWith(prefix));
  const line = conflictLine(c);
  if (at >= 0) lines[at] = line;
  else lines.push(line);
  return lines.join('\n');
}

/** The open question that lists every source and its value for the conflicts of one entry (IM-7). */
export function conflictQuestion(
  title: string,
  conflicts: Conflict[],
): { title: string; question: string } {
  const lines = conflicts.map((c) => conflictLine(c));
  return {
    title: `Sources disagree about ${title}`,
    question: [
      `The sources give different values for ${title}. The most recently modified source was kept.`,
      ...lines,
    ].join('\n'),
  };
}

/** Counts for a report. */
export function summarize(set: ChangeSet): {
  created: number;
  changed: number;
  unchanged: number;
  failed: number;
} {
  return {
    created: set.items.filter((i) => i.kind === 'new').length,
    changed: set.items.filter((i) => i.kind === 'changed').length,
    unchanged: set.unchanged,
    failed: set.failed.length,
  };
}

function collectStrings(value: unknown, into: Set<string>): void {
  if (typeof value === 'string') into.add(value);
  else if (Array.isArray(value)) for (const v of value) collectStrings(v, into);
  else if (isPlainObject(value)) for (const v of Object.values(value)) collectStrings(v, into);
}

/** The IDs of other new items that an item points at (a chapter's part, a part's book, a beat's point of view character). */
export function itemNeeds(item: ChangeItem, items: ChangeItem[]): string[] {
  const strings = new Set<string>();
  collectStrings(item.data, strings);
  collectStrings(item.patch, strings);
  return items
    .filter((o) => o.kind === 'new' && o.id !== item.id && strings.has(o.entryId))
    .map((o) => o.id);
}

/**
 * Approving an item approves the new items it points at, and theirs in turn,
 * so no approved entry is written with a link to something that was not
 * (ED-7). Returns the full set and, for each item pulled in, who needed it.
 */
export function withDependencies(
  items: ChangeItem[],
  approved: ReadonlySet<string>,
): { ids: Set<string>; added: Map<string, string[]> } {
  const byId = new Map(items.map((i) => [i.id, i]));
  const ids = new Set([...approved].filter((id) => byId.has(id)));
  const added = new Map<string, string[]>();
  const queue = [...ids];
  while (queue.length) {
    const item = byId.get(queue.pop() as string);
    if (!item) continue;
    for (const need of itemNeeds(item, items)) {
      if (!ids.has(need)) {
        ids.add(need);
        queue.push(need);
      }
      if (!approved.has(need)) added.set(need, [...(added.get(need) ?? []), item.id]);
    }
  }
  return { ids, added };
}

/** The list choices that approved items point at, with the parents they sit under. */
export function referencedListAdds(items: ChangeItem[], adds: ListAdd[]): ListAdd[] {
  const strings = new Set<string>();
  for (const i of items) {
    collectStrings(i.data, strings);
    collectStrings(i.patch, strings);
  }
  const need = new Set(adds.filter((a) => strings.has(a.id)).map((a) => `${a.listId}:${a.id}`));
  for (let grew = true; grew;) {
    grew = false;
    for (const a of adds) {
      if (!need.has(`${a.listId}:${a.id}`) || a.parentId === null) continue;
      const parent = `${a.listId}:${a.parentId}`;
      if (!need.has(parent) && adds.some((p) => `${p.listId}:${p.id}` === parent)) {
        need.add(parent);
        grew = true;
      }
    }
  }
  return adds.filter((a) => need.has(`${a.listId}:${a.id}`));
}
