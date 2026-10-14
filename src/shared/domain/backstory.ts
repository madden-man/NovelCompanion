/**
 * A35: a character's backstory, dated passage by passage, so Relevant to
 * Session can show the passages from a chapter's backstory years. Pure: the
 * backstory HTML, the birth year, and the marks the writer set (a year fixed
 * by hand, a pin) give the same passages every time.
 *
 * A passage takes its year from a cue in its text: an explicit year ("2052"),
 * the character's age ("when Mark is twelve", "at seven years old"), or a
 * school stage ("sophomore year"). A passage with no cue takes the year of the
 * passage before it. A paragraph naming two or more years is split into its
 * sentences and clauses, so "Homecoming kiss 2052; fights about religion 2053"
 * gives two passages.
 */

export interface BackstoryMark {
  /** The passage's key (see `passageKey`). */
  key: string;
  /** A year set by hand, which wins over any cue. */
  year?: number | null;
  /** Pinned passages show in every session for the character. */
  pinned?: boolean;
}

export type YearSource = 'cue' | 'carried' | 'set' | 'none';

export interface Passage {
  key: string;
  /** The passage, plain text. */
  text: string;
  /** The sentence shown in the session view: the one holding the cue, else the first. */
  excerpt: string;
  year: number | null;
  source: YearSource;
  /** "Freshman", "Age 12", "Summer"; empty for an explicit year or a carried one. */
  tag: string;
  pinned: boolean;
}

const WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
};
const NUM = `(\\d{1,2}|${Object.keys(WORDS).join('|')})`;
const toNum = (s: string) => (/^\d+$/.test(s) ? Number(s) : (WORDS[s.toLowerCase()] ?? NaN));

/** School stages as the age the year starts at, longest phrases first so they win a tie. */
const STAGES: { re: RegExp; age: number; tag: string }[] = [
  { re: /summer between (?:his |her |their )?junior and senior/i, age: 17, tag: 'Summer' },
  { re: /summer between (?:his |her |their )?sophomore and junior/i, age: 16, tag: 'Summer' },
  { re: /summer between (?:his |her |their )?freshman and sophomore/i, age: 15, tag: 'Summer' },
  { re: /freshman year of college|first year of college/i, age: 18, tag: 'College' },
  { re: /first year of high school|freshman year|freshman/i, age: 14, tag: 'Freshman' },
  { re: /sophomore/i, age: 15, tag: 'Sophomore' },
  { re: /junior year|junior/i, age: 16, tag: 'Junior' },
  { re: /senior year|senior/i, age: 17, tag: 'Senior' },
  { re: /last year of middle school|eighth grade|8th grade/i, age: 13, tag: 'Middle school' },
  { re: /middle school/i, age: 11, tag: 'Middle school' },
  { re: /elementary school/i, age: 6, tag: 'Elementary' },
  { re: /kindergarten/i, age: 5, tag: 'Kindergarten' },
];

const AGE_PATTERNS = [
  new RegExp(`\\b(?:age|aged)\\s+${NUM}\\b`, 'gi'),
  new RegExp(`\\b${NUM}(?:\\s+and\\s+a\\s+half)?\\s+years?\\s+old\\b`, 'gi'),
  new RegExp(`\\bat\\s+${NUM}\\b(?!\\s*(?::|%|o['’]clock|am\\b|pm\\b|percent))`, 'gi'),
  new RegExp(
    `\\b(?:is|turns|turned)\\s+${NUM}\\b(?!\\s+(?:years?\\s+)?(?:later|after|before|ago|months?|weeks?|days?))`,
    'gi',
  ),
];

/** Words that start a sentence or clause and are not names. */
const NOT_NAMES = new Set(
  'A An The At Around By When While As In On After Before During Until Since For From Despite Though Although Soon Early Late Many Most Some Surprising Throughout Rather Meanwhile Still Things Writer’s He She They His Her Hers Their It Its I We'.split(
    ' ',
  ),
);

interface Cue {
  index: number;
  length: number;
  year: number;
  tag: string;
}

/**
 * The capitalised word nearest before `index` in its sentence, which is the
 * subject an age most likely belongs to ("Matthew is four years old" is not
 * the character's own age).
 */
