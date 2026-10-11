import { entryTitle } from '../../schema';
import type { CustomSection, EntryCollection } from '../../schema';
import type { Doc } from '../paths';
import { buildEntry } from './build';
import { changedItem, planChanges } from './changes';
import type { ChangeItem, ChangeSet, SourceRecord } from './changes';
import { importableFields } from './fields';
import { documentPrefix, paragraphRef } from './source';
import type { EraDraft } from './eras';
import { normalizeIdentity } from './table';
import type { MapOutput, MappedRow, SourceFile, TableMapping } from './types';

/** What a Word document becomes (IM-4). */
export type DocumentKind = 'backstory' | 'chapter' | 'note';

export const DOCUMENT_KIND_LABELS: Record<DocumentKind, string> = {
  backstory: 'Character backstory',
  chapter: 'Chapter',
  note: 'General note',
};

export type DocumentTarget =
  | { kind: 'backstory'; characterId: string }
  | { kind: 'chapter'; chapterId: string }
  | { kind: 'chapter'; chapterId: null; title: string; partId: string; year: number }
  | { kind: 'note'; sectionId: string; title: string };

export interface DocumentPlanInput {
  file: SourceFile;
  /** The document's body in the editor format. */
  body: string;
  /** The paragraph numbers the body covers. */
  span: { first: number; last: number };
  target: DocumentTarget;
  /** Live entries of a collection. */
  entries: (collection: EntryCollection) => Doc[];
  sources: (entryId: string) => SourceRecord[];
  section?: (id: string) => Pick<CustomSection, 'fields'> | undefined;
  newId: () => string;
}

function emptyBody(body: string): boolean {
  return body.replace(/<[^>]*>/g, '').trim() === '';
}

/** The change set a document makes: one new entry, or one changed entry (IM-4, IM-3). */
export function planDocument(input: DocumentPlanInput): ChangeSet {
  const { file, body, target } = input;
  const ref = paragraphRef(file.fileName, input.span.first, input.span.last);
  const where = `${file.fileName} paragraphs ${input.span.first} to ${input.span.last}`;
  const set: ChangeSet = { items: [], unchanged: 0, failed: [], listAdds: [], notes: [] };
  const fail = (reason: string) => {
    set.failed.push({ where, ref, reason });
    return set;
  };
  if (emptyBody(body)) return fail('The document has no text to import');

  const existingChange = (
    collection: EntryCollection,
    existing: Doc | undefined,
    fields: Record<string, unknown>,
    sectionId?: string,
  ): boolean => {
    if (!existing) return false;
    const result = changedItem({
      id: 'c1',
      collection,
      sectionId,
      existing,
      fields,
      ref,
      where,
      file,
      records: input.sources(String(existing._id)),
      catalog: importableFields(
        { collection, sectionId },
        sectionId ? input.section?.(sectionId) : undefined,
      ),
    });
    if (result.kind === 'unchanged') set.unchanged += 1;
    else if (result.kind === 'failed') set.failed.push(result.failure);
    else set.items.push(result.item);
    return true;
  };
  const created = (item: Omit<ChangeItem, 'id' | 'kind' | 'deltas'>, paths: string[]) => {
    set.items.push({
      id: 'c1',
      kind: 'new',
      deltas: [],
      ...item,
      records: paths.map((path) => ({
        path,
        ref,
        at: file.modifiedAt,
        value: undefined,
        others: [],
      })),
    });
  };

  if (target.kind === 'backstory') {
    const doc = input.entries('characters').find((d) => d._id === target.characterId);
    if (!doc) return fail('That character is not in the bible');
    existingChange('characters', doc, { backstory: body });
    return withValues(set, { backstory: body });
  }

  if (target.kind === 'chapter') {
    if (target.chapterId !== null) {
      const doc = input.entries('chapters').find((d) => d._id === target.chapterId);
      if (!doc) return fail('That chapter is not in the bible');
      const fields = { manuscriptText: body, sourceFile: file.fileName, written: true };
      existingChange('chapters', doc, fields);
      return withValues(set, fields);
    }
    const id = input.newId();
    const fields = {
      title: target.title,
      partId: target.partId,
      'strand.startYear': target.year,
      manuscriptText: body,
      sourceFile: file.fileName,
    };
    const built = buildEntry({
      target: { collection: 'chapters' },
      fields,
      fixed: { status: 'planned', written: true },
      newId: id,
      ref,
      ordinal: input.entries('chapters').length + 1,
    });
    if (!built.ok) return fail(built.reason);
    created(
      {
        collection: 'chapters',
        entryId: id,
        title: target.title,
        ref,
        data: built.data,
        records: [],
      },
      Object.keys(fields),
    );
    return withValues(set, fields);
  }

  // A general note lives in a custom section.
  const existing = input
    .entries('customEntries')
    .find(
      (d) =>
        d.sectionId === target.sectionId &&
        typeof d.sourceRef === 'string' &&
        d.sourceRef.startsWith(documentPrefix(file.fileName)) &&
        entryTitle(d) === target.title,
    );
  if (existingChange('customEntries', existing, { body }, target.sectionId)) {
    return withValues(set, { body });
  }
  const id = input.newId();
  const built = buildEntry({
    target: { collection: 'customEntries', sectionId: target.sectionId },
    fields: { title: target.title, body },
    fixed: { status: 'planned' },
    newId: id,
    ref,
    ordinal: 1,
    section: input.section?.(target.sectionId),
  });
  if (!built.ok) return fail(built.reason);
  created(
    {
      collection: 'customEntries',
      sectionId: target.sectionId,
      entryId: id,
      title: target.title,
      ref,
      data: built.data,
      records: [],
    },
    ['title', 'body'],
  );
  return withValues(set, { title: target.title, body });
}

