import { z } from 'zod';
import { ENTRY_COLLECTIONS } from '../../schema';
import type { CustomSection, EntryCollection } from '../../schema';

/** One cell after parsing: text, a number, a flag, or empty. Dates arrive as ISO text. */
export const Cell = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export type Cell = z.infer<typeof Cell>;

export const MergeRange = z.strictObject({
  top: z.int().min(1),
  left: z.int().min(1),
  bottom: z.int().min(1),
  right: z.int().min(1),
});
export type MergeRange = z.infer<typeof MergeRange>;

/** A sheet as a rectangular grid of cells. Row and column numbers in the app are 1-based. */
export const ParsedSheet = z.strictObject({
  name: z.string(),
  /** `cells[r][c]` is row r+1, column c+1. Every row has the same length. */
  cells: z.array(z.array(Cell)),
  merges: z.array(MergeRange).default([]),
});
export type ParsedSheet = z.infer<typeof ParsedSheet>;

export const ParsedWorkbook = z.strictObject({
  fileName: z.string().min(1),
  /** When the file was last modified, as an ISO time. The newer source wins a conflict (IM-7). */
  modifiedAt: z.iso.datetime({ offset: true }),
  sheets: z.array(ParsedSheet),
});
export type ParsedWorkbook = z.infer<typeof ParsedWorkbook>;

export const SourceFile = z.strictObject({
  fileName: z.string().min(1),
  modifiedAt: z.iso.datetime({ offset: true }),
});
export type SourceFile = z.infer<typeof SourceFile>;

const CollectionEnum = z.enum(ENTRY_COLLECTIONS as [EntryCollection, ...EntryCollection[]]);

/** Where imported rows go: a section, and for custom entries the custom section. */
export const Target = z.strictObject({
  collection: CollectionEnum,
  sectionId: z.string().min(1).optional(),
});
export type Target = z.infer<typeof Target>;

/** One column of a table sheet assigned to one field of the target. */
export const ColumnAssignment = z.strictObject({
  /** The header text, so the assignment survives a moved column. */
  header: z.string(),
  /** The 0-based column, used when the header text is not found or is not unique. */
  index: z.int().min(0),
  /** A field path such as `title`, `names.full`, or `values.<fieldId>`. */
  field: z.string().min(1),
});
export type ColumnAssignment = z.infer<typeof ColumnAssignment>;

/**
 * Rows that are headings rather than entries (a book, a part): each makes a
 * parent entry, and the rows below it point at the deepest heading.
 */
export const HeadingRule = z.strictObject({
  collection: CollectionEnum,
  /**
   * `single`: a row with one filled cell. `banner`: a label and one wide merged
   * cell beside it (a part with its description).
   */
  match: z.enum(['single', 'banner']).default('single'),
  /** The field on the rows below (and on deeper headings) that points at this heading. */
  linkField: z.string().min(1),
  /** The field on this heading that points at the heading one level up, such as a part's book. */
  parentLinkField: z.string().min(1).optional(),
  /** The field that receives the text of a banner's merged cell. */
  textField: z.string().min(1).optional(),
  /** Constant values for each heading entry, keyed by field path. */
  fixed: z.record(z.string(), z.unknown()).default({}),
  /** The field that receives the heading's number, counted from 1 under its parent. */
  numberField: z.string().min(1).optional(),
  /**
   * When rows appear under the heading above with no heading of this level
   * (chapters straight under a book), make one with this title to hold them.
   */
  implicitTitle: z.string().min(1).optional(),
});
export type HeadingRule = z.infer<typeof HeadingRule>;

const Common = {
  sheet: z.string().min(1),
  target: Target,
  /** Constant values for every imported entry, keyed by field path. */
  fixed: z.record(z.string(), z.unknown()).default({}),
  /** Add a list choice that is not in its list yet, instead of failing the row. */
  addMissingListItems: z.boolean().default(false),
  /** Make a stub entry for a name that matches no existing entry, instead of failing the row. */
  createMissing: z.boolean().default(false),
  /**
   * Which existing entries count as the same entry on re-import: only those
   * imported from this sheet, or any entry of the target section.
   */
  matchIn: z.enum(['sheet', 'section']).default('sheet'),
};

export const TableMapping = z.strictObject({
  shape: z.literal('table'),
  ...Common,
  /** The 1-based row that holds the column headers. */
  headerRow: z.int().min(1).default(1),
  columns: z.array(ColumnAssignment),
  /** Field paths that together identify an entry across imports. */
  identity: z.array(z.string().min(1)).default([]),
  /** Heading rules from the top level down, such as books then parts. */
  headings: z.array(HeadingRule).default([]),
});
export type TableMapping = z.infer<typeof TableMapping>;

export const GridMapping = z.strictObject({
  shape: z.literal('grid'),
  ...Common,
  /** The 1-based row of year headers; null finds the first row with two or more years. */
  headerRow: z.int().min(1).nullable().default(null),
  /** The 0-based column that holds row labels. */
  labelColumn: z.int().min(0).default(0),
  /** Added to every year header, for sheets that head columns with 9 for 2009. */
  yearOffset: z.int().min(0).max(10000).default(0),
  /** A category every path starts under, such as the name of the sheet. */
  categoryRoot: z.string().nullable().default(null),
  /** The list that holds categories. */
  categoryList: z.string().min(1).default('eventCategories'),
});
export type GridMapping = z.infer<typeof GridMapping>;

export const Mapping = z.discriminatedUnion('shape', [TableMapping, GridMapping]);
export type Mapping = z.infer<typeof Mapping>;

/** A list choice the import would add before it writes entries. */
export const ListAdd = z.strictObject({
  listId: z.string().min(1),
  id: z.string().min(1),
  label: z.string().min(1),
  parentId: z.string().nullable(),
});
export type ListAdd = z.infer<typeof ListAdd>;

/** One source row (or grid cell) after mapping. */
export interface MappedRow {
  /** Where it came from, as stored in `sourceRef` (IM-6). */
  ref: string;
  /** A short place name for reports: "Sullivan row 12". */
  where: string;
  ok: boolean;
  /** Why a row failed, in plain words (IM-2). */
  reason?: string;
  collection: EntryCollection;
  sectionId?: string;
  /** The ID a new entry will get; heading entries need it so children can point at them. */
  newId: string;
  /** Imported values by field path (what the sheet supplies). */
  fields: Record<string, unknown>;
  /** The complete entry as it would be created. */
  data: Record<string, unknown>;
  /** What matches this row to an existing entry on re-import. */
  identity: string;
  /** Rows of a heading make parents first. */
  kind: 'entry' | 'heading';
}

export interface MapContext {
  file: SourceFile;
  newId: () => string;
  /** Lists by ID, for list choices and categories. */
  list: (
    id: string,
  ) => { items: { id: string; label: string; parentId: string | null }[] } | undefined;
  /** Live entries of a collection, to resolve names to IDs. */
  entries: (collection: EntryCollection) => Record<string, unknown>[];
  /** Fields of a custom section, for `values.<id>` fields. */
  section: (id: string) => Pick<CustomSection, 'fields'> | undefined;
}

export interface MapOutput {
  rows: MappedRow[];
  /** Choices to add to lists before the entries are written. */
  listAdds: ListAdd[];
  /** Names that matched nothing and become stub entries first. */
  stubs: MappedRow[];
  /** Columns the mapping ignored, with the reason. */
  notes: string[];
}
