import { importableFields } from './fields';
import type { ImportField } from './fields';
import { findYearHeader } from './grid';
import type { GridMapping, Mapping, ParsedSheet, TableMapping, Target } from './types';
import { cellText, isBlank } from './values';

const squash = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/** Header words that mean a field, beyond the field's own label. */
const SYNONYMS: Record<string, string[]> = {
  title: ['name', 'title', 'event', 'entry'],
  'names.full': ['fullname', 'name'],
  'names.chinese': ['chinesename', 'chinese', 'characters', 'hanzi'],
  birth: ['born', 'birth', 'birthday', 'birthdate', 'dateofbirth'],
  death: ['died', 'death', 'dateofdeath'],
  familyIds: ['family', 'families'],
  sourceNote: ['notes', 'note', 'source'],
  body: ['body', 'text', 'details', 'description', 'summary'],
  year: ['year', 'storyyear', 'when'],
  'strand.startYear': ['year', 'storyyear', 'when'],
  characterId: ['pov', 'pointofview', 'narrator', 'character'],
  'strand.povCharacterId': ['pov', 'pointofview', 'narrator'],
  worldContext: ['worldcontext', 'world', 'context', 'background'],
  startYear: ['start', 'from', 'startyear'],
  endYear: ['end', 'to', 'endyear'],
  status: ['status'],
  tags: ['tags', 'tag'],
};

/** The sections a grid sheet can fill (A12, SM-12). */
export const GRID_TARGETS = ['worldEvents', 'moments', 'chapters'] as const;

/** Does this sheet read as a grid (years across the top) or a table? */
export function guessShape(sheet: ParsedSheet): 'table' | 'grid' {
  const probe: GridMapping = {
    shape: 'grid',
    sheet: sheet.name,
    target: { collection: 'worldEvents' },
    headerRow: null,
    labelColumn: 0,
    yearOffset: 0,
    categoryRoot: null,
    categoryList: 'eventCategories',
    fixed: {},
    addMissingListItems: true,
    createMissing: false,
    matchIn: 'sheet',
  };
  // A table has words for headers; a grid has years. Three or more year headers make a grid.
  const header = findYearHeader(sheet, probe);
  return header && header.columns.length >= 3 && header.row <= 3 ? 'grid' : 'table';
}

/** The first row with anything in it, 1-based. */
export function guessHeaderRow(sheet: ParsedSheet): number {
  const i = sheet.cells.findIndex((row) => row.some((c) => !isBlank(c)));
  return i < 0 ? 1 : i + 1;
}

function bestField(header: string, fields: ImportField[], taken: Set<string>): ImportField | null {
  const h = squash(header);
  if (!h) return null;
  const free = fields.filter((f) => !taken.has(f.path));
  const exact = free.find(
    (f) =>
      squash(f.label) === h || squash(f.path) === h || squash(f.path.split('.').pop() ?? '') === h,
  );
  if (exact) return exact;
  return free.find((f) => (SYNONYMS[f.path] ?? []).some((w) => squash(w) === h)) ?? null;
}

/** A starting mapping for a sheet: columns matched to fields by header, ready to edit (IM-1). */
export function guessMapping(
  sheet: ParsedSheet,
  shape: 'table' | 'grid',
  target: Target,
  status: 'canon' | 'planned' | 'idea' = 'planned',
): Mapping {
  const base = {
    sheet: sheet.name,
    target,
    fixed: { status } as Record<string, unknown>,
    addMissingListItems: false,
    createMissing: false,
    matchIn: 'sheet' as const,
  };
  if (shape === 'grid') {
    // A grid fills world events (row labels are categories), moments (row labels are people), or chapters.
    const collection = (GRID_TARGETS as readonly string[]).includes(target.collection)
      ? target.collection
      : 'worldEvents';
    return {
      shape: 'grid',
      ...base,
      target: { collection },
      headerRow: null,
      labelColumn: 0,
      yearOffset: 0,
      categoryRoot: null,
      categoryList: 'eventCategories',
      // Bold rows are headings when the sheet has any; otherwise every label-only row is.
      headingBy: (sheet.boldRows?.length ?? 0) > 0 ? ('style' as const) : ('any' as const),
      addMissingListItems: true,
    } satisfies GridMapping;
  }
  const headerRow = guessHeaderRow(sheet);
  const fields = importableFields(target);
  const taken = new Set<string>();
  const columns: TableMapping['columns'] = [];
  (sheet.cells[headerRow - 1] ?? []).forEach((c, index) => {
    const header = cellText(c);
    const hit = bestField(header, fields, taken);
    if (hit) {
      taken.add(hit.path);
      columns.push({ header, index, field: hit.path });
    }
  });
  return {
    shape: 'table',
    ...base,
    headerRow,
    columns,
    identity: [],
    headings: [],
  } satisfies TableMapping;
}
