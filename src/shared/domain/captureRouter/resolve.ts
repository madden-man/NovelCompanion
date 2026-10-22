/**
 * Capture routing (A48, CR-3): find the bible's names in one sentence. A
 * name inside a longer name is not the subject ("Sydney's husband" is its own
 * character, "Siyuan's temple" is a place). A capitalised word mid-sentence
 * that matches nothing is an unknown name.
 */
import { LEXICON } from './lexicon';
import type { Lexicon } from './lexicon';
import { QUOTED } from './parse';
import { findAll, foldAlias, foldText } from './text';
import type { FoldedText } from './text';
import type { CandidateKind, CaptureCandidate, RouterIndex } from './types';

/** A name found in the sentence, with where. */
export interface Match {
  kind: CandidateKind;
  id: string | null;
  label: string;
  /** The longest alias that matched, lowercase. */
  matched: string;
  /** Offset of the first occurrence in the sentence. */
  start: number;
  /** Every occurrence, as [start, end). */
  spans: [number, number][];
  communityId?: string | null;
  /** An unknown name that ends in a place word ("Mission district"). */
  placeTail?: boolean;
}

export interface Resolved {
  text: FoldedText;
  characters: Match[];
  places: Match[];
  communities: Match[];
  demonyms: Match[];
  categories: Match[];
  glossary: Match[];
  ageGroups: Match[];
  unknown: Match[];
  /** Runs of Chinese characters that are not a character's or place's name. */
  cjk: string[];
  /** Words in quotes. */
  quoted: string[];
  /**
   * The first word when it could be a name the bible lacks: capitalised, not
   * inside a known name, not a stop word or an ordinary English word. The
   * moment rule decides whether it is one ("Rosa meets Mark").
   */
  leading: Match | null;
}

/** Every occurrence of any alias, the longest alias, and the first offset; null when none match. */
function matchAliases(
  t: FoldedText,
  aliases: readonly string[],
  capitalOnly?: readonly string[],
): { matched: string; spans: [number, number][]; start: number } | null {
  let matched = '';
  const spans: [number, number][] = [];
  for (const a of aliases) {
    let at = findAll(t.lower, a);
    // "mark" the verb is not Mark: an alias that is an English word needs a capital.
    if (capitalOnly?.includes(a)) at = at.filter((i) => UPPER.test(t.folded[i] ?? ''));
    if (!at.length) continue;
    if (a.length > matched.length) matched = a;
    for (const s of at) spans.push([s, s + a.length]);
  }
  if (!matched) return null;
  // An occurrence inside a longer occurrence of the same entity is the same mention.
  const own = spans.filter(
    ([s, e]) => !spans.some(([s2, e2]) => s2 <= s && e <= e2 && e2 - s2 > e - s),
  );
  own.sort((a, b) => a[0] - b[0]);
  return { matched, spans: own, start: own[0]?.[0] ?? 0 };
}

const UPPER = /\p{Lu}/u;

const inside = ([s, e]: [number, number], [s2, e2]: [number, number]) =>
  s2 <= s && e <= e2 && e2 - s2 > e - s;

/**
 * Keep only the occurrences of each match that do not sit inside a longer
 * occurrence among `containers`; a match with none left is dropped. Its
 * `matched` and `start` then come from what is left.
 */
function notInside(lower: string, matches: Match[], containers: Match[]): Match[] {
  const out: Match[] = [];
  for (const m of matches) {
    const spans = m.spans.filter(
      (sp) =>
        !containers.some(
          (c) => !(c.kind === m.kind && c.id === m.id) && c.spans.some((cs) => inside(sp, cs)),
        ),
    );
    const first = spans[0];
    if (!first) continue;
    const longest = spans.reduce((a, b) => (b[1] - b[0] > a[1] - a[0] ? b : a));
    out.push({ ...m, spans, start: first[0], matched: lower.slice(longest[0], longest[1]) });
  }
  return out;
}

const byStart = (a: Match, b: Match) => a.start - b.start;

