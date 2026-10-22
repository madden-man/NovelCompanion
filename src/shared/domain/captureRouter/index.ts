/**
 * Capture routing (A48). This file is a placeholder on `main` so the capture
 * features and the box can be built against the contract in `types.ts`
 * while branch `a48-router` builds the router. `a48-router` replaces it.
 */
import type { CaptureRouting, RouteOptions, RouterIndex, RouterIndexInput } from './types';

export * from './types';

/** Placeholder: an empty index. `a48-router` builds the real one from lists and entries. */
export function buildIndex(input: RouterIndexInput): RouterIndex {
  return {
    characters: [],
    places: [],
    communities: [],
    categories: [],
    glossary: [],
    ageGroups: [],
    culturalLines: [],
    moments: [],
    timelineEnd: input.timelineEnd,
  };
}

/** Placeholder: one fact on Route C with nothing resolved. `a48-router` replaces it. */
export function routeCapture(
  text: string,
  _index: RouterIndex,
  options: RouteOptions,
): CaptureRouting {
  return {
    text,
    storyYear: options.storyYear,
    facts: [
      {
        index: 0,
        text: text.trim(),
        years: { start: options.storyYear, end: null, source: 'the story year' },
        sentences: 1,
        candidates: [],
        scores: {},
        cues: {},
        ranked: [],
        section: 'openQuestions',
        share: 0,
        margin: 0,
        communities: [],
        missing: [],
        asks: [],
        reasons: ['the router is not built yet'],
        drafts: [],
        route: 'full',
      },
    ],
  };
}
