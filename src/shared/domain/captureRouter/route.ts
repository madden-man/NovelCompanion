/**
 * Capture routing (A48, CR-1, CR-5): route a capture fact by fact. Parse,
 * resolve, score, pick the community, draft, then decide the route with the
 * writer's hints applied. Pure: the renderer and main run the same function
 * on the same index and get the same facts.
 */
import { ASKABLE, draftsFor, firstCommunity } from './drafts';
import { LEXICON } from './lexicon';
import type { Lexicon } from './lexicon';
import { YEAR_SOURCES, parseSentence, splitSentences } from './parse';
import { candidatesOf, pickCommunity, resolve } from './resolve';
import { score } from './score';
import { DEFAULT_THRESHOLDS } from './types';
import type {
  CaptureFact,
  CaptureHint,
  CaptureRoute,
  CaptureRouting,
  CaptureSection,
  RouteOptions,
  RouteThresholds,
  RouterIndex,
} from './types';

export interface DecideInput {
  share: number;
  margin: number;
  reasons: readonly string[];
  missing: readonly string[];
  /** The writer changed the Section chip. */
  forcedSection?: boolean;
  /** The writer forced a route ("Ask Claude instead"). */
  forcedRoute?: CaptureRoute;
}

/**
 * CR-5: Route A (local) when the section holds at least `localShare` of the
 * points, leads by `localMargin`, nothing needs judgment, and every missing
 * field can be asked for with a chip. Route B (fast) when it holds at least
 * `fastShare`. Route C (full) otherwise, or when the writer asks for it. A
 * section the writer chose that would go to C with nothing flagged goes to B.
 */
export function decide(
  input: DecideInput,
  thresholds: RouteThresholds = DEFAULT_THRESHOLDS,
): CaptureRoute {
  if (input.forcedRoute) return input.forcedRoute;
  const judgment = input.reasons.length > 0;
  const canAsk = input.missing.every((m) => ASKABLE.has(m));
  let route: CaptureRoute;
  if (
    input.share >= thresholds.localShare &&
    input.margin >= thresholds.localMargin &&
    !judgment &&
    canAsk
  ) {
    route = 'local';
  } else if (input.share >= thresholds.fastShare) route = 'fast';
  else route = 'full';
  if (input.forcedSection && route === 'full' && !judgment) route = 'fast';
  return route;
}

/** The hints for one fact, merged in order. */
function hintFor(hints: readonly CaptureHint[] | undefined, fact: number): Partial<CaptureHint> {
  const out: Partial<CaptureHint> = {};
  for (const h of hints ?? []) if (h.fact === fact) Object.assign(out, h);
  return out;
}

const pct = (n: number) => Math.round(n * 100);

/** Route one sentence, given the start year it inherits. */
export function routeFact(
  sentence: string,
  factIndex: number,
  sentences: number,
  inherited: { start: number; source: string },
  index: RouterIndex,
  options: RouteOptions,
  lexicon: Lexicon = LEXICON,
): CaptureFact {
  const thresholds = options.thresholds ?? DEFAULT_THRESHOLDS;
  const hint = hintFor(options.hints, factIndex);
  const parsed = parseSentence(sentence, factIndex, inherited);
  const resolved = resolve(sentence, index, lexicon);
  const { scores, cues, ranked, matched } = score(parsed, resolved, lexicon);
  const top = ranked[0] ?? ['openQuestions', 0];
  const section: CaptureSection = hint.section ?? top[0];
  const total = ranked.reduce((s, [, v]) => s + v, 0);
  const mine = scores[section] ?? 0;
  const best = ranked.find(([s]) => s !== section)?.[1] ?? 0;
  // With nothing matched the fallback section is a guess: no share, so Route C.
  const share = total && matched ? mine / total : 0;
  const margin = matched ? mine - best : 0;

  let communities = pickCommunity(resolved, index, options.povCommunityId, lexicon);
  if (hint.communityId) {
    communities = [
      { id: hint.communityId, why: 'chosen by the writer' },
      ...communities.filter((c) => c.id !== hint.communityId),
    ];
  }
  const communityId = hint.communityId ?? firstCommunity(communities);
  const demographic = hint.demographic ?? resolved.ageGroups[0]?.id ?? 'all';
  const years = {
    start: hint.startYear ?? parsed.years.start,
    end: hint.endYear !== undefined ? hint.endYear : parsed.years.end,
    source:
      hint.startYear !== undefined || hint.endYear !== undefined
        ? 'chosen by the writer'
        : parsed.years.source,
  };

  const { drafts, missing, asks, reasons } = draftsFor(
    {
      section,
      sentence,
      parsed,
      resolved,
      years,
      communities,
      communityId,
      demographic,
      characterId: hint.characterId ?? null,
      categoryId: hint.categoryId ?? null,
      index,
    },
    lexicon,
  );
  // How sure the router is of the section; not asked when the writer chose it.
  if (!hint.section && !reasons.length && share < thresholds.localShare) {
    reasons.push(`section only ${pct(share)}% sure`);
  } else if (!hint.section && !reasons.length && margin < thresholds.localMargin) {
    reasons.push(`section leads the next by only ${margin} points`);
  }
  const route = decide(
    { share, margin, reasons, missing, forcedSection: !!hint.section, forcedRoute: hint.route },
    thresholds,
  );
  return {
    index: factIndex,
    text: sentence,
    years,
    sentences,
    candidates: candidatesOf(resolved),
    scores,
    cues,
    ranked,
    section,
    share,
    margin,
    communities,
    missing,
    asks,
    reasons,
    drafts,
    route,
  };
}

/**
 * CR-1: route a capture. Each sentence is a fact routed on its own (CR-2); a
 * fact with no year takes the start year of the fact before it, else the
 * story year. `options.hints` apply per fact before the route is decided.
 */
export function routeCapture(
  text: string,
  index: RouterIndex,
  options: RouteOptions,
  lexicon: Lexicon = LEXICON,
): CaptureRouting {
  const sentences = splitSentences(text);
  const facts: CaptureFact[] = [];
  for (const [i, s] of sentences.entries()) {
    const prev = facts[i - 1];
    const inherited = prev
      ? { start: prev.years.start, source: YEAR_SOURCES.before }
      : { start: options.storyYear, source: YEAR_SOURCES.story };
    facts.push(routeFact(s, i, sentences.length, inherited, index, options, lexicon));
  }
  return { text, storyYear: options.storyYear, facts };
}
