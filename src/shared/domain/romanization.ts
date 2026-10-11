/**
 * Romanization checks (GL-1). One system per language is chosen in settings;
 * a term whose romanization does not follow it is flagged, never blocked.
 * Hanyu Pinyin is initials plus finals with optional tone marks or tone
 * numbers; Jyutping is initials plus finals plus a tone digit from 1 to 6.
 * The tables are compact: they accept real syllables and reject the rest.
 */
import type { ListDoc } from '../schema/lists';

export type RomanizationKind = 'pinyin' | 'jyutping';

/** Shown wherever a system has no checker, so nothing passes silently (GL-1). */
export const NO_CHECKER_NOTE = 'No checker for this system; terms are not flagged';

/** The checker a system's name selects, or null for a system the app has no table for. */
export function romanizationKind(label: string): RomanizationKind | null {
  if (/pinyin/i.test(label)) return 'pinyin';
  if (/jyutping/i.test(label)) return 'jyutping';
  return null;
}

// Hanyu Pinyin

const words = (s: string) => s.split(' ');

/** Finals each group of initials takes. `v` stands for u with a diaeresis. */
const PINYIN: { initials: string[]; finals: Set<string> }[] = [
  { initials: ['b'], finals: new Set(words('a o ai ei ao an en ang eng i ie iao ian in ing u')) },
  {
    initials: ['p'],
    finals: new Set(words('a o ai ei ao ou an en ang eng i ie iao ian in ing u')),
  },
  {
    initials: ['m'],
    finals: new Set(words('a o e ai ei ao ou an en ang eng i ie iao iu ian in ing u')),
  },
  { initials: ['f'], finals: new Set(words('a o ei ou an en ang eng u')) },
  {
    initials: ['d', 't'],
    finals: new Set(
      words('a e ai ei ao ou an en ang eng ong i ia ie iao iu ian ing u uo ui uan un'),
    ),
  },
  {
    initials: ['n', 'l'],
    finals: new Set(
      words('a e ai ei ao ou an en ang eng ong i ia ie iao iu ian in iang ing u uo uan un v ve o'),
    ),
  },
  {
    initials: ['g', 'k', 'h'],
    finals: new Set(words('a e ai ei ao ou an en ang eng ong u ua uo uai ui uan un uang')),
  },
  {
    initials: ['j', 'q', 'x'],
    finals: new Set(words('i ia ie iao iu ian in iang ing iong u ue uan un')),
  },
  {
    initials: ['zh', 'ch', 'sh', 'r'],
    finals: new Set(words('a e ai ei ao ou an en ang eng ong i u ua uo uai ui uan un uang')),
  },
  {
    initials: ['z', 'c', 's'],
    finals: new Set(words('a e ai ei ao ou an en ang eng ong i u uo ui uan un')),
  },
  {
    initials: ['y'],
    finals: new Set(words('a o e ai ao ou an ang ong i in ing u ue uan un')),
  },
  { initials: ['w'], finals: new Set(words('a o ai ei an en ang eng u')) },
  { initials: [''], finals: new Set(words('a o e ai ei ao ou an en ang eng er')) },
];

export function isPinyinSyllable(s: string): boolean {
  for (const group of PINYIN) {
    for (const initial of group.initials) {
      if (s.startsWith(initial) && group.finals.has(s.slice(initial.length))) return true;
    }
  }
  return false;
}

/** Split a run of letters into valid syllables, or null when it cannot be done. */
function splitPinyin(run: string): string[] | null {
  const best: (string[] | null)[] = Array.from({ length: run.length + 1 }, () => null);
  best[0] = [];
  for (let i = 0; i < run.length; i++) {
    const here = best[i];
    if (!here) continue;
    for (let j = i + 1; j <= Math.min(run.length, i + 6); j++) {
      if (isPinyinSyllable(run.slice(i, j)) && !best[j]) best[j] = [...here, run.slice(i, j)];
    }
  }
  return best[run.length] ?? null;
}

const TONE_MARKS = /[̀́̄̌]/g;

/**
 * Standalone interjection syllables that sit outside the initials and finals
 * tables: ê, m, n, ng, hm, hng (with or without a tone mark or number).
 */
const PINYIN_INTERJECTIONS = new Set(words('ê m n ng hm hng'));

export function isPinyinInterjection(s: string): boolean {
  return PINYIN_INTERJECTIONS.has(s);
}

/**
 * A run of letters with no tone digit inside it: real syllables, optionally
 * ending in the erhua r (nǎr, wánr, yìdiǎnr).
 */
function runOk(run: string): boolean {
  if (splitPinyin(run) !== null) return true;
  return run.length > 1 && run.endsWith('r') && splitPinyin(run.slice(0, -1)) !== null;
}

