/**
 * The year grid (SM-8, and the Backstory grid of SM-9 after it): a year axis
 * left to right, rows grouped under collapsible headings, markers placed in
 * lanes inside each row. Pure layout and hit logic over plain objects. The
 * axis and the marker placement know nothing of world events, so any grid of
 * dated items can reuse them; only `buildGroups` reads a category list.
 */

import { DEFAULT_NUMBERS } from '../schema/settings';

// ---------- the year axis ----------

/** The years a grid shows when the bible says nothing else (IP-11: its timeline span). */
export const DEFAULT_SPAN = {
  from: DEFAULT_NUMBERS.timelineStart,
  to: DEFAULT_NUMBERS.timelineEnd,
} as const;

export interface YearSpan {
  from: number;
  to: number;
}

export interface YearScale extends YearSpan {
  /** Pixels per year column. */
  ppy: number;
}

/** The zoom control: the whole span fits the panel, the default width, or close. */
export type Zoom = 'fit' | 'default' | 'close';

export const ZOOM_PPY: Record<Exclude<Zoom, 'fit'>, number> = { default: 18, close: 44 };
/** The narrowest a year column gets when the whole span is fitted. */
export const MIN_PPY = 3;

/** The timeline span widened to take in every given year (an event before its start still shows). */
export function gridSpan(years: Iterable<number>, base: YearSpan = DEFAULT_SPAN): YearSpan {
  let { from, to } = base;
  for (const y of years) {
    if (!Number.isFinite(y)) continue;
    if (y < from) from = y;
    if (y > to) to = y;
  }
  return { from, to };
}

/** The number of year columns in a span. */
export function yearCount(span: YearSpan): number {
  return Math.max(1, span.to - span.from + 1);
}

/** Pixels per year for a zoom; `fit` divides the panel's track width among the years. */
export function zoomPpy(zoom: Zoom, trackWidth: number, span: YearSpan): number {
  if (zoom !== 'fit') return ZOOM_PPY[zoom];
  const ppy = Math.floor((trackWidth / yearCount(span)) * 100) / 100;
  return Math.max(MIN_PPY, ppy);
}

export function makeScale(span: YearSpan, ppy: number): YearScale {
  return { from: span.from, to: span.to, ppy: Math.max(MIN_PPY, ppy) };
}

/** The width of every year column together. */
export function scaleWidth(s: YearScale): number {
  return yearCount(s) * s.ppy;
}

/** The left edge of a year's column. */
export function yearX(s: YearScale, year: number): number {
  return (year - s.from) * s.ppy;
}

