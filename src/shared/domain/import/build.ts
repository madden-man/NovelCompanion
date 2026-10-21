import { entrySchemas, entryTitle, manifests } from '../../schema';
import type { EntryCollection, FieldSpec } from '../../schema';
import { getPath } from '../paths';
import type { Doc } from '../paths';
import { importableFields, readField, writeField } from './fields';
import type { Target } from './types';

const PLACEHOLDER_TIME = '2000-01-01T00:00:00.000Z';

export interface BuildInput {
  target: Target;
  /** Values supplied by the sheet, by field path. */
  fields: Record<string, unknown>;
  /** Constants from the mapping, by field path. */
  fixed: Record<string, unknown>;
  newId: string;
  ref: string;
  /** The row's place among the sheet's data rows, from 1, for numbering. */
  ordinal: number;
}

/** A label for a path in plain words, for error messages. */
export function pathLabel(target: Target, path: string): string {
  const spec = importableFields(target).find((f) => f.path === path);
  if (spec) return spec.label;
  const top = path.split('.')[0] ?? path;
  const found = (manifests[target.collection] as FieldSpec[]).find((s) => s.name === top);
  return found?.label ?? path;
}

/**
 * Put the fields and constants together into one entry of the target section
 * and check it with the section's schema. Returns the entry or the reason it
 * cannot be created (IM-2).
 */
export function buildEntry(
  input: BuildInput,
): { ok: true; data: Doc } | { ok: false; reason: string } {
  const { target, fields, fixed } = input;
  const c: EntryCollection = target.collection;
  const data: Doc = {};
  for (const [path, value] of Object.entries(fixed)) writeField(data, path, value);
  for (const [path, value] of Object.entries(fields)) writeField(data, path, value);

  const text = (path: string) => {
    const v = readField(data, path);
    return typeof v === 'string' && v.trim() ? v.trim() : '';
  };
  // A title is required everywhere; take it from the entry's own name when the sheet has no title column.
  const titleFallbacks: Partial<Record<EntryCollection, string[]>> = {
    characters: ['names.full'],
    families: ['name'],
    eraStates: ['name'],
    glossaryTerms: ['characters'],
    openQuestions: ['question'],
  };
  if (!text('title')) {
    for (const path of titleFallbacks[c] ?? []) {
      if (text(path)) {
        data.title = text(path);
        break;
      }
    }
  }
  if (c === 'characters') {
    if (!text('names.full') && text('title')) writeField(data, 'names.full', text('title'));
    if (data.birth === undefined) data.birth = { unknown: true };
  }
  if (c === 'families' && !text('name') && text('title')) data.name = text('title');
  if (c === 'eraStates' && !text('name') && text('title')) data.name = text('title');
  if (c === 'glossaryTerms' && !text('characters') && text('title'))
    data.characters = text('title');
  if (c === 'chapters') {
    if (data.readingOrder === undefined) data.readingOrder = input.ordinal;
    const strand = Array.isArray(data.strands) ? (data.strands[0] as Doc | undefined) : undefined;
    if (strand) {
      strand.id = 's1';
      strand.primary = true;
      if (strand.label === undefined) strand.label = 'present';
    }
  }
  if (data.status === undefined) data.status = 'planned';
  data.sourceRef = input.ref;

  const missing = missingTitle(data);
  const parsed = entrySchemas[c].safeParse({
    ...data,
    _id: input.newId,
    createdAt: PLACEHOLDER_TIME,
    modifiedAt: PLACEHOLDER_TIME,
  });
  if (!parsed.success) {
    return {
      ok: false,
      reason: describeIssue(
        target,
        parsed.error.issues[0] ?? { code: 'custom', path: [], message: 'is not valid' },
        missing,
      ),
    };
  }
  return { ok: true, data: parsed.data as Doc };
}

function missingTitle(data: Doc): boolean {
  return typeof data.title !== 'string' || data.title.trim() === '';
}

interface IssueLike {
  code: string;
  path: PropertyKey[];
  message: string;
}

/** One schema issue in plain words: which field, and what is wrong. */
export function describeIssue(target: Target, issue: IssueLike, titleMissing = false): string {
  const path = issue.path.map(String).join('.');
  if (path === 'title' || (titleMissing && path === '')) return 'There is no value for the title';
  const mapped = path.replace(/^strands\.0\./, 'strand.').replace(/^strands\.1\./, 'backstory.');
  const label = pathLabel(target, mapped);
  const missing =
    /received undefined|Invalid input: expected \w+, received undefined|Required/i.test(
      issue.message,
    );
  if (missing) return `There is no value for ${label}`;
  return `${label}: ${issue.message}`;
}

/** The name an entry is shown by in reports. */
export function shownTitle(data: Doc): string {
  return entryTitle(data);
}

export function valueAt(doc: Doc, path: string): unknown {
  return getPath(doc, path);
}
