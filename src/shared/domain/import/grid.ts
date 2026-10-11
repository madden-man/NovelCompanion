import { itemPath, newItemId } from '../lists';
import type { Doc } from '../paths';
import { isPlainObject } from '../paths';
import { buildEntry } from './build';
import { cellRef } from './source';
import { normalizeIdentity, ordinalKey } from './table';
import type { GridMapping, ListAdd, MapContext, MapOutput, ParsedSheet } from './types';
import { cellText, isBlank, parseYearHeader } from './values';

const TITLE_LENGTH = 120;

/** The first line of a cell as a title, cut at a word when it is long. */
export function titleFromText(text: string): string {
  const line = (text.split(/\r?\n/)[0] ?? '').trim();
  if (line.length <= TITLE_LENGTH) return line;
  const cut = line.slice(0, TITLE_LENGTH - 3);
  const space = cut.lastIndexOf(' ');
  return `${(space > 40 ? cut.slice(0, space) : cut).trimEnd()}...`;
}

interface YearColumn {
  column: number;
  start: number;
  end: number | null;
}

/** Cells covered by a merge but not its top left cell repeat the master and are not entries. */
function mergedSlave(sheet: ParsedSheet, row: number, column: number): boolean {
  return sheet.merges.some(
    (m) =>
      row >= m.top &&
      row <= m.bottom &&
      column >= m.left &&
      column <= m.right &&
      !(row === m.top && column === m.left),
  );
}

export function findYearHeader(
  sheet: ParsedSheet,
  mapping: GridMapping,
): { row: number; columns: YearColumn[] } | null {
  const rowsToTry = mapping.headerRow ? [mapping.headerRow - 1] : sheet.cells.map((_, i) => i);
  for (const r of rowsToTry) {
    const cells = sheet.cells[r];
    if (!cells) continue;
    const columns: YearColumn[] = [];
    cells.forEach((c, i) => {
      if (i === mapping.labelColumn) return;
      const parsed = parseYearHeader(c);
      if (parsed) {
        columns.push({
          column: i,
          start: parsed.start + mapping.yearOffset,
          end: parsed.end === null ? null : parsed.end + mapping.yearOffset,
        });
      }
    });
    if (columns.length >= (mapping.headerRow ? 1 : 2)) return { row: r + 1, columns };
  }
  return null;
}

/** The category path of a grid entry: the heading above, then the row label. */
export function categoryPath(mapping: GridMapping, heading: string, label: string): string[] {
  return [mapping.categoryRoot ?? '', heading, label].map((s) => s.trim()).filter(Boolean);
}

/**
 * Map a grid sheet (IM-1, A12): rows are labels, columns are years, and every
 * non-empty cell is one entry dated by its column and filed under its row
 * label and the nearest heading row above it.
 */
export function mapGrid(sheet: ParsedSheet, mapping: GridMapping, ctx: MapContext): MapOutput {
  const out: MapOutput = { rows: [], listAdds: [], stubs: [], notes: [] };
  if (mapping.target.collection !== 'worldEvents') {
    out.notes.push('A grid sheet fills world events.');
    return out;
  }
  const header = findYearHeader(sheet, mapping);
  if (!header) {
    out.notes.push(`The sheet ${sheet.name} has no row of years to use as column headers.`);
    return out;
  }
  const base = ctx.list(mapping.categoryList);
  const draft = {
    _id: mapping.categoryList,
    label: mapping.categoryList,
    items: (base?.items ?? []).map((i) => ({ ...i })),
  };
  const listAdds: ListAdd[] = [];
  const categoryId = (path: string[]): string => {
    let parent: string | null = null;
    let id = '';
    for (const label of path) {
      const hit = draft.items.find(
        (i) => i.parentId === parent && i.label.toLowerCase() === label.toLowerCase(),
      );
      if (hit) {
        id = hit.id;
      } else {
        id = newItemId(draft, label);
        draft.items.push({ id, label, parentId: parent });
        listAdds.push({ listId: mapping.categoryList, id, label, parentId: parent });
      }
      parent = id;
    }
    return id;
  };
  const counts = new Map<string, number>();
  let heading = '';
  let ordinal = 0;
  for (let r = header.row; r < sheet.cells.length; r++) {
    const row = r + 1;
    const cells = sheet.cells[r] ?? [];
    const label = cellText(cells[mapping.labelColumn]);
    const filled = header.columns.filter(
      (y) => !isBlank(cells[y.column]) && !mergedSlave(sheet, row, y.column + 1),
    );
    if (filled.length === 0) {
      if (label) heading = label;
      continue;
    }
    for (const y of filled) {
      ordinal += 1;
      const ref = cellRef(ctx.file.fileName, sheet.name, row, y.column + 1);
      const where = `${sheet.name} ${ref.slice(ref.lastIndexOf('!') + 1)}`;
      const text = cellText(cells[y.column]);
      const path = categoryPath(mapping, heading, label);
      const id = ctx.newId();
      const fail = (reason: string) =>
        out.rows.push({
          ref,
          where,
          ok: false,
          reason,
          collection: 'worldEvents',
          newId: id,
          fields: {},
          data: {},
          identity: '',
          kind: 'entry',
        });
      if (path.length === 0) {
        fail('There is no row label or heading to file this under');
        continue;
      }
      const title = titleFromText(text);
      const fields: Record<string, unknown> = {
        title,
        body: title === text ? '' : text,
        start: { year: y.start },
        categoryId: categoryId(path),
      };
      // A cell merged across year columns is an event that lasts until the last of them.
      const span = sheet.merges.find(
        (m) => m.top === row && m.left === y.column + 1 && m.right > m.left,
      );
      const last = span ? header.columns.find((c) => c.column === span.right - 1) : undefined;
      const endYear = last ? (last.end ?? last.start) : y.end;
      if (endYear !== null && endYear !== y.start) fields.end = { year: endYear };
      const built = buildEntry({
        target: mapping.target,
        fields,
        fixed: { reality: 'invented', ...mapping.fixed },
        newId: id,
        ref,
        ordinal,
      });
      if (!built.ok) {
        fail(built.reason);
        continue;
      }
      const key = ordinalKey(counts, gridKey(path, y.start));
      out.rows.push({
        ref,
        where,
        ok: true,
        collection: 'worldEvents',
        newId: id,
        fields,
        data: built.data,
        identity: key,
        kind: 'entry',
      });
    }
  }
  out.listAdds = listAdds;
  return out;
}

export function gridKey(path: string[], year: number): string {
  return `${path.map(normalizeIdentity).join(' > ')}@${year}`;
}

/** The identity of a world event already in the bible, built the way a grid cell's is. */
export function existingGridIdentities(
  docs: Doc[],
  list:
    | {
        _id: string;
        label: string;
        items: { id: string; label: string; parentId: string | null }[];
      }
    | undefined,
): Map<string, Doc> {
  const counts = new Map<string, number>();
  const out = new Map<string, Doc>();
  for (const d of [...docs].sort((a, b) => String(a._id).localeCompare(String(b._id)))) {
    const start = isPlainObject(d.start) ? d.start.year : undefined;
    if (typeof start !== 'number' || !list || typeof d.categoryId !== 'string') continue;
    const path = itemPath(list, d.categoryId).split(' > ');
    out.set(ordinalKey(counts, gridKey(path, start)), d);
  }
  return out;
}
