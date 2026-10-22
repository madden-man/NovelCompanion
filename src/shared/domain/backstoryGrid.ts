/**
 * The Backstory grid (SM-9) as pure functions: one row per character under a
 * heading per family in the family tree's order, a lifespan bar from the
 * StoryDates (TL-2 to TL-4, CH-4), and a marker per moment (SM-3). The year
 * axis, the marker lanes, label room and hit tests are the World events
 * grid's (`worldGrid.ts`); this file only turns characters, families and
 * moments into its groups and items, and reads its hits back as people.
 */
import { ageAt, lifeState } from './ages';
import { yearOf } from './dates';
import { DEFAULT_NUMBERS } from '../schema/settings';
import { isPlainObject } from './paths';
import type { Doc } from './paths';
import { buildGraph, placeLayout } from './tree';
import type { StoredPositions } from './tree';
import {
  DEFAULT_SPAN,
  GRID_METRICS,
  MARKER_DEFAULTS,
  byYear,
  gridSpan,
  hitTest,
  inWindow,
  layoutGrid,
  moveEdge,
  spanExtent,
  yearX,
} from './worldGrid';
import type {
  EdgeSide,
  GridGroup,
  GridItem,
  GridLayout,
  GridMetrics,
  MarkerOptions,
  YearScale,
  YearSpan,
} from './worldGrid';
import type { StoryDate } from '../schema/common';

/** The group for characters with no family, always last. */
export const NO_FAMILY = '__nofamily';
export const NO_FAMILY_LABEL = 'No family';

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const live = (d: Doc) => !d.deletedAt;
const asDate = (v: unknown): StoryDate | null => (isPlainObject(v) ? (v as StoryDate) : null);

// ---------- people and families ----------

export interface BackstoryPerson {
  id: string;
  name: string;
  chinese: string;
  birth: StoryDate | null;
  death: StoryDate | null;
  /** The family whose heading the row sits under, or NO_FAMILY. */
  familyId: string;
  /** Every live family the character belongs to, in tree order. */
  familyIds: string[];
}

export interface BackstoryFamily {
  id: string;
  label: string;
  /** A theme series token such as `series-1`; null for No family. */
  color: string | null;
  people: BackstoryPerson[];
}

export interface BackstoryRowsInput {
  characters: readonly Doc[];
  families: readonly Doc[];
  unions: readonly Doc[];
  parentLinks: readonly Doc[];
  /** The tree's stored node positions (FT-10, FT-11), or null before the first layout. */
  positions?: StoredPositions | null;
}

/**
 * The people in the family tree's reading order: the tree's rows top to
 * bottom, each left to right, as the tree lays them out (stored positions
 * first, else the deterministic layout). Ties fall back to creation order.
 */
export function treeOrder(input: BackstoryRowsInput): string[] {
  const g = buildGraph(input.characters, input.unions, input.parentLinks);
  const { layout } = placeLayout(g, input.positions ?? null);
  const at = (id: string) => layout.nodes.get(id);
  return g.people
    .map((p) => p.id)
    .sort((a, b) => {
      const pa = at(a);
      const pb = at(b);
      if (pa && pb && (pa.y !== pb.y || pa.x !== pb.x)) return pa.y - pb.y || pa.x - pb.x;
      return (g.rank.get(a) ?? 0) - (g.rank.get(b) ?? 0);
    });
}

/**
 * SM-9 rows: a heading per live family, ordered by where its first member
 * sits in the tree; under it, its people in tree order. A character in two
 * families has one row, under the family that comes first. Characters with
 * no family, or only families no longer in the bible, come last under
 * "No family". A family nobody belongs to still gets its heading, after the
 * families with people.
 */
