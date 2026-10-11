/** Stable source locations (IM-6): file, sheet, cell or row, or paragraph. */

/** Column number (1-based) as spreadsheet letters: 1 is A, 27 is AA. */
export function columnLetters(column: number): string {
  let n = column;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** The prefix every entry from one sheet of one file starts with. */
export function sheetPrefix(fileName: string, sheet: string): string {
  return `${fileName}#${sheet}!`;
}

/** A cell of a sheet, such as the name cell of a table row or a grid cell, such as `East_Winds_World.xlsx#High Level!C12`. */
export function cellRef(fileName: string, sheet: string, row: number, column: number): string {
  return `${sheetPrefix(fileName, sheet)}${columnLetters(column)}${row}`;
}

/** A run of paragraphs in a document, such as `Dawns_Life.docx#p1-p42`. */
export function paragraphRef(fileName: string, first: number, last: number = first): string {
  return first === last ? `${fileName}#p${first}` : `${fileName}#p${first}-p${last}`;
}

/** The prefix of every entry imported from one document. */
export function documentPrefix(fileName: string): string {
  return `${fileName}#p`;
}

/** The file name part of a source reference, or null when it is not one. */
export function fileOfRef(ref: string): string | null {
  const at = ref.indexOf('#');
  return at > 0 ? ref.slice(0, at) : null;
}