/** The middle of a year's column. */
export function yearMid(s: YearScale, year: number): number {
  return yearX(s, year) + s.ppy / 2;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The year whose column holds a pixel, clamped to the span. */
export function yearAt(s: YearScale, x: number): number {
  return clamp(s.from + Math.floor(x / s.ppy), s.from, s.to);
}

/** Label steps for the year header, smallest first. */
const TICK_STEPS = [1, 2, 5, 10, 25, 50];

/**
 * The years the header labels: every year when the columns are wide enough,
 * else every 2, 5, 10, 25 or 50 years, so labels never collide.
 */
export function tickYears(s: YearScale, minGap = 40): number[] {
  const step = TICK_STEPS.find((k) => k * s.ppy >= minGap) ?? 100;
  const out: number[] = [];
  const first = Math.ceil(s.from / step) * step;
  for (let y = first; y <= s.to; y += step) out.push(y);
  return out;
}

/** A pixel extent in the track: from the left edge of `startYear` to the right edge of `endYear`. */
export function spanExtent(s: YearScale, startYear: number, endYear: number) {
  const a = clamp(Math.min(startYear, endYear), s.from, s.to);
  const b = clamp(Math.max(startYear, endYear), s.from, s.to);
  return { x: yearX(s, a), width: yearX(s, b + 1) - yearX(s, a) };
}

// ---------- rows from a category list ----------

export interface CategoryItem {
  id: string;
  label: string;
  parentId: string | null;
}

export interface GridRow {
  /** The row's key: the category it files, the group itself for the group's own row. */
  key: string;
  label: string;
  groupId: string;
  /** True for the row of items filed under the group with no subcategory. */
  own: boolean;
}

export interface GridGroup {
  id: string;
  label: string;
  open: boolean;
  rows: GridRow[];
}

/** The group for items whose category is not in the list. */
export const UNFILED = '__unfiled';

export interface GridRows {
  groups: GridGroup[];
  /** The row key each category files into (a sub-subcategory files into its subcategory's row). */
  rowOf: Map<string, string>;
}

/**
 * Groups and rows from a category list, in list order: each top-level item is
 * a group heading, each of its children a row. Items filed under the heading
 * itself get a row of their own first; a heading with no children always has
 * that row, so there is somewhere to click. Deeper items file into the row of
 * their top child. Categories the list lacks gather under a last group.
 */
export function buildGroups(
  items: readonly CategoryItem[],
  used: Iterable<string>,
  closed: ReadonlySet<string> = new Set(),
): GridRows {
  const byId = new Map(items.map((i) => [i.id, i]));
  /** The chain from an item up to its root, guarded against cycles. */
  const chain = (id: string): CategoryItem[] => {
    const out: CategoryItem[] = [];
    const seen = new Set<string>();
    let cur = byId.get(id);
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      out.unshift(cur);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    return out;
  };
  const rowOf = new Map<string, string>();
  for (const i of items) {
    const c = chain(i.id);
    // A broken parent chain makes the topmost item found a root.
    rowOf.set(i.id, (c[1] ?? c[0] ?? i).id);
  }
  const usedSet = new Set(used);
  const groups: GridGroup[] = [];
  const roots = items.filter((i) => chain(i.id)[0]?.id === i.id);
  for (const root of roots) {
    const children = items.filter((i) => i.parentId === root.id && i.id !== root.id);
    const rows: GridRow[] = [];
    if (children.length === 0 || usedSet.has(root.id)) {
      rows.push({
        key: root.id,
        label: children.length ? 'General' : root.label,
        groupId: root.id,
        own: true,
      });
    }
    for (const c of children)
      rows.push({ key: c.id, label: c.label, groupId: root.id, own: false });
    groups.push({ id: root.id, label: root.label, open: !closed.has(root.id), rows });
  }
  const strays = [...usedSet].filter((id) => !byId.has(id)).sort();
  if (strays.length) {
    for (const id of strays) rowOf.set(id, id);
    groups.push({
      id: UNFILED,
      label: 'Not in the category list',
      open: !closed.has(UNFILED),
      rows: strays.map((id) => ({ key: id, label: id, groupId: UNFILED, own: false })),
    });
  }
  return { groups, rowOf };
}

/**
 * WE-1: the categories a filter keeps. No group keeps everything (null); a
 * group keeps itself and everything under it; a subcategory keeps itself
 * and everything under it, plus its group heading (but not the group's own
 * items, which sit outside the subcategory).
 */
export function categoryScope(
  items: readonly CategoryItem[],
  groupId: string | null,
  subId: string | null = null,
): { keep: Set<string>; items: CategoryItem[] } | null {
  if (!groupId) return null;
  const top = subId ?? groupId;
  const under = new Set<string>([top]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const i of items) {
      if (i.parentId && under.has(i.parentId) && !under.has(i.id)) {
        under.add(i.id);
        grew = true;
      }
    }
  }
  const shown = new Set(under);
  if (subId) shown.add(groupId);
  return { keep: under, items: items.filter((i) => shown.has(i.id)) };
}

// ---------- markers ----------

/** Anything dated that sits in a row. */
export interface GridItem {
  id: string;
  /** The row key it belongs to. */
  row: string;
  startYear: number;
  endYear: number;
  /** Drawn larger (a formative event). */
  big?: boolean;
  label: string;
  /** What the grid's caller hands through to the marker (A51: a moment's kind). */
  data?: Readonly<Record<string, string>>;
}

export interface PlacedMarker {
  id: string;
  startYear: number;
  endYear: number;
  big: boolean;
  label: string;
  /** True when the item runs over more than one year. */
  bar: boolean;
  x: number;
  width: number;
  lane: number;
  /** Pixels free to the right before the next marker in the lane, or the end of the track. */
  labelRoom: number;
  showLabel: boolean;
  /** The item's `data`, when it has any. */
  data?: Readonly<Record<string, string>>;
}

export interface RowLayout {
  key: string;
  lanes: number;
  markers: PlacedMarker[];
}