export function buildFamilies(input: BackstoryRowsInput): BackstoryFamily[] {
  const order = treeOrder(input);
  const rankOf = new Map(order.map((id, i) => [id, i]));
  const chars = new Map(input.characters.filter(live).map((c) => [String(c._id), c]));
  const fams = input.families.filter(live);
  const famIds = new Set(fams.map((f) => String(f._id)));
  const firstAt = new Map<string, number>();
  for (const id of order) {
    const c = chars.get(id);
    if (!c) continue;
    const i = rankOf.get(id) ?? 0;
    for (const f of Array.isArray(c.familyIds) ? c.familyIds.map(String) : []) {
      if (famIds.has(f) && !firstAt.has(f)) firstAt.set(f, i);
    }
  }
  const famRank = (f: Doc) => firstAt.get(String(f._id)) ?? Number.POSITIVE_INFINITY;
  const sortedFams = [...fams].sort((a, b) => {
    const d = famRank(a) - famRank(b);
    if (d !== 0 && Number.isFinite(d)) return d;
    if (Number.isFinite(famRank(a)) !== Number.isFinite(famRank(b)))
      return Number.isFinite(famRank(a)) ? -1 : 1;
    const ca = str(a.createdAt);
    const cb = str(b.createdAt);
    return ca < cb ? -1 : ca > cb ? 1 : String(a._id) < String(b._id) ? -1 : 1;
  });
  const famOrder = new Map(sortedFams.map((f, i) => [String(f._id), i]));
  const out: BackstoryFamily[] = sortedFams.map((f) => ({
    id: String(f._id),
    label: str(f.name).trim() || str(f.title).trim() || String(f._id),
    color: str(f.color) || 'series-1',
    people: [],
  }));
  const none: BackstoryFamily = { id: NO_FAMILY, label: NO_FAMILY_LABEL, color: null, people: [] };
  for (const id of order) {
    const c = chars.get(id);
    if (!c) continue;
    const names = isPlainObject(c.names) ? c.names : {};
    const familyIds = (Array.isArray(c.familyIds) ? c.familyIds.map(String) : [])
      .filter((f) => famOrder.has(f))
      .sort((a, b) => (famOrder.get(a) ?? 0) - (famOrder.get(b) ?? 0));
    const home = familyIds[0];
    const person: BackstoryPerson = {
      id,
      name: str(names.full).trim() || str(c.title).trim() || 'Unnamed',
      chinese: str(names.chinese).trim(),
      birth: asDate(c.birth),
      death: asDate(c.death),
      familyId: home ?? NO_FAMILY,
      familyIds,
    };
    if (home === undefined) none.people.push(person);
    else out[famOrder.get(home) ?? 0]?.people.push(person);
  }
  if (none.people.length) out.push(none);
  return out;
}

/** The families as the year grid's groups: one row per person, keyed by their ID. */
export function gridGroups(
  families: readonly BackstoryFamily[],
  closed: ReadonlySet<string> = new Set(),
): GridGroup[] {
  return families.map((f) => ({
    id: f.id,
    label: f.label,
    open: !closed.has(f.id),
    rows: f.people.map((p) => ({ key: p.id, label: p.name, groupId: f.id, own: false })),
  }));
}

// ---------- lifespans (TL-2 to TL-4, CH-4) ----------

export type LifespanKind =
  /** Born and died on record. */
  | 'dead'
  /** Born on record, no death: the bar runs to the end of the axis. */
  | 'alive'
  /** No known birth (CH-4): nothing is drawn, never an estimate. */
  | 'unknown';

export interface Lifespan {
  kind: LifespanKind;
  /** The birth year, or null when unknown. */
  from: number | null;
  /** The death year, or null when alive or unknown. */
  to: number | null;
}

/** TL-2: what the record says of a life: both ends, an open end, or unknown. */
export function lifespanOf(p: { birth: StoryDate | null; death: StoryDate | null }): Lifespan {
  const from = yearOf(p.birth);
  const to = yearOf(p.death);
  if (from === null) return { kind: 'unknown', from: null, to };
  if (to === null) return { kind: 'alive', from, to: null };
  return { kind: 'dead', from, to: Math.max(from, to) };
}

export interface LifespanBar {
  x: number;
  width: number;
  /**
   * For a life with no death on record, where the dashed part starts: the
   * right edge of the story year's column, or the bar's start for someone
   * born after the story year. Null when it is all solid.
   */
  dashFrom: number | null;
}

/**
 * The bar across a lifespan on the axis: birth to death, or to the end of the
 * axis while alive, dashed past the story year. Null for an unknown birth or
 * a life entirely outside the axis.
 */
export function lifespanBar(life: Lifespan, s: YearScale, storyYear: number): LifespanBar | null {
  if (life.from === null) return null;
  const end = life.to ?? s.to;
  if (end < s.from || life.from > s.to) return null;
  const { x, width } = spanExtent(s, life.from, end);
  if (life.to !== null) return { x, width, dashFrom: null };
  // The years after the story year are not written yet: dashed, all of it for someone born later.
  const cut = yearX(s, storyYear + 1);
  return { x, width, dashFrom: cut < x + width ? Math.max(x, cut) : null };
}

// ---------- dragging a lifespan's ends (IP-4) ----------

