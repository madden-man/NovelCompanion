import { z } from 'zod';

/**
 * The Google Drive channels (GD-1 to GD-5), spread into the one IPC contract
 * in `ipc.ts`. Nothing here carries a token or the client secret: the
 * renderer sees only whether Drive is set up and connected, and as whom.
 */

const DriveId = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_-]+$/, 'Drive IDs use letters, digits, dashes, and underscores');

const DriveStatusWire = z.strictObject({
  clientConfigured: z.boolean(),
  clientIdHint: z.string().nullable(),
  connected: z.boolean(),
  email: z.string().nullable(),
  canExport: z.boolean(),
});

const DriveKindWire = z.enum(['folder', 'workbook', 'document', 'other']);

const BrowseItemWire = z.strictObject({
  id: DriveId,
  name: z.string(),
  mimeType: z.string(),
  kind: DriveKindWire,
  modifiedAt: z.string(),
});

const DriveLinkWire = z.strictObject({
  id: DriveId,
  name: z.string(),
  mimeType: z.string(),
  kind: z.enum(['folder', 'workbook', 'document']),
  linkedAt: z.string(),
});

const CheckedFileWire = z.strictObject({
  fileId: DriveId,
  linkId: DriveId,
  name: z.string(),
  kind: z.enum(['workbook', 'document']),
  mimeType: z.string(),
  modifiedTime: z.string().nullable(),
  seenModifiedTime: z.string().nullable(),
  state: z.enum(['new', 'changed', 'unchanged', 'missing']),
});

const FileWire = z.strictObject({
  id: z.string().min(1).max(64),
  name: z.string().min(1),
  kind: z.enum(['workbook', 'document']),
  modifiedAt: z.iso.datetime({ offset: true }),
});

const Folder = z.strictObject({ id: DriveId, name: z.string() });
const Empty = z.strictObject({});

export const driveContract = {
  /** GD-1, ST-1: whether the OAuth client is set up and Drive is connected. */
  'drive.status': { request: Empty, response: DriveStatusWire },
  /** GD-1: store the OAuth client ID and secret in the keychain. */
  'drive.setClient': {
    request: z.strictObject({
      clientId: z.string().trim().min(1).max(300),
      clientSecret: z.string().trim().min(1).max(300),
    }),
    response: DriveStatusWire,
  },
  /** Remove the OAuth client and any tokens. */
  'drive.clearClient': { request: Empty, response: DriveStatusWire },
  /** GD-1: sign in through the system browser, read-only for import. */
  'drive.connect': { request: Empty, response: DriveStatusWire },
  /** GD-4: add access to files the app creates, for export only. */
  'drive.allowExport': { request: Empty, response: DriveStatusWire },
  /** GD-5: revoke and delete the stored tokens. */
  'drive.disconnect': { request: Empty, response: DriveStatusWire },
  /** GD-2: list a folder, My Drive, Shared with me, or a name search. */
  'drive.browse': {
    request: z.strictObject({
      folderId: DriveId.nullable().default(null),
      place: z.enum(['myDrive', 'shared']).default('myDrive'),
      search: z.string().max(200).default(''),
    }),
    response: z.strictObject({ folder: Folder.nullable(), items: z.array(BrowseItemWire) }),
  },
  /** GD-2: the files and folders linked to the open bible. */
  'drive.links': {
    request: Empty,
    response: z.strictObject({ links: z.array(DriveLinkWire) }),
  },
  'drive.link': {
    request: z.strictObject({ ids: z.array(DriveId).min(1).max(200) }),
    response: z.strictObject({ links: z.array(DriveLinkWire) }),
  },
  'drive.unlink': {
    request: z.strictObject({ id: DriveId }),
    response: z.strictObject({ links: z.array(DriveLinkWire) }),
  },
  /** GD-3: which linked files are new, changed, unchanged, or gone. Changes nothing. */
  'drive.check': {
    request: Empty,
    response: z.strictObject({
      checkedAt: z.string(),
      connected: z.boolean(),
      files: z.array(CheckedFileWire),
      missingFolders: z.array(z.string()),
      summary: z.string(),
    }),
  },
  /**
   * GD-2, GD-3: fetch a linked file (a Google Doc or Sheet as .docx or .xlsx)
   * and hand it to the import pipeline. Returns the import file ID; the
   * person then maps, compares, and approves exactly as for a local file.
   */
  'drive.open': {
    request: z.strictObject({ fileId: DriveId }),
    response: z.strictObject({ file: FileWire }),
  },
  /** GD-3: record that the current version was looked at, without importing it. */
  'drive.markSeen': {
    request: z.strictObject({ fileId: DriveId }),
    response: z.strictObject({ ok: z.literal(true) }),
  },
  /** GD-4: folders this app created for exports. */
  'drive.exportFolders': {
    request: Empty,
    response: z.strictObject({ folders: z.array(Folder) }),
  },
  'drive.createExportFolder': {
    request: z.strictObject({ name: z.string().trim().min(1).max(200) }),
    response: z.strictObject({ folder: Folder }),
  },
  /** GD-4: the whole bible as Markdown (one file per entry, by section) and one JSON file. */
  'drive.export': {
    request: z.strictObject({ folderId: DriveId }),
    response: z.strictObject({
      folder: z.strictObject({ id: DriveId, name: z.string(), url: z.string().nullable() }),
      files: z.int().min(0),
      entries: z.int().min(0),
      sections: z.int().min(0),
    }),
  },
} as const;
