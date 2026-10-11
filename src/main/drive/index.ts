/**
 * Google Drive in the main process (GD-1 to GD-5). The renderer never talks
 * to Google: every call goes through `DriveService` here, over Node's own
 * fetch, outside the renderer's session (ARCH-1).
 *
 * For other features (M7 manuscript import, MS-1): call
 * `fetchDriveFile(fileId)` to get a Drive file as .docx or .xlsx bytes and
 * hand `data` to `parseDocxBuffer` (src/main/import/docx.ts) or
 * `parseWorkbookBuffer` (src/main/import/xlsx.ts) with
 * `{ fileName, modifiedAt }`. A Google Doc is exported as .docx, so italics
 * and scene breaks survive exactly as for a Word file. The call is
 * read-only and never writes to Drive (MS-5).
 */
import type { DriveService, FetchedDriveFile } from './service';

export { DriveService } from './service';
export type { DriveStatus, FetchedDriveFile, BrowseItem } from './service';

let current: DriveService | null = null;

/** Main sets the one service at startup; tests may set their own. */
export function setDriveService(service: DriveService | null): void {
  current = service;
}

export function driveService(): DriveService {
  if (!current) throw new Error('Google Drive is not available in this build.');
  return current;
}

/**
 * MS-1 seam: one Drive file as Word or Excel bytes, with the name and
 * modified time the importers record. Throws a plain message when Drive is
 * not connected, the file is gone, or it is not a Word, Excel, Google Docs,
 * or Google Sheets file.
 */
export function fetchDriveFile(fileId: string): Promise<FetchedDriveFile> {
  return driveService().fetchFile(fileId);
}
