import { z } from 'zod';
import { Id, StoryDate, Year, entry } from './common';
import { commonFields, f, yearRange } from './manifest';
import type { FieldSpec } from './manifest';

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

export const characterFields: FieldSpec[] = [
  ...commonFields,
  f.object(
    'names',
    'Names',
    [
      f.text('full', 'Full name', { required: true }),
      f.text('chinese', 'Name in Chinese characters'),
      f.text('romanization', 'Romanization'),
      f.enum(
        'order',
        'Name order',
        [
          { value: 'family-last', label: 'Family name last' },
          { value: 'family-first', label: 'Family name first' },
        ],
        { hint: 'Chinese names usually put the family name first.' },
      ),
      f.text('birthName', 'Birth name'),
      f.text('marriedName', 'Married name'),
      f.strings('nicknames', 'Nicknames'),
      f.objectList(
        'calledBy',
        'What others call them',
        [
          f.ref('characterId', 'Character', ['characters'], { required: true }),
          f.text('name', 'Calls them', { required: true }),
        ],
        { itemLabel: 'name' },
      ),
    ],
    { required: true },
  ),
  f.storyDate('birth', 'Birth', {
    required: true,
    warnings: ['impossible-date'],
    hint: 'A full date, a year, or unknown.',
  }),
  f.storyDate('death', 'Death', {
    nullable: true,
    warnings: ['death-before-birth', 'impossible-date'],
    hint: 'Leave blank if the character is not recorded as dead.',
  }),
  f.text('birthplace', 'Birthplace'),
  f.refs('familyIds', 'Families', ['families']),
  f.longText('backstory', 'Backstory'),
  f.objectList(
    'voiceNotes',
    'Voice notes',
    [
      f.yearOrAge('at', 'At year or age', {
        required: true,
        warnings: ['outside-lifetime'],
      }),
      f.longText('text', 'Note', { required: true }),
    ],
    { itemLabel: 'text' },
  ),
  f.objectList(
    'placesLived',
    'Places lived',
    [
      f.text('place', 'Place', { required: true }),
      ...yearRange('startYear', 'endYear', ['From', 'To']).map((s) => ({
        ...s,
        required: true,
        warnings: [...s.warnings, 'outside-lifetime'],
      })),
    ],
    { itemLabel: 'place' },
  ),
];
