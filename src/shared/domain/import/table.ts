import { bareTitle, numberedKindOf, splitNumberedTitle } from '../numbering';
import type { Doc } from '../paths';
import { buildEntry } from './build';
import { importableFields, readField } from './fields';
import { nameResolver } from './names';
import { cellRef } from './source';
import type {
  ColumnAssignment,
  HeadingRule,
  ListAdd,
  MapContext,
  MapOutput,
  ParsedSheet,
  TableMapping,
} from './types';
import { cellText, coerceCell, isBlank, labelRegex } from './values';
import type { CoerceEnv } from './values';

/** The field paths that identify an entry when the mapping names none. */
export function identityPaths(mapping: TableMapping): string[] {
  if (mapping.identity.length) return mapping.identity;
  const assigned = mapping.columns.map((c) => c.field);
  for (const path of ['title', 'name', 'names.full', 'characters']) {
    if (assigned.includes(path)) return [path];
  }
  return ['title'];
}

const SEP = '␟';

/** An identity value compared without case, spacing, or number formatting differences. */
export function normalizeIdentity(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v).trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * The identity of a chapter, part, or book title is its bare name: "Ch. 3:
 * Mark Gets Drunk" and "Mark Gets Drunk" are the same chapter, so a title
 * cleaned of its number is still found on re-import (IM-3, PL-3).
 */
export function identityTitle(collection: string | undefined, title: unknown): unknown {
  const kind = collection ? numberedKindOf(collection) : null;
  return kind && typeof title === 'string' ? bareTitle(kind, title) : title;
}

export function identityKey(doc: Doc, paths: string[], collection?: string): string {
  return paths
    .map((p) => {
      const v = readField(doc, p);
      return normalizeIdentity(p === 'title' ? identityTitle(collection, v) : v);
    })
    .join(SEP);
}

/** Resolve each assignment to a column: by header when it is unique, otherwise by position. */
export function resolveColumns(headers: string[], columns: ColumnAssignment[]): number[] {
  return columns.map((a) => {
    const hits = headers.flatMap((h, i) => (h === a.header ? [i] : []));
    return hits.length === 1 ? (hits[0] ?? a.index) : a.index;
  });
}

export function sheetHeaders(sheet: ParsedSheet, headerRow: number): string[] {
  return (sheet.cells[headerRow - 1] ?? []).map((c) => cellText(c));
}

function ordinalKey(counts: Map<string, number>, key: string): string {
  const n = (counts.get(key) ?? 0) + 1;
  counts.set(key, n);
  return n > 1 ? `${key}#${n}` : key;
}

interface DistinctCell {
  column: number;
  text: string;
  /** How many columns a merge starting here spans to the right; 1 when not merged. */
  span: number;
}

/** The filled cells of a row, counting each merged range once. */
function distinctCells(sheet: ParsedSheet, row: number): DistinctCell[] {
  const cells = sheet.cells[row - 1] ?? [];
  const out: DistinctCell[] = [];
  cells.forEach((c, i) => {
    if (isBlank(c)) return;
    const merge = sheet.merges.find(
      (m) => row >= m.top && row <= m.bottom && i + 1 >= m.left && i + 1 <= m.right,
    );
    if (merge && !(merge.top === row && merge.left === i + 1)) return;
    out.push({ column: i, text: cellText(c), span: merge ? merge.right - merge.left + 1 : 1 });
  });
  return out;
}

function headingRuleFor(rules: HeadingRule[], cells: DistinctCell[]): number {
  const label = cells[0]?.text ?? '';
  return rules.findIndex((rule) => {
    // A label pattern decides on the label alone, however many cells are filled.
    if (rule.labelPattern) return labelRegex(rule.labelPattern)?.test(label.trim()) ?? false;
    return rule.match === 'single'
      ? cells.length === 1
      : cells.length === 2 && (cells[1]?.span ?? 0) >= 3;
  });
}

