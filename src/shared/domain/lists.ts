/**
 * Editable lists (ED-8): where each list is used, how many entries use an
 * item, and the entry change a rename of a family or an era makes. Pure; the
 * repository applies the changes in one transaction.
 */
import type { FieldSpec } from '../schema/manifest';
import type { ListItem } from '../schema/lists';
import { FAMILY_COLORS, FAMILY_TOKEN_HEX } from '../schema/family';
import {
  CHART_SURFACE_DARK,
  CHART_SURFACE_LIGHT,
  MIN_MARKER_CONTRAST,
  contrastRatio,
} from './colour';
import { isPlainObject } from './paths';
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

/** True when the field holds an item of this list, by its ID. */
function usesItem(
  spec: FieldSpec,
  value: unknown,
  listId: string,
  item: Pick<ListItem, 'id' | 'label'>,
): boolean {
  if (spec.listId !== listId) return false;
  if (spec.kind === 'listItem') return value === item.id;
  if (spec.kind === 'listItems') return Array.isArray(value) && value.includes(item.id);
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
 * The kind violet `#4a3aa7` is also series-4; the family entry comes last, so outside a moment kind it stays `series-4`
 * (the two tokens hold the same values in both themes).
 */
export const THEME_HEX_TOKENS: Record<string, string> = {
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

/**
 * A51: the dark theme value of each seeded kind's `--kind-*` token, by the
 * light hex the list stores (as in `theme.css`). A seeded colour is drawn
 * through its token, so in the dark theme it is this hex, not the stored one.
 */
export const KIND_DARK_HEX: Record<string, string> = {
  '#008300': '#008300',
  '#e34948': '#e66767',
  '#4a3aa7': '#9085e9',
};

/**
 * A51: the hex a kind colour is drawn in, in each theme. A seeded colour
 * takes its token's dark value; a colour the writer picked is drawn as its
 * hex in both themes.
 */
export function kindDrawnHex(color: string): { light: string; dark: string } {
  const light = color.toLowerCase();
  return { light, dark: KIND_DARK_HEX[light] ?? light };
}

/** A51 (NF-2): a kind colour's contrast against the light and the dark chart surface. */
export interface KindContrast {
  light: number;
  dark: number;
  /** True when the marker is under 3:1 on that surface. */
  hardOnLight: boolean;
  hardOnDark: boolean;
}

/**
 * A51 (NF-2, IP-9): the Lists screen's check of a kind colour against both
 * chart surfaces, by the colour it is drawn in there. Null for a kind with no
 * colour (Voice) or a value that is not a `#rrggbb` hex.
 */
export function kindContrast(color: string | null | undefined): KindContrast | null {
  if (!color || !/^#[0-9a-f]{6}$/i.test(color)) return null;
  const drawn = kindDrawnHex(color);
  const light = contrastRatio(drawn.light, CHART_SURFACE_LIGHT);
  const dark = contrastRatio(drawn.dark, CHART_SURFACE_DARK);
  return {
    light,
    dark,
    hardOnLight: light < MIN_MARKER_CONTRAST,
    hardOnDark: dark < MIN_MARKER_CONTRAST,
  };
}
