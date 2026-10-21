import { splitNumberedTitle } from '../numbering';
import { buildEntry } from './build';
import { importableFields } from './fields';
import { findYearHeader, gridRowRange, mergedSlave, skipNote, titleFromText } from './grid';
import { nameResolver } from './names';
import { cellRef } from './source';
import { identityKey, identityTitle, normalizeIdentity, ordinalKey } from './table';
import type { GridMapping, MapContext, MapOutput, MappedRow, ParsedSheet } from './types';
import { cellText, isBlank, labelRegex } from './values';

type YearColumn = NonNullable<ReturnType<typeof findYearHeader>>['columns'][number];

const emptyOutput = (): MapOutput => ({ rows: [], listAdds: [], stubs: [], notes: [] });

/** The year a cell merged across year columns lasts until, or null for a single year. */
function endYearOf(
  sheet: ParsedSheet,
  row: number,
  y: YearColumn,
  columns: YearColumn[],
): number | null {
  const span = sheet.merges.find(
    (m) => m.top === row && m.left === y.column + 1 && m.right > m.left,
  );
  const last = span ? columns.find((c) => c.column === span.right - 1) : undefined;
  const end = last ? (last.end ?? last.start) : y.end;
  return end !== null && end !== y.start ? end : null;
}

/** The short cell name in a report: "High Level C12". */
function placeOf(sheetName: string, ref: string): string {
  return `${sheetName} ${ref.slice(ref.lastIndexOf('!') + 1)}`;
}

function failedRow(
  base: Pick<MappedRow, 'ref' | 'where' | 'collection' | 'newId'>,
  reason: string,
): MappedRow {
  return { ...base, ok: false, reason, fields: {}, data: {}, identity: '', kind: 'entry' };
}

/**
 * A grid of people by year (SM-12, A12): the row label names a character and
 * every filled cell is one moment in their life at its column's year, with the
 * cell's first line as what happens. Label rows with no cells (a family
 * heading) make nothing. A name that matches no one fails the cell unless the
 * mapping makes stubs (IM-2).
 */
export function mapMomentGrid(
  sheet: ParsedSheet,
  mapping: GridMapping,
  ctx: MapContext,
): MapOutput {
  const out = emptyOutput();
  const header = findYearHeader(sheet, mapping);
  if (!header) {
    out.notes.push(`The sheet ${sheet.name} has no row of years to use as column headers.`);
    return out;
  }
  const { startAt, endAt } = gridRowRange(sheet, mapping, header.row, out.notes);
  const skipPatterns = (mapping.skipLabels ?? []).flatMap((p) => labelRegex(p) ?? []);
  const spec = importableFields({ collection: 'moments' }).find(
    (f) => f.path === 'characterId',
  )?.spec;
  let ref = '';
  let where = '';
  const resolver = nameResolver(ctx, {
    createMissing: mapping.createMissing,
    ref: () => ref,
    where: () => where,
    hints: mapping.nameHints ?? [],
  });
  const counts = new Map<string, number>();
  const skipped: { row: number; label: string; cells: number }[] = [];
  let ordinal = 0;
  for (let r = header.row; r < sheet.cells.length && r + 1 < endAt; r++) {
    const row = r + 1;
    const cells = sheet.cells[r] ?? [];
    const label = cellText(cells[mapping.labelColumn]);
    const filled = header.columns.filter(
      (y) => !isBlank(cells[y.column]) && !mergedSlave(sheet, row, y.column + 1),
    );
    if (row < startAt || (label && skipPatterns.some((re) => re.test(label.trim())))) {
      if (label || filled.length) skipped.push({ row, label, cells: filled.length });
      continue;
    }
    for (const y of filled) {
      ordinal += 1;
      ref = cellRef(ctx.file.fileName, sheet.name, row, y.column + 1);
      where = placeOf(sheet.name, ref);
      const id = ctx.newId();
      const base = { ref, where, collection: 'moments' as const, newId: id };
      const mark = resolver.mark();
      const fail = (reason: string) => {
        resolver.rollback(mark);
        out.rows.push(failedRow(base, reason));
      };
      if (!label || !spec) {
        fail('There is no row label to name the character');
        continue;
      }
      const who = resolver.resolve(spec, label);
      if (who === 'ambiguous') {
        fail(`More than one character is called "${label}"`);
        continue;
      }
      if (who === null) {
        fail(`No character is called "${label}"`);
        continue;
      }
      const text = cellText(cells[y.column]);
      const title = titleFromText(text);
      const fields: Record<string, unknown> = { characterId: who, year: y.start, title };
      if (title !== text) fields.body = text;
      const end = endYearOf(sheet, row, y, header.columns);
      if (end !== null) fields.endYear = end;
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
      out.rows.push({
        ...base,
        ok: true,
        fields,
        data: built.data,
        identity: ordinalKey(
          counts,
          identityKey({ characterId: who, title }, ['characterId', 'title'], 'moments'),
        ),
        kind: 'entry',
      });
    }
  }
  out.stubs = resolver.stubs;
  if (skipped.length) out.notes.push(skipNote(skipped));
  return out;
}

