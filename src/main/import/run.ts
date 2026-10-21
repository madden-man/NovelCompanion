import { monotonicFactory } from 'ulid';
import {
  blocksToBody,
  itemNeeds,
  mapSheet,
  planChanges,
  planDocument,
  referencedListAdds,
  shownValue,
  spanOf,
  withDependencies,
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
import type { EntryCollection } from '../../shared/schema';
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
    trashed: (c) => open.model.all(c).filter((d) => d.deletedAt),
    list: (id) => open.model.get('lists', id) as never,
  });
  return { set, output, file };
}

export interface DocumentPlan {
  set: ChangeSet;
  file: SourceFile;
}

/** Plan importing a Word document into one entry (IM-4, IM-3). Writes nothing. */
export function planDocumentImport(
  open: OpenBible,
  doc: Pick<ParsedDocument, 'fileName' | 'modifiedAt' | 'blocks'>,
  target: DocumentTarget,
  blocksOverride?: DocBlock[],
): DocumentPlan {
  const blocks = blocksOverride ?? doc.blocks;
  const file = { fileName: doc.fileName, modifiedAt: doc.modifiedAt };
  const ctx = contextFor(open, file);
  const set = planDocument({
    file,
    body: blocksToBody(blocks),
    span: spanOf(blocks),
    target,
    entries: (c: EntryCollection) => ctx.entries(c),
    sources: (id) => open.repo.sourceRecords(id),
    newId: ctx.newId,
  });
  return { set, file };
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
): Promise<ApplyResult> {
  // An approved item brings along the new items it points at (a part, a book, a character stub), so no link dangles.
  const { ids } = approved === 'all' ? { ids: null } : withDependencies(set.items, approved);
  const items: ChangeItem[] = set.items.filter((i) => ids === null || ids.has(i.id));
  // List choices (a category, a community) come with the approved items that point at them.
  const listAdds =
    items.length === set.items.length ? set.listAdds : referencedListAdds(items, set.listAdds);
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
      needs: itemNeeds(i, set.items),
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
