import { briefs } from './briefs';
import { importProposals } from './importProposals';
import { summaries } from './summaries';

/**
 * Every structured Claude feature, by name: session briefs (SB-4, DB-2),
 * chapter summaries (MS-2), and import proposals (IM-5); M8 adds `alignment`
 * (CC-3). Each is a `FeatureDefinition` (see `../runtime.ts`). The AI-4 test
 * walks this list, so a feature added here is checked for the prose
 * prohibition.
 */
export const FEATURES = {
  briefs,
  summaries,
  importProposals,
};

export type FeatureName = keyof typeof FEATURES;

/** Name and system prompt text of every feature, for the AI-4 test and docs. */
export const FEATURE_LIST: { feature: string; instructions: string }[] = Object.values(FEATURES);
