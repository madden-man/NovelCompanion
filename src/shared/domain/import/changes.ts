import { entrySchemas, entryTitle } from '../../schema';
import type { EntryCollection } from '../../schema';
import { deepEqual, isPlainObject } from '../paths';
import type { Doc } from '../paths';
import { importableFields, isVirtual, readField, writeField } from './fields';
import { existingGridIdentities } from './grid';
import { chapterIdentity } from './gridEntries';
import { sheetPrefix } from './source';
import {
  existingIdentities,
  identityPaths,
  identityTitle,
  normalizeIdentity,
  ordinalKey,
} from './table';
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
  /** Entries of a collection in the trash, so a match there is left alone rather than made again. */
  trashed?: (collection: EntryCollection) => Doc[];
  list: (id: string) =>
    | {
        _id: string;
        label: string;
        items: { id: string; label: string; parentId: string | null }[];
      }
    | undefined;
}

const PLACEHOLDER_TIME = '2000-01-01T00:00:00.000Z';

/** The source named for a value that was on an entry before any import set it: written in the app by hand. */
export const HAND_EDIT_REF = 'the bible (edited by hand)';

/** True for a value that says nothing: missing, blank text, false, an empty list, or an unknown date. */
function isEmptyValue(v: unknown): boolean {
  if (v === null || v === undefined || v === '' || v === false) return true;
  if (Array.isArray(v)) return v.length === 0;
  return isPlainObject(v) && v.unknown === true && Object.keys(v).length === 1;
}

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

/**
 * Source records written before A39 under a plot beat's field names. A beat
 * became a moment with the same ID (SM-3), so its point of view and experience
 * note records now speak for the moment's character and body (IM-3, IM-7).
 */
const LEGACY_PATHS: Partial<Record<EntryCollection, Record<string, string>>> = {
  moments: { povCharacterId: 'characterId', experienceNote: 'body' },
};

/** The records of an entry with any pre-A39 field names read as today's. */
export function currentRecords(
  collection: EntryCollection,
  records: SourceRecord[],
): SourceRecord[] {
  const legacy = LEGACY_PATHS[collection];
  if (!legacy) return records;
  const out = records.filter((r) => !legacy[r.path]);
  for (const r of records) {
    const path = legacy[r.path];
    if (path && !out.some((o) => o.path === path)) out.push({ ...r, path });
  }
  return out;
}

