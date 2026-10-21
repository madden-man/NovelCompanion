/**
 * The year grid (SM-8, and the Backstory grid of SM-9 after it): a year axis
 * left to right, rows grouped under collapsible headings, markers placed in
 * lanes inside each row. Pure layout and hit logic over plain objects. The
 * axis and the marker placement know nothing of world events, so any grid of
 * dated items can reuse them; only `buildGroups` reads a category list.
 */

// ---------- the year axis ----------

/** The years a grid shows by default (SM-8): 2025 to 2100. */
export const DEFAULT_SPAN = { from: 2025, to: 2100 } as const;

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

/** The default span widened to take in every given year (an event before 2025 still shows). */
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
    rowOf.set(i.id, (c[1] ?? c[0]!).id);
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
  /** Most lanes a row grows to; further overlaps share the least-full lane. */
  maxLanes: number;
  /** The width a label needs. */
  labelWidth: (label: string) => number;
}

/** A rough label width for 11 to 12 pixel text, enough to decide whether it fits. */
export const roughLabelWidth = (label: string) => Math.ceil(label.length * 6.4) + 4;

export const MARKER_DEFAULTS: MarkerOptions = {
  dot: 10,
  bigDot: 16,
  gap: 4,
  maxLanes: 4,
  labelWidth: roughLabelWidth,
};

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
 * Place a row's items: x from the year, a bar across the years of a range, a
 * dot centred in its column otherwise (larger when big). Overlapping markers
 * take the next lane down. A label shows when the room to the next marker in
 * its lane holds it.
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
    laneEnds[lane] = Math.max(laneEnds[lane] ?? -Infinity, x + width);
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
      m.showLabel = opts.labelWidth(m.label) <= m.labelRoom;
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
  return { scale: s, lines, height: y, width: scaleWidth(s), metrics };
}

/** The line under a vertical position in the grid, or null in the header or past the end. */
export function lineAt(layout: GridLayout, y: number): GridLine | null {
  const { lines } = layout;
  let lo = 0;
  let hi = lines.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const l = lines[mid]!;
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
    const m = row.markers[i]!;
    if (m.lane === lane && x >= m.x && x <= m.x + m.width) return m;
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

// ---------- the world around the story year ----------

/** A33: three years before the story year through one after. */
export const WINDOW_BEFORE = 3;
export const WINDOW_AFTER = 1;

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
