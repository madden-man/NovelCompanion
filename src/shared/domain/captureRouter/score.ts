/**
 * Capture routing (A48, CR-4): weighted cues per section. Each cue of the
 * lexicon fires at most once per fact; the adjustments after the cues are the
 * question-mark rule, the character-subject and group-subject discounts, and
 * the no-character discount on the moment reading.
 */
import { LEXICON } from './lexicon';
import type { Cue, CueSignal, Lexicon } from './lexicon';
import type { ParsedSentence } from './parse';
import type { Resolved } from './resolve';
import { wordsPattern } from './text';
import { CAPTURE_SECTIONS } from './types';
import type { CaptureSection } from './types';

export interface Scored {
  scores: Partial<Record<CaptureSection, number>>;
  cues: Partial<Record<CaptureSection, string[]>>;
  ranked: [CaptureSection, number][];
}

/** Each cue's matcher, compiled once per lexicon. */
const compiled = new WeakMap<Lexicon, Map<string, RegExp>>();
function matchers(lexicon: Lexicon): Map<string, RegExp> {
  let m = compiled.get(lexicon);
  if (!m) {
    m = new Map();
    for (const cue of lexicon.cues) {
      if (cue.words) m.set(cue.id, wordsPattern(cue.words));
      else if (cue.pattern) m.set(cue.id, cue.pattern);
    }
    m.set('#group', wordsPattern(lexicon.groupWords));
    m.set('#life', wordsPattern(lexicon.lifeVerbs));
    m.set('#move', wordsPattern(lexicon.moveVerbs));
    m.set('#role', wordsPattern(lexicon.roleWords));
    m.set('#nickname', wordsPattern(lexicon.nicknameWords));
    compiled.set(lexicon, m);
  }
  return m;
}

/** A compiled word list of the lexicon: life, move, role, nickname or group words. */
export function lexiconPattern(
  name: 'group' | 'life' | 'move' | 'role' | 'nickname',
  lexicon: Lexicon = LEXICON,
): RegExp {
  return matchers(lexicon).get(`#${name}`)!;
}

const LEADING_THE = /^\s*(?:the\s+)?/;

/** The signals of CR-4 that come from what the resolver found. */
export function signals(parsed: ParsedSentence, r: Resolved): Record<CueSignal, boolean> {
  const lead = LEADING_THE.exec(r.text.lower)?.[0].length ?? 0;
  const anyCharacter = r.characters.length > 0;
  const placeOrCommunity = r.places.length > 0 || r.communities.length > 0;
  return {
    ageGroup: r.ageGroups.length > 0,
    demonymPlusPlace: r.demonyms.length > 0 && placeOrCommunity,
    demonymNamed: r.demonyms.length > 0,
    communityNamed: r.communities.length > 0 || r.places.some((p) => !!p.communityId),
    placeSubject: [...r.places, ...r.communities].some((m) => m.start === lead),
    characterNamed: anyCharacter,
    categoryCue: r.categories.length > 0,
    yearNoCharacter: !!parsed.own && parsed.own.years.length > 0 && !anyCharacter,
    newPlaceName: r.unknown.some((u) => u.placeTail),
    cjk: r.cjk.length > 0,
    quotedWord: r.quoted.length > 0,
    questionMark: parsed.question,
  };
}

function fires(cue: Cue, lower: string, sig: Record<CueSignal, boolean>, m: Map<string, RegExp>) {
  if (cue.needsNoCharacter && sig.characterNamed) return false;
  if (cue.signal) return sig[cue.signal];
  const re = m.get(cue.id);
  return !!re && re.test(lower);
}

const order = (s: CaptureSection) => CAPTURE_SECTIONS.indexOf(s);

/** Sections highest first; a tie goes to the earlier section in `CAPTURE_SECTIONS`. */
export function rank(scores: Partial<Record<CaptureSection, number>>): [CaptureSection, number][] {
  return (Object.entries(scores) as [CaptureSection, number][])
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1] || order(a[0]) - order(b[0]));
}

/** CR-4: score one sentence. */
export function score(parsed: ParsedSentence, r: Resolved, lexicon: Lexicon = LEXICON): Scored {
  const m = matchers(lexicon);
  const lower = r.text.lower;
  const sig = signals(parsed, r);
  const scores: Partial<Record<CaptureSection, number>> = {};
  const cues: Partial<Record<CaptureSection, string[]>> = {};
  for (const cue of lexicon.cues) {
    if (!fires(cue, lower, sig, m)) continue;
    scores[cue.section] = (scores[cue.section] ?? 0) + cue.weight;
    (cues[cue.section] ??= []).push(cue.label);
  }
  const adj = Object.fromEntries(lexicon.adjustments.map((a) => [a.id, a]));
  const scale = (s: CaptureSection, id: string) => {
    const a = adj[id];
    const v = scores[s];
    if (!a || !v) return;
    scores[s] = Math.round(v * a.factor);
    (cues[s] ??= []).push(a.label);
  };
  if (sig.characterNamed) scale('worldEvents', 'characterSubject');
  else scale('moments', 'noCharacter');
  if (m.get('#group')!.test(lower)) scale('moments', 'groupSubject');
  if (sig.questionMark) {
    for (const s of CAPTURE_SECTIONS) if (s !== 'openQuestions') scale(s, 'questionMark');
  }
  for (const s of CAPTURE_SECTIONS) if (scores[s] === 0) delete scores[s];
  if (!Object.keys(scores).length) {
    const f = lexicon.fallback;
    scores[f.section] = f.weight;
    cues[f.section] = [f.label];
  }
  return { scores, cues, ranked: rank(scores) };
}
