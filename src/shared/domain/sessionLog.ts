/**
 * The session log (SL-1): the entry the "Where did you stop?" prompt writes,
 * and the note the launch panel shows first.
 */
import type { Doc } from './paths';

const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** A calendar date as YYYY-MM-DD in local time. */
export function localDateString(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** The data for a new session log entry made by the stop prompt. Null when the answer is empty. */
export function stopLogData(
  answer: { stoppedAt: string; chapterId?: string | null },
  today: Date,
): Record<string, unknown> | null {
  const stoppedAt = answer.stoppedAt.trim();
  if (!stoppedAt) return null;
  const date = localDateString(today);
  return {
    title: `Session ${date}`,
    status: 'canon',
    date,
    chapterId: answer.chapterId || null,
    stoppedAt,
    notes: '',
  };
}

/** The newest live log, by date and then by when it was made. */
export function latestLog(logs: readonly Doc[]): Doc | null {
  const live = logs.filter((l) => !l.deletedAt && str(l.stoppedAt).trim() + str(l.notes).trim());
  live.sort(
    (a, b) =>
      str(b.date).localeCompare(str(a.date)) || str(b.createdAt).localeCompare(str(a.createdAt)),
  );
  return live[0] ?? null;
}

/** Session logs newest first, for the list. */
export function logsNewestFirst<T extends Doc>(logs: readonly T[]): T[] {
  return [...logs].sort(
    (a, b) =>
      str(b.date).localeCompare(str(a.date)) || str(b.createdAt).localeCompare(str(a.createdAt)),
  );
}

/** SL-1: how long main waits for the page to show the stop prompt before it closes anyway. */
export const STOP_PROMPT_TIMEOUT_MS = 10_000;

/**
 * SL-1: the label on the stop prompt's main button. With a note it says what
 * is being closed ("close" for the window, "quit" for the app); without one it
 * says so.
 */
export function stopPromptLabel(hasNote: boolean, quitting: boolean): string {
  if (hasNote) return quitting ? 'Save note and quit' : 'Save note and close';
  return quitting ? 'Quit without a note' : 'Close without a note';
}

export interface StopPromptState {
  /** True once the page has said it is showing the prompt. */
  shown: boolean;
  /** The person's answer: true closes, false keeps working, null is no answer yet. */
  decision: boolean | null;
  /** Milliseconds since main asked the page to show the prompt. */
  elapsedMs: number;
}

/**
 * SL-1: what main does next. A page that never shows the prompt (it hung or
 * crashed) cannot trap the window: after the timeout main closes without
 * writing a log. Once the prompt is shown, main waits for the person for as
 * long as they take.
 */
export function stopPromptOutcome(
  state: StopPromptState,
  timeoutMs: number = STOP_PROMPT_TIMEOUT_MS,
): 'wait' | 'close' | 'stay' {
  if (state.decision === true) return 'close';
  if (state.decision === false) return 'stay';
  if (state.shown) return 'wait';
  return state.elapsedMs >= timeoutMs ? 'close' : 'wait';
}
