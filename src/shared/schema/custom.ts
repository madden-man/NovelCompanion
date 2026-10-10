import { z } from 'zod';
import { Id, Timestamp, entry } from './common';
import { commonFields, f } from './manifest';
import type { FieldOption, FieldSpec } from './manifest';

/** CS-1 field types. */
export const CUSTOM_FIELD_TYPES = [
  'text',
  'longText',
  'number',
  'year',
  'yearRange',
  'singleChoice',
  'tags',
  'link',
] as const;
export const CustomFieldType = z.enum(CUSTOM_FIELD_TYPES);
export type CustomFieldType = z.infer<typeof CustomFieldType>;

export const CUSTOM_FIELD_TYPE_LABELS: Record<CustomFieldType, string> = {
  text: 'Text',
  longText: 'Long text',
  number: 'Number',
  year: 'Year',
  yearRange: 'Year range',
  singleChoice: 'Single choice',
  tags: 'Tags',
  link: 'Link to entry',
};

export const CustomField = z.strictObject({
  id: Id,
  label: z.string().min(1),
  type: CustomFieldType,
  options: z.array(z.string()).default([]),
});
export type CustomField = z.infer<typeof CustomField>;

/**
 * A custom section definition. It is a schema, not an entry, but it is
 * written through the same path, so it has history and a trash too.
 */
export const CustomSection = z.strictObject({
  _id: Id,
  name: z.string().min(1),
  fields: z.array(CustomField),
  /** CS-3 brief selection rule. */
  briefRule: z.enum(['linked', 'storyYear', 'always', 'never']).default('linked'),
  createdAt: Timestamp,
  modifiedAt: Timestamp,
  deletedAt: Timestamp.optional(),
});
export type CustomSection = z.infer<typeof CustomSection>;

export const customSectionFields: FieldSpec[] = [
  f.system('_id', 'ID'),
  f.text('name', 'Section name', { required: true }),
  f.objectList(
    'fields',
    'Fields',
    [
      f.system('id', 'Field ID'),
      f.text('label', 'Label', { required: true }),
      f.enum(
        'type',
        'Kind',
        CUSTOM_FIELD_TYPES.map((t) => ({ value: t, label: CUSTOM_FIELD_TYPE_LABELS[t] })),
        { required: true },
      ),
      f.strings('options', 'Choices', { hint: 'Only used by single choice fields.' }),
    ],
    { required: true, itemLabel: 'label' },
  ),
  f.enum('briefRule', 'Include in briefs', [
    { value: 'linked', label: 'When linked to the chapter' },
    { value: 'storyYear', label: 'When it matches the story year' },
    { value: 'always', label: 'Always' },
    { value: 'never', label: 'Never' },
  ]),
  f.system('createdAt', 'Created'),
  f.system('modifiedAt', 'Last changed'),
  f.system('deletedAt', 'Moved to trash'),
];

export const CustomYearRange = z.strictObject({
  startYear: z.int().nullable().default(null),
  endYear: z.int().nullable().default(null),
});

const CustomValue = z.union([
  z.string(),
  z.number(),
  z.null(),
  z.array(z.string()),
  CustomYearRange,
]);
export type CustomValue = z.infer<typeof CustomValue>;

/** An entry in a custom section (CS-2): shared entry fields plus values keyed by field ID. */
export const CustomEntry = entry({
  sectionId: Id,
  values: z.record(z.string(), CustomValue),
});
export type CustomEntry = z.infer<typeof CustomEntry>;

export const customEntryFields: FieldSpec[] = [
  ...commonFields,
  f.ref('sectionId', 'Section', ['customSections'], { required: true }),
  f.customValues('values', 'Fields', {
    required: true,
    warnings: ['missing-target', 'range-end-before-start', 'custom-value'],
  }),
];

/** The manifest of one section's own fields, so the editor and T-5 can walk them (CS-1). */
export function customFieldSpecs(section: Pick<CustomSection, 'fields'>): FieldSpec[] {
  return section.fields.map((cf): FieldSpec => {
    const options: FieldOption[] = cf.options.map((o) => ({ value: o, label: o }));
    switch (cf.type) {
      case 'text':
        return f.text(cf.id, cf.label);
      case 'longText':
        return f.longText(cf.id, cf.label);
      case 'number':
        return f.number(cf.id, cf.label, { nullable: true });
      case 'year':
        return f.year(cf.id, cf.label, { nullable: true });
      case 'yearRange':
        return f.object(cf.id, cf.label, [
          f.year('startYear', 'From', {
            nullable: true,
            rangeEnd: 'endYear',
            warnings: ['range-end-before-start'],
          }),
          f.year('endYear', 'To', { nullable: true, warnings: ['range-end-before-start'] }),
        ]);
      case 'singleChoice':
        return f.enum(cf.id, cf.label, options, { nullable: true });
      case 'tags':
        return f.tags(cf.id, cf.label);
      case 'link':
        return f.ref(cf.id, cf.label, ['*'], { nullable: true });
    }
  });
}