const CAPITAL_WORD = /[\p{Lu}][\p{L}\p{M}\p{N}'-]*/gu;
const HAN_RUN = /\p{Script=Han}+/gu;
const POSSESSIVE = /'s?$/;
const WORD = /[\p{L}\p{N}]/u;
const TAIL = /^ (\p{L}+)/u;

/**
 * CR-3: unknown names. A capitalised word or run of words that is not the
 * first word of the sentence, is not inside a known name or a quote, and is
 * not a stop word; a following place word ("district") joins it.
 */
function unknownNames(t: FoldedText, covered: [number, number][], lexicon: Lexicon): Match[] {
  const stop = new Set(lexicon.stopWords);
  const tails = new Set(lexicon.placeTails);
  const words = [...t.folded.matchAll(CAPITAL_WORD)];
  const firstWord = WORD.exec(t.folded)?.index ?? 0;
  const out: Match[] = [];
  let i = 0;
  while (i < words.length) {
    const w = words[i];
    if (!w) break;
    const start = w.index;
    // The word must start a word (not "LiNa" inside "xLiNa") and not open the sentence;
    // a single capital before a full stop is an initial or "U.S.", not a name.
    if (
      start === firstWord ||
      WORD.test(t.folded[start - 1] ?? '') ||
      (w[0].length === 1 && t.folded[start + 1] === '.')
    ) {
      i++;
      continue;
    }
    let end = start + w[0].length;
    let j = i + 1;
    for (
      let next = words[j];
      next && next.index === end + 1 && t.folded[end] === ' ' && j - i < 4;
    ) {
      end = next.index + next[0].length;
      next = words[++j];
    }
    const run: [number, number] = [start, end];
    const known = covered.some(([s, e]) => s < run[1] && run[0] < e);
    const parts = t.folded
      .slice(start, end)
      .split(' ')
      .map((p) => p.replace(POSSESSIVE, '').toLowerCase());
    if (!known && parts.some((p) => !stop.has(p))) {
      let label = t.text.slice(start, end).replace(POSSESSIVE, '');
      let placeTail = false;
      const tail = TAIL.exec(t.lower.slice(end));
      if (tail?.[1] && tails.has(tail[1])) {
        label = t.text.slice(start, end + tail[0].length);
        end += tail[0].length;
        placeTail = true;
      }
      out.push({
        kind: 'unknown',
        id: null,
        label,
        matched: label.toLowerCase(),
        start,
        spans: [[start, end]],
        placeTail,
      });
    }
    i = j;
  }
  return out;
}

const LEAD = /^\s*["'“‘(]?(\p{Lu}[\p{L}\p{M}'-]*)/u;

/** The first word of the sentence when it could be an unknown name. */
function leadingWord(t: FoldedText, covered: [number, number][], lexicon: Lexicon): Match | null {
  const m = LEAD.exec(t.folded);
  const word = m?.[1];
  if (!m || !word) return null;
  const start = m.index + m[0].length - word.length;
  const end = start + word.length;
  const lower = word.replace(POSSESSIVE, '').toLowerCase();
  if (covered.some(([s, e]) => s < end && start < e)) return null;
  if (
    lexicon.stopWords.includes(lower) ||
    lexicon.englishWords.includes(lower) ||
    lexicon.groupWords.includes(lower)
  ) {
    return null;
  }
  const label = t.text.slice(start, end).replace(POSSESSIVE, '');
  return {
    kind: 'unknown',
    id: null,
    label,
    matched: label.toLowerCase(),
    start,
    spans: [[start, end]],
  };
}

/** CR-3: resolve one sentence against the index. */
export function resolve(
  sentence: string,
  index: RouterIndex,
  lexicon: Lexicon = LEXICON,
): Resolved {
  const t = foldText(sentence);
  const { lower } = t;
  const find = <T extends { id: string }>(
    items: readonly T[],
    kind: CandidateKind,
    aliases: (i: T) => readonly string[],
    label: (i: T) => string,
    community?: (i: T) => string | null,
    capitalOnly?: (i: T) => readonly string[] | undefined,
  ): Match[] => {
    const out: Match[] = [];
    for (const item of items) {
      const m = matchAliases(t, aliases(item), capitalOnly?.(item));
      if (!m) continue;
      out.push({
        kind,
        id: item.id,
        label: label(item),
        ...m,
        ...(community ? { communityId: community(item) } : {}),
      });
    }
    return out.sort(byStart);
  };

  const allCharacters = find(
    index.characters,
    'character',
    (c) => c.aliases,
    (c) => c.name,
    undefined,
    (c) => c.capitalOnly,
  );
  const allPlaces = find(
    index.places,
    'place',
    (p) => p.aliases,
    (p) => p.name,
    (p) => p.communityId,
  );
  const allCommunities = find(
    index.communities,
    'community',
    (c) => c.aliases,
    (c) => c.label,
  );
  const allDemonyms = find(
    index.communities.filter((c) => c.demonyms.length),
    'demonym',
    (c) => c.demonyms,
    (c) => c.label,
    (c) => c.id,
  );
  const allCategories = find(
    index.categories,
    'category',
    (c) => c.cues,
    (c) => c.label,
  );
  const allAgeGroups = find(
    index.ageGroups,
    'ageGroup',
    (a) => a.words,
    (a) => a.label,
  );
  const glossary = find(
    index.glossary,
    'glossary',
    (g) => [foldAlias(g.characters)],
    (g) => g.characters,
  );

  // Names (characters and places) swallow anything inside a longer name.
  const names = [...allCharacters, ...allPlaces];
  const characters = notInside(lower, allCharacters, names);
  const places = notInside(lower, allPlaces, names);
  const keptNames = [...characters, ...places];
  const communities = notInside(lower, allCommunities, keptNames);
  const demonyms = notInside(lower, allDemonyms, [...keptNames, ...communities]);
  const categories = notInside(lower, allCategories, keptNames);
  const ageGroups = notInside(lower, allAgeGroups, keptNames);

  const quoted: string[] = [];
  const quoteSpans: [number, number][] = [];
  for (const m of t.folded.matchAll(QUOTED)) {
    quoted.push(m[1] ?? '');
    quoteSpans.push([m.index, m.index + m[0].length]);
  }

  const covered: [number, number][] = [
    ...[
      ...allCharacters,
      ...allPlaces,
      ...allCommunities,
      ...allDemonyms,
      ...allCategories,
      ...allAgeGroups,
      ...glossary,
    ].flatMap((m) => m.spans),
    ...quoteSpans,
  ];
  const unknown = unknownNames(t, covered, lexicon);
  const leading = leadingWord(t, covered, lexicon);

  const nameSpans = keptNames.flatMap((m) => m.spans);
  const cjk: string[] = [];
  for (const m of t.folded.matchAll(HAN_RUN)) {
    const run: [number, number] = [m.index, m.index + m[0].length];
    const named = nameSpans.some(([s, e]) => s <= run[0] && run[1] <= e);
    if (!named) cjk.push(m[0]);
  }

  return {
    text: t,
    characters,
    places,
    communities,
    demonyms,
    categories,
    glossary,
    ageGroups,
    unknown,
    cjk,
    quoted: quoted.filter(Boolean),
    leading,
  };
}

/** The candidates of a resolved sentence, in the order the box lists them. */
export function candidatesOf(r: Resolved): CaptureCandidate[] {
  const out: CaptureCandidate[] = [];
  for (const m of [
    ...r.characters,
    ...r.places,
    ...r.communities,
    ...r.demonyms,
    ...r.categories,
    ...r.glossary,
    ...r.ageGroups,
    ...r.unknown,
  ]) {
    out.push({
      kind: m.kind,
      id: m.id,
      label: m.label,
      matched: m.matched,
      ...(m.communityId !== undefined ? { communityId: m.communityId } : {}),
    });
  }
  return out;
}

/** The community candidates of CR-3, in preference order, with why. */
export interface CommunityChoice {
  id: string;
  why: string;
}

/** The `why` of the writing strand's community: a weak guess, never filled in without a chip. */
export const WRITING_STRAND = 'the writing strand';

/**
 * CR-3: community candidates. A place's community first, then a community
 * named by an alias, then the demonym rule (a demonym plus a place in
 * California also offers the diaspora community, after the place's; a
 * demonym alone gives its national community), then the writing strand's
 * community, marked as a weak guess. Deduplicated, in that order.
 */
export function pickCommunity(
  r: Resolved,
  index: RouterIndex,
  povCommunityId?: string | null,
  lexicon: Lexicon = LEXICON,
): CommunityChoice[] {
  const known = new Set(index.communities.map((c) => c.id));
  const out: CommunityChoice[] = [];
  const add = (id: string | null | undefined, why: string) => {
    if (id && !out.some((c) => c.id === id)) out.push({ id, why });
  };
  const places = new Map(index.places.map((p) => [p.id, p]));
  for (const p of r.places) {
    if (p.communityId) {
      add(p.communityId, `the place ${p.label}`);
      continue;
    }
    // A place with no community takes its nearest larger place's.
    let up = p.id ? places.get(p.id)?.parentId : null;
    for (let hops = 0; up && hops < 10; hops++) {
      const parent = places.get(up);
      if (!parent) break;
      if (parent.communityId) {
        add(parent.communityId, `the place ${p.label}, in ${parent.name}`);
        break;
      }
      up = parent.parentId;
    }
  }
  for (const c of r.communities) add(c.id, `named as "${c.matched}"`);
  for (const d of r.demonyms) {
    for (const rule of lexicon.diaspora) {
      if (rule.demonymOf !== d.id || !known.has(rule.community)) continue;
      if (out.some((c) => rule.whenCommunities.includes(c.id))) add(rule.community, rule.why);
    }
    add(d.id, `people of a country, "${d.matched}"`);
  }
  if (povCommunityId) add(povCommunityId, WRITING_STRAND);
  return out;
}
