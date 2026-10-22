import { CLAUDE_FEATURES, FEATURE_INFO } from '../../shared/claude';
import type { ClaudeFeature, ClaudeInstructionWire } from '../../shared/claude';
import { promptFooter } from './prompts';
import { FEATURES } from './features';
import { PANEL_INSTRUCTIONS } from './features/panel';

/**
 * IP-15: each Claude feature's default instructions, the text the writer can
 * replace in Settings. The fixed footer (`promptFooter`) follows whatever is
 * used, so the shared rules and the AI-4 sentence are always there.
 */
export function defaultInstructions(feature: ClaudeFeature): string {
  return feature === 'panel' ? PANEL_INSTRUCTIONS : FEATURES[feature].instructions;
}

/** The panel and both capture features keep the AI-4 refusal rule in their footer. */
const keepsRefusal = (feature: ClaudeFeature) =>
  feature === 'panel' || feature === 'capture' || feature === 'captureFast';

/** One feature's instructions as Settings shows them. */
export function instructionView(
  feature: ClaudeFeature,
  stored: Partial<Record<ClaudeFeature, string>>,
): ClaudeInstructionWire {
  return {
    feature,
    label: FEATURE_INFO[feature].label,
    default: defaultInstructions(feature),
    text: stored[feature] ?? null,
    footer: promptFooter(keepsRefusal(feature)),
  };
}

/** Every feature's instructions, in the order of `CLAUDE_FEATURES`. */
export function instructionViews(
  stored: Partial<Record<ClaudeFeature, string>>,
): ClaudeInstructionWire[] {
  return CLAUDE_FEATURES.map((f) => instructionView(f, stored));
}
