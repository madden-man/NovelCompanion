/**
 * Where manuscript chapters are read from (MS-1). A source only reads: there
 * is no write method on the interface and no code path that writes to a
 * manuscript file or document (MS-5, A4).
 *
 * Word files are the one source (A53).
 */
import { basename } from 'node:path';
import { blocksToBody } from '../../shared/domain/wordDocument';
import { parseDocxFile } from './docx';

export interface ManuscriptText {
  /** A name to show, such as the file name or the document title. */
  name: string;
  modifiedAt: string;
  /** The chapter in the editor format: paragraphs, headings, italics, scene breaks as <hr>. */
  body: string;
}

export interface ManuscriptSource {
  /** Short and stable: `word`. It prefixes the stored locator. */
  id: string;
  label: string;
  /** Ask the person for a document. Returns a locator (a path), or null when cancelled. */
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

/** `word:/path/file.docx` to its source ID and locator. */
export function parseLocator(stored: string | null | undefined): {
  sourceId: string;
  locator: string;
} | null {
  const m = /^([a-z][a-z0-9]*):(.+)$/s.exec(stored ?? '');
  return m ? { sourceId: m[1] as string, locator: m[2] as string } : null;
}
