import { entrySchemas, entryTitle } from '../../schema';
import type { CustomSection, EntryCollection } from '../../schema';
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
  sectionId?: string;
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
  section?: (id: string) => Pick<CustomSection, 'fields'> | undefined;
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

/** Which existing entries a row may match: those from this sheet or file, or any of the section. */
function candidates(
  mapping: Mapping,
  collection: EntryCollection,
  sectionId: string | undefined,
  input: PlanInput,
  prefix: string,
): Doc[] {
  const docs = input.existing(collection).filter((d) => !sectionId || d.sectionId === sectionId);
  if (mapping.matchIn === 'section') return docs;
  return docs.filter((d) => typeof d.sourceRef === 'string' && d.sourceRef.startsWith(prefix));
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
  const identityFor = (row: MappedRow): Map<string, Doc> => {
    const key = `${row.collection}:${row.sectionId ?? ''}:${row.kind}`;
    let map = identityMaps.get(key);
    if (!map) {
      const docs = candidates(mapping, row.collection, row.sectionId, input, prefix);
      const isGrid = mapping.shape === 'grid' && row.kind === 'entry';
      map = isGrid
        ? existingGridIdentities(docs, input.list(mapping.categoryList))
        : existingIdentities(
            docs,
            row.kind === 'heading' || mapping.shape !== 'table'
              ? ['title']
              : identityPaths(mapping),
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
  for (const row of ordered) {
    const hit = identityFor(row).get(row.identity);
    if (hit) {
      matches.set(row, hit);
      if (row.kind === 'heading') idMap.set(row.newId, String(hit._id));
    }
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

  const catalogFor = (row: MappedRow) =>
    importableFields(
      { collection: row.collection, sectionId: row.sectionId },
      row.sectionId ? input.section?.(row.sectionId) : undefined,
    );

  for (const row of ordered) {
    const existing = matches.get(row);
    if (!existing) {
      const data = replaceIds(row.data, idMap) as Doc;
      items.push({
        id: nextId(),
        kind: 'new',
        collection: row.collection,
        ...(row.sectionId ? { sectionId: row.sectionId } : {}),
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
      sectionId: row.sectionId,
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
  sectionId?: string | undefined;
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
      ...(a.sectionId ? { sectionId: a.sectionId } : {}),
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
          ? [...prior.others, { ref: prior.ref, at: prior.at, value: prior.value }].slice(-10)
          : [],
      });
    } else if (prior) {
      out.push({
        ...prior,
        others: [...prior.others, { ref, at: file.modifiedAt, value: d.after }].slice(-10),
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

/** The open question that lists every source and its value for the conflicts of one entry (IM-7). */
export function conflictQuestion(
  title: string,
  conflicts: Conflict[],
): { title: string; question: string } {
  const lines = conflicts.map((c) => {
    const claims = c.claims
      .map(
        (k) => `${k.ref} (modified ${day(k.at)}) says ${shown(k.value)}${k.kept ? ' [kept]' : ''}`,
      )
      .join('; ');
    return `${c.label}: ${claims}.`;
  });
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
