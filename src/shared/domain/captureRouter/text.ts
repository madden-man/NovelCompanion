/**
 * Capture routing (A48): text helpers shared by the index and the resolver.
 * Matching runs on a folded copy of the text that keeps every offset, so a
 * span found in the folded text names the same characters in the original.
 */

/** Romanization with tone numbers, such as xiao3xi1: letters then a digit, repeated. */
const TONE_NUMBERED = /^(?:[a-z]{2,7}[0-5])+$/;
const MARKS = /\p{M}/gu;

/**
 * Copied from `src/main/search/tokenize.ts` (`foldLatin`), since the router
 * may import nothing from `src/main`: lowercase a word and drop tone marks; a
 * word made of tone-numbered syllables also loses the numbers.
 */
export function foldLatin(word: string): string {
  const folded = word.normalize('NFD').replace(MARKS, '').toLowerCase();
  return TONE_NUMBERED.test(folded) ? folded.replace(/[0-5]/g, '') : folded;
}

const CURLY = /[‘’ʼ]/g;
const SPACES = /\s+/g;

/** An alias as the index stores it: folded, straight apostrophes, single spaces. */
export function foldAlias(alias: string): string {
  return foldLatin(alias.replace(CURLY, "'")).replace(SPACES, ' ').trim();
}

/** A label without its parenthetical: "China (national)" gives "China". */
export function withoutParenthetical(label: string): string {
  return label
    .replace(/\s*\([^)]*\)\s*/g, ' ')
    .replace(SPACES, ' ')
    .trim();
}

/**
 * The text in three forms with the same length: as typed (NFC), with marks
 * dropped and apostrophes straightened (`folded`, case kept), and lowercase
 * (`lower`). A character whose fold would change the length is kept as is.
 */
export interface FoldedText {
  text: string;
  folded: string;
  lower: string;
}

export function foldText(input: string): FoldedText {
  const text = input.normalize('NFC');
  let folded = '';
  let lower = '';
  for (const ch of text) {
    let f = ch === '‘' || ch === '’' || ch === 'ʼ' ? "'" : ch.normalize('NFD').replace(MARKS, '');
    if (f.length !== ch.length) f = ch;
    let l = f.toLowerCase();
    if (l.length !== f.length) l = f;
    folded += f;
    lower += l;
  }
  return { text, folded, lower };
}

const WORD_CHAR = /[\p{L}\p{N}]/u;
const HAN = /\p{Script=Han}/u;

export const isWordChar = (ch: string | undefined): boolean => !!ch && WORD_CHAR.test(ch);
export const hasHan = (s: string): boolean => HAN.test(s);

/**
 * Every start offset of `alias` in `lower` as a whole word or phrase. A
 * Latin match may end at an apostrophe ("sydney's" matches "sydney"); an
 * alias with Chinese characters matches anywhere, since Chinese has no spaces.
 */
export function findAll(lower: string, alias: string): number[] {
  const out: number[] = [];
  if (!alias) return out;
  const cjk = hasHan(alias);
  let at = lower.indexOf(alias);
  while (at !== -1) {
    const before = lower[at - 1];
    const after = lower[at + alias.length];
    const startOk = cjk || !isWordChar(alias[0]) || !isWordChar(before);
    const endOk = cjk || !isWordChar(alias[alias.length - 1]) || !isWordChar(after);
    if (startOk && endOk) out.push(at);
    at = lower.indexOf(alias, at + 1);
  }
  return out;
}

/** Escape a string for use inside a regular expression. */
export const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * One regular expression that finds any of `words` as a whole word or
 * phrase, built once when a module loads (never inside a loop).
 */
export function wordsPattern(words: readonly string[], flags = 'u'): RegExp {
  if (!words.length) return /(?!)/u;
  const sorted = [...words].sort((a, b) => b.length - a.length).map(escapeRegExp);
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${sorted.join('|')})(?![\\p{L}\\p{N}])`, flags);
}

/** Escape text for the body of an entry, which is stored as HTML. */
export const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
