import { z } from 'zod';

/** A user-editable list (ED-8). Hierarchical lists use `parentId`. */
export const ListItem = z.strictObject({
  id: z.string().min(1),
  label: z.string().min(1),
  parentId: z.string().nullable().default(null),
});
export type ListItem = z.infer<typeof ListItem>;

export const ListDoc = z.strictObject({
  _id: z.string().min(1),
  label: z.string().min(1),
  items: z.array(ListItem),
});
export type ListDoc = z.infer<typeof ListDoc>;

/** Lists stored in the `lists` collection of every bible. */
export const LIST_IDS = [
  'unionTypes',
  'parentLinkTypes',
  'communities',
  'statuses',
  'provenance',
  'eventCategories',
  'romanizationSystems',
  'languages',
  'tags',
] as const;
export type ListId = (typeof LIST_IDS)[number];

/**
 * Lists in the `lists` collection that configure the bible rather than name
 * choices: `eraDefaults` holds the default era ranges a new bible copies into
 * era states (WE-2). They are not shown on the Lists screen.
 */
export const CONFIG_LIST_IDS = ['eraDefaults'] as const;

/**
 * Lists the app shows and renames alongside the stored ones, but whose items
 * are entries or definitions: family names, custom section names, and era
 * names with their ranges (ED-8).
 */
export const DERIVED_LIST_IDS = ['families', 'sectionNames', 'eraRanges'] as const;
export type DerivedListId = (typeof DERIVED_LIST_IDS)[number];

export type AnyListId = ListId | DerivedListId;

export const AnyListIdSchema = z.enum([...LIST_IDS, ...DERIVED_LIST_IDS]);

/**
 * The choices of a single-choice field in a custom section are a list too
 * (ED-8, CS-1): `choice:<sectionId>:<fieldId>`, items keyed by the choice text.
 */
export const CHOICE_LIST_PATTERN = /^choice:([A-Za-z0-9_-]+):([A-Za-z0-9_-]+)$/;

export function choiceListId(sectionId: string, fieldId: string): string {
  return `choice:${sectionId}:${fieldId}`;
}

export function parseChoiceListId(id: string): { sectionId: string; fieldId: string } | null {
  const [, sectionId, fieldId] = CHOICE_LIST_PATTERN.exec(id) ?? [];
  return sectionId && fieldId ? { sectionId, fieldId } : null;
}

/** Any list the app can show, rename in, add to, or remove from. */
export const ListIdParam = z.union([AnyListIdSchema, z.string().regex(CHOICE_LIST_PATTERN)]);

/** Lists whose items are fixed by the schema; their labels can change, their items cannot. */
export const FIXED_ITEM_LISTS: readonly string[] = ['statuses', 'provenance'];
