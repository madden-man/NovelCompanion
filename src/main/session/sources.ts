/**
 * Where manuscript chapters are read from (MS-1). A source only reads: there
 * is no write method on the interface and no code path that writes to a
 * manuscript file or document (MS-5, A4).
 *
 * Word files are built in. Google Docs (`gdocSource`, id `gdoc`) export the
 * Doc as .docx through M9's `fetchDriveFile` and run the same Word parsing,
 * so italics and scene breaks survive alike; main registers it at startup
 * with `registerManuscriptSource`. A Google Doc is chosen in the page with the
 * Drive browser (`picker: 'drive'`), so its `pick` returns null and the page
 * passes the chosen file ID as the locator.
 */
import { basename } from 'node:path';
import { blocksToBody } from '../../shared/domain/import';
import { parseDocxBuffer, parseDocxFile } from '../import/docx';
import type { FetchedDriveFile } from '../drive/service';

export interface ManuscriptText {
  /** A name to show, such as the file name or the document title. */
  name: string;
  modifiedAt: string;
  /** The chapter in the editor format: paragraphs, headings, italics, scene breaks as <hr>. */
  body: string;
}

export interface ManuscriptSource {
  /** Short and stable: `word`, `gdoc`. It prefixes the stored locator. */
  id: string;
  label: string;
  /** `dialog`: `pick` asks in main. `drive`: the page picks with the Drive browser and sends the locator. */
  picker?: 'dialog' | 'drive';
  /** Ask the person for a document. Returns a locator (a path or document ID), or null when cancelled. */
  pick(): Promise<string | null>;
  /** Read the document at a locator. Never writes. */
  read(locator: string): Promise<ManuscriptText>;
}

/** MS-1: Word files through mammoth, keeping italics, headings, and scene breaks. */
export function wordSource(pick: () => Promise<string | null>): ManuscriptSource {
  return {
    id: 'word',
    label: 'Word file',
    pick,
    async read(path) {
      const doc = await parseDocxFile(path);
      return { name: basename(path), modifiedAt: doc.modifiedAt, body: blocksToBody(doc.blocks) };
    },
  };
}

const GOOGLE_DOC_MIME = 'application/vnd.google-apps.document';

/**
 * MS-1: a Google Doc, linked by its Drive file ID. Drive exports it as .docx
 * and the Word parsing keeps italics, headings, and scene breaks. Read only
 * (MS-5): `fetch` downloads or exports and never writes to Drive.
 */
export function gdocSource(fetch: (fileId: string) => Promise<FetchedDriveFile>): ManuscriptSource {
  return {
    id: 'gdoc',
    label: 'Google Doc',
    picker: 'drive',
    // Chosen in the page with the Drive browser; main has nothing to ask.
    pick: async () => null,
    async read(fileId) {
      const f = await fetch(fileId);
      if (f.kind !== 'document') {
        throw new Error(
          'That Drive file is not a Google Doc or a Word file, so it cannot be a chapter.',
        );
      }
      const doc = await parseDocxBuffer(f.data, { fileName: f.fileName, modifiedAt: f.modifiedAt });
      const name = f.mimeType === GOOGLE_DOC_MIME ? f.fileName.replace(/\.docx$/i, '') : f.fileName;
      return {
        name: f.mimeType === GOOGLE_DOC_MIME ? `${name} (Google Doc)` : `${name} (Google Drive)`,
        modifiedAt: doc.modifiedAt,
        body: blocksToBody(doc.blocks),
      };
    },
  };
}

const extra: ManuscriptSource[] = [];

/** Add a source (Google Docs) at startup. */
export function registerManuscriptSource(source: ManuscriptSource): void {
  const at = extra.findIndex((s) => s.id === source.id);
  if (at >= 0) extra.splice(at, 1, source);
  else extra.push(source);
}

export function registeredSources(): ManuscriptSource[] {
  return [...extra];
}

/** `word:/path/file.docx` to its source ID and locator. */
export function parseLocator(stored: string | null | undefined): {
  sourceId: string;
  locator: string;
} | null {
  const m = /^([a-z][a-z0-9]*):(.+)$/s.exec(stored ?? '');
  return m ? { sourceId: m[1] as string, locator: m[2] as string } : null;
}
