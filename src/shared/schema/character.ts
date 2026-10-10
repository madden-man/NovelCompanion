import { z } from 'zod';
import { Id, StoryDate, Year, entry } from './common';

/** CH-2 names. */
export const Names = z.strictObject({
  full: z.string().min(1),
  chinese: z.string().optional(),
  romanization: z.string().optional(),
  order: z.enum(['family-first', 'family-last']).default('family-last'),
  birthName: z.string().optional(),
  marriedName: z.string().optional(),
  nicknames: z.array(z.string()).default([]),
  /** What each other character calls this one. */
  calledBy: z.array(z.strictObject({ characterId: Id, name: z.string().min(1) })).default([]),
});

/** A voice note stamped with a story year or an age (A9). */
export const VoiceNote = z.strictObject({
  at: z.union([z.strictObject({ year: Year }), z.strictObject({ age: z.int().min(0).max(200) })]),
  text: z.string(),
});

export const PlaceLived = z.strictObject({
  place: z.string().min(1),
  startYear: Year.nullable(),
  endYear: Year.nullable(),
});

export const Character = entry({
  names: Names,
  birth: StoryDate,
  /** Null means the character is not recorded as dead. */
  death: StoryDate.nullable().default(null),
  birthplace: z.string().default(''),
  familyIds: z.array(Id).default([]),
  backstory: z.string().default(''),
  voiceNotes: z.array(VoiceNote).default([]),
  placesLived: z.array(PlaceLived).default([]),
});
export type Character = z.infer<typeof Character>;
