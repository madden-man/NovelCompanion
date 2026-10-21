/**
 * Editable lists (ED-8): where each list is used, how many entries use an
 * item, and the entry changes a rename makes. Pure; the repository applies
 * the changes in one transaction.
 */
import type { FieldSpec } from '../schema/manifest';
import type { ListDoc, ListItem } from '../schema/lists';
import { deepEqual, isPlainObject } from './paths';
import type { Doc } from './paths';

export interface EntryPatch {
  collection: string;
  id: string;
  patch: Doc;
}

type Visit = (spec: FieldSpec, value: unknown) => unknown;

/** Rebuild a value with `visit` applied to every field; untouched parts keep their identity. */
function mapFields(specs: readonly FieldSpec[], value: Doc, visit: Visit): Doc {
  let out: Doc | null = null;
  for (const s of specs) {
    if (!(s.name in value)) continue;
    const v = value[s.name];
    let next: unknown = visit(s, v);
    if (s.kind === 'object' && s.fields && isPlainObject(v)) {
      next = mapFields(s.fields, v, visit);
    } else if (s.kind === 'objectList' && s.fields && Array.isArray(v)) {
      const fields = s.fields;
      const mapped = v.map((item) => (isPlainObject(item) ? mapFields(fields, item, visit) : item));
      next = mapped.some((m, i) => m !== v[i]) ? mapped : v;
    }
    if (next !== v) {
      out ??= { ...value };
      out[s.name] = next;
    }
  }
  return out ?? value;
}

function visitAll(
  specs: readonly FieldSpec[],
  doc: Doc,
  fn: (spec: FieldSpec, value: unknown) => void,
): void {
  mapFields(specs, doc, (s, v) => {
    fn(s, v);
    return v;
  });
}

/** True when the field holds an item of this list: by ID for list fields, by label for tags. */
function usesItem(spec: FieldSpec, value: unknown, listId: string, item: ListItem): boolean {
  if (spec.listId !== listId) return false;
  if (spec.kind === 'listItem') return value === item.id;
  if (spec.kind === 'tags') return Array.isArray(value) && value.includes(item.label);
  return false;
}

export interface CollectionDocs {
  collection: string;
  manifest: readonly FieldSpec[];
  docs: readonly Doc[];
}

/** How many entries use an item, so a rename or a removal can say so first. */
export function countListUsage(
  listId: string,
  item: ListItem,
  all: readonly CollectionDocs[],
): number {
  let n = 0;
  for (const { manifest, docs } of all) {
    for (const doc of docs) {
      // A42: an entry in the trash does not hold the item; restoring it warns of the missing item (ED-10).
      if (doc.deletedAt) continue;
      let used = false;
      visitAll(manifest, doc, (s, v) => {
        if (usesItem(s, v, listId, item)) used = true;
      });
      if (used) n++;
    }
  }
  return n;
}

function replaceTag(values: unknown, from: string, to: string): unknown {
  if (!Array.isArray(values) || !values.includes(from)) return values;
  const out: string[] = [];
  for (const v of values as string[]) {
    const next = v === from ? to : v;
    if (!out.includes(next)) out.push(next);
  }
  return out;
}

/**
 * The entry changes that renaming an item makes (ED-8). Fields that store a
 * list item by ID need no change: they show the new label at once. Fields
 * that store the label, which are tags, are rewritten on every entry.
 */
export function renameCascade(
  listId: string,
  from: string,
  to: string,
  all: readonly CollectionDocs[],
): EntryPatch[] {
  if (from === to) return [];
  const out: EntryPatch[] = [];
  for (const { collection, manifest, docs } of all) {
    for (const doc of docs) {
      const next = mapFields(manifest, doc, (s, v) =>
        s.kind === 'tags' && s.listId === listId ? replaceTag(v, from, to) : v,
      );
      if (next === doc) continue;
      const patch: Doc = {};
      for (const k of Object.keys(next)) {
        if (!deepEqual(next[k], doc[k])) patch[k] = next[k];
      }
      out.push({ collection, id: String(doc._id), patch });
    }
  }
  return out;
}

/** Every tag label an entry carries. */
export function tagsUsed(manifest: readonly FieldSpec[], doc: Doc): string[] {
  const out = new Set<string>();
  visitAll(manifest, doc, (s, v) => {
    if (s.kind === 'tags' && Array.isArray(v)) {
      for (const t of v) if (typeof t === 'string' && t) out.add(t);
    }
  });
  return [...out];
}

/** The label path of a hierarchical item, for example "Technology > Robotics". */
export function itemPath(list: ListDoc, itemId: string): string {
  const parts: string[] = [];
  const seen = new Set<string>();
  let cur = list.items.find((i) => i.id === itemId);
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    parts.unshift(cur.label);
    const parentId: string | null = cur.parentId;
    cur = parentId ? list.items.find((i) => i.id === parentId) : undefined;
  }
  return parts.join(' > ');
}

/** A new item ID from its label, unique within the list. */
export function newItemId(list: ListDoc, label: string): string {
  const base =
    label
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'item';
  let id = base;
  for (let n = 2; list.items.some((i) => i.id === id); n++) id = `${base}-${n}`;
  return id;
}

/**
 * The entry change for renaming an item of a list whose items are entries:
 * a family's name or an era's name (ED-8). A title that contains the old
 * name follows it.
 */
export function derivedRename(
  listId: 'families' | 'eraRanges',
  doc: Doc,
  label: string,
): EntryPatch {
  const collection = listId === 'families' ? 'families' : 'eraStates';
  const oldName = typeof doc.name === 'string' ? doc.name : '';
  const patch: Doc = { name: label };
  if (typeof doc.title === 'string' && oldName && doc.title.includes(oldName)) {
    patch.title = doc.title.split(oldName).join(label);
  }
  return { collection, id: String(doc._id), patch };
}
