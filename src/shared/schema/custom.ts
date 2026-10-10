import { z } from 'zod';
import { Id, Timestamp, entry } from './common';

/** CS-1 field types. */
export const CustomFieldType = z.enum([
  'text',
  'longText',
  'number',
  'year',
  'yearRange',
  'singleChoice',
  'tags',
  'link',
]);

export const CustomField = z.strictObject({
  id: Id,
  label: z.string().min(1),
  type: CustomFieldType,
  options: z.array(z.string()).default([]),
});

/** A custom section definition. It is a schema, not an entry. */
export const CustomSection = z.strictObject({
  _id: Id,
  name: z.string().min(1),
  fields: z.array(CustomField),
  /** CS-3 brief selection rule. */
  briefRule: z.enum(['linked', 'storyYear', 'always', 'never']).default('linked'),
  createdAt: Timestamp,
  modifiedAt: Timestamp,
});
export type CustomSection = z.infer<typeof CustomSection>;

const CustomValue = z.union([
  z.string(),
  z.number(),
  z.null(),
  z.array(z.string()),
  z.strictObject({ startYear: z.int().nullable(), endYear: z.int().nullable() }),
]);

/** An entry in a custom section (CS-2): shared entry fields plus values keyed by field ID. */
export const CustomEntry = entry({
  sectionId: Id,
  values: z.record(z.string(), CustomValue),
});
export type CustomEntry = z.infer<typeof CustomEntry>;
