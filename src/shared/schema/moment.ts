import { z } from 'zod';
import { Id, Year, entry } from './common';
import { commonFields, f, yearRange } from './manifest';
import type { FieldSpec } from './manifest';

/**
 * SM-3: a moment in one character's life, a row of their Backstory. `title`
 * (the common field) holds what happens. Migration 9 makes them from plot
 * beats, voice notes, and places lived.
 */
export const Moment = entry({
  characterId: Id,
  year: Year,
  /** Null for a single year. */
  endYear: Year.nullable().default(null),
  /** How the character experiences it. */
  body: z.string().default(''),
  /** Relevant world events, as text. */
  worldContext: z.string().default(''),
});
export type Moment = z.infer<typeof Moment>;

/** The title of a moment made from a voice note: how the character speaks at that time (SB-3). */
export const VOICE_MOMENT_TITLE = 'Voice';

/** The start of the title of a moment made from a place lived ("Lives in Guangzhou"). */
export const LIVES_IN_PREFIX = 'Lives in ';

/**
 * The common fields with the moment's own labels: the title is what happens
 * and the body is how the character experiences it.
 */
export const momentFields: FieldSpec[] = [
  ...commonFields.map((s) =>
    s.name === 'title'
      ? { ...s, label: 'What happens' }
      : s.name === 'body'
        ? { ...s, label: 'How they experience it' }
        : s,
  ),
  f.ref('characterId', 'Character', ['characters'], { required: true }),
  ...yearRange('year', 'endYear', ['Year', 'To'], { startRequired: true }).map((s) => ({
    ...s,
    ...(s.name === 'endYear' ? { hint: 'Leave blank for a single year.' } : {}),
    warnings: [...s.warnings, 'outside-lifetime'],
  })),
  f.longText('worldContext', 'Relevant world events'),
];
