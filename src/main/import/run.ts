import { monotonicFactory } from 'ulid';
import {
  blocksToBody,
  mapSheet,
  planChanges,
  planDocument,
  shownValue,
  spanOf,
} from '../../shared/domain/import';
import type {
  ChangeItem,
  ChangeSet,
  DocBlock,
  DocumentTarget,
  MapContext,
  MapOutput,
  Mapping,
  ParsedSheet,
  SourceFile,
} from '../../shared/domain/import';
import { entryTitle } from '../../shared/schema';
import type { CustomSection, EntryCollection } from '../../shared/schema';
import type { OpenBible } from '../db/session';
import type { StoredDoc } from '../readmodel';
import type { ParsedDocument } from './docx';

const newId = monotonicFactory();

const live = (docs: StoredDoc[]) => docs.filter((d) => !d.deletedAt);

/** What the mapping engine needs to know about the open bible. */
export function contextFor(open: OpenBible, file: SourceFile): MapContext {
  return {
    file,
    newId: () => newId(),
    list: (id) => {
      const l = open.model.get('lists', id);
      return l ? (l as unknown as ReturnType<MapContext['list']>) : undefined;
    },
    entries: (c) => live(open.model.all(c)),
    section: (id) =>
      open.model.get('customSections', id) as unknown as Pick<CustomSection, 'fields'> | undefined,
  };
}

export interface SheetPlan {
  set: ChangeSet;
  output: MapOutput;
  file: SourceFile;
}

/** Map a sheet and compare it with the bible (IM-1, IM-3, IM-7). Writes nothing. */
export function planSheet(
  open: OpenBible,
  sheet: ParsedSheet,
  file: SourceFile,
  mapping: Mapping,
): SheetPlan {
  const ctx = contextFor(open, file);
  const output = mapSheet(sheet, mapping, ctx);
  const set = planChanges({
    mapping,
    output,
    file,
    existing: ctx.entries,
    sources: (id) => open.repo.sourceRecords(id),
    list: (id) => open.model.get('lists', id) as never,
    section: ctx.section,
  });
  return { set, output, file };
}

/** The ID of the custom section that holds general notes, or a new one to make at apply time. */
export function notesSection(open: OpenBible): { id: string; create: boolean } {
  const found = live(open.model.all('customSections')).find((s) => s.name === 'Notes');
  return found ? { id: found._id, create: false } : { id: newId(), create: true };
}

export interface DocumentPlan {
  set: ChangeSet;
  file: SourceFile;
  /** A custom section to create first, for a general note. */
  createSection: { id: string; name: string } | null;
}

/** Plan importing a Word document into one entry (IM-4, IM-3). Writes nothing. */
export function planDocumentImport(
  open: OpenBible,
  doc: Pick<ParsedDocument, 'fileName' | 'modifiedAt' | 'blocks'>,
  target: DocumentTarget,
  blocksOverride?: DocBlock[],
  noteSectionId?: { id: string; create: boolean },
): DocumentPlan {
  const blocks = blocksOverride ?? doc.blocks;
  const file = { fileName: doc.fileName, modifiedAt: doc.modifiedAt };
  const ctx = contextFor(open, file);
  const sectionInfo = target.kind === 'note' ? (noteSectionId ?? notesSection(open)) : null;
  const sectionId = sectionInfo?.id;
  const finalTarget = target.kind === 'note' && sectionId ? { ...target, sectionId } : target;
  const set = planDocument({
    file,
    body: blocksToBody(blocks),
    span: spanOf(blocks),
    target: finalTarget as DocumentTarget,
    entries: (c: EntryCollection) => ctx.entries(c),
    sources: (id) => open.repo.sourceRecords(id),
    section: (id) => (id === sectionId && sectionInfo?.create ? { fields: [] } : ctx.section(id)),
    newId: ctx.newId,
  });
  return {
    set,
    file,
    createSection: sectionInfo?.create && sectionId ? { id: sectionId, name: 'Notes' } : null,
  };
}

export interface ApplyResult {
  created: number;
  updated: number;
  unchanged: number;
  questions: number;
  failed: ChangeSet['failed'];
}

/**
 * Write the approved items of a change set through the one write path (ED-7).
 * `repo.applyImport` takes the snapshot first (BK-1) and writes everything in
 * one transaction.
 */
export async function applyPlan(
  open: OpenBible,
  set: ChangeSet,
  file: SourceFile,
  approved: ReadonlySet<string> | 'all',
  createSection: DocumentPlan['createSection'] = null,
): Promise<ApplyResult> {
  const items: ChangeItem[] = set.items.filter((i) => approved === 'all' || approved.has(i.id));
  // New list choices (a category, a community) come with the first approved new entry.
  const listAdds = items.some((i) => i.kind === 'new') ? set.listAdds : [];
  if (createSection && items.length) {
    await open.repo.create('customSections', {
      _id: createSection.id,
      name: createSection.name,
      fields: [],
      briefRule: 'never',
    } as never);
  }
  const done = items.length
    ? await open.repo.applyImport({ file, items, listAdds })
    : { created: 0, updated: 0, questions: 0 };
  return { ...done, unchanged: set.unchanged, failed: set.failed };
}

/** The change set as the page shows it: values as text, no entry data. */
export function planView(open: OpenBible, planId: string, fileName: string, set: ChangeSet) {
  const text = (v: unknown) => shownValue(v);
  return {
    planId,
    file: fileName,
    created: set.items.filter((i) => i.kind === 'new').length,
    changed: set.items.filter((i) => i.kind === 'changed').length,
    unchanged: set.unchanged,
    conflicts: set.items.reduce((n, i) => n + i.deltas.filter((d) => d.conflict).length, 0),
    listAdds: set.listAdds.map((a) => `${a.label} (${a.listId})`),
    failed: set.failed,
    notes: set.notes,
    items: set.items.map((i) => ({
      id: i.id,
      kind: i.kind,
      collection: i.collection,
      title: i.title || entryTitle(i.data ?? {}),
      ref: i.ref,
      ...(i.note ? { note: i.note } : {}),
      deltas: i.deltas.map((d) => ({
        path: d.path,
        label: d.label,
        before: text(d.before),
        after: text(d.after),
        outcome: d.outcome,
        ...(d.conflict
          ? {
              conflict: {
                winner: d.conflict.winner,
                claims: d.conflict.claims.map((c) => ({
                  ref: c.ref,
                  at: c.at,
                  value: text(c.value),
                  kept: c.kept,
                })),
              },
            }
          : {}),
      })),
    })),
  };
}
