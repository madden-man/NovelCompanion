import { z } from 'zod';
import { Id, StoryDate, Year, entry } from './common';
import { commonFields, f, yearRange } from './manifest';
import type { FieldSpec } from './manifest';

/** World event (A8): a date or year, or a range when `end` is set. */
export const WorldEvent = entry({
  start: StoryDate,
  end: StoryDate.nullable().default(null),
  /** An item ID in the `eventCategories` list, which is a hierarchy. */
  categoryId: z.string().min(1),
  /** A47 (IP-8): item IDs in the `regions` list, so a rename reaches every event. */
  regions: z.array(z.string().min(1)).default([]),
  characterIds: z.array(Id).default([]),
  formative: z.boolean().default(false),
});
export type WorldEvent = z.infer<typeof WorldEvent>;

export const worldEventFields: FieldSpec[] = [
  ...commonFields,
  f.storyDate('start', 'Date or start', { required: true, warnings: ['impossible-date'] }),
  f.storyDate('end', 'End', {
    nullable: true,
    warnings: ['range-end-before-start', 'impossible-date'],
    hint: 'Leave blank for a single date or year.',
  }),
  f.listItem('categoryId', 'Category', 'eventCategories', { required: true }),
  f.listItems('regions', 'Regions', 'regions'),
  f.refs('characterIds', 'Characters affected', ['characters']),
  f.boolean('formative', 'Formative', {
    hint: 'Formative events reach the session selection for anyone who lived through them.',
  }),
];

/** Era state (was decade state, A8): any year range. An end before the start is a warning. */
export const EraState = entry({
  name: z.string().min(1),
  startYear: Year,
  endYear: Year,
});
export type EraState = z.infer<typeof EraState>;

export const eraStateFields: FieldSpec[] = [
  ...commonFields,
  f.text('name', 'Era name', { required: true }),
  ...yearRange('startYear', 'endYear', ['Start year', 'End year'], {
    startRequired: true,
    nullable: false,
  }).map((s) => ({ ...s, required: true })),
];

/**
 * A41: who a cultural line is about: everyone in the community, or one age
 * group. A47 (IP-10): these are the seeded items of the `ageGroups` list, and
 * a line stores an item ID of that list.
 */
export const DEMOGRAPHIC_IDS = ['all', '0-18', '18-30', '30-50', '50-70', '70+'] as const;
/** An item ID in the `ageGroups` list (A47); `all` is everyone. */
export const Demographic = z.string().min(1).max(64);
export type Demographic = z.infer<typeof Demographic>;
export const DEMOGRAPHIC_OPTIONS: { value: string; label: string }[] = [
  { value: 'all', label: 'Everyone' },
  { value: '0-18', label: 'Ages 0 to 18' },
  { value: '18-30', label: 'Ages 18 to 30' },
  { value: '30-50', label: 'Ages 30 to 50' },
  { value: '50-70', label: 'Ages 50 to 70' },
  { value: '70+', label: 'Ages 70 and over' },
];

/** Cultural entry (CU-1): a community list item ID and the years it applies to. */
export const CulturalEntry = entry({
  communityId: z.string().min(1),
  startYear: Year.nullable(),
  endYear: Year.nullable(),
  /** A41: the age group the line is about; an entry made before A41 is about everyone. */
  demographic: Demographic.default('all'),
});
export type CulturalEntry = z.infer<typeof CulturalEntry>;

export const culturalEntryFields: FieldSpec[] = [
  ...commonFields,
  f.listItem('communityId', 'Community', 'communities', { required: true }),
  f.listItem('demographic', 'Age group', 'ageGroups'),
  ...yearRange('startYear', 'endYear', ['Applies from', 'Applies to']).map((s) => ({
    ...s,
    required: true,
  })),
];

export const GlossaryTerm = entry({
  characters: z.string().min(1),
  romanization: z.string().default(''),
  language: z.string().min(1),
  meaning: z.string().default(''),
  usageNote: z.string().default(''),
});
export type GlossaryTerm = z.infer<typeof GlossaryTerm>;

export const glossaryTermFields: FieldSpec[] = [
  ...commonFields,
  f.text('characters', 'Term in characters', { required: true }),
  f.text('romanization', 'Romanization', { warnings: ['romanization-system'] }),
  f.listItem('language', 'Language', 'languages', { required: true }),
  f.longText('meaning', 'Meaning'),
  f.longText('usageNote', 'Usage note'),
];

/** A description of a place for a span of years (PC-1). */
export const PlaceDescription = z.strictObject({
  startYear: Year.nullable(),
  endYear: Year.nullable(),
  text: z.string(),
});

/** Places nest: city, district, building (PC-1). */
export const Place = entry({
  parentId: Id.nullable().default(null),
  communityId: z.string().nullable().default(null),
  descriptions: z.array(PlaceDescription).default([]),
});
export type Place = z.infer<typeof Place>;

export const placeFields: FieldSpec[] = [
  ...commonFields,
  f.ref('parentId', 'Inside', ['places'], {
    nullable: true,
    warnings: ['missing-target', 'self-reference'],
    hint: 'The larger place this one sits in.',
  }),
  f.listItem('communityId', 'Community', 'communities', { nullable: true }),
  f.objectList(
    'descriptions',
    'Descriptions by year',
    [
      ...yearRange('startYear', 'endYear').map((s) => ({ ...s, required: true })),
      f.longText('text', 'Description', { required: true }),
    ],
    { itemLabel: 'text' },
  ),
];
