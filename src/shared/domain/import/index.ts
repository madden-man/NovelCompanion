import { mapGrid } from './grid';
import { mapTable } from './table';
import type { MapContext, MapOutput, Mapping, ParsedSheet } from './types';

export * from './types';
export * from './source';
export * from './values';
export * from './fields';
export * from './build';
export * from './names';
export {
  identityPaths,
  identityKey,
  existingIdentities,
  resolveColumns,
  sheetHeaders,
} from './table';
export { findYearHeader, titleFromText, mapGrid, categoryPath, regionsOfLabel } from './grid';
export { chapterStrands, mapChapterGrid, mapMomentGrid } from './gridEntries';
export { mapTable } from './table';
export * from './changes';
export * from './document';
export * from './documents';
export * from './eras';

/** Map one sheet with its saved or chosen mapping (IM-1). */
export function mapSheet(sheet: ParsedSheet, mapping: Mapping, ctx: MapContext): MapOutput {
  return mapping.shape === 'grid' ? mapGrid(sheet, mapping, ctx) : mapTable(sheet, mapping, ctx);
}

/** The key a saved mapping is stored under: the file name and the sheet (IM-1). */
export function mappingKey(fileName: string, sheet: string): string {
  return `${fileName}#${sheet}`;
}
export * from './guess';