function pinyinWordOk(word: string): boolean {
  // Remove tone marks, keep the diaeresis, then write it as v.
  const plain = word
    .normalize('NFD')
    .replace(TONE_MARKS, '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/ü/g, 'v');
  if (isPinyinInterjection(plain.replace(/[0-5]$/, ''))) return true;
  if (!/^(?:[a-z]+[0-5]?)+$/.test(plain)) return false;
  // With tone numbers the erhua r can follow its own digit: dian3r.
  return plain
    .split(/[0-5]/)
    .filter(Boolean)
    .every((run, i) => (run === 'r' ? i > 0 : runOk(run)));
}

// Jyutping

const JP_INITIALS = new Set(words('b p m f d t n l g k ng h gw kw w z c s j'));
const JP_FINALS = new Set(
  words(
    'aa aai aau aam aan aang aap aat aak ai au am an ang ap at ak e ei eu em eng ep ek ' +
      'i iu im in ing ip it ik o oi ou on ong ot ok u ui un ung ut uk ' +
      'oe oeng oek eoi eon eot yu yun yut m ng',
  ),
);

export function isJyutpingSyllable(s: string): boolean {
  const m = /^([a-z]+)([1-6])$/.exec(s);
  if (!m) return false;
  const letters = m[1] ?? '';
  // A syllabic nasal (m4, ng5) takes no initial; every other final needs a valid one or none.
  if (JP_FINALS.has(letters)) return true;
  for (const initial of JP_INITIALS) {
    const final = letters.slice(initial.length);
    if (letters.startsWith(initial) && final !== 'm' && final !== 'ng' && JP_FINALS.has(final)) {
      return true;
    }
  }
  return false;
}

function jyutpingWordOk(word: string): boolean {
  const plain = word.toLowerCase();
  if (!/^(?:[a-z]+[1-6])+$/.test(plain)) return false;
  return (plain.match(/[a-z]+[1-6]/g) ?? []).every(isJyutpingSyllable);
}

// the checker

export interface RomanizationResult {
  ok: boolean;
  /** Words that do not follow the system. */
  invalid: string[];
}

/** Check a romanization against a system. Empty text passes: nothing is claimed. */
export function checkRomanization(kind: RomanizationKind, text: string): RomanizationResult {
  const parts = text
    .split(/[\s\-'’·,.;]+/)
    .map((w) => w.trim())
    .filter(Boolean);
  const wordOk = kind === 'pinyin' ? pinyinWordOk : jyutpingWordOk;
  const invalid = parts.filter((w) => !wordOk(w));
  return { ok: invalid.length === 0, invalid };
}

// settings

/** Language list item ID to romanization system list item ID. */
export type RomanizationSettings = Record<string, string>;

export interface ResolvedSystem {
  id: string;
  label: string;
  kind: RomanizationKind | null;
}

/**
 * The system for a language: the one chosen in settings, else the system whose
 * item ID matches the language ID (Mandarin to Hanyu Pinyin, Cantonese to
 * Jyutping in a new bible). Null when the language has none (English).
 */
export function systemFor(
  languageId: string,
  settings: RomanizationSettings,
  systems: ListDoc | undefined,
): ResolvedSystem | null {
  const chosen = settings[languageId];
  if (chosen === '') return null;
  const item = systems?.items.find((i) => i.id === (chosen ?? languageId));
  return item ? { id: item.id, label: item.label, kind: romanizationKind(item.label) } : null;
}

/** The warning text for a glossary term, or null when it follows its language's system. */
export function termProblem(
  term: { language: string; romanization: string },
  settings: RomanizationSettings,
  systems: ListDoc | undefined,
): string | null {
  if (!term.romanization.trim()) return null;
  const system = systemFor(term.language, settings, systems);
  if (!system?.kind) return null;
  const r = checkRomanization(system.kind, term.romanization);
  if (r.ok) return null;
  const rule =
    system.kind === 'jyutping'
      ? 'Jyutping needs a tone digit from 1 to 6 after every syllable.'
      : 'Hanyu Pinyin uses real syllables, with tone marks or tone numbers.';
  return `"${r.invalid.join(' ')}" does not follow ${system.label}. ${rule} It still saves.`;
}

/** The meta document that holds the romanization choices (GL-1). */
export const ROMANIZATION_META_ID = 'romanization';

/** Read the choices from the stored meta document, ignoring anything malformed. */
export function settingsFromMeta(doc: Record<string, unknown> | undefined): RomanizationSettings {
  const raw = doc?.systems;
  const out: RomanizationSettings = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw)) if (typeof v === 'string') out[k] = v;
  }
  return out;
}
