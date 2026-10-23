/**
 * Editable lists (ED-8): where each list is used, how many entries use an
 * item, and the entry changes a rename makes. Pure; the repository applies
 * the changes in one transaction.
 */
import type { FieldSpec } from '../schema/manifest';
import { STATUS_KINDS } from '../schema/lists';
import type { ListItem, StatusKind } from '../schema/lists';
import { FAMILY_COLORS, FAMILY_TOKEN_HEX } from '../schema/family';
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
function usesItem(
  spec: FieldSpec,
  value: unknown,
  listId: string,
  item: Pick<ListItem, 'id' | 'label'>,
): boolean {
  if (spec.listId !== listId) return false;
  if (spec.kind === 'listItem') return value === item.id;
  if (spec.kind === 'listItems') return Array.isArray(value) && value.includes(item.id);
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
  item: Pick<ListItem, 'id' | 'label'> & Partial<ListItem>,
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
export function itemPath(
  list: { items: readonly Pick<ListItem, 'id' | 'label' | 'parentId'>[] },
  itemId: string,
): string {
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
export function newItemId(list: { items: readonly { id: string }[] }, label: string): string {
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

// ---------- A47: order, parents, colours and kinds (IP-8, IP-9, IP-12) ----------

type Items = readonly Pick<ListItem, 'id' | 'parentId'>[];

/** True when `candidate` is `itemId` or sits anywhere under it. */
export function isUnder(items: Items, candidate: string, itemId: string): boolean {
  const seen = new Set<string>();
  let cur: string | null = candidate;
  while (cur && !seen.has(cur)) {
    if (cur === itemId) return true;
    seen.add(cur);
    cur = items.find((i) => i.id === cur)?.parentId ?? null;
  }
  return false;
}

/**
 * IP-8: the items with one moved to `index` in the stored order, which is the
 * order every select and list shows. The index is the item's place in the
 * whole list after the move, clamped to the ends. Null when the item is not
 * in the list.
 */
export function moveItem<T extends { id: string }>(
  items: readonly T[],
  itemId: string,
  index: number,
): T[] | null {
  const from = items.findIndex((i) => i.id === itemId);
  if (from < 0) return null;
  const rest = items.filter((_, i) => i !== from);
  const to = Math.max(0, Math.min(rest.length, Math.trunc(index)));
  rest.splice(to, 0, items[from] as T);
  return rest;
}

/**
 * IP-8: why an item cannot take a parent, in plain words, or null when it
 * can. An item cannot sit under itself or anything under it.
 */
export function parentProblem(
  items: readonly Pick<ListItem, 'id' | 'label' | 'parentId'>[],
  itemId: string,
  parentId: string | null,
): string | null {
  const item = items.find((i) => i.id === itemId);
  if (!item) return `The list has no item ${itemId}.`;
  if (parentId === null) return null;
  const parent = items.find((i) => i.id === parentId);
  if (!parent) return 'The parent item is not in this list.';
  if (isUnder(items, parentId, itemId)) {
    return parentId === itemId
      ? `${item.label} cannot sit under itself.`
      : `${item.label} cannot sit under ${parent.label}, which is already under it.`;
  }
  return null;
}

/** The fallback kind of a status ID with no `extra.kind`: the seeded IDs mean themselves. */
const isKind = (v: unknown): v is StatusKind =>
  typeof v === 'string' && (STATUS_KINDS as readonly string[]).includes(v);

/**
 * IP-9, SB-5: what a status means to the brief rules: canon, planned or idea,
 * read from the item's `extra.kind`. `lists` is the bible's list documents
 * (or anything with `_id` and `items`). A status with no kind is read by its
 * ID when that is one of the three, and as idea otherwise, so nothing unknown
 * ever counts as canon.
 */
export function statusKind(
  lists: readonly { _id?: unknown; items?: unknown }[],
  id: unknown,
): StatusKind {
  const list = lists.find((l) => l._id === 'statuses');
  const items = Array.isArray(list?.items) ? (list.items as Partial<ListItem>[]) : [];
  const kind = items.find((i) => i.id === id)?.extra?.kind;
  if (isKind(kind)) return kind;
  return isKind(id) ? id : 'idea';
}

/**
 * A51: the colours of the seeded moment kinds (Moves, Life event, Work and
 * study), by their light theme hex, with the `--kind-*` token that draws them.
 */
export const KIND_HEX_TOKENS: Record<string, string> = {
  '#008300': 'kind-move',
  '#e34948': 'kind-life',
  '#4a3aa7': 'kind-work',
};

/**
 * The CSS colours the seeded items carry, by their light theme hex, with the
 * token that draws them in both themes. The renderer draws a known hex through
 * its token, so it follows the theme; any other hex is drawn as it is.
 * The kind violet `#4a3aa7` is also series-4 and the planned status; the
 * family entry comes last, so outside a moment kind it stays `series-4`
 * (the two tokens hold the same values in both themes).
 */
export const THEME_HEX_TOKENS: Record<string, string> = {
  '#1b705f': 'canon',
  '#7a611b': 'idea',
  '#b84f25': 'serious-ink',
  ...KIND_HEX_TOKENS,
  ...Object.fromEntries(FAMILY_COLORS.map((t) => [FAMILY_TOKEN_HEX[t], t])),
};

/** A stored colour as CSS: `var(--token)` for a seeded colour, the hex for any other, or null. */
export function listColorCss(color: string | null | undefined): string | null {
  if (!color) return null;
  const token = THEME_HEX_TOKENS[color.toLowerCase()];
  return token ? `var(--${token})` : color;
}

/**
 * IP-12: the series token (`series-1` to `series-4`) a family colour is drawn
 * with, for the four colours families had before A47 (as a hex or, before
 * migration 11, as the token name). Null for any other colour, which the
 * renderer draws as the hex itself.
 */
export function familyToken(color: unknown): (typeof FAMILY_COLORS)[number] | null {
  if (typeof color !== 'string') return null;
  const c = color.toLowerCase();
  return FAMILY_COLORS.find((t) => t === c || FAMILY_TOKEN_HEX[t] === c) ?? null;
}

/** A family colour as CSS: its token for the four known colours, else the hex. */
export function familyColorCss(color: unknown): string | null {
  const token = familyToken(color);
  if (token) return `var(--${token})`;
  return typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color) ? color : null;
}

type ListDocs = readonly { _id?: unknown; items?: unknown }[];

const itemsOf = (lists: ListDocs, listId: string): Partial<ListItem>[] => {
  const list = lists.find((l) => l._id === listId);
  return Array.isArray(list?.items) ? (list.items as Partial<ListItem>[]) : [];
};

/**
 * IP-9: the status to write when code means "a status of this kind": the
 * first status item of that kind, else the item whose ID is the kind (a list
 * without kinds), else the first status, else the kind word itself (no list).
 */
export function defaultStatus(lists: ListDocs, kind: StatusKind): string {
  const items = itemsOf(lists, 'statuses');
  const hit =
    items.find((i) => i.extra?.kind === kind) ??
    items.find((i) => i.id === kind && i.extra?.kind === undefined) ??
    items[0];
  return typeof hit?.id === 'string' ? hit.id : kind;
}

/**
 * IP-9: the provenance to write when code means a seeded one (`researched`,
 * `invented`): that item while the list holds it, else none (provenance may
 * be blank). With no list at all, the ID itself.
 */
export function defaultProvenance(lists: ListDocs, id: string): string | null {
  const list = lists.find((l) => l._id === 'provenance');
  if (!list) return id;
  return itemsOf(lists, 'provenance').some((i) => i.id === id) ? id : null;
}

// ---------- A51: moment kinds (SM-3, SM-9, IP-9) ----------

/** A51: how large a kind's markers draw on the Backstory grid, from the item's `extra.weight`. */
export const MOMENT_KIND_WEIGHTS = ['plain', 'big'] as const;
export type MomentKindWeight = (typeof MOMENT_KIND_WEIGHTS)[number];

/**
 * A51: a moment kind item as the grid draws it, or undefined for no kind or
 * an ID the list does not hold. `lists` is the bible's list documents.
 */
export function momentKindItem(
  lists: ListDocs,
  kind: string | null | undefined,
): Partial<ListItem> | undefined {
  if (!kind) return undefined;
  return itemsOf(lists, 'momentKinds').find((i) => i.id === kind);
}

/** A51: an item's weight; anything but `big` reads as plain. */
export function kindWeight(
  item: Pick<Partial<ListItem>, 'extra'> | null | undefined,
): MomentKindWeight {
  return item?.extra?.weight === 'big' ? 'big' : 'plain';
}

/**
 * A51: the CSS colour a moment kind's marker draws in: the token for a seeded
 * hex (so it follows the theme), the hex for a colour the writer picked, and
 * null for a kind with no colour (Voice) or no kind at all. The caller picks
 * the fallback: `--fg-2` for a kind with no colour, `--fg` for no kind.
 */
export function kindColorCss(
  item: Pick<Partial<ListItem>, 'color'> | null | undefined,
): string | null {
  const color = item?.color;
  if (!color) return null;
  const token = KIND_HEX_TOKENS[color.toLowerCase()];
  return token ? `var(--${token})` : listColorCss(color);
}