export interface MarkerOptions {
  /** Diameter of a single-year marker, and of a big one. */
  dot: number;
  bigDot: number;
  /** Space kept between markers in a lane, and before a label. */
  gap: number;
  /**
   * Most lanes a row grows to; further overlaps share the least-full lane. `Infinity` leaves the
   * row unbounded: a marker that fits no lane opens a new one, so no two ever share (A54, the
   * Backstory grid).
   */
  maxLanes: number;
  /** The width a label needs. */
  labelWidth: (label: string) => number;
  /** Height of a bar across several years, and of a big one (8 and 12 when not given). */
  barHeight?: number;
  bigBarHeight?: number;
  /**
   * Every marker draws its title, and the title takes room in its lane: the
   * next marker in the lane starts past it (the Backstory person view, A50).
   * False when not given, so the grids keep their labels only where they fit.
   */
  reserveLabel?: boolean;
}

/** The space the CSS keeps between a marker's right edge and its title (`.wg-mlabel`). */
export const LABEL_OFFSET = 4;

/** A rough label width for 11 to 12 pixel text, enough to decide whether it fits. */
export const roughLabelWidth = (label: string) => Math.ceil(label.length * 6.4) + 4;

/** A bar's height when the options do not say, and a big bar's. */
const BAR_HEIGHT = 8;
const BIG_BAR_HEIGHT = 12;

export const MARKER_DEFAULTS: MarkerOptions = {
  dot: 10,
  bigDot: 16,
  gap: 4,
  maxLanes: 4,
  labelWidth: roughLabelWidth,
  barHeight: BAR_HEIGHT,
  bigBarHeight: BIG_BAR_HEIGHT,
};

/** How tall a bar across several years draws under these options, big or not. */
export function barHeightOf(opts: MarkerOptions, big: boolean): number {
  return big ? (opts.bigBarHeight ?? BIG_BAR_HEIGHT) : (opts.barHeight ?? BAR_HEIGHT);
}

