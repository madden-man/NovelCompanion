import { basename } from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import mammoth from 'mammoth';
import { parseBlocks } from '../../shared/domain/import';
import type { DocBlock } from '../../shared/domain/import';

export interface ParsedDocument {
  fileName: string;
  modifiedAt: string;
  /** What mammoth made of the document: headings, italics, lists, paragraphs. */
  html: string;
  blocks: DocBlock[];
}

/** Word to HTML, keeping headings, italics, and empty paragraphs so numbering matches Word (IM-4). */
export async function parseDocxBuffer(
  data: Buffer,
  source: { fileName: string; modifiedAt: string },
): Promise<ParsedDocument> {
  const result = await mammoth.convertToHtml(
    { buffer: data },
    {
      ignoreEmptyParagraphs: false,
      styleMap: ["p[style-name='Title'] => h1:fresh", "p[style-name='Subtitle'] => h2:fresh"],
    },
  );
  return { ...source, html: result.value, blocks: parseBlocks(result.value) };
}

export async function parseDocxFile(path: string): Promise<ParsedDocument> {
  const [data, info] = await Promise.all([readFile(path), stat(path)]);
  return parseDocxBuffer(data, { fileName: basename(path), modifiedAt: info.mtime.toISOString() });
}
