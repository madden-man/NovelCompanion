import { z } from 'zod';

/** A user-editable list (ED-8). Hierarchical lists use `parentId`. */
export const ListItem = z.strictObject({
  id: z.string().min(1),
  label: z.string().min(1),
  parentId: z.string().nullable().default(null),
});

export const ListDoc = z.strictObject({
  _id: z.string().min(1),
  label: z.string().min(1),
  items: z.array(ListItem),
});
export type ListDoc = z.infer<typeof ListDoc>;

export const LIST_IDS = [
  'unionTypes',
  'parentLinkTypes',
  'communities',
  'statuses',
  'provenance',
  'eventCategories',
  'romanizationSystems',
] as const;
export type ListId = (typeof LIST_IDS)[number];
