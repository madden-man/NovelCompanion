/**
 * IP-6 (a47-desk): whether a saved brief's text was edited by hand since the
 * app last wrote it. The brief writer stores its text with a revision note
 * (`BRIEF_WRITTEN_NOTE`), and a brief's first revision is the one Start
 * session made, so the text is the writer's own unless it matches one of
 * those. Regenerate says "This replaces your edits" when it is.
 */

/** The revision note the brief writer leaves when it writes a brief again. */
export const BRIEF_WRITTEN_NOTE = 'Brief written again from the selection';

/** The brief fields a write of the brief writer sets; undoing it puts these back. */
export const BRIEF_WRITTEN_FIELDS = [
  'title',
  'chapterId',
  'storyYear',
  'povCharacterId',
  'entryIds',
  'content',
  'sectionKind',
  'strandId',
  'partId',
  'placeIds',
  'characterIds',
  'added',
  'removed',
  'model',
  'synthesized',
  'selection',
] as const;

/** A revision as `revisions.list` gives it, newest first. */
export interface BriefRevision {
  _id: string;
  op: string;
  note: string | null;
}

/** The revisions the app wrote the text in, newest first (at most `limit`). */
export function writtenRevisions(revisions: readonly BriefRevision[], limit = 5): BriefRevision[] {
  return revisions
    .filter((r) => r.op === 'create' || r.note === BRIEF_WRITTEN_NOTE)
    .slice(0, limit);
}

/**
 * True when the text is not any text the app wrote: an edit by hand. Line
 * endings and the space at the ends do not count as edits.
 */
export function briefEdited(content: string, written: readonly string[]): boolean {
  const norm = (s: string) => s.replace(/\r\n/g, '\n').trim();
  const now = norm(content);
  return !written.some((w) => norm(w) === now);
}
