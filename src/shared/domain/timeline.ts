/**
 * Timeline queries (TL-1 to TL-7, WE-1 to WE-3, TM-2, TM-4) as pure functions
 * over the bible's entries. Every age and every alive-or-dead answer comes
 * from `ages.ts`, so the tree, the character page, the year view, the story
 * time dialog, and the timeline all agree. Nothing here calls a model (TL-1).
 */
import type { ListDoc } from '../schema/lists';
import type { StoryDate } from '../schema/common';
import { LIVES_IN_PREFIX } from '../schema/moment';
import { lifeState } from './ages';
import type { LifeState, Lifespan, StoryMoment, YearStates } from './ages';
import { compareStoryDates, isKnown, yearOf } from './dates';
import type { KnownDate } from './dates';
import { itemPath } from './lists';
import { isPlainObject } from './paths';
import type { Doc } from './paths';

/** Locale-independent text order, so the same bible sorts the same on every machine. */
const byCode = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Anything that hands out the live and trashed entries of a collection: the read model, or plain arrays. */
export interface TimelineData {
  all(collection: string): Doc[];
}

/** Wrap plain arrays, for tests and for the renderer. */
export function fromCollections(c: Record<string, readonly Doc[] | undefined>): TimelineData {
  return { all: (name) => [...(c[name] ?? [])] };
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const live = (d: Doc) => !d.deletedAt;
const asDate = (v: unknown): StoryDate | null => (isPlainObject(v) ? (v as StoryDate) : null);
const momentYear = (at: StoryMoment) => (typeof at === 'number' ? at : at.year);
const momentDate = (at: StoryMoment): KnownDate => (typeof at === 'number' ? { year: at } : at);
const ids = (v: unknown) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);

function lifespan(c: Doc): Lifespan {
  return { birth: asDate(c.birth), death: asDate(c.death) };
}

export function characterName(c: Doc | undefined, fallback = ''): string {
  if (!c) return fallback;
  const n = isPlainObject(c.names) ? str(c.names.full).trim() : '';
  return n || str(c.title).trim() || fallback || String(c._id);
}

// ---------- TL-2 to TL-4, CH-4: one character, everyone ----------

/** TL-2 to TL-4 and CH-4 for one character at a year or a full date. */
export function stateIn(character: Doc | Lifespan, at: StoryMoment): LifeState {
  const span =
    'birth' in character && 'death' in character && !('_id' in character)
      ? (character as Lifespan)
      : lifespan(character as Doc);
  return lifeState(span, at);
}

export interface PersonInYear {
  id: string;
  name: string;
  chinese: string;
  familyIds: string[];
  status: string;
  birthYear: number | null;
  state: LifeState;
}

export interface EveryoneIn extends YearStates {
  /** Every live character, alive first, then not yet born, dead, and unknown. */
  rows: PersonInYear[];
}

const STATE_ORDER: Record<LifeState['state'], number> = {
  alive: 0,
  unborn: 1,
  dead: 2,
  unknown: 3,
};

/** TL-2: every live character at a year or date, as alive with age, dead, not yet born, or unknown. */
export function everyoneIn(data: TimelineData, at: StoryMoment): EveryoneIn {
  const out: EveryoneIn = {
    year: momentYear(at),
    alive: [],
    dead: [],
    unborn: [],
    unknown: [],
    rows: [],
  };
  for (const c of data.all('characters')) {
    if (!live(c)) continue;
    const id = String(c._id);
    const state = lifeState(lifespan(c), at);
    if (state.state === 'alive')
      out.alive.push({ id, age: state.age, dyingThisYear: state.dyingThisYear });
    else if (state.state === 'dead') out.dead.push({ id, deathYear: state.deathYear });
    else if (state.state === 'unborn') out.unborn.push(id);
    else out.unknown.push(id);
    out.rows.push({
      id,
      name: characterName(c, id),
      chinese: isPlainObject(c.names) ? str(c.names.chinese) : '',
      familyIds: ids(c.familyIds),
      status: str(c.status),
      birthYear: yearOf(asDate(c.birth)),
      state,
    });
  }
  out.rows.sort(
    (a, b) =>
      STATE_ORDER[a.state.state] - STATE_ORDER[b.state.state] ||
      (a.birthYear ?? 0) - (b.birthYear ?? 0) ||
      byCode(a.name, b.name),
  );
  return out;
}

