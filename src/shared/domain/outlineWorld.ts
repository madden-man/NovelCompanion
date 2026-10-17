/**
 * A37: the world around the outline. The scene flow puts each chapter's story
 * year beside the era and the world events of that year, and names the time
 * that passes between two chapters with the events that fall in it; the year
 * grid draws the eras and events above the chapters. These helpers pick the
 * events and say the gaps in plain words; all of it is computed in code (TL-1).
 */

export interface WorldEra {
  id: string;
  name: string;
  startYear: number;
  endYear: number;
}

export interface WorldEvent {
  id: string;
  title: string;
  startYear: number;
  endYear: number;
}

/** The era a year falls in; with overlapping eras, the one that started last. */
export function eraAt<E extends WorldEra>(eras: readonly E[], year: number): E | null {
  let best: E | null = null;
  for (const e of eras) {
    if (e.startYear <= year && year <= e.endYear && (!best || e.startYear > best.startYear))
      best = e;
  }
  return best;
}

/**
 * The events going on in a year: those that begin that year first, then the
 * ongoing ones, latest start first, so what is new reads before what is old.
 */
export function eventsIn<E extends WorldEvent>(events: readonly E[], year: number): E[] {
  return events
    .filter((e) => e.startYear <= year && year <= e.endYear)
    .sort(
      (a, b) =>
        Number(b.startYear === year) - Number(a.startYear === year) ||
        b.startYear - a.startYear ||
        a.title.localeCompare(b.title),
    );
}

/**
 * The events that begin after one chapter's year and before the next one's,
 * in order: what happens in the world while the story looks away. Events
 * that begin in the later year belong to that chapter, so they are left out.
 */
export function eventsBetween<E extends WorldEvent>(
  events: readonly E[],
  from: number,
  to: number,
): E[] {
  if (to - from < 2) return [];
  return events
    .filter((e) => e.startYear > from && e.startYear < to)
    .sort((a, b) => a.startYear - b.startYear || a.title.localeCompare(b.title));
}

/** The time from one chapter to the next, in plain words. */
export function yearGap(from: number, to: number): string {
  const n = Math.abs(to - from);
  const years = `${n} ${n === 1 ? 'year' : 'years'}`;
  if (to === from) return `Same year, ${to}`;
  if (to > from) return `${years} later, ${to}`;
  return `Back ${years}, to ${to}`;
}

/** Events stacked in rows so none hides another: an event takes the first row free at its start. */
export function eventLanes<E extends WorldEvent>(
  events: readonly E[],
  maxLanes: number,
): { event: E; lane: number }[] {
  const ends: number[] = [];
  return [...events]
    .sort((a, b) => a.startYear - b.startYear || b.endYear - a.endYear)
    .map((event) => {
      let lane = ends.findIndex((end) => end < event.startYear);
      if (lane === -1) {
        lane = ends.length < maxLanes ? ends.length : ends.indexOf(Math.min(...ends));
        if (lane === ends.length) ends.push(event.endYear);
      }
      ends[lane] = Math.max(ends[lane] ?? event.endYear, event.endYear);
      return { event, lane };
    });
}
