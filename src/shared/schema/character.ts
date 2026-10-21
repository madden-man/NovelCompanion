import { z } from 'zod';
import { Id, StoryDate, entry } from './common';
import { commonFields, f } from './manifest';
import type { FieldSpec } from './manifest';

/** SM-1 names: the full name, and the name in Chinese characters where there is one. */
export const Names = z.strictObject({
  full: z.string().min(1),
  chinese: z.string().optional(),
});

/** SM-1: the character as the writer fills it by hand. */
export const Character = entry({
  /** A38: one or two sentences on what they are to the story, shown first on their page. */
  role: z.string().default(''),
  names: Names,
  birth: StoryDate,
  /** Null means the character is not recorded as dead. */
  death: StoryDate.nullable().default(null),
  familyIds: z.array(Id).default([]),
  backstory: z.string().default(''),
});
export type Character = z.infer<typeof Character>;

export const characterFields: FieldSpec[] = [
  ...commonFields,
  f.longText('role', 'In the story', {
    hint: 'One or two sentences: what they are to the story.',
  }),
  f.object(
    'names',
    'Names',
    [
      f.text('full', 'Full name', { required: true }),
      f.text('chinese', 'Name in Chinese characters'),
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
  f.refs('familyIds', 'Families', ['families']),
  f.longText('backstory', 'Backstory'),
];