// ---------- world events (WE-1, WE-3, TL-5) ----------

export interface EventSpan {
  id: string;
  title: string;
  start: StoryDate | null;
  end: StoryDate | null;
  startYear: number;
  endYear: number;
  categoryId: string;
  regions: string[];
  characterIds: string[];
  formative: boolean;
  status: string;
}

function eventSpan(e: Doc): EventSpan | null {
  const start = asDate(e.start);
  const s = yearOf(start);
  if (s === null) return null;
  const end = asDate(e.end);
  const endYear = yearOf(end);
  return {
    id: String(e._id),
    title: str(e.title) || 'World event',
    start,
    end,
    startYear: s,
    endYear: endYear === null ? s : Math.max(endYear, s),
    categoryId: str(e.categoryId),
    regions: ids(e.regions),
    characterIds: ids(e.characterIds),
    formative: e.formative === true,
    status: str(e.status),
  };
}

/** Live world events with a known year, in date order. */
export function eventSpans(data: TimelineData): EventSpan[] {
  const out: EventSpan[] = [];
  for (const e of data.all('worldEvents')) {
    if (!live(e)) continue;
    const s = eventSpan(e);
    if (s) out.push(s);
  }
  return out.sort((a, b) => (compareStoryDates(a.start, b.start) ?? 0) || byCode(a.title, b.title));
}

/** True when the event has begun by this moment: its year is earlier, or the same with no later day. */
function begunBy(e: EventSpan, at: StoryMoment): boolean {
  if (e.startYear !== momentYear(at)) return e.startYear < momentYear(at);
  return (compareStoryDates(e.start, momentDate(at)) ?? 0) <= 0;
}

/**
 * WE-3: the events up to a year: every event begun by then, in date order.
 * With a window, only events still running within that many years before it.
 */
export function eventsUpTo(data: TimelineData, at: StoryMoment, window?: number): EventSpan[] {
  const y = momentYear(at);
  return eventSpans(data).filter(
    (e) => begunBy(e, at) && (window === undefined || e.endYear >= y - window),
  );
}

/**
 * The events that have not begun by this moment but start within `ahead`
 * years of it, in date order: next year's events for the brief window (A33).
 */
export function eventsAhead(data: TimelineData, at: StoryMoment, ahead: number): EventSpan[] {
  const y = momentYear(at);
  return eventSpans(data).filter((e) => !begunBy(e, at) && e.startYear <= y + ahead);
}

/** TM-2: events whose date or range includes the year. */
export function eventsIn(data: TimelineData, year: number): EventSpan[] {
  return eventSpans(data).filter((e) => e.startYear <= year && e.endYear >= year);
}

export interface LivedEvent {
  id: string;
  title: string;
  startYear: number;
  endYear: number;
  /** The year the character first lived through it: the start, or their birth year when it was already running. */
  year: number;
  age: number;
  categoryId: string;
  formative: boolean;
}

export interface LivedThrough {
  characterId: string;
  year: number;
  /** False when the birth is unknown: nothing can be computed (CH-4). */
  birthKnown: boolean;
  state: LifeState;
  events: LivedEvent[];
}

/** True when the death is a full date and the event starts later in the same year. */
function diedAfter(death: StoryDate | null | undefined, e: EventSpan): boolean {
  if (!isKnown(death) || death.month === undefined || death.day === undefined) return false;
  if (!e.start || !isKnown(e.start) || e.startYear !== death.year) return false;
  if (e.start.month === undefined) return false;
  if (e.start.month !== death.month) return e.start.month > death.month;
  return e.start.day !== undefined && e.start.day > death.day;
}

