/**
 * Cultural entries and places by year (CU-1, CU-2, PC-1). Pure lookups over
 * plain entries: a year range with a missing start or end is open on that side.
 */
import { DEMOGRAPHIC_OPTIONS } from '../schema/world';
import type { Demographic } from '../schema/world';
import { CULTURE_UNIT_YEARS } from '../schema/settings';
import type { CultureUnit } from '../schema/settings';
import type { Doc } from './paths';

interface Ranged {
  startYear?: unknown;
  endYear?: unknown;
  deletedAt?: unknown;
}

function covers(r: Ranged, year: number): boolean {
  const start = typeof r.startYear === 'number' ? r.startYear : -Infinity;
  const end = typeof r.endYear === 'number' ? r.endYear : Infinity;
  return start <= year && year <= end;
}

const titleOf = (d: Doc) => (typeof d.title === 'string' ? d.title : '');

/** CU-2: the cultural entries of a community that apply in a year, earliest start first. */
export function entriesFor<T extends Doc>(
  entries: readonly T[],
  community: string,
  year: number,
): T[] {
  return entries
    .filter((e) => !e.deletedAt && e.communityId === community && covers(e, year))
    .sort(
      (a, b) =>
        ((a.startYear as number | null) ?? -Infinity) -
          ((b.startYear as number | null) ?? -Infinity) || titleOf(a).localeCompare(titleOf(b)),
    );
}

/**
 * A41, A47 (IP-10): the Cultural data screen steps over units of years: a
 * decade, five years, or one year, as the bible's settings say. Every
 * function takes the unit and defaults to the decade, so a unit is named by
 * its first year (2047 is the 2040s, or 2045 in fives, or 2047 alone).
 */
const sizeOf = (unit: CultureUnit): number => CULTURE_UNIT_YEARS[unit] ?? 10;

/** The first year of the unit a year falls in. */
export const unitOf = (year: number, unit: CultureUnit = 'decade'): number =>
  Math.floor(year / sizeOf(unit)) * sizeOf(unit);

/** "2040s", "2045 to 2049", or "2047". */
export function unitLabel(start: number, unit: CultureUnit = 'decade'): string {
  if (unit === 'decade') return `${start}s`;
  if (unit === 'one') return String(start);
  return `${start} to ${start + sizeOf(unit) - 1}`;
}

/** The years a line added in a unit covers: that unit only. */
export const unitSpan = (
  start: number,
  unit: CultureUnit = 'decade',
): { startYear: number; endYear: number } => ({
  startYear: start,
  endYear: start + sizeOf(unit) - 1,
});

/** A41: the decade a year falls in, as its first year (2047 is the 2040s). */
export const decadeOf = (year: number): number => unitOf(year, 'decade');

/** "2040s" */
export const decadeLabel = (decade: number): string => unitLabel(decade, 'decade');

/** The years a line added in a decade covers: that decade only. */
export const decadeSpan = (decade: number): { startYear: number; endYear: number } =>
  unitSpan(decade, 'decade');

function overlaps(r: Doc, start: number, unit: CultureUnit): boolean {
  const from = typeof r.startYear === 'number' ? r.startYear : -Infinity;
  const to = typeof r.endYear === 'number' ? r.endYear : Infinity;
  return from <= start + sizeOf(unit) - 1 && start <= to;
}

/** An age group a screen offers: the `ageGroups` list item ID and its label. */
export interface AgeGroupOption {
  value: string;
  label: string;
}

/**
 * A47 (IP-10): the age groups of the bible's `ageGroups` list, in its order,
 * or the six seeded bands when the list is missing or empty.
 */
export function ageGroupOptions(
  list: { items?: readonly { id: string; label: string }[] } | undefined,
): AgeGroupOption[] {
  const items = list?.items ?? [];
  return items.length ? items.map((i) => ({ value: i.id, label: i.label })) : DEMOGRAPHIC_OPTIONS;
}

/**
 * An entry's age group; an entry made before A41, or one whose group is not
 * among `groups`, is about everyone.
 */
export function demographicOf(
  e: Doc,
  groups: readonly AgeGroupOption[] = DEMOGRAPHIC_OPTIONS,
): Demographic {
  const d = e.demographic;
  return typeof d === 'string' && groups.some((g) => g.value === d) ? d : 'all';
}

export interface DecadeGroup<T> {
  demographic: Demographic;
  label: string;
  rows: T[];
}

/**
 * A41: the cultural lines of a community that touch a unit of years, one
 * group per age group in the list's order (everyone first when seeded),
 * earliest start first within each. Every group is returned, empty or not,
 * so each has a place to add to.
 */
export function decadeGroups<T extends Doc>(
  entries: readonly T[],
  community: string,
  start: number,
  unit: CultureUnit = 'decade',
  groups: readonly AgeGroupOption[] = DEMOGRAPHIC_OPTIONS,
): DecadeGroup<T>[] {
  const mine = entries.filter(
    (e) => !e.deletedAt && e.communityId === community && overlaps(e, start, unit),
  );
  return groups.map((o) => ({
    demographic: o.value,
    label: o.label,
    rows: mine
      .filter((e) => demographicOf(e, groups) === o.value)
      .sort(
        (a, b) =>
          ((a.startYear as number | null) ?? -Infinity) -
            ((b.startYear as number | null) ?? -Infinity) || titleOf(a).localeCompare(titleOf(b)),
      ),
  }));
}

