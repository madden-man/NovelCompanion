import { join } from 'node:path';
import { ulid } from 'ulid';
import { planChanges, mapSheet } from '../../src/shared/domain/import';
import type {
  ChangeSet,
  MapContext,
  Mapping,
  ParsedWorkbook,
  SourceFile,
  SourceRecord,
} from '../../src/shared/domain/import';
import { parseWorkbookFile } from '../../src/main/import/xlsx';
import type { EntryCollection } from '../../src/shared/schema';
import { readFixture } from './loadFixture';

export const FIXTURE_WORKBOOK = join(
  import.meta.dirname,
  '../../fixtures/files/fixture-workbook.xlsx',
);

type Doc = { _id: string } & Record<string, unknown>;

export async function fixtureWorkbook(): Promise<ParsedWorkbook> {
  return parseWorkbookFile(FIXTURE_WORKBOOK);
}

/**
 * A tiny stand-in for a bible, for pure tests of the mapping engine: entries,
 * lists, and source records in memory. The real write path is exercised in the
 * integration tests.
 */
export class SimBible {
  docs = new Map<string, Doc[]>();
  lists = new Map<
    string,
    { _id: string; label: string; items: { id: string; label: string; parentId: string | null }[] }
  >();
  sources = new Map<string, SourceRecord[]>();
  private n = 0;

  static fromFixture(): SimBible {
    const sim = new SimBible();
    const fx = readFixture();
    for (const l of fx.lists ?? []) sim.lists.set(l._id, l as never);
    return sim;
  }

  static empty(): SimBible {
    const sim = new SimBible();
    sim.lists.set('eventCategories', {
      _id: 'eventCategories',
      label: 'Event categories',
      items: [],
    });
    return sim;
  }

  newId = (): string => `N${String(++this.n).padStart(4, '0')}`;

  entries = (c: EntryCollection): Doc[] => (this.docs.get(c) ?? []).filter((d) => !d.deletedAt);

  ctx(file: SourceFile): MapContext {
    return {
      file,
      newId: this.newId,
      list: (id) => this.lists.get(id),
      entries: this.entries,
    };
  }

  plan(
    wb: ParsedWorkbook,
    mapping: Mapping,
    file: SourceFile = { fileName: wb.fileName, modifiedAt: '2026-01-15T09:00:00.000Z' },
  ): { set: ChangeSet; rows: ReturnType<typeof mapSheet> } {
    const sheet = wb.sheets.find((s) => s.name === mapping.sheet)!;
    const rows = mapSheet(sheet, mapping, this.ctx(file));
    const set = planChanges({
      mapping,
      output: rows,
      file,
      existing: this.entries,
      sources: (id) => this.sources.get(id) ?? [],
      list: (id) => this.lists.get(id),
    });
    return { set, rows };
  }

  /** Write approved items the way the importer does: entries, list items, and source records. */
  apply(set: ChangeSet, approved?: string[]): void {
    for (const add of set.listAdds) {
      const list = this.lists.get(add.listId)!;
      if (!list.items.some((i) => i.id === add.id)) {
        list.items.push({ id: add.id, label: add.label, parentId: add.parentId });
      }
    }
    for (const item of set.items) {
      if (approved && !approved.includes(item.id)) continue;
      const list = this.docs.get(item.collection) ?? [];
      this.docs.set(item.collection, list);
      if (item.kind === 'new') {
        list.push({ ...(item.data as Doc), _id: item.entryId });
      } else {
        const doc = list.find((d) => d._id === item.entryId)!;
        Object.assign(doc, item.patch);
      }
      const prior = this.sources.get(item.entryId) ?? [];
      const merged = [...prior];
      for (const r of item.records) {
        const at = merged.findIndex((x) => x.path === r.path);
        if (at >= 0) merged[at] = r;
        else merged.push(r);
      }
      this.sources.set(item.entryId, merged);
    }
  }
}

export const newUlid = (): string => ulid();
