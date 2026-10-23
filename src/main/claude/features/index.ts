import { alignment } from './alignment';
import { capture } from './capture';
import { captureFast } from './captureFast';
import { summaries } from './summaries';

/**
 * Every structured Claude feature, by name: chapter summaries (MS-2),
 * alignment checks (CC-3), capture (KB-6), and the fast file of capture
 * routing (A48, CR-7). Each is a `FeatureDefinition` (see `../runtime.ts`).
 * The AI-4 test walks this list, so a feature added here is checked for the
 * prose prohibition.
 */
export const FEATURES = {
  summaries,
  alignment,
  capture,
  captureFast,
};

export type FeatureName = keyof typeof FEATURES;

/** Name and system prompt text of every feature, for the AI-4 test and docs. */
export const FEATURE_LIST: { feature: string; instructions: string }[] = Object.values(FEATURES);
