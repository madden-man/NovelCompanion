import { deepEqual, isPlainObject, joinPath } from './paths';
import type { Doc } from './paths';

export interface FieldChange {
  path: string;
  before: unknown;
  after: unknown;
}

/** Fields that change on every write and say nothing about content. */
export const BOOKKEEPING_FIELDS = ['_id', 'createdAt', 'modifiedAt'] as const;

function walk(a: unknown, b: unknown, path: string, out: FieldChange[]): void {
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
    for (const k of keys) {
      if (!path && (BOOKKEEPING_FIELDS as readonly string[]).includes(k)) continue;
      walk(a[k], b[k], joinPath(path, k), out);
    }
    return;
  }
  if (!deepEqual(a, b)) out.push({ path, before: a, after: b });
}

/**
 * A field-by-field comparison of two versions of an entry, for the revision
 * history's side-by-side view (ED-4). Nested groups are compared field by
 * field; lists and single values are compared whole. Bookkeeping fields are
 * left out.
 */
export function diffEntries(before: Doc | null, after: Doc | null): FieldChange[] {
  const out: FieldChange[] = [];
  walk(before ?? {}, after ?? {}, '', out);
  return out;
}

/** Content fields of an entry: everything but identity, timestamps, and trash state. */
export function contentOf(doc: Doc): Doc {
  const out: Doc = {};
  for (const [k, v] of Object.entries(doc)) {
    if (k === '_id' || k === 'createdAt' || k === 'modifiedAt' || k === 'deletedAt') continue;
    out[k] = v;
  }
  return out;
}

/**
 * The top-level fields that differ between two versions, as a patch to go
 * from `from` to `to`, and the patch to go back. Used to build undo commands.
 */
export function patchBetween(from: Doc, to: Doc): { forward: Doc; backward: Doc } {
  const forward: Doc = {};
  const backward: Doc = {};
  const a = contentOf(from);
  const b = contentOf(to);
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (!deepEqual(a[k], b[k])) {
      forward[k] = b[k] ?? null;
      backward[k] = a[k] ?? null;
    }
  }
  return { forward, backward };
}
