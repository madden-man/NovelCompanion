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
