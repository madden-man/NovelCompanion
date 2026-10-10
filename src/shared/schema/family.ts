import { z } from 'zod';
import { Id, Year, entry } from './common';
import { commonFields, f, yearRange } from './manifest';
import type { FieldSpec } from './manifest';

/** Display colors are series tokens from the theme. */
export const FAMILY_COLORS = ['series-1', 'series-2', 'series-3', 'series-4'] as const;

export const Family = entry({
  name: z.string().min(1),
  notes: z.string().default(''),
  /** A series token name from the theme, for example `series-1`. */
  color: z.enum(FAMILY_COLORS).default('series-1'),
});
export type Family = z.infer<typeof Family>;

export const familyFields: FieldSpec[] = [
  ...commonFields,
  f.text('name', 'Family name', { required: true }),
  f.longText('notes', 'Notes'),
  f.enum(
    'color',
    'Display color',
    FAMILY_COLORS.map((c, i) => ({ value: c, label: `Color ${i + 1}` })),
  ),
];

/** Union types are a user-editable list; the value is a list item ID. */
export const Union = entry({
  partnerIds: z.tuple([Id, Id]),
  type: z.string().min(1),
  startYear: Year.nullable().default(null),
  endYear: Year.nullable().default(null),
  endReason: z.string().default(''),
});
export type Union = z.infer<typeof Union>;

export const unionFields: FieldSpec[] = [
  ...commonFields,
  f.refPair('partnerIds', 'Partners', ['characters']),
  f.listItem('type', 'Union type', 'unionTypes', { required: true }),
  ...yearRange('startYear', 'endYear').map((s) => ({
    ...s,
    warnings:
      s.name === 'startYear'
        ? [...s.warnings, 'union-before-birth', 'overlapping-unions', 'born-before-union']
        : [...s.warnings, 'union-before-birth'],
  })),
  f.text('endReason', 'How it ended'),
];

/** Parent-link types are a user-editable list; the value is a list item ID. */
export const ParentLink = entry({
  parentId: Id,
  childId: Id,
  type: z.string().min(1),
  startYear: Year.nullable().default(null),
}).refine((p) => p.parentId !== p.childId, { message: 'A person cannot be their own parent' });
export type ParentLink = z.infer<typeof ParentLink>;

export const parentLinkFields: FieldSpec[] = [
  ...commonFields,
  f.ref('parentId', 'Parent', ['characters'], {
    required: true,
    warnings: ['missing-target', 'parent-age'],
  }),
  f.ref('childId', 'Child', ['characters'], {
    required: true,
    warnings: ['missing-target', 'born-after-parent-death'],
  }),
  f.listItem('type', 'Link type', 'parentLinkTypes', { required: true }),
  f.year('startYear', 'Start year', {
    nullable: true,
    hint: 'For adoptive, step, and guardian links: the year it began.',
  }),
];

/** Relationship (section 4): two characters, a free-text type, and a year range. */
export const Relationship = entry({
  characterIds: z.tuple([Id, Id]),
  type: z.string().default(''),
  startYear: Year.nullable().default(null),
  endYear: Year.nullable().default(null),
});
export type Relationship = z.infer<typeof Relationship>;

export const relationshipFields: FieldSpec[] = [
  ...commonFields,
  f.refPair('characterIds', 'Characters', ['characters']),
  f.text('type', 'Relationship', { hint: 'For example friend, rival, or employer.' }),
  ...yearRange('startYear', 'endYear'),
];
