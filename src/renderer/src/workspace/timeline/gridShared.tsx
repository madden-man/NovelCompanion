import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from 'react';
import {
  dragYears,
  makeScale,
  scrollToYear,
  shiftSpan,
  spanExtent,
  tickYears,
  yearAt,
  yearMid,
  zoomPpy,
} from '../../../../shared/domain/worldGrid';
import type {
  GridLayout,
  GridLine,
  PlacedMarker,
  YearScale,
  YearSpan,
  Zoom,
} from '../../../../shared/domain/worldGrid';
import { span } from './common';
import './grid.css';

/**
 * What the year grids share (SM-8 World events, SM-9 Backstory): the viewport
 * and its scale, the sticky year header with the era band, group heading
 * lines, the row track, the marker buttons with their drag, roving Tab stop
 * and arrow keys, the story year line and writing band, and the tooltip. The
 * layout itself is `worldGrid.ts`; each grid supplies its rows and callbacks.
 */

/** Width of the sticky row label column, on every grid. */
export const LABEL_W = 200;

export interface GridEra {
  id: string;
  name: string;
  startYear: number;
  endYear: number;
}

/** The chapter being written, as a band on the grid. */
export interface GridBand {
  from: number;
  to: number;
  label: string;
}

/** A move from a drag or an arrow key: the whole span, or only its end (Shift). */
export type MovePart = 'span' | 'end';

// ---------- the viewport ----------

export interface GridViewport {
  scale: YearScale;
  zoom: Zoom;
  storyYear: number;
  /** The track's visible width, for fitting and scrolling. */
  trackView: number;
  viewWidth: number;
  setViewWidth: (w: number) => void;
}

/** The scale for a zoom over the scroll box's measured width (the frame measures it). */
export function useGridViewport(span: YearSpan, zoom: Zoom, storyYear: number): GridViewport {
  const [viewWidth, setViewWidth] = useState(0);
  const trackView = Math.max(120, viewWidth - LABEL_W - 2);
  const scale = useMemo(
    () => makeScale(span, zoomPpy(zoom, trackView, span)),
    [span, zoom, trackView],
  );
  return { scale, zoom, storyYear, trackView, viewWidth, setViewWidth };
}

