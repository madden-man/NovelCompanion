/**
 * Search filters (SR-2): section, status, provenance, family, place, tag, and
 * a year range. Pure predicates over stored entries, applied after the text
 * match so the index stays simple.
 */
import { manifests } from '../schema';
import type { EntryCollection } from '../schema';
import type { FieldSpec } from '../schema/manifest';
import { isKnown } from './dates';
import { tagsUsed } from './lists';
import { isPlainObject } from './paths';
import type { Doc } from './paths';
import { outgoingRefs } from './refs';
import type { CustomSpecs } from './refs';

export interface SearchFilters {
  /** Sections (collections) to search; empty or absent means all. */
  sections?: string[];
  status?: string[];
  provenance?: string[];
  familyId?: string | null;
  placeId?: string | null;
  tag?: string | null;
  yearFrom?: number | null;
  yearTo?: number | null;
}

export const NO_SEARCH_FILTERS: SearchFilters = {};

export interface FilterContext {
  get(collection: string, id: string): Doc | undefined;
  places: readonly Doc[];
  customSpecs?: CustomSpecs;
}

export type Span = readonly [number, number];

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function dateYear(v: unknown): number | null {
  return isPlainObject(v) && isKnown(v as never) ? num(v.year) : null;
}

function collectSpans(
  specs: readonly FieldSpec[],
  value: Doc,
  out: Span[],
  custom: CustomSpecs | undefined,
  root: Doc,
): void {
  const ends = new Set(specs.map((s) => s.rangeEnd).filter((e): e is string => !!e));
  for (const s of specs) {
    const v = value[s.name];
    switch (s.kind) {
      case 'year': {
        const y = num(v);
        if (y === null) break;
        if (s.rangeEnd) out.push([y, Math.max(y, num(value[s.rangeEnd]) ?? y)]);
        else if (
          !ends.has(s.name) ||
          !specs.some((o) => o.rangeEnd === s.name && num(value[o.name]) !== null)
        ) {
          out.push([y, y]);
        }
        break;
      }
      case 'storyDate': {
        const y = dateYear(v);
        if (y === null) break;
        if (s.name === 'start') out.push([y, Math.max(y, dateYear(value.end) ?? y)]);
        else if (s.name !== 'end' || dateYear(value.start) === null) out.push([y, y]);
        break;
      }
      case 'yearOrAge': {
        const y = isPlainObject(v) ? num(v.year) : null;
        if (y !== null) out.push([y, y]);
        break;
      }
      case 'object':
        if (isPlainObject(v) && s.fields) collectSpans(s.fields, v, out, custom, root);
        break;
      case 'objectList':
        if (Array.isArray(v) && s.fields) {
          for (const item of v)
            if (isPlainObject(item)) collectSpans(s.fields, item, out, custom, root);
        }
        break;
      case 'customValues': {
        const sub = typeof root.sectionId === 'string' ? custom?.(root.sectionId) : undefined;
        if (sub && isPlainObject(v)) collectSpans(sub, v, out, custom, root);
        break;
      }
      default:
        break;
    }
  }
}

/**
 * The year spans an entry covers, found through its field manifest: a year
 * field is a point, a start and end pair is a span, and so are a world
 * event's start and end dates. An open end is treated as the start year.
 */
export function entrySpans(collection: string, doc: Doc, custom?: CustomSpecs): Span[] {
  const manifest = manifests[collection as EntryCollection];
  if (!manifest) return [];
  const out: Span[] = [];
  collectSpans(manifest, doc, out, custom, doc);
  return out;
}

/** True when any span overlaps the range; an open bound matches everything on that side. */
export function overlapsYears(
  spans: readonly Span[],
  from: number | null | undefined,
  to: number | null | undefined,
): boolean {
  const lo = from ?? -Infinity;
  const hi = to ?? Infinity;
  return spans.some(([a, b]) => a <= hi && b >= lo);
}

/** The place and every place inside it. */
export function placeAndDescendants(places: readonly Doc[], placeId: string): Set<string> {
  const out = new Set([placeId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of places) {
      const id = String(p._id);
      if (!out.has(id) && typeof p.parentId === 'string' && out.has(p.parentId)) {
        out.add(id);
        grew = true;
      }
    }
  }
  return out;
}

const hasYearFilter = (f: SearchFilters) =>
  (f.yearFrom !== null && f.yearFrom !== undefined) ||
  (f.yearTo !== null && f.yearTo !== undefined);

/**
 * Build the predicate for a set of filters. Entries without a year or range
 * field never match a year filter. A family filter matches the family, its
 * characters, and any entry that refers to either; a place filter matches the
 * place, the places inside it, and any entry that refers to one of them.
 */
export function compileFilters(
  filters: SearchFilters,
  ctx: FilterContext,
): (collection: string, doc: Doc) => boolean {
  const sections = filters.sections?.length ? new Set(filters.sections) : null;
  const status = filters.status?.length ? new Set(filters.status) : null;
  const provenance = filters.provenance?.length ? new Set(filters.provenance) : null;
  const places = filters.placeId ? placeAndDescendants(ctx.places, filters.placeId) : null;
  const familyId = filters.familyId || null;
  const years = hasYearFilter(filters);
  const inFamily = (id: string): boolean => {
    if (id === familyId) return true;
    const c = ctx.get('characters', id);
    return Array.isArray(c?.familyIds) && (c.familyIds as unknown[]).includes(familyId);
  };

  return (collection, doc) => {
    if (sections && !sections.has(collection)) return false;
    if (status && !status.has(String(doc.status))) return false;
    if (provenance && !provenance.has(String(doc.provenance))) return false;
    const manifest = manifests[collection as EntryCollection];
    if (
      filters.tag &&
      !(manifest && tagsUsed(manifest, doc, ctx.customSpecs).includes(filters.tag))
    ) {
      return false;
    }
    if (
      years &&
      !overlapsYears(entrySpans(collection, doc, ctx.customSpecs), filters.yearFrom, filters.yearTo)
    ) {
      return false;
    }
    if (familyId || places) {
      const refs = manifest ? outgoingRefs(manifest, doc, ctx.customSpecs) : [];
      if (
        familyId &&
        !(collection === 'families' && doc._id === familyId) &&
        !inFamily(String(doc._id)) &&
        !refs.some((r) => inFamily(r.targetId))
      ) {
        return false;
      }
      if (places && !places.has(String(doc._id)) && !refs.some((r) => places.has(r.targetId))) {
        return false;
      }
    }
    return true;
  };
}
