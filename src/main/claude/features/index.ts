import { importProposals } from './importProposals';

/**
 * Every structured Claude feature, by name. M7 adds `briefs` (SB-4, DB-2) and
 * `summaries` (MS-2); M8 adds `alignment` (CC-3). Each is a
 * `FeatureDefinition` (see `../runtime.ts`). The AI-4 test walks this list,
 * so a feature added here is checked for the prose prohibition.
 */
export const FEATURES = {
  importProposals,
};

export type FeatureName = keyof typeof FEATURES;

/** Name and system prompt text of every feature, for the AI-4 test and docs. */
export const FEATURE_LIST: { feature: string; instructions: string }[] = Object.values(FEATURES);