interface StrandSpan {
  label: string;
  start: number;
  end: number;
}

const BACKSTORY = /^backstory\b/i;

/**
 * A chapter's strands from its row (A29): each label written under the years
 * it spans. A strand labelled "Backstory: ..." is the backstory strand and the
 * other is the present (primary) one. When neither says so, the later span is
 * the present and the earlier one jumps back in story time, so it is labelled
 * backstory.
 */
export function chapterStrands(
  spans: StrandSpan[],
): { primary: StrandSpan; backstory: StrandSpan | null } | { problem: string } {
  if (spans.length === 0) return { problem: 'The row has no strand labels under its years' };
  if (spans.length > 2) {
    return {
      problem: `The row names ${spans.length} strands (${spans.map((s) => s.label).join('; ')}); a chapter row has a present strand and a backstory strand`,
    };
  }
  const [a, b] = [...spans].sort((x, y) => x.start - y.start || x.end - y.end);
  if (!a) return { problem: 'The row has no strand labels under its years' };
  if (!b) return { primary: a, backstory: null };
  const aBack = BACKSTORY.test(a.label);
  const bBack = BACKSTORY.test(b.label);
  if (aBack !== bBack) return aBack ? { primary: b, backstory: a } : { primary: a, backstory: b };
  return {
    primary: b,
    backstory: aBack ? a : { ...a, label: `Backstory: ${a.label}` },
  };
}

/**
 * The High Level sheet's chapter rows (A29, IM-1): a part row starts a part of
 * the book the mapping names, and every labelled row with cells below it is a
 * chapter whose strands are the labels written across the years they span. A
 * chapter's number lives in its reading order, so "Ch. 3: Mark Gets Drunk"
 * is "Mark Gets Drunk" (PL-3). Chapters are matched on re-import by their part
 * and title (IM-3).
 */