/**
 * TL-5: the world events a character has lived through by a year or date,
 * with their age at each. An event counts when it overlaps the lifetime and
 * has begun by then; events after death are left out.
 */
export function livedThrough(
  data: TimelineData,
  characterId: string,
  at: StoryMoment,
): LivedThrough | null {
  const c = data.all('characters').find((d) => d._id === characterId);
  if (!c) return null;
  const span = lifespan(c);
  const state = lifeState(span, at);
  const out: LivedThrough = {
    characterId,
    year: momentYear(at),
    birthKnown: isKnown(span.birth),
    state,
    events: [],
  };
  const born = yearOf(span.birth);
  if (born === null || state.state === 'unborn') return out;
  const died = yearOf(span.death);
  for (const e of eventSpans(data)) {
    if (!begunBy(e, at)) continue;
    if (e.endYear < born) continue;
    if (died !== null && e.startYear > died) continue;
    // Within the death year, an event that starts after a full death date is after death.
    if (diedAfter(span.death, e)) continue;
    const metAt: StoryMoment =
      e.startYear >= born && e.start && isKnown(e.start) ? (e.start as KnownDate) : born;
    const st = lifeState(span, metAt);
    const age = st.state === 'alive' ? st.age : 0;
    out.events.push({
      id: e.id,
      title: e.title,
      startYear: e.startYear,
      endYear: e.endYear,
      year: Math.max(e.startYear, born),
      age,
      categoryId: e.categoryId,
      formative: e.formative,
    });
  }
  return out;
}

// ---------- eras (WE-2, WE-3) ----------

export interface EraSpan {
  id: string;
  name: string;
  startYear: number;
  endYear: number;
  /** The era's text; A39 folded its five prose fields into it (SM-4). */
  body: string;
}

/** Live eras in start order. An era whose end is before its start covers nothing. */
export function eraSpans(data: TimelineData): EraSpan[] {
  const out: EraSpan[] = [];
  for (const e of data.all('eraStates')) {
    if (!live(e)) continue;
    const s = num(e.startYear);
    const t = num(e.endYear);
    if (s === null || t === null) continue;
    out.push({
      id: String(e._id),
      name: str(e.name) || str(e.title) || String(e._id),
      startYear: s,
      endYear: t,
      body: str(e.body),
    });
  }
  return out.sort((a, b) => a.startYear - b.startYear || a.endYear - b.endYear);
}

/** Every era that covers the year, latest start first. */
export function erasFor(data: TimelineData, year: number): EraSpan[] {
  return eraSpans(data)
    .filter((e) => e.startYear <= year && year <= e.endYear)
    .sort((a, b) => b.startYear - a.startYear);
}

/** WE-3: the era state for a year. When eras overlap, the one that started last applies. */
export function eraFor(data: TimelineData, year: number): EraSpan | null {
  return erasFor(data, year)[0] ?? null;
}

export interface EraCoverage {
  from: number;
  to: number;
  gaps: { from: number; to: number }[];
  overlaps: { ids: [string, string]; names: [string, string]; from: number; to: number }[];
  /** Eras whose end year is before their start year. */
  backwards: { id: string; name: string }[];
}

/** The default span the eras should cover (WE-2). */
export const ERA_SPAN = { from: 2025, to: 2100 } as const;

/**
 * WE-2: gaps and overlaps in the eras across a span. These are flags for the
 * eras screen; they never block a save.
 */
