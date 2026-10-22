/**
 * Capture routing (A48, CR-2): split a capture into sentences and read the
 * years each one gives. Every regular expression is built once, when the
 * module loads, from the year grammar in the lexicon.
 */
import { LEXICON } from './lexicon';
import { escapeRegExp, foldText } from './text';

const Y = '(1[5-9]\\d\\d|2[0-4]\\d\\d)';
const DECADE3 = '(1[5-9]\\d|2[0-4]\\d)0s';
const alt = (words: readonly string[]) =>
  [...words]
    .sort((a, b) => b.length - a.length)
    .map((w) => escapeRegExp(w).replace(/ /g, '\\s+'))
    .join('|');

const G = LEXICON.years;
const SPAN = new RegExp(`(?<!\\p{N})${Y}s?\\s*(?:${alt(G.spanJoiners)})\\s*${Y}(?!\\p{N})`, 'u');
const BY = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:${alt(G.openStartWords)})\\s+(?:the\\s+)?(?:${DECADE3}|${Y})(?!\\p{N})`,
  'u',
);
const DECADE = new RegExp(`(?<!\\p{N})${DECADE3}(?![\\p{L}\\p{N}])`, 'u');
const END = new RegExp(`(?<![\\p{L}\\p{N}])(?:${alt(G.endWords)})\\s+${Y}(?![\\p{N}s])`, 'u');
const YEARS = new RegExp(`(?<!\\p{N})${Y}(?!\\p{N})`, 'gu');

/** The years a sentence gives of its own; `start` null means it gave only an end. */
export interface OwnYears {
  start: number | null;
  end: number | null;
  source: string;
  /** Every year written in the sentence, in order. */
  years: number[];
}

export const YEAR_SOURCES = {
  year: 'a year in the text',
  span: 'a span in the text',
  decade: 'a decade in the text',
  by: '"by" a year in the text, taken as the start with an open end',
  end: 'an end year in the text',
  story: 'the story year',
  before: 'the year of the sentence before',
} as const;

/** CR-2: the years one sentence sets, or null when it names no year. */
export function parseYears(sentence: string): OwnYears | null {
  const lower = sentence.toLowerCase();
  const years = [...lower.matchAll(YEARS)].map((m) => Number(m[1]));
  const span = SPAN.exec(lower);
  if (span) {
    return {
      start: Number(span[1]),
      end: Number(span[2]),
      source: YEAR_SOURCES.span,
      years,
    };
  }
  const by = BY.exec(lower);
  if (by) {
    const start = by[1] ? Number(by[1]) * 10 : Number(by[2]);
    return { start, end: null, source: YEAR_SOURCES.by, years };
  }
  const decade = DECADE.exec(lower);
  if (decade) {
    const start = Number(decade[1]) * 10;
    return { start, end: start + 9, source: YEAR_SOURCES.decade, years };
  }
  const end = END.exec(lower);
  if (end) {
    const endYear = Number(end[1]);
    const others = years.filter((y, i) => !(y === endYear && i === years.indexOf(endYear)));
    const start = others[0] ?? null;
    return {
      start,
      end: endYear,
      source: start === null ? YEAR_SOURCES.end : YEAR_SOURCES.year,
      years,
    };
  }
  const first = years[0];
  if (first !== undefined) return { start: first, end: null, source: YEAR_SOURCES.year, years };
  return null;
}

const ABBREVIATIONS = new Set(LEXICON.abbreviations);
const BREAK = /[.!?]+(?=\s)/gu;
const OPENS_SENTENCE = /^\s+["'“‘(]?[\p{Lu}\p{Script=Han}]/u;
const LAST_TOKEN = /(\S+)$/u;
const SINGLE_LETTER = /^\p{L}$/u;
const LEADING_PUNCT = /^["'“‘(]+/u;

/**
 * CR-2: the sentences of a capture. A break is `.`, `!` or `?` followed by
 * whitespace and a capital or a Chinese character; a line break always
 * splits. "Mr." and single initials do not end a sentence.
 */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    let from = 0;
    for (const m of line.matchAll(BREAK)) {
      const end = m.index + m[0].length;
      if (!OPENS_SENTENCE.test(line.slice(end))) continue;
      if (m[0] === '.') {
        const token = (LAST_TOKEN.exec(line.slice(from, m.index))?.[1] ?? '')
          .replace(LEADING_PUNCT, '')
          .toLowerCase();
        if (ABBREVIATIONS.has(token) || SINGLE_LETTER.test(token)) continue;
      }
      out.push(line.slice(from, end).trim());
      from = end;
    }
    out.push(line.slice(from).trim());
  }
  return out.filter(Boolean);
}

/** A word or short phrase in quotes; an apostrophe inside a word never opens one. */
export const QUOTED =
  /(?<![\p{L}\p{N}])["'“‘](?=\S)([^"'“”‘’\n]{1,30}?)(?<=\S)["'”’](?![\p{L}\p{N}])/gu;
const QUESTION = /\?/;

/** Words in quotes ('Wanda', "yee haw"), from the folded text. */
export function quotedWords(sentence: string): string[] {
  return [...foldText(sentence).folded.matchAll(QUOTED)].map((m) => m[1] ?? '').filter(Boolean);
}

/** One sentence of a capture with the years it takes. */
export interface ParsedSentence {
  index: number;
  text: string;
  /** The years the fact takes: its own, else those of the sentence before, else the story year. */
  years: { start: number; end: number | null; source: string };
  /** What the sentence gave of its own, or null. */
  own: OwnYears | null;
  question: boolean;
  quoted: string[];
}

/** One sentence, given the start year it inherits when it names none. */
export function parseSentence(
  text: string,
  index: number,
  inherited: { start: number; source: string },
): ParsedSentence {
  const own = parseYears(text);
  const start = own?.start ?? inherited.start;
  const source = own?.start != null ? own.source : own ? own.source : inherited.source;
  return {
    index,
    text,
    years: { start, end: own?.end ?? null, source },
    own,
    question: QUESTION.test(text),
    quoted: quotedWords(text),
  };
}

/**
 * CR-2: the sentences of a capture with their years. A sentence with no year
 * of its own takes the start year of the sentence before it, else the story
 * year.
 */
export function parse(text: string, storyYear: number): ParsedSentence[] {
  const out: ParsedSentence[] = [];
  for (const [i, s] of splitSentences(text).entries()) {
    const prev = out[i - 1];
    const inherited = prev
      ? { start: prev.years.start, source: YEAR_SOURCES.before }
      : { start: storyYear, source: YEAR_SOURCES.story };
    out.push(parseSentence(s, i, inherited));
  }
  return out;
}
