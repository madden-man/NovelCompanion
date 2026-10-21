import { itemPath, newItemId } from '../lists';
import type { Doc } from '../paths';
import { isPlainObject } from '../paths';
import { buildEntry } from './build';
import { cellRef } from './source';
import { normalizeIdentity, ordinalKey } from './table';
import { mapChapterGrid, mapMomentGrid } from './gridEntries';
import type { GridMapping, ListAdd, MapContext, MapOutput, ParsedSheet } from './types';
import { cellText, isBlank, labelRegex, parseYearHeader } from './values';

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
export function mergedSlave(sheet: ParsedSheet, row: number, column: number): boolean {
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

/** Words in a row label that name a region, and the region they name. */
const REGION_WORDS: [RegExp, string][] = [
  [/\b(US|USA|U\.S\.)(?![a-z])/, 'United States'],
  // "American" is the United States, but not in Latin, South, Central, or North American.
  [/(?<!\b(Latin|South|Central|North|Native)\s+)\bAmericans?\b/i, 'United States'],
  [/(?<!\b(Latin|South|Central|North)\s+)\bAmerica\b/i, 'United States'],
  [/\bChin(a|ese)\b/i, 'China'],
  [/\bEurope(an)?\b/i, 'Europe'],
  [/\bEU\b/, 'Europe'],
  // The Indian Ocean is not India.
  [/\bIndia(n)?\b(?!\s+Ocean)/i, 'India'],
  [/\bJapan(ese)?\b/i, 'Japan'],
  [/\bRussia(n)?\b/i, 'Russia'],
  [/\bMexic(o|an)\b/i, 'Mexico'],
  [/\bTaiwan(ese)?\b/i, 'Taiwan'],
  [/\bAfrica(n)?\b/i, 'Africa'],
];

/**
 * The regions a row label names, in the order they appear: "US: Oil" is the
 * United States, "US/China Tension" is both, "Chinese Leadership" is China.
 * A label that names none gives none.
 */
export function regionsOfLabel(label: string): string[] {
  const found: { at: number; region: string }[] = [];
  for (const [re, region] of REGION_WORDS) {
    const m = re.exec(label);
    if (m && !found.some((f) => f.region === region)) found.push({ at: m.index, region });
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.region);
}

/** The rows a grid mapping reads: from its start label down to just above its end label. */
export function gridRowRange(
  sheet: ParsedSheet,
  mapping: GridMapping,
  first: number,
  notes: string[],
): { startAt: number; endAt: number } {
  const startAt = startRow(sheet, mapping, first, notes);
  let endAt = Number.POSITIVE_INFINITY;
  if (mapping.endLabel) {
    const re = labelRegex(mapping.endLabel);
    if (!re) {
      notes.push(
        `The end label "${mapping.endLabel}" is not a valid pattern, so no rows were skipped for it.`,
      );
    } else {
      for (let r = Math.max(first, startAt); r < sheet.cells.length; r++) {
        if (re.test(cellText(sheet.cells[r]?.[mapping.labelColumn]).trim())) {
          endAt = r + 1;
          break;
        }
      }
    }
  }
  return { startAt, endAt };
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
  if (mapping.target.collection === 'moments') return mapMomentGrid(sheet, mapping, ctx);
  if (mapping.target.collection === 'chapters') return mapChapterGrid(sheet, mapping, ctx);
  const out: MapOutput = { rows: [], listAdds: [], stubs: [], notes: [] };
  if (mapping.target.collection !== 'worldEvents') {
    out.notes.push('A grid sheet fills world events, moments, or chapters.');
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
  const isHeading = headingTest(sheet, mapping);
  const skipPatterns = (mapping.skipLabels ?? []).flatMap((p) => labelRegex(p) ?? []);
  const { startAt, endAt } = gridRowRange(sheet, mapping, header.row, out.notes);
  const skipped: { row: number; label: string; cells: number }[] = [];
  for (let r = header.row; r < sheet.cells.length; r++) {
    const row = r + 1;
    const cells = sheet.cells[r] ?? [];
    const label = cellText(cells[mapping.labelColumn]);
    const filled = header.columns.filter(
      (y) => !isBlank(cells[y.column]) && !mergedSlave(sheet, row, y.column + 1),
    );
    // Rows above the start row, and rows the mapping skips, make nothing and are reported (IM-2).
    if (
      row < startAt ||
      row >= endAt ||
      (label && skipPatterns.some((re) => re.test(label.trim())))
    ) {
      if (label || filled.length) skipped.push({ row, label, cells: filled.length });
      continue;
    }
    if (filled.length === 0) {
      if (label && isHeading(row, label)) heading = label;
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
      if (mapping.regionsFromLabels) {
        const regions = regionsOfLabel(label);
        if (regions.length) fields.regions = regions;
      }
      const built = buildEntry({
        target: mapping.target,
        fields,
        fixed: mapping.fixed,
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
  if (skipped.length) out.notes.push(skipNote(skipped));
  return out;
}

/** The row where entries start: the first row whose label matches `startLabel`, or the row below the years. */
function startRow(
  sheet: ParsedSheet,
  mapping: GridMapping,
  first: number,
  notes: string[],
): number {
  const re = labelRegex(mapping.startLabel);
  if (!mapping.startLabel) return 0;
  if (!re) {
    notes.push(
      `The start label "${mapping.startLabel}" is not a valid pattern, so no rows were skipped.`,
    );
    return 0;
  }
  for (let r = first; r < sheet.cells.length; r++) {
    if (re.test(cellText(sheet.cells[r]?.[mapping.labelColumn]).trim())) return r + 1;
  }
  notes.push(
    `No row matches the start label "${mapping.startLabel}", so no rows were skipped for it.`,
  );
  return 0;
}

/** Whether a row with a label and no cells is a heading, by the mapping's rule. */
function headingTest(
  sheet: ParsedSheet,
  mapping: GridMapping,
): (row: number, label: string) => boolean {
  const by = mapping.headingBy ?? 'style';
  if (by === 'any') return () => true;
  if (by === 'rows') {
    const rows = new Set(mapping.headingRows ?? []);
    return (row) => rows.has(row);
  }
  if (by === 'pattern') {
    const re = labelRegex(mapping.headingPattern);
    return (_row, label) => re?.test(label.trim()) ?? false;
  }
  const bold = new Set(sheet.boldRows ?? []);
  return (row) => bold.has(row);
}

export function skipNote(skipped: { row: number; label: string; cells: number }[]): string {
  const cells = skipped.reduce((n, s) => n + s.cells, 0);
  const labels = skipped
    .filter((s) => s.label)
    .slice(0, 6)
    .map((s) => s.label);
  const more = skipped.filter((s) => s.label).length - labels.length;
  const rows = skipped.map((s) => s.row);
  return `Skipped ${skipped.length} ${skipped.length === 1 ? 'row' : 'rows'} (rows ${Math.min(...rows)} to ${Math.max(...rows)}) with ${cells} filled ${cells === 1 ? 'cell' : 'cells'} because they are chapters, parts, characters, or other rows the mapping leaves out: ${labels.join('; ')}${more > 0 ? `; and ${more} more` : ''}.`;
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
  view: (doc: Doc) => Doc = (d) => d,
): Map<string, Doc> {
  const counts = new Map<string, number>();
  const out = new Map<string, Doc>();
  for (const d of [...docs].sort((a, b) => String(a._id).localeCompare(String(b._id)))) {
    const seen = view(d);
    const start = isPlainObject(seen.start) ? seen.start.year : undefined;
    if (typeof start !== 'number' || !list || typeof seen.categoryId !== 'string') continue;
    const path = itemPath(list, seen.categoryId).split(' > ');
    out.set(ordinalKey(counts, gridKey(path, start)), d);
  }
  return out;
}
