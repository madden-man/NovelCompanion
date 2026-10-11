/**
 * Google Drive file kinds and change detection (GD-2, GD-3). Pure: no
 * network, no Electron, no MongoDB.
 */

export const FOLDER_MIME = 'application/vnd.google-apps.folder';
export const GOOGLE_DOC_MIME = 'application/vnd.google-apps.document';
export const GOOGLE_SHEET_MIME = 'application/vnd.google-apps.spreadsheet';
export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** What the app can do with a Drive item. `other` is shown greyed out and cannot be linked. */
export type DriveKind = 'folder' | 'workbook' | 'document' | 'other';

/** GD-2: Word, Excel, Google Docs, and Google Sheets, plus folders that hold them. */
export function driveKind(mimeType: string, name = ''): DriveKind {
  if (mimeType === FOLDER_MIME) return 'folder';
  if (mimeType === GOOGLE_DOC_MIME || mimeType === DOCX_MIME) return 'document';
  if (mimeType === GOOGLE_SHEET_MIME || mimeType === XLSX_MIME) return 'workbook';
  // Drive sometimes reports an uploaded Office file as a generic binary.
  if (mimeType === 'application/octet-stream') {
    if (/\.docx$/i.test(name)) return 'document';
    if (/\.xlsx$/i.test(name)) return 'workbook';
  }
  return 'other';
}

/** The Office format a Google file is exported as, or null for a file downloaded as it is. */
export function exportMimeFor(mimeType: string): string | null {
  if (mimeType === GOOGLE_DOC_MIME) return DOCX_MIME;
  if (mimeType === GOOGLE_SHEET_MIME) return XLSX_MIME;
  return null;
}

/**
 * The file name the importer records (IM-6) and keys saved mappings by
 * (IM-1). A Google Doc "Chapter 3" becomes "Chapter 3.docx", so it reads as
 * the same source whether it was downloaded by hand or fetched from Drive.
 */
export function importFileName(name: string, mimeType: string): string {
  const kind = driveKind(mimeType, name);
  const ext = kind === 'document' ? '.docx' : kind === 'workbook' ? '.xlsx' : '';
  return ext && !name.toLowerCase().endsWith(ext) ? `${name}${ext}` : name;
}

/** A file or folder the person linked (GD-2). Stored per bible in `meta`, never a token. */
export interface DriveLink {
  /** The Drive file ID. */
  id: string;
  name: string;
  mimeType: string;
  kind: Exclude<DriveKind, 'other'>;
  linkedAt: string;
}

/** The Drive version last brought in (or looked at and declined) for one file. */
export interface DriveSeen {
  fileId: string;
  modifiedTime: string;
  at: string;
}

/** A file as Drive reports it during a check. `linkId` is the link that reached it. */
export interface RemoteFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  linkId: string;
}

export type FileState = 'new' | 'changed' | 'unchanged' | 'missing';

export interface CheckedFile {
  fileId: string;
  linkId: string;
  name: string;
  kind: 'workbook' | 'document';
  mimeType: string;
  modifiedTime: string | null;
  seenModifiedTime: string | null;
  state: FileState;
}

const ORDER: Record<FileState, number> = { changed: 0, new: 1, missing: 2, unchanged: 3 };

/**
 * GD-3: compare what Drive reports now with what was last brought in.
 * `new` is a linked file never imported, `changed` one modified since,
 * `missing` a linked file Drive no longer returns (deleted, trashed, or
 * unshared). A file reached through two links is reported once.
 */
export function classifyFiles(
  links: readonly DriveLink[],
  remote: readonly RemoteFile[],
  missingLinkIds: readonly string[],
  seen: readonly DriveSeen[],
): CheckedFile[] {
  const seenBy = new Map(seen.map((s) => [s.fileId, s]));
  const out = new Map<string, CheckedFile>();
  for (const f of remote) {
    const kind = driveKind(f.mimeType, f.name);
    if (kind !== 'workbook' && kind !== 'document') continue;
    if (out.has(f.id)) continue;
    const last = seenBy.get(f.id);
    const state: FileState = !last
      ? 'new'
      : Date.parse(f.modifiedTime) > Date.parse(last.modifiedTime)
        ? 'changed'
        : 'unchanged';
    out.set(f.id, {
      fileId: f.id,
      linkId: f.linkId,
      name: f.name,
      kind,
      mimeType: f.mimeType,
      modifiedTime: f.modifiedTime,
      seenModifiedTime: last?.modifiedTime ?? null,
      state,
    });
  }
  for (const id of missingLinkIds) {
    const link = links.find((l) => l.id === id);
    if (!link || link.kind === 'folder' || out.has(id)) continue;
    out.set(id, {
      fileId: id,
      linkId: id,
      name: link.name,
      kind: link.kind,
      mimeType: link.mimeType,
      modifiedTime: null,
      seenModifiedTime: seenBy.get(id)?.modifiedTime ?? null,
      state: 'missing',
    });
  }
  return [...out.values()].sort(
    (a, b) => ORDER[a.state] - ORDER[b.state] || a.name.localeCompare(b.name),
  );
}

/** One plain sentence for the launch notice and the Drive screen. */
export function changeSummary(files: readonly CheckedFile[]): string {
  const changed = files.filter((f) => f.state === 'changed').length;
  const fresh = files.filter((f) => f.state === 'new').length;
  const missing = files.filter((f) => f.state === 'missing').length;
  const parts: string[] = [];
  if (changed) parts.push(`${changed} changed since you last imported`);
  if (fresh) parts.push(`${fresh} not imported yet`);
  if (missing) parts.push(`${missing} no longer in Drive`);
  if (!parts.length) return 'Every linked Drive file matches what you imported.';
  const total = changed + fresh + missing;
  return `${total === 1 ? 'One linked Drive file' : `${total} linked Drive files`}: ${parts.join(', ')}. Nothing changes until you review it.`;
}
