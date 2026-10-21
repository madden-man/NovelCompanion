import { z } from 'zod';
import { WORD_KINDS } from './domain/words';

/**
 * WT-1: the writing tools channel. The renderer asks main to look a word up
 * on Datamuse (ARCHITECTURE rule 3: the renderer has no network). A read
 * channel: it writes nothing to the bible.
 */

export const WordKindWire = z.enum(WORD_KINDS);

export const WordDefinitionWire = z.strictObject({
  pos: z.string(),
  text: z.string(),
});

export const WordResultWire = z.strictObject({
  word: z.string(),
  score: z.number(),
  partsOfSpeech: z.array(z.string()),
  syllables: z.int().min(1).nullable(),
  definitions: z.array(WordDefinitionWire).optional(),
});
export type WordResultWire = z.infer<typeof WordResultWire>;

export const wordsContract = {
  'words.lookup': {
    request: z.strictObject({
      kind: WordKindWire,
      word: z.string().trim().min(1, 'Type a word first.').max(80),
    }),
    response: z.strictObject({
      kind: WordKindWire,
      word: z.string(),
      results: z.array(WordResultWire),
    }),
  },
} as const;
