import { z } from 'zod';
import { Id, Year, entry } from './common';

/** A5: books contain parts, parts contain chapters. */
export const Book = entry({
  number: z.int().min(1),
  summary: z.string().default(''),
});
export type Book = z.infer<typeof Book>;

export const Part = entry({
  bookId: Id,
  number: z.int().min(1),
  summary: z.string().default(''),
});
export type Part = z.infer<typeof Part>;

/**
 * A chapter strand (A5). Exactly one strand per chapter is primary and supplies
 * the chapter's story year.
 */
export const Strand = z
  .strictObject({
    id: Id,
    label: z.string().min(1),
    startYear: Year,
    endYear: Year.nullable().default(null),
    primary: z.boolean(),
    povCharacterId: Id.nullable().default(null),
    characterIds: z.array(Id).default([]),
    placeIds: z.array(Id).default([]),
  })
  .refine((s) => s.endYear === null || s.endYear >= s.startYear, {
    message: 'The strand ends before it starts',
  });
export type Strand = z.infer<typeof Strand>;

/** KN-3: which characters act on which facts in a chapter. */
export const FactInPlay = z.strictObject({
  factId: Id,
  characterId: Id,
  note: z.string().default(''),
});

export const Chapter = entry({
  partId: Id,
  readingOrder: z.int().min(1),
  strands: z
    .array(Strand)
    .min(1)
    .refine((strands) => strands.filter((s) => s.primary).length === 1, {
      message: 'Exactly one strand must be primary',
    }),
  arcIds: z.array(Id).default([]),
  themeIds: z.array(Id).default([]),
  factsInPlay: z.array(FactInPlay).default([]),
  written: z.boolean().default(false),
  /** Read-only import of the manuscript (MS-5). */
  manuscriptText: z.string().default(''),
  summary: z.string().default(''),
  sourceFile: z.string().nullable().default(null),
});
export type Chapter = z.infer<typeof Chapter>;

/** A fact is a secret or a piece of family history; its text is the shared body. */
export const Fact = entry({});
export type Fact = z.infer<typeof Fact>;

export const KnowledgeRecord = entry({
  factId: Id,
  characterId: Id,
  yearLearned: Year.nullable(),
  chapterLearnedId: Id.nullable().default(null),
  how: z.string().default(''),
});
export type KnowledgeRecord = z.infer<typeof KnowledgeRecord>;