/** Fill the recorded values on the change records of a set (new entries record what they were given). */
function withValues(set: ChangeSet, values: Record<string, unknown>): ChangeSet {
  for (const item of set.items) {
    for (const r of item.records) if (r.value === undefined) r.value = values[r.path] ?? null;
  }
  return set;
}

export interface EraPlanInput {
  file: SourceFile;
  eras: EraDraft[];
  entries: (collection: EntryCollection) => Doc[];
  sources: (entryId: string) => SourceRecord[];
  newId: () => string;
}

/**
 * Era states from a document's headings (IM-4, WE-1) as a change set: a new
 * era for each heading with years, an update to one imported before, or
 * nothing when it has not changed. Eras are matched by name.
 */
export function planEraDocument(input: EraPlanInput): ChangeSet {
  const { file } = input;
  const rows: MappedRow[] = [];
  const counts = new Map<string, number>();
  for (const era of input.eras) {
    const ref = paragraphRef(file.fileName, era.first, era.last);
    const where = `${file.fileName} paragraphs ${era.first} to ${era.last}`;
    const id = input.newId();
    const fields: Record<string, unknown> = {
      title: era.name,
      name: era.name,
      startYear: era.startYear,
      endYear: era.endYear,
      ...era.fields,
      ...(era.body ? { body: era.body } : {}),
    };
    const built = buildEntry({
      target: { collection: 'eraStates' },
      fields,
      fixed: {},
      newId: id,
      ref,
      ordinal: rows.length + 1,
    });
    const base = normalizeIdentity(era.name);
    const n = (counts.get(base) ?? 0) + 1;
    counts.set(base, n);
    rows.push({
      ref,
      where,
      ok: built.ok,
      ...(built.ok ? {} : { reason: built.reason }),
      collection: 'eraStates',
      newId: id,
      fields,
      data: built.ok ? built.data : {},
      identity: n > 1 ? `${base}#${n}` : base,
      kind: 'entry',
    });
  }
  const mapping: TableMapping = {
    shape: 'table',
    sheet: file.fileName,
    target: { collection: 'eraStates' },
    headerRow: 1,
    columns: [],
    identity: ['name'],
    fixed: {},
    addMissingListItems: false,
    createMissing: false,
    matchIn: 'sheet',
    headings: [],
  };
  const output: MapOutput = { rows, listAdds: [], stubs: [], notes: [] };
  return planChanges({
    mapping,
    output,
    file,
    prefix: documentPrefix(file.fileName),
    existing: input.entries,
    sources: input.sources,
    list: () => undefined,
  });
}
