/**
 * Tokenizer for the in-process search index (ARCH-2, SR-1, GL-2).
 * Latin script text becomes lowercase words with diacritics and tone marks
 * removed. Chinese, Japanese, and Korean text has no spaces, so each run of
 * those characters becomes overlapping character bigrams.
 */

const CJK = '\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}';
const RUNS = new RegExp(`([${CJK}]+)|((?:(?![${CJK}])[\\p{L}\\p{M}\\p{N}])+)`, 'gu');

/** Romanization with tone numbers, such as xiao3xi1 or gwong2dung1: letters then a digit, repeated. */
const TONE_NUMBERED = /^(?:[a-z]{2,7}[0-5])+$/;

/**
 * Lowercase a word and drop tone marks. A word made of syllables with tone
 * numbers also loses the numbers, so xiao3 and xiǎo both find xiǎo (GL-2).
 */
export function foldLatin(word: string): string {
  const folded = word.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  return TONE_NUMBERED.test(folded) ? folded.replace(/[0-5]/g, '') : folded;
}

function bigrams(run: string): string[] {
  const chars = [...run];
  return chars.slice(1).map((c, i) => `${chars[i] ?? ''}${c}`);
}

/**
 * Tokens for indexing: words, CJK bigrams, and every CJK character on its own
 * so that a one-character query finds a longer name.
 */
export function tokenizeForIndex(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(RUNS)) {
    if (m[1]) {
      const chars = [...m[1]];
      out.push(...chars);
      out.push(...bigrams(m[1]));
    } else if (m[2]) {
      out.push(foldLatin(m[2]));
    }
  }
  return out;
}

/**
 * Tokens for a query: words and CJK bigrams, or the single character when a
 * CJK run has only one character.
 */
export function tokenizeForQuery(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(RUNS)) {
    if (m[1]) {
      const chars = [...m[1]];
      if (chars.length === 1) out.push(m[1]);
      else out.push(...bigrams(m[1]));
    } else if (m[2]) {
      out.push(foldLatin(m[2]));
    }
  }
  return out;
}