/**
 * A lifespan with one end moved by whole years: the left end is the birth,
 * the right end the death. A life with no death on record ends at the axis
 * end, so its right end dragged in sets a death there. The moved end may
 * pass the other; `lifeProblem` refuses that at release.
 */
export function moveLifeEnd(
  life: Lifespan,
  side: EdgeSide,
  delta: number,
  s: YearSpan,
): { from: number; to: number | null } | null {
  if (life.from === null) return null;
  const end = life.to ?? s.to;
  const moved = moveEdge(life.from, end, side, delta, s, true);
  if (side === 'start') return { from: moved.startYear, to: life.to };
  return { from: life.from, to: moved.endYear };
}

/** ED-10: why a lifespan cannot be stored as dragged, or null when it can. */
export function lifeProblem(from: number, to: number | null): string | null {
  if (to === null || to >= from) return null;
  return `The death year ${to} is before the birth year ${from}. Drag the death to ${from} or later.`;
}

/**
 * A story date with its year replaced, keeping its month and day; an unknown
 * or missing date becomes the plain year.
 */
export function withYear(d: StoryDate | null, year: number): StoryDate {
  if (d && 'year' in d) return { ...d, year };
  return { year };
}

// ---------- moments ----------

export interface BackstoryMoment {
  id: string;
  characterId: string;
  year: number;
  endYear: number | null;
  title: string;
  body: string;
  worldContext: string;
}

/** Live moments with a year, as plain rows. */
export function momentRows(moments: readonly Doc[]): BackstoryMoment[] {
  const out: BackstoryMoment[] = [];
  for (const m of moments) {
    if (!live(m)) continue;
    const year = num(m.year);
    if (year === null) continue;
    const end = num(m.endYear);
    out.push({
      id: String(m._id),
      characterId: str(m.characterId),
      year,
      endYear: end,
      title: str(m.title),
      body: str(m.body),
      worldContext: str(m.worldContext),
    });
  }
  return out;
}

/** The title a marker shows: what happens, or a plain stand-in while it is blank. */
export function momentLabel(m: { title: string }): string {
  return m.title.trim() || 'Untitled moment';
}

/** The grid items for moments: one per moment, in its character's row, a bar to its end year. */
export function momentItems(moments: readonly BackstoryMoment[]): GridItem[] {
  return moments.map((m) => ({
    id: m.id,
    row: m.characterId,
    startYear: m.year,
    endYear: m.endYear === null ? m.year : Math.max(m.year, m.endYear),
    label: momentLabel(m),
  }));
}

/** One person's moments in year order, as the table lists them. */
export function momentsOf(
  moments: readonly BackstoryMoment[],
  characterId: string,
): BackstoryMoment[] {
  const mine = moments.filter((m) => m.characterId === characterId);
  const items = momentItems(mine).sort(byYear);
  const byId = new Map(mine.map((m) => [m.id, m]));
  return items.flatMap((i) => byId.get(i.id) ?? []);
}

/**
 * IP-13: every moment as the table lists them when no person is picked: by
 * year, then by the person's name, then by end year and title.
 */