/** Reading order: by start year, then end year, then label. */
export function byYear(a: GridItem, b: GridItem): number {
  return (
    a.startYear - b.startYear ||
    a.endYear - b.endYear ||
    (a.label < b.label ? -1 : a.label > b.label ? 1 : 0) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/**
 * How far right a placed marker holds its lane: its own right edge, and with `reserveLabel` its
 * title too, which draws after the dot or the bar (A54).
 */
export function markerExtent(
  m: Pick<PlacedMarker, 'x' | 'width' | 'label'>,
  opts: MarkerOptions,
): number {
  const end = m.x + m.width;
  if (!opts.reserveLabel) return end;
  return end + Math.max(opts.gap, LABEL_OFFSET) + opts.labelWidth(m.label);
}

/**
 * Place a row's items: x from the year, a bar across the years of a range, a
 * dot centred in its column otherwise (larger when big). Overlapping markers
 * take the next lane down. A label shows when the room to the next marker in
 * its lane holds it; with `reserveLabel` every label shows and its width is
 * part of the lane, so the next marker in that lane starts past it.
 */
export function placeRow(
  key: string,
  items: readonly GridItem[],
  s: YearScale,
  opts: MarkerOptions = MARKER_DEFAULTS,
): RowLayout {
  const sorted = [...items].sort(byYear);
  const laneEnds: number[] = [];
  const lanes: PlacedMarker[][] = [];
  const markers: PlacedMarker[] = [];
  for (const it of sorted) {
    const startYear = Math.min(it.startYear, it.endYear);
    const endYear = Math.max(it.startYear, it.endYear);
    const bar = endYear > startYear;
    const size = it.big ? opts.bigDot : opts.dot;
    let x: number;
    let width: number;
    if (bar) {
      ({ x, width } = spanExtent(s, startYear, endYear));
    } else {
      x = yearMid(s, clamp(startYear, s.from, s.to)) - size / 2;
      width = size;
    }
    let lane = laneEnds.findIndex((end) => end + opts.gap <= x);
    if (lane < 0) {
      if (laneEnds.length < opts.maxLanes) lane = laneEnds.length;
      else lane = laneEnds.indexOf(Math.min(...laneEnds));
    }
    const end = markerExtent({ x, width, label: it.label }, opts);
    laneEnds[lane] = Math.max(laneEnds[lane] ?? -Infinity, end);
    const m: PlacedMarker = {
      id: it.id,
      startYear,
      endYear,
      big: it.big === true,
      label: it.label,
      bar,
      x,
      width,
      lane,
      labelRoom: 0,
      showLabel: false,
      ...(it.data ? { data: it.data } : {}),
    };
    (lanes[lane] ??= []).push(m);
    markers.push(m);
  }
  const trackEnd = scaleWidth(s);
  for (const lane of lanes) {
    if (!lane) continue;
    lane.forEach((m, i) => {
      const next = lane[i + 1];
      m.labelRoom = Math.max(0, (next ? next.x : trackEnd) - (m.x + m.width) - opts.gap);
      m.showLabel = opts.reserveLabel === true || opts.labelWidth(m.label) <= m.labelRoom;
    });
  }
  return { key, lanes: Math.max(1, laneEnds.length), markers };
}

// ---------- the whole grid ----------

export interface GridMetrics {
  /** The year header with the era band under it. */
  header: number;
  groupHeading: number;
  lane: number;
  /** Space above and below the lanes of a row. */
  rowPad: number;
}

export const GRID_METRICS: GridMetrics = { header: 56, groupHeading: 30, lane: 22, rowPad: 4 };

export type GridLine =
  | { kind: 'group'; group: GridGroup; y: number; height: number; merged: RowLayout | null }
  | { kind: 'row'; row: GridRow; y: number; height: number; layout: RowLayout };

export interface GridLayout {
  scale: YearScale;
  lines: GridLine[];
  /** Total height of the lines, header included. */
  height: number;
  width: number;
  metrics: GridMetrics;
  /** The marker options the lines were placed with; the markers draw their bars from them. */
  markers: MarkerOptions;
}

/**
 * Lay out every heading and row top to bottom. An open group shows its rows;
 * a closed one shows its rows' markers merged onto the heading line.
 */
export function layoutGrid(
  groups: readonly GridGroup[],
  items: readonly GridItem[],
  s: YearScale,
  opts: MarkerOptions = MARKER_DEFAULTS,
  metrics: GridMetrics = GRID_METRICS,
): GridLayout {
  const byRow = new Map<string, GridItem[]>();
  for (const it of items) {
    const list = byRow.get(it.row);
    if (list) list.push(it);
    else byRow.set(it.row, [it]);
  }
  const lines: GridLine[] = [];
  let y = metrics.header;
  const rowHeight = (l: RowLayout) => l.lanes * metrics.lane + metrics.rowPad * 2;
  for (const g of groups) {
    if (g.open) {
      lines.push({ kind: 'group', group: g, y, height: metrics.groupHeading, merged: null });
      y += metrics.groupHeading;
      for (const r of g.rows) {
        const layout = placeRow(r.key, byRow.get(r.key) ?? [], s, opts);
        const height = rowHeight(layout);
        lines.push({ kind: 'row', row: r, y, height, layout });
        y += height;
      }
    } else {
      const merged = placeRow(
        g.id,
        g.rows.flatMap((r) => byRow.get(r.key) ?? []),
        s,
        opts,
      );
      const height = Math.max(metrics.groupHeading, rowHeight(merged));
      lines.push({ kind: 'group', group: g, y, height, merged });
      y += height;
    }
  }
  return { scale: s, lines, height: y, width: scaleWidth(s), metrics, markers: opts };
}

/** The line under a vertical position in the grid, or null in the header or past the end. */
export function lineAt(layout: GridLayout, y: number): GridLine | null {
  const { lines } = layout;
  let lo = 0;
  let hi = lines.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const l = lines[mid];
    if (!l) return null;
    if (y < l.y) hi = mid - 1;
    else if (y >= l.y + l.height) lo = mid + 1;
    else return l;
  }
  return null;
}

/** The marker under a point in a row's track, if any. */
export function markerAt(
  row: RowLayout,
  x: number,
  yInRow: number,
  metrics: GridMetrics = GRID_METRICS,
): PlacedMarker | null {
  const lane = Math.floor((yInRow - metrics.rowPad) / metrics.lane);
  for (let i = row.markers.length - 1; i >= 0; i--) {
    const m = row.markers[i];
    if (m && m.lane === lane && x >= m.x && x <= m.x + m.width) return m;
  }
  return null;
}

export type Hit =
  | { kind: 'marker'; rowKey: string; marker: PlacedMarker; year: number }
  | { kind: 'empty'; rowKey: string; year: number }
  | { kind: 'group'; groupId: string; year: number };

/**
 * From a pointer position in the track (x from the first year's left edge, y
 * from the top of the grid) to what is there: a marker, an empty spot in a
 * row and the year under it, or a group heading. Null in the header.
 */
export function hitTest(layout: GridLayout, x: number, y: number): Hit | null {
  if (x < 0 || x >= layout.width) return null;
  const line = lineAt(layout, y);
  if (!line) return null;
  const year = yearAt(layout.scale, x);
  if (line.kind === 'group') {
    const m = line.merged ? markerAt(line.merged, x, y - line.y, layout.metrics) : null;
    if (m) return { kind: 'marker', rowKey: line.group.id, marker: m, year };
    return { kind: 'group', groupId: line.group.id, year };
  }
  const m = markerAt(line.layout, x, y - line.y, layout.metrics);
  if (m) return { kind: 'marker', rowKey: line.row.key, marker: m, year };
  return { kind: 'empty', rowKey: line.row.key, year };
}

// ---------- dragging and the arrow keys ----------

/** Whole years for a drag of `dx` pixels. */
export function dragYears(dx: number, ppy: number): number {
  const d = Math.round(dx / ppy);
  return d === 0 ? 0 : d;
}

/**
 * Move a span by whole years, the end with the start, clamped so it stays
 * inside the axis. Returns the years moved after clamping.
 */
export function shiftSpan(
  startYear: number,
  endYear: number,
  delta: number,
  span: YearSpan,
): { startYear: number; endYear: number; delta: number } {
  const d = clamp(delta, Math.min(0, span.from - startYear), Math.max(0, span.to - endYear));
  return { startYear: startYear + d, endYear: endYear + d, delta: d };
}

/** Move only the end year, never before the start nor past the axis. */
export function shiftEnd(
  startYear: number,
  endYear: number,
  delta: number,
  span: YearSpan,
): number {
  return clamp(endYear + delta, startYear, Math.max(startYear, span.to));
}

// ---------- span ends and edges (IP-4) ----------

/** One end of a span: its first year (`start`) or its last (`end`). */
export type EdgeSide = 'start' | 'end';

/** The width of a grab handle at each end of a bar, in pixels. */
export const HANDLE_W = 8;

/**
 * Which end of a bar a pointer is on: within a handle's width inside either
 * edge. On a bar narrower than two handles the nearer edge wins.
 */
export function edgeAt(
  ext: { x: number; width: number },
  x: number,
  handle: number = HANDLE_W,
): EdgeSide | null {
  const left = ext.x;
  const right = ext.x + ext.width;
  if (x < left - handle / 2 || x > right + handle / 2) return null;
  const toLeft = Math.abs(x - left);
  const toRight = Math.abs(x - right);
  if (toLeft > handle && toRight > handle) return null;
  return toLeft <= toRight ? 'start' : 'end';
}

/**
 * The year an edge dropped at a pixel lands on, snapped to the nearest column
 * boundary: a start edge takes the column to the boundary's right, an end
 * edge the column to its left. Clamped to the axis.
 */
export function snapEdge(s: YearScale, x: number, side: EdgeSide): number {
  const boundary = Math.round(x / s.ppy);
  const year = side === 'start' ? s.from + boundary : s.from + boundary - 1;
  return clamp(year, s.from, s.to);
}

/**
 * One end of a span moved by whole years, the other end left where it is.
 * The moved end stays on the axis and never passes the other end, unless
 * `cross` lets it (a death dragged before the birth is refused later, at
 * release, with the reason).
 */
export function moveEdge(
  startYear: number,
  endYear: number,
  side: EdgeSide,
  delta: number,
  span: YearSpan,
  cross = false,
): { startYear: number; endYear: number } {
  if (side === 'start') {
    const hi = cross ? span.to : Math.min(endYear, span.to);
    return { startYear: clamp(startYear + delta, Math.min(span.from, startYear), hi), endYear };
  }
  const lo = cross ? span.from : Math.max(startYear, span.from);
  return { startYear, endYear: clamp(endYear + delta, lo, Math.max(span.to, endYear)) };
}

/** A span with an ID, such as an era. */
export interface IdSpan {
  id: string;
  startYear: number;
  endYear: number;
}

/**
 * The era that meets an era's edge: the one ending the year before it starts
 * (its start edge), or starting the year after it ends (its end edge).
 */
export function neighbourAt<T extends IdSpan>(spans: readonly T[], id: string, side: EdgeSide) {
  const me = spans.find((e) => e.id === id);
  if (!me) return null;
  const meets = (e: T) =>
    side === 'start' ? e.endYear + 1 === me.startYear : e.startYear === me.endYear + 1;
  return spans.find((e) => e.id !== id && meets(e)) ?? null;
}

/**
 * The shared edge between two eras that meet (`before` ends the year before
 * `after` starts) moved by whole years: both ends move together, and neither
 * era is left shorter than one year.
 */
export function moveSharedEdge(
  before: { startYear: number; endYear: number },
  after: { startYear: number; endYear: number },
  delta: number,
): { beforeEnd: number; afterStart: number; delta: number } {
  const d = clamp(delta, before.startYear - before.endYear, after.endYear - after.startYear);
  return { beforeEnd: before.endYear + d, afterStart: after.startYear + d, delta: d };
}

/** A stretch of the axis no era covers. */
export interface BandGap {
  startYear: number;
  endYear: number;
}

/** IP-4: the stretches of the axis no era covers, left to right, for the era band. */
export function bandGaps(spans: readonly { startYear: number; endYear: number }[], s: YearSpan) {
  const sorted = [...spans]
    .map((e) => ({ a: Math.min(e.startYear, e.endYear), b: Math.max(e.startYear, e.endYear) }))
    .sort((x, y) => x.a - y.a);
  const gaps: BandGap[] = [];
  let next = s.from;
  for (const e of sorted) {
    if (e.a > next && next <= s.to)
      gaps.push({ startYear: next, endYear: Math.min(e.a - 1, s.to) });
    next = Math.max(next, e.b + 1);
  }
  if (next <= s.to) gaps.push({ startYear: next, endYear: s.to });
  return gaps;
}

// ---------- the world around the story year ----------

/** A33: the years before the story year through the years after (IP-11: per bible). */
export const WINDOW_BEFORE = DEFAULT_NUMBERS.windowBefore;
export const WINDOW_AFTER = DEFAULT_NUMBERS.windowAfter;

export function yearWindow(
  year: number,
  before: number = WINDOW_BEFORE,
  after: number = WINDOW_AFTER,
): YearSpan {
  return { from: year - before, to: year + after };
}

/** The items running at any time inside the window, in reading order. */
export function inWindow<T extends { startYear: number; endYear: number }>(
  items: readonly T[],
  w: YearSpan,
): T[] {
  return items
    .filter((i) => i.startYear <= w.to && Math.max(i.startYear, i.endYear) >= w.from)
    .sort((a, b) => a.startYear - b.startYear || a.endYear - b.endYear);
}

/** Where to scroll so a year sits in the middle of a viewport of `viewWidth` pixels. */
export function scrollToYear(s: YearScale, year: number, viewWidth: number): number {
  const target = yearMid(s, clamp(year, s.from, s.to)) - viewWidth / 2;
  return clamp(target, 0, Math.max(0, scaleWidth(s) - viewWidth));
}

// ---------- the chapter being written ----------

export interface WritingBand {
  from: number;
  to: number;
  label: string;
}

/** The strand the Writing picker holds (A27), else its chapter's primary strand, as a band. */
export function writingBand(
  strands: readonly {
    chapterId: string;
    strandId: string;
    primary: boolean;
    startYear: number;
    endYear: number;
    number: number | null;
    chapterTitle: string;
    label: string;
  }[],
  chapterId: string | undefined,
  strandId: string | undefined,
): WritingBand | null {
  if (!chapterId) return null;
  const mine = strands.filter((s) => s.chapterId === chapterId);
  const s =
    mine.find((x) => strandId !== undefined && x.strandId === strandId) ??
    mine.find((x) => x.primary) ??
    mine[0];
  if (!s) return null;
  const years = s.startYear === s.endYear ? `${s.startYear}` : `${s.startYear} to ${s.endYear}`;
  return {
    from: s.startYear,
    to: s.endYear,
    label: `Chapter ${s.number ?? '?'}: ${s.chapterTitle}, ${s.label}, being written (${years})`,
  };
}
