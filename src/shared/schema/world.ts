import { z } from 'zod';
import { Id, StoryDate, Year, entry } from './common';

/** World event (A8): a date or year, or a range when `end` is set. */
export const WorldEvent = entry({
  start: StoryDate,
  end: StoryDate.nullable().default(null),
  reality: z.enum(['real', 'invented']),
  /** An item ID in the `eventCategories` list, which is a hierarchy. */
  categoryId: z.string().min(1),
  regions: z.array(z.string()).default([]),
  placeIds: z.array(Id).default([]),
  characterIds: z.array(Id).default([]),
  formative: z.boolean().default(false),
});
export type WorldEvent = z.infer<typeof WorldEvent>;

/** Era state (was decade state, A8): any year range. */
export const EraState = entry({
  name: z.string().min(1),
  startYear: Year,
  endYear: Year,
  technology: z.string().default(''),
  climate: z.string().default(''),
  economy: z.string().default(''),
  politics: z.string().default(''),
  dailyLife: z.string().default(''),
}).refine((e) => e.endYear >= e.startYear, { message: 'The era ends before it starts' });
export type EraState = z.infer<typeof EraState>;

/** Cultural entry (CU-1): a community list item ID and the years it applies to. */
export const CulturalEntry = entry({
  communityId: z.string().min(1),
  startYear: Year.nullable(),
  endYear: Year.nullable(),
  generationNotes: z.string().default(''),
});
export type CulturalEntry = z.infer<typeof CulturalEntry>;

export const GlossaryTerm = entry({
  characters: z.string().min(1),
  romanization: z.string().default(''),
  language: z.string().min(1),
  meaning: z.string().default(''),
  usageNote: z.string().default(''),
});
export type GlossaryTerm = z.infer<typeof GlossaryTerm>;
