/**
 * Cultural entries and places by year (CU-1, CU-2, PC-1). Pure lookups over
 * plain entries: a year range with a missing start or end is open on that side.
 */
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