export function eraCoverage(
  eras: readonly EraSpan[],
  from: number = ERA_SPAN.from,
  to: number = ERA_SPAN.to,
): EraCoverage {
  const backwards = eras
    .filter((e) => e.endYear < e.startYear)
    .map((e) => ({ id: e.id, name: e.name }));
  const valid = eras
    .filter((e) => e.endYear >= e.startYear)
    .sort((a, b) => a.startYear - b.startYear || a.endYear - b.endYear);
  const gaps: EraCoverage['gaps'] = [];
  let covered = from - 1;
  for (const e of valid) {
    if (e.endYear < from) continue;
    if (e.startYear > to) break;
    if (e.startYear > covered + 1)
      gaps.push({ from: covered + 1, to: Math.min(e.startYear - 1, to) });
    covered = Math.max(covered, e.endYear);
    if (covered >= to) break;
  }
  if (covered < to) gaps.push({ from: Math.max(covered + 1, from), to });
  const overlaps: EraCoverage['overlaps'] = [];
  for (const [i, a] of valid.entries()) {
    for (const b of valid.slice(i + 1)) {
      if (b.startYear > a.endYear) break;
      overlaps.push({
        ids: [a.id, b.id],
        names: [a.name, b.name],
        from: b.startYear,
        to: Math.min(a.endYear, b.endYear),
      });
    }
  }
  return { from, to, gaps, overlaps, backwards };
}

/** The coverage flags in plain words, one line each. */
export function coverageMessages(c: EraCoverage): string[] {
  const span = (a: number, b: number) => (a === b ? String(a) : `${a} to ${b}`);
  return [
    ...c.gaps.map((g) => `No era covers ${span(g.from, g.to)}.`),
    ...c.overlaps.map((o) => `${o.names[0]} and ${o.names[1]} both cover ${span(o.from, o.to)}.`),
    ...c.backwards.map((b) => `${b.name} ends before it starts, so it covers no years.`),
  ];
}

/**
 * Default eras for a new bible (WE-2, ARCH-8): decades from 2025 to 2100 with
 * no gaps. They are stored in the bible's `lists` collection and copied into
 * era states when the bible is made, so each bible can change them.
 */
export function defaultEraRanges(): { startYear: number; endYear: number; name: string }[] {
  const out = [{ startYear: 2025, endYear: 2029, name: 'The late 2020s' }];
  for (let y = 2030; y < 2090; y += 10) {
    out.push({ startYear: y, endYear: y + 9, name: `The ${y}s` });
  }
  out.push({ startYear: 2090, endYear: 2100, name: 'The 2090s' });
  return out;
}

/** Parse a default era list item: its ID is "start-end", its label the era name. */
export function eraRangeFromItem(item: { id: string; label: string }): {
  startYear: number;
  endYear: number;
  name: string;
} | null {
  const m = /^(-?\d+)-(-?\d+)$/.exec(item.id);
  if (!m) return null;
  return { startYear: Number(m[1]), endYear: Number(m[2]), name: item.label };
}

// ---------- chapters and strands (TM-2, TM-4, TL-6) ----------

export interface StrandSpan {
  chapterId: string;
  chapterTitle: string;
  readingOrder: number | null;
  chapterStatus: string;
  written: boolean;
  strandId: string;
  label: string;
  primary: boolean;
  startYear: number;
  endYear: number;
  povCharacterId: string | null;
  characterIds: string[];
  placeIds: string[];
}

/** Every strand of every live chapter, in reading order. */
export function strandSpans(data: TimelineData): StrandSpan[] {
  const out: StrandSpan[] = [];
  for (const c of data.all('chapters')) {
    if (!live(c)) continue;
    const strands = Array.isArray(c.strands) ? c.strands.filter(isPlainObject) : [];
    for (const s of strands) {
      const start = num(s.startYear);
      if (start === null) continue;
      const end = num(s.endYear);
      out.push({
        chapterId: String(c._id),
        chapterTitle: str(c.title) || 'Untitled chapter',
        readingOrder: num(c.readingOrder),
        chapterStatus: str(c.status),
        written: c.written === true,
        strandId: str(s.id),
        label: str(s.label),
        primary: s.primary === true,
        startYear: start,
        endYear: end === null ? start : Math.max(start, end),
        povCharacterId: typeof s.povCharacterId === 'string' ? s.povCharacterId : null,
        characterIds: ids(s.characterIds),
        placeIds: ids(s.placeIds),
      });
    }
  }
  return out.sort(
    (a, b) =>
      (a.readingOrder ?? Infinity) - (b.readingOrder ?? Infinity) ||
      Number(b.primary) - Number(a.primary) ||
      a.startYear - b.startYear,
  );
}

