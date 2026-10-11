import { basename } from 'node:path';
import { stat } from 'node:fs/promises';
import ExcelJS from 'exceljs';
import type { Cell, MergeRange, ParsedSheet, ParsedWorkbook } from '../../shared/domain/import';

type Raw = ExcelJS.CellValue;

/** One cell as plain data: text, a number, a flag, or empty. Dates become ISO text. */
export function normalizeCell(value: Raw): Cell {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    const iso = value.toISOString();
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso;
  }
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'object') {
    if ('richText' in value && Array.isArray(value.richText)) {
      return value.richText.map((r) => r.text).join('');
    }
    if ('error' in value) return null;
    if ('result' in value) return normalizeCell(value.result as Raw);
    if ('text' in value) return normalizeCell(value.text as Raw);
  }
  return null;
}

function parseRange(range: string): MergeRange | null {
  const m = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(range);
  if (!m) return null;
  const col = (letters: string) =>
    [...letters].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0);
  return { top: Number(m[2]), left: col(m[1] ?? ''), bottom: Number(m[4]), right: col(m[3] ?? '') };
}

function parseSheet(ws: ExcelJS.Worksheet): ParsedSheet {
  const rows = ws.rowCount;
  const columns = ws.columnCount;
  const cells: Cell[][] = [];
  for (let r = 1; r <= rows; r++) {
    const row = ws.getRow(r);
    const line: Cell[] = [];
    for (let c = 1; c <= columns; c++) line.push(normalizeCell(row.getCell(c).value));
    cells.push(line);
  }
  const merges = ((ws.model as { merges?: string[] }).merges ?? [])
    .map(parseRange)
    .filter((m): m is MergeRange => m !== null);
  return { name: ws.name, cells, merges };
}

/** Read a workbook's sheets as plain grids (IM-1). Numbers such as 2055.0 come out as 2055. */
export async function parseWorkbookBuffer(
  data: Buffer | ArrayBuffer,
  source: { fileName: string; modifiedAt: string },
): Promise<ParsedWorkbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(data as ArrayBuffer);
  return {
    fileName: source.fileName,
    modifiedAt: source.modifiedAt,
    sheets: wb.worksheets.map(parseSheet),
  };
}

export async function parseWorkbookFile(path: string): Promise<ParsedWorkbook> {
  const { readFile } = await import('node:fs/promises');
  const [data, info] = await Promise.all([readFile(path), stat(path)]);
  return parseWorkbookBuffer(data, {
    fileName: basename(path),
    modifiedAt: info.mtime.toISOString(),
  });
}
