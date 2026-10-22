import { z } from 'zod';
import { Id, Year, entry } from './common';
import { commonFields, f, yearRange } from './manifest';
import type { FieldSpec } from './manifest';

/**
 * The four series tokens families used before A47, in order, with the hex
 * value each token has in the light theme (`theme.css`). Migration 11 stores
 * the hex; the renderer keeps drawing these four through their tokens, so
 * they still change with the theme (IP-12).
 */
export const FAMILY_COLORS = ['series-1', 'series-2', 'series-3', 'series-4'] as const;
export const FAMILY_TOKEN_HEX: Record<(typeof FAMILY_COLORS)[number], string> = {
  'series-1': '#2a78d6',
  'series-2': '#eb6834',
  'series-3': '#1baf7a',
  'series-4': '#4a3aa7',
};

export const Family = entry({
  name: z.string().min(1),
  notes: z.string().default(''),
  /** A47 (IP-12): any CSS hex colour, for example `#2a78d6`. */
  color: z
    .string()
    .regex(/^#[0-9a-f]{6}$/i, 'A family colour is a hex value such as #2a78d6.')
    .default(FAMILY_TOKEN_HEX['series-1']),
});
export type Family = z.infer<typeof Family>;

export const familyFields: FieldSpec[] = [
  ...commonFields,
  f.text('name', 'Family name', { required: true }),
  f.longText('notes', 'Notes'),
  f.text('color', 'Display color', { hint: 'A hex colour such as #2a78d6.' }),
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