export function allMoments(
  moments: readonly BackstoryMoment[],
  people: ReadonlyMap<string, { name: string }>,
): BackstoryMoment[] {
  const name = (m: BackstoryMoment) => people.get(m.characterId)?.name ?? '';
  return [...moments].sort(
    (a, b) =>
      a.year - b.year ||
      name(a).localeCompare(name(b)) ||
      (a.endYear ?? a.year) - (b.endYear ?? b.year) ||
      a.title.localeCompare(b.title) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/** TL-3: the age a moment's year gives, in words for the table. */
export function ageText(p: { birth: StoryDate | null; death: StoryDate | null }, year: number) {
  const s = lifeState({ birth: p.birth, death: p.death }, year);
  switch (s.state) {
    case 'alive':
      return String(s.age);
    case 'unborn':
      return 'Not yet born';
    case 'dead':
      return `After death (${s.deathYear})`;
    case 'unknown':
      return 'Unknown';
  }
}

/** TL-3: the age in a year as a number, or null when unborn, dead or unknown. */
export function ageIn(p: { birth: StoryDate | null; death: StoryDate | null }, year: number) {
  return ageAt({ birth: p.birth, death: p.death }, year);
}

// ---------- the whole grid ----------

/** The Backstory grid's rows are one lane taller at the bottom, for the lifespan bar. */
export const BACKSTORY_METRICS: GridMetrics = { ...GRID_METRICS, rowPad: 7 };

export interface BackstoryGridInput extends BackstoryRowsInput {
  moments: readonly Doc[];
  /** IP-11: the bible's timeline span; the default numbers' span when not given. */
  base?: YearSpan;
}

export interface BackstoryGrid {
  families: BackstoryFamily[];
  people: Map<string, BackstoryPerson>;
  moments: BackstoryMoment[];
  /** The axis the grid needs: the timeline span widened to every birth, death and moment. */
  span: YearSpan;
}

/** Rows, people and moments, and the span that holds them. */
export function backstoryGrid(input: BackstoryGridInput): BackstoryGrid {
  const families = buildFamilies(input);
  const people = new Map(families.flatMap((f) => f.people.map((p) => [p.id, p] as const)));
  const moments = momentRows(input.moments).filter((m) => people.has(m.characterId));
  const years: number[] = [];
  for (const p of people.values()) {
    const b = yearOf(p.birth);
    const d = yearOf(p.death);
    if (b !== null) years.push(b);
    if (d !== null) years.push(d);
  }
  for (const m of moments) years.push(m.year, m.endYear ?? m.year);
  return { families, people, moments, span: gridSpan(years, input.base ?? DEFAULT_SPAN) };
}

/** Lay the grid out on a scale through the World events grid's layout. */
export function layoutBackstory(
  g: BackstoryGrid,
  s: YearScale,
  closed: ReadonlySet<string> = new Set(),
  opts: MarkerOptions = MARKER_DEFAULTS,
): GridLayout {
  return layoutGrid(
    gridGroups(g.families, closed),
    momentItems(g.moments),
    s,
    opts,
    BACKSTORY_METRICS,
  );
}

export type BackstoryHit =
  | { kind: 'moment'; id: string; characterId: string; year: number }
  | { kind: 'person'; characterId: string; year: number }
  | { kind: 'family'; familyId: string; year: number };

/**
 * From a point in the track to what is there: a moment's marker, an empty
 * spot in a person's row and the year under it, or a family heading.
 */
export function hitBackstory(
  layout: GridLayout,
  g: BackstoryGrid,
  x: number,
  y: number,
): BackstoryHit | null {
  const h = hitTest(layout, x, y);
  if (!h) return null;
  if (h.kind === 'group') return { kind: 'family', familyId: h.groupId, year: h.year };
  if (h.kind === 'empty') return { kind: 'person', characterId: h.rowKey, year: h.year };
  const m = g.moments.find((x) => x.id === h.marker.id);
  return {
    kind: 'moment',
    id: h.marker.id,
    characterId: m?.characterId ?? h.rowKey,
    year: h.marker.startYear,
  };
}

// ---------- the "Relevant world events" picker (A33) ----------

/** How many years either side of a moment's year the picker reaches, by default (IP-11: per bible). */
export const PICKER_REACH = DEFAULT_NUMBERS.pickerReach;

/**
 * The world events of a year plus or minus one: every event running at any
 * time from the year before to the year after, in date order.
 */
export function eventsNear<T extends { startYear: number; endYear: number }>(
  events: readonly T[],
  year: number,
  reach: number = PICKER_REACH,
): T[] {
  return inWindow(events, { from: year - reach, to: year + reach });
}

/**
 * IP-4, ED-9: the text after inserting a mention of an event (`@Title`) on a
 * line of its own after what is there, and not again when the text already
 * mentions it.
 */
export function insertMention(text: string, title: string): string {
  const t = title.trim();
  if (!t) return text;
  const at = `@${t}`;
  const lines = text.split('\n').map((l) => l.trim());
  if (lines.some((l) => l === at || l.includes(at))) return text;
  const base = text.replace(/\s+$/, '');
  return base ? `${base}\n${at}` : at;
}

/** The links an entry holds after it mentions another (ED-9): the mention added once. */
export function withMentionLink(
  links: readonly { targetId: string; kind: string }[],
  targetId: string,
): { targetId: string; kind: string }[] {
  if (links.some((l) => l.targetId === targetId)) return [...links];
  return [...links, { targetId, kind: 'mention' }];
}

/**
 * The text after inserting an event title: on a line of its own after what
 * is there, and not again when it is already in the text.
 */
export function insertEventTitle(text: string, title: string): string {
  const t = title.trim();
  if (!t) return text;
  const lines = text.split('\n').map((l) => l.trim());
  if (lines.includes(t)) return text;
  const base = text.replace(/\s+$/, '');
  return base ? `${base}\n${t}` : t;
}
