import type { ParsedDocument } from './docx';

/**
 * Word documents picked for import in this run of the app, by file ID, so
 * Claude import proposals (IM-5) can read the same document the importer
 * showed. Only the most recent few are kept.
 */
const picked = new Map<string, ParsedDocument>();
const KEEP = 8;

export function rememberDocument(fileId: string, doc: ParsedDocument): void {
  picked.set(fileId, doc);
  for (const old of [...picked.keys()].slice(0, Math.max(0, picked.size - KEEP))) {
    picked.delete(old);
  }
}

export function pickedDocument(fileId: string): ParsedDocument | null {
  return picked.get(fileId) ?? null;
}
