/**
 * WT-1: writing tools over the Datamuse API (api.datamuse.com), a free
 * service with no key. This module is pure: it names the lookups, builds the
 * query parameters for each, and reads Datamuse's JSON into a typed result.
 * The fetch itself lives in main (ARCHITECTURE rule 3).
 */

export const WORD_KINDS = [
  'synonyms',
  'antonyms',
  'meansLike',
  'rhymes',
  'nearRhymes',
  'soundsLike',
  'spelledLike',
  'related',
  'adjectivesFor',
  'nounsFor',
  'homophones',
  'definition',
] as const;
export type WordKind = (typeof WORD_KINDS)[number];

export interface WordKindInfo {
  id: WordKind;
  /** The choice in the Look up menu. */
  label: string;
  /** One line under the form about what the lookup gives. */
  hint: string;
  /** True when the results show syllable counts (the rhyme lookups). */
  syllables: boolean;
}

export const KINDS: readonly WordKindInfo[] = [
  { id: 'synonyms', label: 'Synonyms', hint: 'Words that mean the same.', syllables: false },
  { id: 'antonyms', label: 'Antonyms', hint: 'Words that mean the opposite.', syllables: false },
  {
    id: 'meansLike',
    label: 'Means like',
    hint: 'Words close in meaning, wider than synonyms. A phrase works too.',
    syllables: false,
  },
  { id: 'rhymes', label: 'Rhymes', hint: 'Perfect rhymes, with syllable counts.', syllables: true },
  {
    id: 'nearRhymes',
    label: 'Near rhymes',
    hint: 'Slant rhymes, with syllable counts.',
    syllables: true,
  },
  {
    id: 'soundsLike',
    label: 'Sounds like',
    hint: 'Words pronounced like this one, with syllable counts.',
    syllables: true,
  },
  {
    id: 'spelledLike',
    label: 'Spelled like',
    hint: 'Use ? for one letter and * for any run of letters, for example t?ngle or s*ng.',
    syllables: false,
  },
  {
    id: 'related',
    label: 'Related words',
    hint: 'Words that often appear with this one.',
    syllables: false,
  },
  {
    id: 'adjectivesFor',
    label: 'Adjectives for it',
    hint: 'Adjectives often used to describe this noun.',
    syllables: false,
  },
  {
    id: 'nounsFor',
    label: 'Nouns it describes',
    hint: 'Nouns this adjective is often used with.',
    syllables: false,
  },
  {
    id: 'homophones',
    label: 'Homophones',
    hint: 'Words that sound the same and are spelled differently.',
    syllables: false,
  },
  {
    id: 'definition',
    label: 'Definition',
    hint: 'A short dictionary entry with its parts of speech.',
    syllables: false,
  },
];

export function kindInfo(kind: WordKind): WordKindInfo {
  const k = KINDS.find((i) => i.id === kind);
  if (!k) throw new Error(`Unknown word lookup: ${String(kind)}`);
  return k;
}

/** How many words a list lookup asks for. */
export const WORD_MAX = 40;

/** The Datamuse query parameter each list lookup uses. */
const PARAM: Record<Exclude<WordKind, 'definition'>, string> = {
  synonyms: 'rel_syn',
  antonyms: 'rel_ant',
  meansLike: 'ml',
  rhymes: 'rel_rhy',
  nearRhymes: 'rel_nry',
  soundsLike: 'sl',
  spelledLike: 'sp',
  related: 'rel_trg',
  adjectivesFor: 'rel_jjb',
  nounsFor: 'rel_jja',
  homophones: 'rel_hom',
};

/**
 * The query string parameters for a lookup, in a fixed order so the URL is
 * the same for the same request. `md=ps` asks for parts of speech and
 * syllable counts; the definition adds `d` and asks for the one entry.
 */
export function wordQuery(kind: WordKind, word: string): [string, string][] {
  const w = word.trim();
  if (kind === 'definition') {
    return [
      ['sp', w],
      ['md', 'dp'],
      ['max', '1'],
    ];
  }
  return [
    [PARAM[kind], w],
    ['md', 'ps'],
    ['max', String(WORD_MAX)],
  ];
}

export const DATAMUSE_URL = 'https://api.datamuse.com/words';

export function wordUrl(kind: WordKind, word: string, base = DATAMUSE_URL): string {
  const u = new URL(base);
  for (const [k, v] of wordQuery(kind, word)) u.searchParams.set(k, v);
  return u.toString();
}

export interface WordDefinition {
  /** The part of speech, as Datamuse abbreviates it: n, v, adj, adv, u. */
  pos: string;
  text: string;
}

export interface WordResult {
  word: string;
  score: number;
  partsOfSpeech: string[];
  syllables: number | null;
  definitions?: WordDefinition[];
}

/** The part-of-speech tags Datamuse uses, in the words people read. */
export const POS_TEXT: Record<string, string> = {
  n: 'noun',
  v: 'verb',
  adj: 'adjective',
  adv: 'adverb',
  u: 'unknown',
  prop: 'proper noun',
};

export const posText = (pos: string): string => POS_TEXT[pos] ?? pos;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** One Datamuse row into a result, or null when it has no word. */
function parseRow(row: unknown): WordResult | null {
  if (!isRecord(row) || typeof row.word !== 'string' || row.word.trim() === '') return null;
  const tags = Array.isArray(row.tags) ? row.tags.filter((t) => typeof t === 'string') : [];
  const partsOfSpeech: string[] = [];
  // Datamuse answers md=s with a numSyllables field; older rows carried a syl: tag.
  let syllables: number | null =
    typeof row.numSyllables === 'number' &&
    Number.isInteger(row.numSyllables) &&
    row.numSyllables > 0
      ? row.numSyllables
      : null;
  for (const t of tags) {
    if (t.startsWith('syl:')) {
      const n = Number(t.slice(4));
      if (Number.isInteger(n) && n > 0) syllables = n;
    } else if (!t.startsWith('pron:') && !t.startsWith('ipa_pron:') && !t.startsWith('f:')) {
      if (!partsOfSpeech.includes(t)) partsOfSpeech.push(t);
    }
  }
  const out: WordResult = {
    word: row.word,
    score: typeof row.score === 'number' && Number.isFinite(row.score) ? row.score : 0,
    partsOfSpeech,
    syllables,
  };
  if (Array.isArray(row.defs)) {
    const definitions: WordDefinition[] = [];
    for (const d of row.defs) {
      if (typeof d !== 'string') continue;
      const tab = d.indexOf('\t');
      const pos = tab === -1 ? '' : d.slice(0, tab).trim();
      const text = (tab === -1 ? d : d.slice(tab + 1)).trim();
      if (text) definitions.push({ pos, text });
    }
    out.definitions = definitions;
  }
  return out;
}

/**
 * Datamuse's JSON (an array of rows) into results. Anything that is not an
 * array, and any row without a word, is left out rather than refused: the
 * service's shape may grow and the app shows what it can read.
 */
export function parseWords(body: unknown): WordResult[] {
  if (!Array.isArray(body)) return [];
  const out: WordResult[] = [];
  for (const row of body) {
    const r = parseRow(row);
    if (r) out.push(r);
  }
  return out;
}
