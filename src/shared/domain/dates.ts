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

/** Which date a one-box date field holds: blank means unknown for a birth, not recorded for a death. */
export type DateBox = 'birth' | 'death';

export const DATE_TEXT_HELP =
  'Write a year (1990), a year and month (1990-03), or a full date (1990-03-14).';

/**
 * SM-1: the text a one-box date field shows. A year, "1990-03", or
 * "1990-03-14"; an unknown or absent date is blank.
 */
export function dateText(d: StoryDate | null | undefined): string {
  return isKnown(d) ? formatStoryDate(d) : '';
}

/**
 * SM-1: read a one-box date. Accepts a year, a year and month, a full date, or
 * blank (unknown for a birth, null for a death). Anything else is refused with
 * a plain message and nothing is written. A day past the end of its month is
 * kept so the impossible-date warning can show it (ED-10).
 */
export function parseDateText(
  text: string,
  box: DateBox,
): { ok: true; value: StoryDate | null } | { ok: false; message: string } {
  const t = text.trim();
  if (t === '') return { ok: true, value: box === 'birth' ? { unknown: true } : null };
  const m = /^(-?\d{1,5})(?:-(\d{1,2})(?:-(\d{1,2}))?)?$/.exec(t);
  if (!m) return { ok: false, message: `${t} is not a date. ${DATE_TEXT_HELP}` };
  const year = Number(m[1]);
  if (year < -10000 || year > 10000) {
    return { ok: false, message: `${year} is outside the years the app keeps (-10000 to 10000).` };
  }
  if (m[2] === undefined) return { ok: true, value: { year } };
  const month = Number(m[2]);
  if (month < 1 || month > 12) {
    return { ok: false, message: `${m[2]} is not a month. Months run from 01 to 12.` };
  }
  if (m[3] === undefined) return { ok: true, value: { year, month } };
  const day = Number(m[3]);
  if (day < 1 || day > 31) {
    return { ok: false, message: `${m[3]} is not a day. Days run from 01 to 31.` };
  }
  return { ok: true, value: { year, month, day } };
}

/** A calendar date as YYYY-MM-DD in local time. */
export function localDateString(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