function nameBefore(text: string, index: number): string | null {
  const start = Math.max(text.lastIndexOf('. ', index), text.lastIndexOf('; ', index)) + 1;
  const words = text.slice(start, index).match(/[A-Z][\p{L}'’-]*/gu) ?? [];
  for (const word of [...words].reverse()) {
    const w = word.replace(/['’]s$/, '');
    if (!NOT_NAMES.has(word) && !NOT_NAMES.has(w)) return w;
  }
  return null;
}

function cues(text: string, born: number | null, names: string[]): Cue[] {
  const out: Cue[] = [];
  for (const m of text.matchAll(/\b(1[5-9]\d\d|2[01]\d\d)\b/g)) {
    out.push({ index: m.index, length: m[0].length, year: Number(m[1]), tag: '' });
  }
  // An explicit year beats an age or a school stage anywhere in the passage.
  if (out.length) return out;
  const theirs = (index: number) => {
    const who = nameBefore(text, index);
    return !who || names.some((n) => n.toLowerCase() === who.toLowerCase());
  };
  if (born !== null) {
    for (const re of AGE_PATTERNS) {
      for (const m of text.matchAll(re)) {
        const age = toNum(m[1] ?? '');
        if (!Number.isFinite(age)) continue;
        if (!theirs(m.index)) continue;
        out.push({ index: m.index, length: m[0].length, year: born + age, tag: `Age ${age}` });
      }
    }
    for (const s of STAGES) {
      const re = new RegExp(s.re.source, 'gi');
      for (const m of text.matchAll(re)) {
        if (!theirs(m.index)) continue;
        out.push({ index: m.index, length: m[0].length, year: born + s.age, tag: s.tag });
      }
    }
  }
  // The earliest cue wins; at the same place the longer phrase does.
  return out.sort((a, b) => a.index - b.index || b.length - a.length);
}

/** Plain paragraphs from the editor's HTML. */
function paragraphs(html: string): string[] {
  return html
    .replace(/<\/(p|h[1-6]|li|blockquote|div)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .split('\n')
    .map((p) => p.replace(CITATION, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/** Source citations such as "(Sullivan!A23-A30)" or "(East_Winds L101; Marks_Life L33)". */
const CITATION = /\s*\((?=[^()]*(?:!|\bL\d+\b))[^()]*\)/g;

/** Headings such as "Narrative Summary" or "Writer’s Note:" are not passages. */
function isHeading(p: string): boolean {
  return p.length < 40 && !/[.!?]["”’)]?$/.test(p);
}

/** "Writer’s Note: …" paragraphs are about the book, not the character's life. */
const isNote = (p: string) => /^(writer['’]?s\s+note|author['’]?s\s+note|note)\s*:/i.test(p);

function sentences(p: string): string[] {
  return (p.match(/[^.!?;]+(?:[.!?;]+["”’)]?|$)/g) ?? [p]).map((s) => s.trim()).filter(Boolean);
}

/** A passage's key: its first words, lowercased, so a mark survives edits further on. */
export function passageKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]+/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

const MAX_EXCERPT = 220;
function clip(s: string): string {
  return s.length > MAX_EXCERPT ? `${s.slice(0, MAX_EXCERPT - 1).trimEnd()}…` : s;
}

/**
 * The backstory as dated passages, in the order written. `names` are the
 * words the text uses for the character (first name, nicknames).
 */
export function datePassages(
  html: string,
  born: number | null,
  names: string[],
  marks: readonly BackstoryMark[] = [],
): Passage[] {
  const byKey = new Map(marks.map((m) => [m.key, m]));
  const raw: string[] = [];
  for (const p of paragraphs(html)) {
    if (isHeading(p) || isNote(p)) continue;
    const years = new Set([...p.matchAll(/\b(1[5-9]\d\d|2[01]\d\d)\b/g)].map((m) => m[1]));
    if (years.size >= 2) raw.push(...sentences(p).map((s) => s.replace(/[;]$/, '.')));
    else raw.push(p);
  }
  const out: Passage[] = [];
  let last: number | null = null;
  for (const text of raw) {
    const key = passageKey(text);
    const mark = byKey.get(key);
    const found = cues(text, born, names).filter(
      (c) => born === null || (c.year >= born - 5 && c.year <= born + 120),
    );
    const cue = found[0];
    let year: number | null = null;
    let source: YearSource = 'none';
    let tag = '';
    if (typeof mark?.year === 'number') {
      year = mark.year;
      source = 'set';
    } else if (cue) {
      year = cue.year;
      source = 'cue';
      tag = cue.tag;
    } else if (last !== null) {
      year = last;
      source = 'carried';
    }
    if (year !== null) last = year;
    const holder = cue
      ? sentences(text).find((s) => s.includes(text.slice(cue.index, cue.index + cue.length)))
      : null;
    out.push({
      key,
      text,
      excerpt: clip(holder ?? sentences(text)[0] ?? text),
      year,
      source,
      tag,
      pinned: mark?.pinned === true,
    });
  }
  return out;
}

export interface BackstoryRow extends Passage {
  /** window: inside the years; lead: the last passage before them; pinned: kept by the writer. */
  kind: 'window' | 'lead' | 'pinned';
}

/**
 * The passages for a span of years: pinned ones first (earliest first), then
 * the last passage before the span, then every passage inside it.
 */
export function passagesFor(
  passages: readonly Passage[],
  from: number,
  to: number,
): BackstoryRow[] {
  const inside = (p: Passage) => p.year !== null && p.year >= from && p.year <= to;
  const window = passages.filter(inside);
  if (!window.length && !passages.some((p) => p.pinned)) return [];
  const before = passages.filter((p) => p.year !== null && p.year < from && !p.pinned);
  const lead = window.length ? before[before.length - 1] : undefined;
  const pinned = passages
    .filter((p) => p.pinned && !inside(p))
    .sort((a, b) => (a.year ?? Infinity) - (b.year ?? Infinity));
  return [
    ...pinned.map((p) => ({ ...p, kind: 'pinned' as const })),
    ...(lead ? [{ ...lead, kind: 'lead' as const }] : []),
    ...window.map((p) => ({ ...p, kind: 'window' as const })),
  ];
}