export function mapChapterGrid(
  sheet: ParsedSheet,
  mapping: GridMapping,
  ctx: MapContext,
): MapOutput {
  const out = emptyOutput();
  const header = findYearHeader(sheet, mapping);
  if (!header) {
    out.notes.push(`The sheet ${sheet.name} has no row of years to use as column headers.`);
    return out;
  }
  const { startAt, endAt } = gridRowRange(sheet, mapping, header.row, out.notes);
  const skipPatterns = (mapping.skipLabels ?? []).flatMap((p) => labelRegex(p) ?? []);
  const partRe = labelRegex(mapping.partLabel ?? '^Part\\b');
  const headingFixed = Object.fromEntries(
    Object.entries(mapping.fixed).filter(([k]) => k === 'status' || k === 'provenance'),
  );
  const file = ctx.file.fileName;
  let book: { id: string } | null = null;
  let part: { id: string; title: string } | null = null;
  let partNumber = 0;
  let inPart = 0;
  let ordinal = 0;
  const partCounts = new Map<string, number>();
  const counts = new Map<string, number>();
  const skipped: { row: number; label: string; cells: number }[] = [];

  /** The text under a year column, reading a merged cell's value from its top left cell. */
  const textAt = (r: number, column: number): string => {
    const own = cellText(sheet.cells[r]?.[column]);
    if (own) return own;
    const m = sheet.merges.find(
      (x) => r + 1 >= x.top && r + 1 <= x.bottom && column + 1 >= x.left && column + 1 <= x.right,
    );
    return m ? cellText(sheet.cells[m.top - 1]?.[m.left - 1]) : '';
  };

  const startBook = (ref: string, where: string): { id: string } | null => {
    const wanted = mapping.bookTitle ?? 'Book One';
    const split = splitNumberedTitle('book', wanted);
    const title = split?.name ? split.name : wanted;
    const fields = { title, number: split?.number ?? 1 };
    const id = ctx.newId();
    const built = buildEntry({
      target: { collection: 'books' },
      fields,
      fixed: headingFixed,
      newId: id,
      ref,
      ordinal: 1,
    });
    const base = {
      ref,
      where,
      collection: 'books' as const,
      newId: id,
      fields,
      identity: normalizeIdentity(identityTitle('books', title)),
      kind: 'heading' as const,
    };
    if (!built.ok) {
      out.rows.push({ ...base, ok: false, reason: built.reason, data: {} });
      return null;
    }
    out.rows.push({ ...base, ok: true, data: built.data });
    return { id };
  };

  for (let r = header.row; r < sheet.cells.length && r + 1 < endAt; r++) {
    const row = r + 1;
    const cells = sheet.cells[r] ?? [];
    const label = cellText(cells[mapping.labelColumn]);
    const years = header.columns
      .map((y) => ({ y, text: textAt(r, y.column) }))
      .filter((c) => c.text !== '');
    if (row < startAt || (label && skipPatterns.some((re) => re.test(label.trim())))) {
      if (label || years.length) skipped.push({ row, label, cells: years.length });
      continue;
    }
    if (!label) {
      if (years.length) skipped.push({ row, label, cells: years.length });
      continue;
    }
    const ref = cellRef(file, sheet.name, row, mapping.labelColumn + 1);
    const where = `${sheet.name} row ${row}`;

    if (years.length === 0) {
      if (!partRe?.test(label.trim())) {
        skipped.push({ row, label, cells: 0 });
        continue;
      }
      book ??= startBook(ref, where);
      if (!book) continue;
      partNumber += 1;
      inPart = 0;
      const split = splitNumberedTitle('part', label);
      let title = label;
      if (split && split.number === partNumber && split.name) title = split.name;
      else if (split) {
        out.notes.push(
          `${where}: "${label}" says part ${split.number} but is part ${partNumber} here, so its title is kept whole.`,
        );
      }
      const id = ctx.newId();
      const fields = { title, number: partNumber, bookId: book.id };
      const built = buildEntry({
        target: { collection: 'parts' },
        fields,
        fixed: headingFixed,
        newId: id,
        ref,
        ordinal: partNumber,
      });
      const base = {
        ref,
        where,
        collection: 'parts' as const,
        newId: id,
        fields,
        identity: ordinalKey(partCounts, normalizeIdentity(identityTitle('parts', title))),
        kind: 'heading' as const,
      };
      if (!built.ok) {
        out.rows.push({ ...base, ok: false, reason: built.reason, data: {} });
        part = null;
        continue;
      }
      out.rows.push({ ...base, ok: true, data: built.data });
      part = { id, title };
      continue;
    }

    ordinal += 1;
    inPart += 1;
    const id = ctx.newId();
    const fail = (reason: string) =>
      out.rows.push(failedRow({ ref, where, collection: 'chapters', newId: id }, reason));
    if (!part) {
      fail('There is no part row above this chapter');
      continue;
    }
    // Each label once, from the first year it is under to the last.
    const spans: StrandSpan[] = [];
    for (const { y, text } of years) {
      const end = y.end ?? y.start;
      const hit = spans.find((s) => s.label === text);
      if (hit) {
        hit.start = Math.min(hit.start, y.start);
        hit.end = Math.max(hit.end, end);
      } else spans.push({ label: text, start: y.start, end });
    }
    const strands = chapterStrands(spans);
    if ('problem' in strands) {
      fail(strands.problem);
      continue;
    }
    const split = splitNumberedTitle('chapter', label);
    const title = split?.name ? split.name : label;
    if (split && split.number !== inPart) {
      out.notes.push(
        `${where}: "${label}" says chapter ${split.number} but is chapter ${inPart} of its part; it is imported as "${title}" and its place comes from the sheet.`,
      );
    }
    const endOf = (s: StrandSpan) => (s.end !== s.start ? s.end : null);
    const fields: Record<string, unknown> = {
      title,
      partId: part.id,
      'strand.label': strands.primary.label,
      'strand.startYear': strands.primary.start,
      'strand.endYear': endOf(strands.primary),
    };
    if (strands.backstory) {
      fields['backstory.label'] = strands.backstory.label;
      fields['backstory.startYear'] = strands.backstory.start;
      fields['backstory.endYear'] = endOf(strands.backstory);
    }
    const built = buildEntry({
      target: { collection: 'chapters' },
      fields,
      fixed: mapping.fixed,
      newId: id,
      ref,
      ordinal: (mapping.orderFrom ?? 1) + ordinal - 1,
    });
    if (!built.ok) {
      fail(built.reason);
      continue;
    }
    out.rows.push({
      ref,
      where,
      ok: true,
      collection: 'chapters',
      newId: id,
      fields,
      data: built.data,
      identity: ordinalKey(counts, chapterIdentity(part.title, title)),
      kind: 'entry',
    });
  }
  if (skipped.length) out.notes.push(skipNote(skipped));
  return out;
}

/** A chapter's identity across imports: its part's bare title and its own (IM-3). */
export function chapterIdentity(partTitle: unknown, title: unknown): string {
  return identityKey(
    {
      partId: typeof partTitle === 'string' ? identityTitle('parts', partTitle) : '',
      title,
    },
    ['partId', 'title'],
    'chapters',
  );
}