/**
 * The units a community screen offers: every unit from the earliest year any
 * entry or era starts (or the story year) to the latest any ends, with a unit
 * either side so there is always somewhere to add to.
 */
export function decadesFor(
  entries: readonly Doc[],
  eras: readonly Doc[],
  storyYear: number,
  unit: CultureUnit = 'decade',
): number[] {
  const of = (y: number) => unitOf(y, unit);
  let lo = of(storyYear);
  let hi = lo;
  for (const r of [...entries, ...eras]) {
    if (r.deletedAt) continue;
    if (typeof r.startYear === 'number') lo = Math.min(lo, of(r.startYear));
    if (typeof r.endYear === 'number') hi = Math.max(hi, of(r.endYear));
    if (typeof r.startYear === 'number') hi = Math.max(hi, of(r.startYear));
    if (typeof r.endYear === 'number') lo = Math.min(lo, of(r.endYear));
  }
  const step = sizeOf(unit);
  const out: number[] = [];
  for (let d = lo - step; d <= hi + step; d += step) out.push(d);
  return out;
}

/** How a line's years read inside a unit: nothing when it is that unit alone. */
export function spanInDecade(e: Doc, start: number, unit: CultureUnit = 'decade'): string | null {
  const s = typeof e.startYear === 'number' ? e.startYear : null;
  const en = typeof e.endYear === 'number' ? e.endYear : null;
  if (s === start && en === start + sizeOf(unit) - 1) return null;
  if (s === null && en === null) return 'every year';
  if (en === null) return `from ${s}`;
  if (s === null) return `until ${en}`;
  return `${s} to ${en}`;
}

export interface PlaceDescription {
  startYear: number | null;
  endYear: number | null;
  text: string;
}

/**
 * PC-1: the description of a place in a year. When ranges overlap, the one
 * that starts latest wins, because it is the more specific. Null when none applies.
 */
export function descriptionFor(
  place: { descriptions?: readonly PlaceDescription[] },
  year: number,
): PlaceDescription | null {
  let best: PlaceDescription | null = null;
  for (const d of place.descriptions ?? []) {
    if (!covers(d, year)) continue;
    const start = d.startYear ?? -Infinity;
    if (!best || start > (best.startYear ?? -Infinity)) best = d;
  }
  return best;
}

/** "Portland > Pearl District > The Archive": a place with the places it sits in. */
export function placePath(places: readonly Doc[], id: string): string {
  const byId = new Map(places.map((p) => [String(p._id), p]));
  const names: string[] = [];
  const seen = new Set<string>();
  let cur: Doc | undefined = byId.get(id);
  while (cur && !seen.has(String(cur._id))) {
    seen.add(String(cur._id));
    names.unshift(titleOf(cur) || 'Untitled');
    cur = typeof cur.parentId === 'string' ? byId.get(cur.parentId) : undefined;
  }
  return names.join(' > ');
}

export interface PlaceNode {
  id: string;
  title: string;
  depth: number;
}

/** Places in tree order for a nested list: each parent followed by its children. */
export function placeOutline(places: readonly Doc[]): PlaceNode[] {
  const live = places.filter((p) => !p.deletedAt);
  const ids = new Set(live.map((p) => String(p._id)));
  const children = new Map<string | null, Doc[]>();
  for (const p of live) {
    const parent = typeof p.parentId === 'string' && ids.has(p.parentId) ? p.parentId : null;
    const list = children.get(parent) ?? [];
    list.push(p);
    children.set(parent, list);
  }
  const out: PlaceNode[] = [];
  const seen = new Set<string>();
  const walk = (parent: string | null, depth: number) => {
    const kids = (children.get(parent) ?? []).sort((a, b) => titleOf(a).localeCompare(titleOf(b)));
    for (const k of kids) {
      const id = String(k._id);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ id, title: titleOf(k), depth });
      walk(id, depth + 1);
    }
  };
  walk(null, 0);
  // Anything caught in a parent cycle still shows, at the top.
  for (const p of live) {
    if (!seen.has(String(p._id))) out.push({ id: String(p._id), title: titleOf(p), depth: 0 });
  }
  return out;
}

/**
 * A35: the place a free-text "place lived" names, such as "Los Angeles,
 * California (USC)". The parenthesised part is tried first, then each comma
 * part in order, so the most specific match wins. A place matches when its
 * title is the part, or carries the part in parentheses. Null when none does.
 */
export function placeForText(places: readonly Doc[], text: string): string | null {
  const inner = [...text.matchAll(/\(([^)]+)\)/g)].map((m) => (m[1] ?? '').trim());
  const outer = text
    .replace(/\([^)]*\)/g, '')
    .split(',')
    .map((s) => s.trim());
  const live = places.filter((p) => !p.deletedAt);
  for (const part of [...inner, ...outer]) {
    if (!part) continue;
    const want = part.toLowerCase();
    const hit =
      live.find((p) => titleOf(p).toLowerCase() === want) ??
      live.find((p) => titleOf(p).toLowerCase().includes(`(${want})`));
    if (hit) return String(hit._id);
  }
  return null;
}
