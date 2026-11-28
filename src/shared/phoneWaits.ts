import { z } from 'zod';
import { lineKey } from './domain/tray';
import type { TrayMarks } from './domain/tray';

/**
 * A58 U5 (PH-28): sentences caught on the phone that the Capture Router
 * cannot file without Claude. They are not sent anywhere: they wait in the
 * bible's `meta` document `phoneWaits` until the desk handles them in the
 * From the notebook tray, or the phone takes them back. This is their own
 * source: the notebook pull (`planNotebook`) reads and trashes only
 * `notebookPages`, so it never touches them.
 */

/** The `meta` document that holds the waiting sentences. */
export const PHONE_WAITS_META_ID = 'phoneWaits';

/**
 * The most sentences that may wait at once; more is refused in plain words.
 * Only lines the desk has not handled count, and the store never holds more
 * than this many: the oldest handled lines make room for new ones.
 */
export const PHONE_WAITS_MAX = 500;
export const PHONE_WAITS_FULL = `No more than ${PHONE_WAITS_MAX} sentences can be waiting for the Mac at once. File or dismiss some there first.`;
/** Take back of a line the desk filed, dismissed or sent: it stays for the desk. */
export const PHONE_WAITS_HANDLED = 'The Mac has already handled this sentence.';

const Year = z.int().min(-10000).max(10000);

/** One waiting sentence: its ID, the sentence, the story year it was caught in, and when. */
export const WaitingLine = z.strictObject({
  id: z.string().min(1).max(64),
  text: z.string().min(1).max(4000),
  year: Year,
  /** ISO time it was kept. */
  at: z.string().min(1).max(40),
});
export type WaitingLine = z.infer<typeof WaitingLine>;

/** The stored shape (schema version 17). */
export const PhoneWaitsDoc = z.strictObject({
  _id: z.literal(PHONE_WAITS_META_ID),
  lines: z.array(WaitingLine),
});
export type PhoneWaitsDoc = z.infer<typeof PhoneWaitsDoc>;

/** The waiting lines a stored document holds; an unreadable line is left out, never thrown on. */
export function readWaits(doc: unknown): WaitingLine[] {
  const lines = (doc as { lines?: unknown } | null | undefined)?.lines;
  if (!Array.isArray(lines)) return [];
  return lines.flatMap((l) => {
    const r = WaitingLine.safeParse(l);
    return r.success ? [r.data] : [];
  });
}

/**
 * PH-28: whether the desk has handled a waiting line: the tray marked one of
 * its facts filed, dismissed or sent (FN-3, FN-4, FN-6). The tray's fact key
 * is the line's key and the fact's place, so any mark under the line's key
 * counts. Undo on the desk clears the mark, and the line waits again.
 */
export function waitingHandled(line: Pick<WaitingLine, 'id' | 'text'>, marks: TrayMarks): boolean {
  const prefix = `${lineKey(line.id, line.text)}#`;
  return [marks.dismissed, marks.filed, marks.sent].some((keys) =>
    keys.some((k) => k.startsWith(prefix)),
  );
}

/** A line to add: a new one gets its ID and time from the store; undo and redo bring the old ones back. */
export const WaitingInput = z.strictObject({
  id: z.string().min(1).max(64).optional(),
  text: z.string().trim().min(1).max(4000),
  year: Year,
  at: z.string().min(1).max(40).optional(),
});
export type WaitingInput = z.infer<typeof WaitingInput>;

/**
 * The lines after adding `add` (an ID already there is replaced in place,
 * so a redo never doubles a line) and taking out `drop`.
 */
export function withWaits(
  lines: readonly WaitingLine[],
  add: readonly WaitingLine[],
  drop: readonly string[] = [],
): WaitingLine[] {
  const gone = new Set(drop);
  const fresh = new Map(add.map((l) => [l.id, l]));
  const out = lines.filter((l) => !gone.has(l.id)).map((l) => fresh.get(l.id) ?? l);
  const have = new Set(out.map((l) => l.id));
  for (const l of add) if (!have.has(l.id) && !gone.has(l.id)) out.push(l);
  return out;
}

/**
 * The lines to store after a change: refused when more than the limit would
 * wait, or when a line to take out has been handled on the desk (its text
 * would come back to the phone and could be filed twice). When the store would
 * hold more than the limit, the oldest handled lines are left out.
 */
export function nextWaits(
  lines: readonly WaitingLine[],
  add: readonly WaitingLine[],
  drop: readonly string[],
  marks: TrayMarks,
): { lines: WaitingLine[] } | { refused: string } {
  const handled = (l: WaitingLine) => waitingHandled(l, marks);
  if (lines.some((l) => drop.includes(l.id) && handled(l))) return { refused: PHONE_WAITS_HANDLED };
  const next = withWaits(lines, add, drop);
  if (next.filter((l) => !handled(l)).length > PHONE_WAITS_MAX)
    return { refused: PHONE_WAITS_FULL };
  const over = next.length - PHONE_WAITS_MAX;
  if (over <= 0) return { lines: next };
  const added = new Set(add.map((l) => l.id));
  const gone = new Set(
    next
      .filter((l) => handled(l) && !added.has(l.id))
      .sort((a, b) => a.at.localeCompare(b.at))
      .slice(0, over)
      .map((l) => l.id),
  );
  return { lines: next.filter((l) => !gone.has(l.id)) };
}

/** What the channels answer: every stored line, with whether the desk has handled it. */
export const WaitingLineWire = WaitingLine.extend({ handled: z.boolean() });
export type WaitingLineWire = z.infer<typeof WaitingLineWire>;