/** Map every row of a table sheet (IM-1): one entry per row, headings making parents. */
export function mapTable(sheet: ParsedSheet, mapping: TableMapping, ctx: MapContext): MapOutput {
  const out: MapOutput = { rows: [], listAdds: [], stubs: [], notes: [] };
  const fields = importableFields(mapping.target);
  const headers = sheetHeaders(sheet, mapping.headerRow);
  if (!sheet.cells[mapping.headerRow - 1]) {
    out.notes.push(`The sheet ${sheet.name} has no row ${mapping.headerRow} for headers.`);
    return out;
  }
  const indexes = resolveColumns(headers, mapping.columns);
  const assigned: { column: number; header: string; path: string }[] = [];
  mapping.columns.forEach((a, i) => {
    if (!fields.some((f) => f.path === a.field)) {
      out.notes.push(
        `${a.header || `Column ${a.index + 1}`} goes to ${a.field}, which this section does not have. It is ignored.`,
      );
      return;
    }
    assigned.push({ column: indexes[i] ?? a.index, header: a.header, path: a.field });
  });
  const idPaths = identityPaths(mapping);
  const identityColumn = assigned.find((a) => a.path === idPaths[0])?.column ?? 0;
  const listAdds: ListAdd[] = [];
  const counts = new Map<string, number>();
  const headingCounts: Map<string, number>[] = [];
  const numbers = new Map<string, number>();
  const groupCounts = new Map<string, number>();
  const current: { id: string }[] = [];
  let ordinal = 0;
  let where = '';
  let ref = '';
  const resolver = nameResolver(ctx, {
    createMissing: mapping.createMissing,
    ref: () => ref,
    where: () => where,
    hints: mapping.nameHints ?? [],
  });
  // A section another sheet plans (Book One under A29) is read for its numbering only: its rows are left out and reported.
  const skipPatterns = (mapping.skipSections ?? []).flatMap((p) => labelRegex(p) ?? []);
  /** The heading level a skipped section starts at, or -1 when rows are kept. */
  let skipFrom = -1;
  const skipped: { where: string; label: string }[] = [];
  const env: CoerceEnv = {
    ctx,
    addMissingListItems: mapping.addMissingListItems,
    createMissing: mapping.createMissing,
    listAdds,
    resolveName: (spec, name) => resolver.resolve(spec, name),
  };

  const startHeading = (level: number, title: string, text?: string) => {
    const rule = mapping.headings[level];
    if (!rule) return;
    if (skipFrom >= 0 && level <= skipFrom) skipFrom = -1;
    if (skipFrom < 0 && skipPatterns.some((re) => re.test(title.trim()))) skipFrom = level;
    const parent = current[level - 1] ?? null;
    const id = ctx.newId();
    const counterKey = `${level}:${parent?.id ?? ''}`;
    const number = (numbers.get(counterKey) ?? 0) + 1;
    numbers.set(counterKey, number);
    const kind = numberedKindOf(rule.collection);
    const split = kind ? splitNumberedTitle(kind, title) : null;
    if (split && kind) {
      // "Part One: Roots" is part 1 named "Roots": the number field holds the number (PL-3).
      if (split.number === number) {
        if (split.name) title = split.name;
      } else {
        out.notes.push(
          `${where}: "${title}" says ${kind} ${split.number} but is ${kind} ${number} here, so its title is kept whole.`,
        );
      }
    }
    const hFields: Record<string, unknown> = { title };
    if (rule.numberField) hFields[rule.numberField] = number;
    if (rule.textField && text !== undefined) hFields[rule.textField] = text;
    if (rule.parentLinkField && parent) hFields[rule.parentLinkField] = parent.id;
    const built = buildEntry({
      target: { collection: rule.collection },
      fields: hFields,
      fixed: { ...rule.fixed },
      newId: id,
      ref,
      ordinal: number,
    });
    const counts = headingCounts[level] ?? (headingCounts[level] = new Map());
    current.length = level;
    if (skipFrom >= 0) {
      // Counted, so the next book or part keeps its number, but nothing is made.
      current[level] = { id };
      skipped.push({ where, label: title });
      return;
    }
    const key = ordinalKey(counts, normalizeIdentity(identityTitle(rule.collection, title)));
    const base = {
      ref,
      where,
      collection: rule.collection,
      newId: id,
      fields: hFields,
      identity: key,
      kind: 'heading' as const,
    };
    if (!built.ok) {
      out.rows.push({ ...base, ok: false, reason: built.reason, data: {} });
      return;
    }
    out.rows.push({ ...base, ok: true, data: built.data });
    current[level] = { id };
  };

  for (let r = mapping.headerRow; r < sheet.cells.length; r++) {
    const row = r + 1;
    const cells = sheet.cells[r] ?? [];
    const filled = cells.map((c, i) => (isBlank(c) ? -1 : i)).filter((i) => i >= 0);
    if (filled.length === 0) continue;
    where = `${sheet.name} row ${row}`;
    const distinct = distinctCells(sheet, row);
    const level = headingRuleFor(mapping.headings, distinct);
    // A source location names the cell that identifies the row: the label of a heading, the identity column of an entry.
    ref = cellRef(
      ctx.file.fileName,
      sheet.name,
      row,
      (level >= 0 ? (distinct[0]?.column ?? 0) : identityColumn) + 1,
    );
    if (level >= 0) {
      startHeading(level, distinct[0]?.text ?? '', distinct[1]?.text);
      continue;
    }
    if (skipFrom >= 0) {
      skipped.push({ where, label: distinct[0]?.text ?? '' });
      continue;
    }
    // Rows under a book with no part get an implicit part to belong to.
    for (let l = current.length; l < mapping.headings.length; l++) {
      const rule = mapping.headings[l];
      if (!rule?.implicitTitle || (l > 0 && !current[l - 1])) break;
      startHeading(l, rule.implicitTitle);
    }

    const mark = resolver.mark();
    const values: Record<string, unknown> = {};
    const problems: string[] = [];
    for (const a of assigned) {
      const spec = fields.find((f) => f.path === a.path);
      if (!spec) continue;
      const result = coerceCell(spec.spec, cells[a.column], env);
      if (result.ok === true) values[a.path] = result.value;
      else if (result.ok === false) problems.push(`${spec.label}: ${result.reason}`);
    }
    ordinal += 1;
    const group = current[current.length - 1]?.id ?? '';
    const inGroup = (groupCounts.get(group) ?? 0) + 1;
    groupCounts.set(group, inGroup);
    if (mapping.target.collection === 'chapters' && typeof values.title === 'string') {
      // "Ch. 3: Mark Gets Drunk" is the third chapter named "Mark Gets Drunk": the reading order holds
      // the number (PL-3). A number that is neither the row's place in its part nor in the sheet is
      // not guessed at: the title is kept whole and the report says so.
      const split = splitNumberedTitle('chapter', values.title);
      if (split && (split.number === inGroup || split.number === ordinal)) {
        if (split.name) values.title = split.name;
      } else if (split) {
        out.notes.push(
          `${where}: "${values.title}" says chapter ${split.number} but is chapter ${inGroup} of its part and chapter ${ordinal} of the sheet, so its title is kept whole.`,
        );
      }
    }
    const id = ctx.newId();
    const failRow = (reason: string) => {
      resolver.rollback(mark);
      out.rows.push({
        ref,
        where,
        ok: false,
        reason,
        collection: mapping.target.collection,
        newId: id,
        fields: values,
        data: {},
        identity: '',
        kind: 'entry',
      });
    };
    if (problems.length) {
      failRow(problems.slice(0, 3).join('; '));
      continue;
    }
    // The row belongs to the deepest heading above it.
    for (let l = current.length - 1; l >= 0; l--) {
      const heading = current[l];
      const rule = mapping.headings[l];
      if (heading && rule) {
        values[rule.linkField] = heading.id;
        break;
      }
    }
    const built = buildEntry({
      target: mapping.target,
      fields: values,
      fixed: mapping.fixed,
      newId: id,
      ref,
      // A new chapter reads after the chapters a run already planned (see `orderFrom`).
      ordinal: (mapping.orderFrom ?? 1) + ordinal - 1,
    });
    if (!built.ok) {
      failRow(built.reason);
      continue;
    }
    const key = identityKey(built.data, idPaths, mapping.target.collection);
    if (key.replaceAll(SEP, '') === '') {
      failRow('There is no value to tell this row from the others');
      continue;
    }
    out.rows.push({
      ref,
      where,
      ok: true,
      collection: mapping.target.collection,
      newId: id,
      fields: values,
      data: built.data,
      identity: ordinalKey(counts, key),
      kind: 'entry',
    });
  }
  out.listAdds = listAdds;
  out.stubs = resolver.stubs;
  if (skipped.length) {
    const first = skipped[0];
    const last = skipped[skipped.length - 1];
    out.notes.push(
      `Left out ${skipped.length} ${skipped.length === 1 ? 'row' : 'rows'} (${first?.where} to ${last?.where}) because another sheet plans that section: ${skipped
        .slice(0, 4)
        .map((s) => s.label)
        .join('; ')}${skipped.length > 4 ? `; and ${skipped.length - 4} more` : ''}.`,
    );
  }
  return out;
}

/**
 * The identity of an entry already in the bible, counted the same way as a
 * sheet's rows. `view` lets the caller read each entry as the import last
 * left it (see `recordedView`), so a hand edit to an identity field does not
 * hide the entry from a re-import.
 */
export function existingIdentities(
  docs: Doc[],
  paths: string[],
  view: (doc: Doc) => Doc = (d) => d,
  collection?: string,
): Map<string, Doc> {
  const counts = new Map<string, number>();
  const out = new Map<string, Doc>();
  for (const d of [...docs].sort((a, b) => String(a._id).localeCompare(String(b._id)))) {
    const key = identityKey(view(d), paths, collection);
    if (key.replaceAll(SEP, '') === '') continue;
    out.set(ordinalKey(counts, key), d);
  }
  return out;
}

export { ordinalKey };