/** TM-2: which chapters' strands fall in a year. */
export function strandsIn(data: TimelineData, year: number): StrandSpan[] {
  return strandSpans(data).filter((s) => s.startYear <= year && year <= s.endYear);
}

/** TM-4: the year a character is a given age, or null when the birth is unknown (CH-4). */
export function yearForAge(character: Doc, age: number): number | null {
  const born = yearOf(asDate(character.birth));
  return born === null || !Number.isInteger(age) ? null : born + age;
}

/** TM-4: step the year by one or ten, either way. */
export function stepYear(year: number, by: -10 | -1 | 1 | 10): number {
  return year + by;
}

// ---------- TL-7: compare ----------

export interface CompareRow {
  year: number;
  a: LifeState;
  b: LifeState;
  /** The age gap when both are alive, else null. */
  gap: number | null;
}

/** TL-7: two characters' states side by side from one year to another in steps of 1 or 5. */
export function compare(
  data: TimelineData,
  aId: string,
  bId: string,
  from: number,
  to: number,
  step: number,
): CompareRow[] {
  const chars = data.all('characters');
  const a = chars.find((c) => c._id === aId);
  const b = chars.find((c) => c._id === bId);
  if (!a || !b || !Number.isInteger(step) || step < 1) return [];
  const [lo, hi] = from <= to ? [from, to] : [to, from];
  const rows: CompareRow[] = [];
  for (let y = lo; y <= hi && rows.length < 2000; y += step) {
    const sa = lifeState(lifespan(a), y);
    const sb = lifeState(lifespan(b), y);
    rows.push({
      year: y,
      a: sa,
      b: sb,
      gap: sa.state === 'alive' && sb.state === 'alive' ? Math.abs(sa.age - sb.age) : null,
    });
  }
  return rows;
}

// ---------- TL-6: the timeline chart and its filters ----------

export interface LifespanBar {
  id: string;
  name: string;
  status: string;
  familyIds: string[];
  /** Places the character is tied to: the places of their "Lives in" moments (SM-3), as written. */
  placeNames: string[];
  birthYear: number;
  /** Null while alive at the end of the record. */
  deathYear: number | null;
}

export interface ChartEvent extends EventSpan {
  categoryPath: string;
  /** The top-level category, for the category filter. */
  categoryRoot: string;
}

export interface TimelineChart {
  eras: EraSpan[];
  events: ChartEvent[];
  strands: StrandSpan[];
  lifespans: LifespanBar[];
  /** Characters with an unknown birth: listed, never drawn (CH-4). */
  undrawn: { id: string; name: string }[];
}

function categoryRootOf(list: ListDoc | undefined, id: string): string {
  if (!list) return id;
  let cur = list.items.find((i) => i.id === id);
  const seen = new Set<string>();
  while (cur?.parentId && !seen.has(cur.id)) {
    seen.add(cur.id);
    const parentId = cur.parentId;
    const next = list.items.find((i) => i.id === parentId);
    if (!next) break;
    cur = next;
  }
  return cur?.id ?? id;
}

/** Everything the timeline view draws (TL-6), from the entries. */
export function timelineChart(data: TimelineData): TimelineChart {
  const categories = data.all('lists').find((l) => l._id === 'eventCategories') as
    ListDoc | undefined;
  const lifespans: LifespanBar[] = [];
  const undrawn: { id: string; name: string }[] = [];
  const livedIn = new Map<string, string[]>();
  for (const m of data.all('moments')) {
    const t = str(m.title);
    if (!live(m) || !t.startsWith(LIVES_IN_PREFIX)) continue;
    const who = str(m.characterId);
    livedIn.set(who, [...(livedIn.get(who) ?? []), t.slice(LIVES_IN_PREFIX.length).trim()]);
  }
  for (const c of data.all('characters')) {
    if (!live(c)) continue;
    const id = String(c._id);
    const born = yearOf(asDate(c.birth));
    if (born === null) {
      undrawn.push({ id, name: characterName(c, id) });
      continue;
    }
    lifespans.push({
      id,
      name: characterName(c, id),
      status: str(c.status),
      familyIds: ids(c.familyIds),
      placeNames: (livedIn.get(id) ?? []).filter(Boolean),
      birthYear: born,
      deathYear: yearOf(asDate(c.death)),
    });
  }
  lifespans.sort((a, b) => a.birthYear - b.birthYear || byCode(a.name, b.name));
  return {
    eras: eraSpans(data),
    events: eventSpans(data).map((e) => ({
      ...e,
      categoryPath: categories ? itemPath(categories, e.categoryId) || e.categoryId : e.categoryId,
      categoryRoot: categoryRootOf(categories, e.categoryId),
    })),
    strands: strandSpans(data),
    lifespans,
    undrawn,
  };
}