/** Which group headings are closed, and the toggle. */
export function useClosedGroups(): [ReadonlySet<string>, (id: string) => void] {
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const toggle = useCallback(
    (id: string) =>
      setClosed((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    [],
  );
  return [closed, toggle];
}

/** The markers of a line: a row's own, or a closed group's merged ones. */
export function lineMarkers(l: GridLine): PlacedMarker[] {
  return l.kind === 'row' ? l.layout.markers : (l.merged?.markers ?? []);
}

// ---------- markers: drag, roving Tab stop, keys, tooltip ----------

interface Drag {
  id: string;
  pointerId: number;
  startX: number;
  moved: boolean;
  delta: number;
}

export interface Tip {
  id: string;
  left: number;
  top: number;
}

export interface GridMarkers {
  /** Every marker in reading order: row by row, year by year. */
  order: string[];
  /** The marker holding the grid's one Tab stop. */
  active: string | undefined;
  drag: Drag | null;
  tip: Tip | null;
  setTip: (t: Tip | null | ((t: Tip | null) => Tip | null)) => void;
  setCurrent: (id: string) => void;
  /** True once for the click that ends a drag, which must not count as a click. */
  takeSuppressedClick: () => boolean;
  onPointerDown: (ev: ReactPointerEvent<HTMLButtonElement>, id: string) => void;
  onPointerMove: (ev: ReactPointerEvent<HTMLButtonElement>) => void;
  onPointerUp: (ev: ReactPointerEvent<HTMLButtonElement>) => void;
  cancelDrag: () => void;
  onKeyDown: (ev: ReactKeyboardEvent<HTMLButtonElement>, id: string) => void;
}

/**
 * Marker behaviour both grids share. A marker drags along its row by whole
 * years (shown live, written once on release); a click right after a drag is
 * swallowed. The markers are one Tab stop: Up and Down walk them in reading
 * order, Home and End jump, Left and Right move one a year (Shift for its end
 * year), Escape hides the tooltip.
 */
export function useGridMarkers(opts: {
  layout: GridLayout;
  scale: YearScale;
  readOnly: boolean;
  /** The years of a marker's item, for clamping a drag to the axis. */
  yearsOf: (id: string) => { startYear: number; endYear: number } | undefined;
  onMove: (id: string, delta: number, part: MovePart) => Promise<void>;
}): GridMarkers {
  const { layout, scale, readOnly, yearsOf, onMove } = opts;
  const [tip, setTip] = useState<Tip | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const suppressClick = useRef(false);
  const order = useMemo(
    () => layout.lines.flatMap((l) => lineMarkers(l).map((m) => m.id)),
    [layout],
  );
  const active = current !== null && order.includes(current) ? current : order[0];

  /** Focus another marker of the same grid. */
  const focusMarker = (from: HTMLElement, id: string) => {
    setCurrent(id);
    from
      .closest('.wg-scroll')
      ?.querySelector<HTMLElement>(`.wg-marker[data-id="${CSS.escape(id)}"]`)
      ?.focus();
  };

  return {
    order,
    active,
    drag,
    tip,
    setTip,
    setCurrent,
    takeSuppressedClick: () => {
      if (!suppressClick.current) return false;
      suppressClick.current = false;
      return true;
    },
    onPointerDown: (ev, id) => {
      // A new press starts fresh: a drag that ended with no click never swallows this one.
      suppressClick.current = false;
      if (ev.button !== 0 || readOnly) return;
      ev.currentTarget.setPointerCapture(ev.pointerId);
      setDrag({ id, pointerId: ev.pointerId, startX: ev.clientX, moved: false, delta: 0 });
    },
    onPointerMove: (ev) => {
      if (!drag || ev.pointerId !== drag.pointerId) return;
      const dx = ev.clientX - drag.startX;
      const y = yearsOf(drag.id);
      if (!y) return;
      const moved = drag.moved || Math.abs(dx) > 3;
      const delta = shiftSpan(y.startYear, y.endYear, dragYears(dx, scale.ppy), scale).delta;
      if (moved !== drag.moved || delta !== drag.delta) setDrag({ ...drag, moved, delta });
    },
    onPointerUp: (ev) => {
      if (!drag || ev.pointerId !== drag.pointerId) return;
      const d = drag;
      setDrag(null);
      if (!d.moved) return;
      // The click that follows this release (if any) is part of the drag; nothing after it is.
      suppressClick.current = true;
      setTimeout(() => {
        suppressClick.current = false;
      }, 0);
      if (d.delta !== 0) void onMove(d.id, d.delta, 'span');
    },
    cancelDrag: () => setDrag(null),
    onKeyDown: (ev, id) => {
      if (ev.key === 'Escape') {
        setTip(null);
        return;
      }
      const i = order.indexOf(id);
      const to =
        ev.key === 'ArrowDown'
          ? order[Math.min(order.length - 1, i + 1)]
          : ev.key === 'ArrowUp'
            ? order[Math.max(0, i - 1)]
            : ev.key === 'Home'
              ? order[0]
              : ev.key === 'End'
                ? order[order.length - 1]
                : undefined;
      if (to !== undefined) {
        ev.preventDefault();
        focusMarker(ev.currentTarget, to);
        return;
      }
      if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
      ev.preventDefault();
      if (readOnly) return;
      void onMove(id, ev.key === 'ArrowRight' ? 1 : -1, ev.shiftKey ? 'end' : 'span');
    },
  };
}

/**
 * One marker: a dot at its year or a bar across its years, in its lane,
 * larger when big, its title beside it when the lane leaves room.
 */
export function GridMarker(props: {
  m: PlacedMarker;
  ctl: GridMarkers;
  layout: GridLayout;
  label: string;
  selected: boolean;
  className?: string;
  data?: Record<string, string>;
  onActivate: () => void;
}) {
  const { m, ctl, layout } = props;
  const metrics = layout.metrics;
  const drag = ctl.drag;
  const dragging = drag?.id === m.id && drag.moved;
  const shift = dragging ? drag.delta * layout.scale.ppy : 0;
  const size = m.bar ? (m.big ? 12 : 8) : m.width;
  const top = metrics.rowPad + m.lane * metrics.lane + (metrics.lane - size) / 2;
  const liveYear = dragging ? m.startYear + drag.delta : null;
  return (
    <button
      type="button"
      className={`wg-marker${m.bar ? ' bar' : ' dot'}${m.big ? ' big' : ''}${props.selected ? ' selected' : ''}${dragging ? ' dragging' : ''}${props.className ? ` ${props.className}` : ''}`}
      style={{ left: m.x + shift, top, width: m.width, height: size }}
      data-id={m.id}
      data-year={m.startYear}
      data-end-year={m.endYear}
      {...Object.fromEntries(Object.entries(props.data ?? {}).map(([k, v]) => [`data-${k}`, v]))}
      aria-label={props.label}
      aria-current={props.selected ? 'true' : undefined}
      tabIndex={m.id === ctl.active ? 0 : -1}
      onClick={() => {
        if (ctl.takeSuppressedClick()) return;
        props.onActivate();
      }}
      onPointerDown={(ev) => ctl.onPointerDown(ev, m.id)}
      onPointerMove={ctl.onPointerMove}
      onPointerUp={ctl.onPointerUp}
      onPointerCancel={ctl.cancelDrag}
      onKeyDown={(ev) => ctl.onKeyDown(ev, m.id)}
      onMouseEnter={() => ctl.setTip({ id: m.id, left: m.x, top })}
      onMouseLeave={() => ctl.setTip((t) => (t?.id === m.id ? null : t))}
      onFocus={() => {
        ctl.setCurrent(m.id);
        ctl.setTip({ id: m.id, left: m.x, top });
      }}
      onBlur={() => ctl.setTip((t) => (t?.id === m.id ? null : t))}
    >
      {m.showLabel && !dragging && (
        <span className="wg-mlabel" aria-hidden="true">
          {m.label}
        </span>
      )}
      {liveYear !== null && (
        <span className="wg-drag-year num" data-testid="drag-year" aria-live="polite">
          {liveYear}
        </span>
      )}
    </button>
  );
}

// ---------- the frame, header, lines, overlay, tooltip ----------

/**
 * The scroll box and the canvas the header, lines and overlay sit on. It
 * measures its width for the scale, and opens scrolled so the story year is
 * in view, again when the zoom changes.
 */
export function GridFrame(props: {
  vp: GridViewport;
  layout: GridLayout;
  testid: string;
  className?: string;
  children: ReactNode;
}) {
  const { layout } = props;
  const { setViewWidth, viewWidth, scale, storyYear, trackView, zoom } = props.vp;
  const scroller = useRef<HTMLDivElement>(null);
  const scrolledFor = useRef<string | null>(null);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => setViewWidth(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [setViewWidth]);

  // A vertical scrollbar that comes or goes with the rows narrows the panel without resizing it.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && el.clientWidth !== viewWidth) setViewWidth(el.clientWidth);
  }, [layout.height, viewWidth, setViewWidth]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || viewWidth === 0) return;
    const key = `${zoom}`;
    if (scrolledFor.current === key) return;
    scrolledFor.current = key;
    el.scrollLeft = scrollToYear(scale, storyYear, trackView);
  }, [scale, storyYear, trackView, viewWidth, zoom]);

  return (
    <div
      className={`wg-scroll${props.className ? ` ${props.className}` : ''}`}
      ref={scroller}
      data-testid={props.testid}
      data-ppy={layout.scale.ppy}
      data-from={layout.scale.from}
      data-to={layout.scale.to}
      style={{ ['--wg-label' as string]: `${LABEL_W}px` }}
    >
      <div className="wg-canvas" style={{ width: LABEL_W + layout.width, height: layout.height }}>
        {props.children}
      </div>
    </div>
  );
}

