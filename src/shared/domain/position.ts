/**
 * The current position (SPEC section 2): the last chapter in reading order
 * marked as written. Character pages show ages at the current story time, or
 * at the current position's story year when no story time is set (CH-3, TM-3).
 */
import { isPlainObject } from './paths';
import type { Doc } from './paths';

/** The story year of a chapter: its primary strand, or the first strand when none is marked. */
export function chapterYear(chapter: Doc): number | null {
  const strands = Array.isArray(chapter.strands) ? chapter.strands.filter(isPlainObject) : [];
  const primary = strands.find((s) => s.primary === true) ?? strands[0];
  return primary && typeof primary.startYear === 'number' ? primary.startYear : null;
}

/** The last written chapter in reading order, or null when none is written. */
export function currentPositionChapter(chapters: readonly Doc[]): Doc | null {
  let best: Doc | null = null;
  for (const c of chapters) {
    if (c.deletedAt || c.written !== true || typeof c.readingOrder !== 'number') continue;
    if (!best || c.readingOrder > (best.readingOrder as number)) best = c;
  }
  return best;
}

export type PositionSource = 'storyTime' | 'lastWritten' | 'none';

export interface Position {
  year: number | null;
  source: PositionSource;
  chapterId: string | null;
}

/** The year ages are shown at: the story time, else the last written chapter's year. */
export function positionYear(
  storyTime: { year: number } | null,
  chapters: readonly Doc[],
): Position {
  if (storyTime) return { year: storyTime.year, source: 'storyTime', chapterId: null };
  const ch = currentPositionChapter(chapters);
  const year = ch ? chapterYear(ch) : null;
  if (ch && year !== null) return { year, source: 'lastWritten', chapterId: String(ch._id) };
  return { year: null, source: 'none', chapterId: null };
}