export interface ChartFilters {
  /** A family ID, "none" for people in no family, or null for everyone. */
  familyId: string | null;
  /** A place entry ID, or null. */
  placeId: string | null;
  status: string | null;
  /** A category item ID; its subcategories match too. */
  categoryId: string | null;
}

export const NO_FILTERS: ChartFilters = {
  familyId: null,
  placeId: null,
  status: null,
  categoryId: null,
};

/**
 * TL-6 filters. Family keeps the lifespans of that family, the events that
 * affect its members, and the strands its members appear in. Place keeps what
 * is tied to that place (or a place inside it); world events have no places
 * since A39, so a place leaves them as they are. Status and category act on
 * every item that has one. Eras are never filtered out.
 */
export function filterChart(
  chart: TimelineChart,
  filters: ChartFilters,
  context: { places?: readonly Doc[]; categories?: ListDoc } = {},
): TimelineChart {
  const { familyId, placeId, status, categoryId } = filters;
  const inFamily = (fids: string[]) =>
    familyId === null || (familyId === 'none' ? fids.length === 0 : fids.includes(familyId));
  const members = new Set(chart.lifespans.filter((l) => inFamily(l.familyIds)).map((l) => l.id));
  const places = (context.places ?? []).filter(live);
  const placeSet = new Set<string>();
  if (placeId) {
    placeSet.add(placeId);
    let grew = true;
    while (grew) {
      grew = false;
      for (const p of places) {
        const id = String(p._id);
        if (!placeSet.has(id) && typeof p.parentId === 'string' && placeSet.has(p.parentId)) {
          placeSet.add(id);
          grew = true;
        }
      }
    }
  }
  const placeNames = new Set(
    places.filter((p) => placeSet.has(String(p._id))).map((p) => str(p.title).trim().toLowerCase()),
  );
  const atPlace = (pids: string[]) => placeId === null || pids.some((p) => placeSet.has(p));
  const categoryIds = new Set<string>();
  if (categoryId) {
    categoryIds.add(categoryId);
    const items = context.categories?.items ?? [];
    let grew = true;
    while (grew) {
      grew = false;
      for (const i of items) {
        if (!categoryIds.has(i.id) && i.parentId && categoryIds.has(i.parentId)) {
          categoryIds.add(i.id);
          grew = true;
        }
      }
    }
  }
  return {
    eras: chart.eras,
    events: chart.events.filter(
      (e) =>
        (familyId === null || e.characterIds.some((c) => members.has(c))) &&
        (status === null || e.status === status) &&
        (categoryId === null || categoryIds.has(e.categoryId)),
    ),
    strands: chart.strands.filter(
      (s) =>
        (familyId === null ||
          s.characterIds.some((c) => members.has(c)) ||
          (s.povCharacterId !== null && members.has(s.povCharacterId))) &&
        atPlace(s.placeIds) &&
        (status === null || s.chapterStatus === status),
    ),
    lifespans: chart.lifespans.filter(
      (l) =>
        members.has(l.id) &&
        (status === null || l.status === status) &&
        (placeId === null || l.placeNames.some((n) => placeNames.has(n.trim().toLowerCase()))),
    ),
    undrawn: chart.undrawn,
  };
}