/** A chapter read with its part's title in place of the part's ID, for matching by part and title. */
function chapterKeyOf(doc: Doc, partTitle: (id: unknown) => string | undefined): string {
  return chapterIdentity(partTitle(doc.partId), doc.title);
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

  const sourcesOf = (collection: EntryCollection, id: string) =>
    currentRecords(collection, input.sources(id));
  const partTitles = new Map<string, string>();
  const partTitle = (id: unknown): string | undefined => {
    if (typeof id !== 'string') return undefined;
    if (partTitles.size === 0) {
      for (const p of input.existing('parts')) partTitles.set(String(p._id), String(p.title));
    }
    return partTitles.get(id);
  };
  const identityMaps = new Map<string, Map<string, Doc>>();
  const identityFor = (row: MappedRow, recorded: boolean): Map<string, Doc> => {
    const key = `${recorded ? 'r' : 'c'}:${row.collection}:${row.kind}`;
    let map = identityMaps.get(key);
    if (!map) {
      const docs = candidates(mapping, row.collection, input, prefix);
      // The recorded view reads each entry as the import last left it, so a hand edit to an identity field does not hide it.
      const view = recorded
        ? (d: Doc) => recordedView(d, sourcesOf(row.collection, String(d._id)))
        : (d: Doc) => d;
      const isGrid = mapping.shape === 'grid' && row.kind === 'entry';
      map =
        isGrid && row.collection === 'chapters'
          ? keyed(docs, (d) => chapterKeyOf(view(d), partTitle))
          : isGrid && row.collection === 'moments'
            ? existingIdentities(docs, ['characterId', 'title'], view, 'moments')
            : isGrid
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

  // A High Level chapter that matches nothing by part and title (A29, IM-3) is looked for, in order: by its
  // title anywhere in the same book (the writer moves chapters between parts), by the sheet row its
  // sourceRef names (live or in the trash), then by its place in the part (a title renamed by hand; the
  // Introduction is not counted, as in the title cleanup). A match in the trash is left there.
  const notes: string[] = [];
  const leftInTrash = new Set<MappedRow>();
  if (mapping.shape === 'grid' && mapping.target.collection === 'chapters') {
    const chapters = input.existing('chapters');
    const parts = new Map(input.existing('parts').map((p) => [String(p._id), p]));
    const headingRows = new Map(output.rows.map((r) => [r.newId, r]));
    const waiting = () =>
      ordered.filter(
        (r) =>
          !matches.has(r) &&
          !leftInTrash.has(r) &&
          r.kind === 'entry' &&
          r.collection === 'chapters',
      );
    const bareKey = (t: unknown) => normalizeIdentity(identityTitle('chapters', t));
    // The book a row's part belongs to, as an existing book's ID.
    const bookOf = (row: MappedRow): string | undefined => {
      const partId = idMap.get(String(row.fields.partId));
      if (partId) return parts.get(partId)?.bookId as string | undefined;
      const part = headingRows.get(String(row.fields.partId));
      return part ? idMap.get(String(part.fields.bookId)) : undefined;
    };
    for (const row of waiting()) {
      const book = bookOf(row);
      if (!book) continue;
      const hits = chapters.filter(
        (c) =>
          !taken.has(String(c._id)) &&
          parts.get(String(c.partId))?.bookId === book &&
          bareKey(c.title) === bareKey(row.fields.title),
      );
      const hit = hits.length === 1 ? hits[0] : undefined;
      if (!hit) continue;
      claim(row, hit);
      notes.push(
        `${row.where}: "${String(row.fields.title)}" matched the chapter of that title in ${String(parts.get(String(hit.partId))?.title ?? 'another part')}; it stays where it is.`,
      );
    }
    // The sheet row a sourceRef names: "...#High Level!A19" or a range such as "...#High Level!AS19:AV19".
    const rowOf = (ref: unknown): string | null => {
      if (typeof ref !== 'string' || !ref.startsWith(prefix)) return null;
      const m = /^[A-Z]+(\d+)/.exec(ref.slice(prefix.length));
      return m ? (m[1] ?? null) : null;
    };
    const trashed = input.trashed?.('chapters') ?? [];
    for (const row of waiting()) {
      const want = rowOf(row.ref);
      if (!want) continue;
      const live = chapters.find((c) => !taken.has(String(c._id)) && rowOf(c.sourceRef) === want);
      if (live) {
        claim(row, live);
        notes.push(
          `${row.where}: "${String(row.fields.title)}" matched "${String(live.title)}" by its source row.`,
        );
        continue;
      }
      const gone = trashed.find((c) => rowOf(c.sourceRef) === want);
      if (gone) {
        leftInTrash.add(row);
        notes.push(
          `${row.where}: "${String(row.fields.title)}" is "${String(gone.title)}", in the trash, left alone.`,
        );
      }
    }
    for (const row of waiting()) {
      if (row.position === undefined) continue;
      const partId = idMap.get(String(row.fields.partId));
      if (!partId) continue;
      // A chapter moved into this part from another part's row is not counted in this part's places.
      const movedIn = (c: Doc) =>
        [...matches].some(
          ([r, d]) => d._id === c._id && String(r.fields.partId) !== String(row.fields.partId),
        );
      const inPart = chapters
        .filter(
          (c) =>
            c.partId === partId &&
            String(c.title).trim().toLowerCase() !== 'introduction' &&
            !movedIn(c),
        )
        .sort(
          (x, y) =>
            Number(x.readingOrder) - Number(y.readingOrder) ||
            String(x._id).localeCompare(String(y._id)),
        );
      const hit = inPart[row.position - 1];
      if (!hit || taken.has(String(hit._id))) continue;
      claim(row, hit);
      notes.push(
        `${row.where}: "${String(row.fields.title)}" matched chapter ${row.position} of its part, "${String(hit.title)}", by its place; its title is listed as a change.`,
      );
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

  const catalogFor = (row: MappedRow) => importableFields({ collection: row.collection });

  for (const row of ordered) {
    if (leftInTrash.has(row)) {
      unchanged += 1;
      continue;
    }
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
    const fields = replaceIds(row.fields, idMap) as Record<string, unknown>;
    // A chapter that exists keeps its part and reading order: they are the writer's structure (A29).
    if (row.collection === 'chapters') delete fields.partId;
    const result = changedItem({
      id: nextId(),
      collection: row.collection,
      existing,
      fields,
      ref: row.ref,
      where: row.where,
      file,
      records: sourcesOf(row.collection, String(existing._id)),
      catalog: catalogFor(row),
      addOnly: mapping.addOnly ?? [],
    });
    if (result.kind === 'unchanged') unchanged += 1;
    else if (result.kind === 'failed') failed.push(result.failure);
    else items.push(result.item);
  }
  return {
    items,
    unchanged,
    failed,
    listAdds: output.listAdds,
    notes: [...output.notes, ...notes],
  };
}

/** Existing entries by a key, counted the way a sheet's rows are. */
function keyed(docs: Doc[], key: (d: Doc) => string): Map<string, Doc> {
  const counts = new Map<string, number>();
  const out = new Map<string, Doc>();
  for (const d of [...docs].sort((a, b) => String(a._id).localeCompare(String(b._id)))) {
    const k = key(d);
    if (k.replace(/\u241f/g, '') === '') continue;
    out.set(ordinalKey(counts, k), d);
  }
  return out;
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
  /** List fields the import only adds to: what the entry has stays (see `Mapping.addOnly`). */
  addOnly?: string[];
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
  for (const [path, value] of Object.entries(fields)) {
    const prior = readField(existing, path);
    // An add-only list keeps its values and gains the sheet's missing ones after them.
    const incoming =
      a.addOnly?.includes(path) && Array.isArray(prior) && Array.isArray(value)
        ? [...prior, ...value.filter((v) => !prior.some((p) => deepEqual(p, v)))]
        : value;
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
    // No source ever set this field, and the entry already holds a value: it was written by hand (or by an
    // older tool). The newer of the entry and the file wins, and the disagreement is filed like two sources' (IM-7).
    // An empty value counts too once the entry has been edited after it was made: the writer may have cleared
    // it on purpose (a strand left open, a body emptied). Only a field never on the entry, or an entry never
    // edited, is filled quietly.
    const editedSinceMade =
      typeof existing.createdAt === 'string' &&
      typeof existing.modifiedAt === 'string' &&
      existing.modifiedAt !== existing.createdAt;
    const handValue = !isEmptyValue(prior) || (editedSinceMade && prior !== undefined);
    if (!rec && handValue && !a.addOnly?.includes(path)) {
      const edited = typeof existing.modifiedAt === 'string' ? existing.modifiedAt : null;
      const incomingWins = edited === null || file.modifiedAt >= edited;
      delta.outcome = incomingWins ? 'apply' : 'keep';
      delta.conflict = {
        path,
        label,
        winner: incomingWins ? 'incoming' : 'existing',
        claims: [
          { ref: HAND_EDIT_REF, at: edited ?? PLACEHOLDER_TIME, value: prior, kept: !incomingWins },
          { ref: a.ref, at: file.modifiedAt, value: incoming, kept: incomingWins },
        ],
      };
      deltas.push(delta);
      continue;
    }
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
    // A value written by hand gets a record of its own, so the next run sees the same claim and stays quiet.
    const hand = d.conflict?.claims.find((c) => c.ref === HAND_EDIT_REF);
    const prior =
      records.find((r) => r.path === d.path) ??
      (hand
        ? { path: d.path, ref: hand.ref, at: hand.at, value: hand.value, others: [] }
        : undefined);
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
