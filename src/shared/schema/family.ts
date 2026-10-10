import { z } from 'zod';
import { Id, Year, entry } from './common';

export const Family = entry({
  name: z.string().min(1),
  notes: z.string().default(''),
  /** A series token name from the theme, for example `series-1`. */
  color: z.string().default('series-1'),
});
export type Family = z.infer<typeof Family>;

/** Union types are a user-editable list; the value is a list item ID. */
export const Union = entry({
  partnerIds: z.tuple([Id, Id]),
  type: z.string().min(1),
  startYear: Year.nullable().default(null),
  endYear: Year.nullable().default(null),
  endReason: z.string().default(''),
});
export type Union = z.infer<typeof Union>;

/** Parent-link types are a user-editable list; the value is a list item ID. */
export const ParentLink = entry({
  parentId: Id,
  childId: Id,
  type: z.string().min(1),
  startYear: Year.nullable().default(null),
}).refine((p) => p.parentId !== p.childId, { message: 'A person cannot be their own parent' });
export type ParentLink = z.infer<typeof ParentLink>;