/** The sticky year header: the corner, the year ticks, the story year tag, and the era band. */
export function GridHeader(props: {
  layout: GridLayout;
  storyYear: number;
  corner: string;
  eras: GridEra[];
  onOpenEra: (id: string) => void;
}) {
  const { layout, storyYear } = props;
  const scale = layout.scale;
  const storyX =
    storyYear >= scale.from && storyYear <= scale.to ? yearMid(scale, storyYear) : null;
  return (
    <div className="wg-head" style={{ height: layout.metrics.header }}>
      <div className="wg-corner">
        <span>{props.corner}</span>
        <span className="wg-corner-sub">Era</span>
      </div>
      <div className="wg-years" style={{ width: layout.width }} aria-hidden="true">
        {tickYears(scale).map((y) => (
          <span
            key={y}
            className={`wg-tick num${yearMid(scale, y) + 24 > layout.width ? ' end' : ''}`}
            style={{ left: yearMid(scale, y) }}
            data-year={y}
          >
            {y}
          </span>
        ))}
        {storyX !== null && (
          <span
            className={`wg-story-tag num${storyX + 24 > layout.width ? ' end' : ''}`}
            style={{ left: storyX }}
          >
            {storyYear}
          </span>
        )}
      </div>
      <div
        className="wg-eras"
        style={{ width: layout.width }}
        role="group"
        aria-label="Eras"
        data-testid="era-band"
      >
        {props.eras.map((era) => {
          if (era.endYear < scale.from || era.startYear > scale.to) return null;
          const x = spanExtent(scale, era.startYear, era.endYear);
          return (
            <button
              key={era.id}
              type="button"
              className="wg-era"
              style={{ left: x.x, width: Math.max(2, x.width - 1) }}
              data-id={era.id}
              data-from={era.startYear}
              data-to={era.endYear}
              aria-label={`Era ${era.name}, ${span(era.startYear, era.endYear)}`}
              title={`${era.name}, ${span(era.startYear, era.endYear)}`}
              onClick={() => props.onOpenEra(era.id)}
            >
              {era.name}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** A row's track: the markers over the years; a click on an empty spot gives its year. */
export function GridTrack(props: {
  layout: GridLayout;
  onEmptyClick?: (year: number, e: ReactMouseEvent<HTMLDivElement>) => void;
  children?: ReactNode;
}) {
  const { layout, onEmptyClick } = props;
  return (
    <div
      className={`wg-track${onEmptyClick ? ' addable' : ''}`}
      style={{ width: layout.width }}
      onClick={
        onEmptyClick
          ? (e) => {
              if (e.target !== e.currentTarget) return;
              const x = e.clientX - e.currentTarget.getBoundingClientRect().left;
              onEmptyClick(yearAt(layout.scale, x), e);
            }
          : undefined
      }
    >
      {props.children}
    </div>
  );
}

/** A group heading line: the caret button, and the merged markers when it is closed. */
export function GroupLine(props: {
  line: Extract<GridLine, { kind: 'group' }>;
  layout: GridLayout;
  onToggle: (id: string) => void;
  /** The markers merged onto a closed heading. */
  merged: ReactNode;
  children: ReactNode;
}) {
  const { line } = props;
  return (
    <div
      className={`wg-line wg-group${line.group.open ? '' : ' closed'}`}
      style={{ height: line.height }}
      data-group={line.group.id}
    >
      <button
        type="button"
        className="wg-label wg-group-label"
        aria-expanded={line.group.open}
        onClick={() => props.onToggle(line.group.id)}
      >
        <span className="wg-caret" aria-hidden="true">
          {line.group.open ? '▾' : '▸'}
        </span>
        {props.children}
      </button>
      {line.merged ? (
        <GridTrack layout={props.layout}>{props.merged}</GridTrack>
      ) : (
        <div className="wg-track wg-group-track" style={{ width: props.layout.width }} />
      )}
    </div>
  );
}

/** The story year line and the chapter being written, over every row. */
export function GridOverlay(props: {
  layout: GridLayout;
  storyYear: number;
  writing: GridBand | null;
}) {
  const { layout, storyYear, writing } = props;
  const scale = layout.scale;
  const storyX =
    storyYear >= scale.from && storyYear <= scale.to ? yearMid(scale, storyYear) : null;
  const band = writing ? spanExtent(scale, writing.from, writing.to) : null;
  return (
    <div
      className="wg-overlay"
      style={{
        left: LABEL_W,
        top: layout.metrics.header,
        height: layout.height - layout.metrics.header,
      }}
      aria-hidden="true"
    >
      {band && writing && (
        <div
          className="wg-writing"
          style={{ left: band.x, width: band.width }}
          data-testid="grid-writing"
          data-from={writing.from}
          data-to={writing.to}
          title={writing.label}
        />
      )}
      {storyX !== null && (
        <div
          className="wg-story"
          style={{ left: storyX - 1 }}
          data-testid="grid-story-year"
          data-year={storyYear}
        />
      )}
    </div>
  );
}

/** The tooltip under a hovered or focused marker. */
export function GridTip(props: { layout: GridLayout; tip: Tip; children: ReactNode }) {
  const { layout, tip } = props;
  const lineY = layout.lines.find((l) => lineMarkers(l).some((m) => m.id === tip.id))?.y ?? 0;
  return (
    <div
      className="tooltip wg-tip"
      role="tooltip"
      style={{
        left: Math.max(0, Math.min(LABEL_W + tip.left, LABEL_W + layout.width - 300)),
        top: lineY + tip.top + 24,
      }}
      data-testid="grid-tip"
    >
      {props.children}
    </div>
  );
}
