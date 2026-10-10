/** Open questions (OQ-1): filtering by state. */
import type { Doc } from './paths';

export type QuestionFilter = 'all' | 'open' | 'decided';

/** The questions in a state, or all of them. A question with no state counts as open. */
export function filterQuestions<T extends Doc>(
  questions: readonly T[],
  state: QuestionFilter,
): T[] {
  if (state === 'all') return [...questions];
  return questions.filter((q) => (q.state === 'decided' ? 'decided' : 'open') === state);
}

export function questionCounts(questions: readonly Doc[]): { open: number; decided: number } {
  const decided = questions.filter((q) => q.state === 'decided').length;
  return { open: questions.length - decided, decided };
}
