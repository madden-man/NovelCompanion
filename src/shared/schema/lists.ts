import { z } from 'zod';

/** A CSS hex colour, for example `#2a78d6` (A47, IP-9, IP-12). */
export const HexColor = z
  .string()
  .regex(/^#[0-9a-f]{6}$/i, 'A colour is a hex value such as #2a78d6.');

/**
 * A user-editable list (ED-8). Hierarchical lists use `parentId`. A47 (IP-8):
 * every item may carry a colour and a few extra values (a status kind, an
 * age group's from and to), so one shape serves every list.
 */
export const ListItem = z.strictObject({
  id: z.string().min(1),
  label: z.string().min(1),
  parentId: z.string().nullable().default(null),
  color: HexColor.nullable().default(null),
  extra: z.record(z.string(), z.union([z.string(), z.number()])).default({}),
});
/**
 * An item as code holds it. A parsed item always has `color` and `extra`; they
 * are optional in the type so code that makes an item from a label need not
 * spell them out (the schema fills them in).
 */
export type ListItem = Omit<z.infer<typeof ListItem>, 'color' | 'extra'> &
  Partial<Pick<z.infer<typeof ListItem>, 'color' | 'extra'>>;
/** An item as the schema stores and returns it, colour and extra always present. */
export type StoredListItem = z.infer<typeof ListItem>;
/** An item as code writes it: colour and extra may be left out. */
export type ListItemInput = z.input<typeof ListItem>;

export const ListDoc = z.strictObject({
  _id: z.string().min(1),
  label: z.string().min(1),
  items: z.array(ListItem),
});
export type ListDoc = Omit<z.infer<typeof ListDoc>, 'items'> & { items: ListItem[] };

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
  /** A47 (IP-8): the regions world events name, by item ID. */
  'regions',
  /** A47 (IP-10): who a cultural line is about; `extra.from` and `extra.to` in years. */
  'ageGroups',
] as const;
export type ListId = (typeof LIST_IDS)[number];

/** A47 (IP-9): what a status means to the brief rules (SB-5). Every status item carries one in `extra.kind`. */
export const STATUS_KINDS = ['canon', 'planned', 'idea'] as const;
export type StatusKind = (typeof STATUS_KINDS)[number];

/**
 * Lists in the `lists` collection that configure the bible rather than name
 * choices: `eraDefaults` holds the default era ranges a new bible copies into
 * era states (WE-2). They are not shown on the Lists screen.
 */
export const CONFIG_LIST_IDS = ['eraDefaults'] as const;

/**
 * Lists the app shows and renames alongside the stored ones, but whose items
 * are entries: family names, and era names with their ranges (ED-8).
 */
export const DERIVED_LIST_IDS = ['families', 'eraRanges'] as const;
export type DerivedListId = (typeof DERIVED_LIST_IDS)[number];

export type AnyListId = ListId | DerivedListId;

export const AnyListIdSchema = z.enum([...LIST_IDS, ...DERIVED_LIST_IDS]);

/** Any list the app can show, rename in, add to, or remove from. */
export const ListIdParam = z.string().refine((id) => AnyListIdSchema.safeParse(id).success, {
  message: 'There is no list with that ID.',
});
