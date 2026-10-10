import type { StoryDate } from '../schema/common';

export type KnownDate = { year: number; month?: number; day?: number };

export function isKnown(d: StoryDate | null | undefined): d is KnownDate {
  return !!d && 'year' in d;
}

/** The year of a story date, or null when it is unknown or absent. */
export function yearOf(d: StoryDate | null | undefined): number | null {
  return isKnown(d) ? d.year : null;
}

/**
 * Compare two story dates as far as both are known: by year, then month when
 * both have one, then day when both have one. Null when either is unknown.
 */
export function compareStoryDates(
  a: StoryDate | null | undefined,
  b: StoryDate | null | undefined,
): number | null {
  if (!isKnown(a) || !isKnown(b)) return null;
  if (a.year !== b.year) return a.year - b.year;
  if (a.month === undefined || b.month === undefined) return 0;
  if (a.month !== b.month) return a.month - b.month;
  if (a.day === undefined || b.day === undefined) return 0;
  return a.day - b.day;
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** A day number for a full date, or null when the month or day is missing. */
export function dayNumber(d: KnownDate): number | null {
  if (d.month === undefined || d.day === undefined) return null;
  return Math.floor(Date.UTC(d.year, d.month - 1, d.day) / 86_400_000);
}

/** True when the day does not exist in that month, for example 30 February. */
export function isImpossibleDate(d: StoryDate | null | undefined): boolean {
  if (!isKnown(d) || d.month === undefined || d.day === undefined) return false;
  return d.day > daysInMonth(d.year, d.month);
}

export function formatStoryDate(d: StoryDate | null | undefined): string {
  if (!d) return 'none';
  if (!isKnown(d)) return 'unknown';
  if (d.month === undefined) return String(d.year);
  const mm = String(d.month).padStart(2, '0');
  if (d.day === undefined) return `${d.year}-${mm}`;
  return `${d.year}-${mm}-${String(d.day).padStart(2, '0')}`;
}
