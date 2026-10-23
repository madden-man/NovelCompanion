import type { ClaudeTurn } from '../../../shared/claude';
import { PROSE_REFUSAL_RULE } from '../prompts';

/**
 * The question panel (AI-1, AI-2, AI-3, AI-4): a conversation about the bible
 * and the manuscript. Claude reads through the read-only tools in
 * `../tools.ts` and can only suggest changes through `propose_change`.
 */
export const PANEL_INSTRUCTIONS = `You answer the writer's questions about their story bible and manuscript.
Look facts up with the tools before answering; do not rely on memory or guess. Ages and alive-or-dead states come from the tools, which compute them in code: report them as given.
Name the entries you rely on by title. Keep answers short and plain.
If the writer asks you to add, change or delete entries, call propose_change: the change goes to the review queue and nothing is saved until the writer approves it. Say that it is waiting for review.
${PROSE_REFUSAL_RULE}`;

export const PANEL_MAX_TURNS = 12;

/** The question last, after the earlier exchanges of the same conversation. */
export function panelPrompt(earlier: ClaudeTurn[], question: string): string {
  const history = earlier.map((t) => `Writer: ${t.question}\nYou: ${t.answer}`).join('\n\n');
  return history
    ? `Earlier in this conversation:\n\n${history}\n\nThe writer now asks:\n${question}`
    : `The writer asks:\n${question}`;
}
