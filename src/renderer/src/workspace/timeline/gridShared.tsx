import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from 'react';
import {
  bandGaps,
  barHeightOf,
  dragYears,
  makeScale,
  moveEdge,
  moveSharedEdge,
  neighbourAt,
  scrollToYear,
  shiftSpan,
  spanExtent,
  tickYears,
  yearAt,
  yearMid,
  zoomPpy,
} from '../../../../shared/domain/worldGrid';
import type {
  BandGap,
  EdgeSide,
  WritingBand,
  GridLayout,
  GridLine,
  PlacedMarker,
  YearScale,
  YearSpan,
  Zoom,
} from '../../../../shared/domain/worldGrid';
import type { EntryCollection } from '../../../../shared/schema';
import { createCommand, editCommand } from '../../../../shared/domain/undoRunner';
import { call, plainError } from '../../api';
import { useReadOnly } from '../../connection';
import { useBibleSettings } from '../bibleSettings';
import { Editable, mergeCommands, saveEntryField } from '../editable';
import { useUndo } from '../undo';
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

/** The chapter being written, as a band on the grid (`writingBand` in `worldGrid.ts`). */
export type GridBand = WritingBand;

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
  /** A50: the scroll box's inner height, for a row that fills the frame (0 until measured). */
  viewHeight: number;
  setViewHeight: (h: number) => void;
}

/** The scale for a zoom over the scroll box's measured width (the frame measures it). */
export function useGridViewport(span: YearSpan, zoom: Zoom, storyYear: number): GridViewport {
  const [viewWidth, setViewWidth] = useState(0);
  const [viewHeight, setViewHeight] = useState(0);
  const trackView = Math.max(120, viewWidth - LABEL_W - 2);
  const scale = useMemo(
    () => makeScale(span, zoomPpy(zoom, trackView, span)),
    [span, zoom, trackView],
  );
  return { scale, zoom, storyYear, trackView, viewWidth, setViewWidth, viewHeight, setViewHeight };
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
  /** Escape called it off; the press still runs to its release, which then does nothing. */
  canceled?: boolean;
}

/**
 * While a drag is live, Escape anywhere calls it off: the item goes back to
 * where it was and nothing is written. The key is marked taken
 * (`preventDefault`), so nothing else answers that Escape (the person view
 * leaving, A50); the next Escape is everyone's again.
 */
function useEscapeCancels(live: boolean, cancel: () => void): void {
  const ref = useRef(cancel);
  useLayoutEffect(() => {
    ref.current = cancel;
  });
  useEffect(() => {
    if (!live) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      ref.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [live]);
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
  /** A50: a press or drag is under way and Escape has not called it off. */
  dragging: boolean;
  onPointerDown: (ev: ReactPointerEvent<HTMLButtonElement>, id: string) => void;
  onPointerMove: (ev: ReactPointerEvent<HTMLButtonElement>) => void;
  onPointerUp: (ev: ReactPointerEvent<HTMLButtonElement>) => void;
  cancelDrag: () => void;
  onKeyDown: (ev: ReactKeyboardEvent<HTMLButtonElement>, id: string) => void;
  /** IP-4: the marker whose label is open as a field, if any. */
  renaming: string | null;
  /** ARCH-6: nothing moves, renames or adds while the grid is read only. */
  readOnly: boolean;
  /** A57: move a marker a year back or forward, as Left and Right do (the marker bar). */
  nudge: (id: string, delta: number) => void;
  startRename: (id: string) => void;
  /** Close the rename field and put the focus back on its marker. */
  endRename: () => void;
}

/**
 * After a rename field closes and is gone, the focus goes back to what it
 * renamed, unless the writer put it somewhere else (a click elsewhere).
 */
function useRefocus(
  open: string | null,
  selector: (id: string) => string,
): (id: string | null) => void {
  const backToRef = useRef<string | null>(null);
  useEffect(() => {
    const id = backToRef.current;
    if (open !== null || id === null) return;
    backToRef.current = null;
    const now = document.activeElement;
    if (now && now !== document.body) return;
    document.querySelector<HTMLElement>(selector(id))?.focus({ preventScroll: true });
  });
  return useCallback((id: string | null) => {
    backToRef.current = id;
  }, []);
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
  const [renaming, setRenaming] = useState<string | null>(null);
  const backTo = useRefocus(renaming, (id) => `.wg-marker[data-id="${CSS.escape(id)}"]`);
  const suppressClick = useRef(false);
  const order = useMemo(
    () => layout.lines.flatMap((l) => lineMarkers(l).map((m) => m.id)),
    [layout],
  );
  const active = current !== null && order.includes(current) ? current : order[0];
  const dragging = drag !== null && !drag.canceled;
  useEscapeCancels(dragging, () =>
    setDrag((d) => (d ? { ...d, canceled: true, moved: false, delta: 0 } : d)),
  );

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
    dragging,
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
      if (!drag || drag.canceled || ev.pointerId !== drag.pointerId) return;
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
      if (!d.moved && !d.canceled) return;
      // The click that follows this release (if any) is part of the drag; nothing after it is.
      suppressClick.current = true;
      setTimeout(() => {
        suppressClick.current = false;
      }, 0);
      if (!d.canceled && d.delta !== 0) void onMove(d.id, d.delta, 'span');
    },
    cancelDrag: () => setDrag(null),
    renaming,
    readOnly,
    nudge: (id, delta) => {
      if (!readOnly) void onMove(id, delta, 'span');
    },
    startRename: (id) => {
      if (readOnly) return;
      setTip(null);
      setCurrent(id);
      setRenaming(id);
    },
    endRename: () => {
      backTo(renaming);
      setRenaming(null);
    },
    onKeyDown: (ev, id) => {
      if (ev.key === 'Escape') {
        setTip(null);
        return;
      }
      if (ev.key === 'F2') {
        ev.preventDefault();
        if (!readOnly) {
          setTip(null);
          setRenaming(id);
        }
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
 * larger when big, its title beside it when the lane leaves room. F2 renames
 * the label in place (IP-4); so does a double-click, unless `onDoubleClick`
 * is given, which then runs instead (Backstory opens the moment, A49).
 */
export function GridMarker(props: {
  m: PlacedMarker;
  ctl: GridMarkers;
  layout: GridLayout;
  label: string;
  selected: boolean;
  className?: string;
  data?: Record<string, string>;
  /** More style for the button, such as a custom property its grid's CSS reads (A51). */
  style?: CSSProperties;
  onActivate: () => void;
  /** IP-4: the title as stored, and its save, for renaming the label in place. */
  title?: string;
  onRename?: (title: string) => Promise<void>;
  /** In place of the double-click rename. */
  onDoubleClick?: () => void;
  /**
   * A57: while selected, a small bar over the marker with a year back, a year forward, rename
   * and delete, each showing its key. `onDelete` moves the item to the trash after its confirm.
   */
  bar?: { onDelete: () => Promise<void> };
}) {
  const { m, ctl, layout } = props;
  const [asking, setAsking] = useState(false);
  const metrics = layout.metrics;
  const drag = ctl.drag;
  const dragging = drag?.id === m.id && drag.moved;
  const shift = dragging ? drag.delta * layout.scale.ppy : 0;
  const size = m.bar ? barHeightOf(layout.markers, m.big) : m.width;
  const top = metrics.rowPad + m.lane * metrics.lane + (metrics.lane - size) / 2;
  const liveYear = dragging ? m.startYear + drag.delta : null;
  const renaming = ctl.renaming === m.id && props.onRename !== undefined;
  const showBar =
    props.bar !== undefined && props.selected && !ctl.readOnly && !dragging && !renaming;
  // The delete confirm belongs to this selection: once the bar goes (the marker is deselected,
  // dragged or renamed), the question ends with it and the bar opens fresh next time.
  if (asking && !showBar) setAsking(false);
  return (
    <>
      <button
        type="button"
        className={`wg-marker${m.bar ? ' bar' : ' dot'}${m.big ? ' big' : ''}${props.selected ? ' selected' : ''}${dragging ? ' dragging' : ''}${props.className ? ` ${props.className}` : ''}`}
        style={{ ...props.style, left: m.x + shift, top, width: m.width, height: size }}
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
        onDoubleClick={() => {
          if (props.onDoubleClick) props.onDoubleClick();
          else if (props.onRename) ctl.startRename(m.id);
        }}
        onPointerDown={(ev) => ctl.onPointerDown(ev, m.id)}
        onPointerMove={ctl.onPointerMove}
        onPointerUp={ctl.onPointerUp}
        onPointerCancel={ctl.cancelDrag}
        onKeyDown={(ev) => {
          if ((ev.key === 'Delete' || ev.key === 'Backspace') && showBar) {
            ev.preventDefault();
            ctl.setTip(null);
            setAsking(true);
            return;
          }
          ctl.onKeyDown(ev, m.id);
        }}
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
      {showBar && props.bar && (
        <MarkerBar
          m={m}
          ctl={ctl}
          top={top}
          title={props.title ?? m.label}
          canRename={props.onRename !== undefined}
          asking={asking}
          setAsking={setAsking}
          onDelete={props.bar.onDelete}
        />
      )}
      {renaming && props.onRename && (
        <span
          className="wg-rename"
          style={{ left: m.x + m.width + 4, top: top + size / 2 }}
          data-testid="marker-rename"
        >
          <Editable
            kind="text"
            label="Title"
            value={props.title ?? m.label}
            allowEmpty={false}
            autoOpen
            onSave={(next) => (props.onRename ? props.onRename(next) : Promise.resolve())}
            onClose={ctl.endRename}
          />
        </span>
      )}
    </>
  );
}

/**
 * A57: the bar over the selected marker. Each button shows the key that does the same on the
 * focused marker. Delete asks first, in the bar, and names what goes to the trash.
 */
function MarkerBar(props: {
  m: PlacedMarker;
  ctl: GridMarkers;
  top: number;
  title: string;
  canRename: boolean;
  asking: boolean;
  setAsking: (a: boolean) => void;
  onDelete: () => Promise<void>;
}) {
  const { m, ctl, asking, setAsking } = props;
  const keepRef = useRef<HTMLButtonElement>(null);
  const [error, setError] = useState<string | null>(null);
  useLayoutEffect(() => {
    if (asking) keepRef.current?.focus();
  }, [asking]);
  const backToMarker = (from: HTMLElement) =>
    from
      .closest('.wg-scroll')
      ?.querySelector<HTMLElement>(`.wg-marker[data-id="${CSS.escape(m.id)}"]`)
      ?.focus();
  const keep = (from: HTMLElement) => {
    setAsking(false);
    backToMarker(from);
  };
  return (
    <div
      className="wg-bar"
      role="toolbar"
      aria-label={`${props.title}, ${span(m.startYear, m.endYear)}`}
      data-testid="marker-bar"
      style={{ left: m.x + m.width / 2, top: props.top }}
      onClick={(ev) => ev.stopPropagation()}
      onKeyDown={(ev) => {
        if (ev.key !== 'Escape' || !asking) return;
        ev.preventDefault();
        ev.stopPropagation();
        keep(ev.currentTarget);
      }}
    >
      {asking ? (
        <>
          <span className="wg-bar-ask">Move {props.title} to the trash?</span>
          <button
            type="button"
            className="wg-bar-btn danger"
            onClick={(ev) => {
              const el = ev.currentTarget;
              const grid = el.closest<HTMLElement>('.wg-scroll');
              // The marker goes with its item, so the focus moves to the next marker in reading
              // order (or the one before it), or to the grid when it was the last one.
              const at = ctl.order.indexOf(m.id);
              const near = ctl.order[at + 1] ?? (at > 0 ? ctl.order[at - 1] : undefined);
              setError(null);
              props.onDelete().then(
                () => {
                  setAsking(false);
                  const next =
                    near === undefined
                      ? null
                      : grid?.querySelector<HTMLElement>(
                          `.wg-marker[data-id="${CSS.escape(near)}"]`,
                        );
                  if (next && near !== undefined) {
                    ctl.setCurrent(near);
                    next.focus();
                  } else grid?.focus();
                },
                (e: unknown) => {
                  setError(plainError(e));
                  backToMarker(el);
                },
              );
            }}
          >
            Trash it
          </button>
          <button
            ref={keepRef}
            type="button"
            className="wg-bar-btn"
            onClick={(ev) => keep(ev.currentTarget)}
          >
            Keep it
          </button>
        </>
      ) : (
        <>
          <button
            type="button"
            className="wg-bar-btn"
            aria-label="A year earlier"
            onClick={() => ctl.nudge(m.id, -1)}
          >
            ‹ <kbd>←</kbd>
          </button>
          <button
            type="button"
            className="wg-bar-btn"
            aria-label="A year later"
            onClick={() => ctl.nudge(m.id, 1)}
          >
            › <kbd>→</kbd>
          </button>
          {props.canRename && (
            <button
              type="button"
              className="wg-bar-btn"
              aria-label="Rename"
              onClick={() => ctl.startRename(m.id)}
            >
              Rename <kbd>F2</kbd>
            </button>
          )}
          <button
            type="button"
            className="wg-bar-btn danger"
            aria-label="Delete"
            onClick={() => {
              ctl.setTip(null);
              setAsking(true);
            }}
          >
            Delete <kbd>Del</kbd>
          </button>
        </>
      )}
      {error && (
        <span className="wg-bar-error" role="alert">
          {error}
        </span>
      )}
    </div>
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
  /** A50: keys pressed inside the frame that nothing in it took (the person view's Escape). */
  onKeyDown?: (ev: ReactKeyboardEvent<HTMLDivElement>) => void;
  children: ReactNode;
}) {
  const { layout } = props;
  const { setViewWidth, setViewHeight, viewWidth, scale, storyYear, trackView, zoom } = props.vp;
  const scroller = useRef<HTMLDivElement>(null);
  const scrolledFor = useRef<string | null>(null);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => {
      setViewWidth(el.clientWidth);
      setViewHeight(el.clientHeight);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [setViewWidth, setViewHeight]);

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
      tabIndex={-1}
      onKeyDown={props.onKeyDown}
    >
      <div className="wg-canvas" style={{ width: LABEL_W + layout.width, height: layout.height }}>
        {props.children}
      </div>
    </div>
  );
}

// ---------- grab handles at the ends of a span (IP-4) ----------

interface EdgeDragState {
  key: string;
  side: EdgeSide;
  pointerId: number;
  startX: number;
  moved: boolean;
  delta: number;
  /** Escape called it off (A50). */
  canceled?: boolean;
}

export interface EdgeDrag {
  /** The years an end is dragged by right now, or 0. */
  deltaFor: (key: string, side: EdgeSide) => number;
  /** The end being dragged, once it has moved. */
  active: { key: string; side: EdgeSide; delta: number } | null;
  /** A50: a press or drag on a handle is under way and Escape has not called it off. */
  dragging: boolean;
  /** The pointer handlers for one handle. */
  handle: (
    key: string,
    side: EdgeSide,
  ) => {
    onPointerDown: (ev: ReactPointerEvent<HTMLElement>) => void;
    onPointerMove: (ev: ReactPointerEvent<HTMLElement>) => void;
    onPointerUp: (ev: ReactPointerEvent<HTMLElement>) => void;
    onPointerCancel: () => void;
    onClick: (ev: ReactMouseEvent<HTMLElement>) => void;
  };
}

/**
 * IP-4: a grab handle at an end of a bar (a lifespan, an era). A drag moves
 * that end by whole years, shown live and written once on release; the click
 * that ends a drag counts for nothing.
 */
export function useEdgeDrag(
  ppy: number,
  readOnly: boolean,
  onRelease: (key: string, side: EdgeSide, delta: number) => void,
): EdgeDrag {
  const [drag, setDrag] = useState<EdgeDragState | null>(null);
  const swallow = useRef(false);
  const dragging = drag !== null && !drag.canceled;
  useEscapeCancels(dragging, () =>
    setDrag((d) => (d ? { ...d, canceled: true, moved: false, delta: 0 } : d)),
  );
  return {
    deltaFor: (key, side) =>
      drag && drag.moved && drag.key === key && drag.side === side ? drag.delta : 0,
    active: drag && drag.moved ? { key: drag.key, side: drag.side, delta: drag.delta } : null,
    dragging,
    handle: (key, side) => ({
      onPointerDown: (ev) => {
        swallow.current = false;
        if (ev.button !== 0 || readOnly) return;
        ev.stopPropagation();
        ev.preventDefault();
        ev.currentTarget.setPointerCapture(ev.pointerId);
        setDrag({ key, side, pointerId: ev.pointerId, startX: ev.clientX, moved: false, delta: 0 });
      },
      onPointerMove: (ev) => {
        if (!drag || drag.canceled || ev.pointerId !== drag.pointerId) return;
        const dx = ev.clientX - drag.startX;
        const moved = drag.moved || Math.abs(dx) > 3;
        const delta = dragYears(dx, ppy);
        if (moved !== drag.moved || delta !== drag.delta) setDrag({ ...drag, moved, delta });
      },
      onPointerUp: (ev) => {
        if (!drag || ev.pointerId !== drag.pointerId) return;
        const d = drag;
        setDrag(null);
        if (!d.moved && !d.canceled) return;
        swallow.current = true;
        setTimeout(() => {
          swallow.current = false;
        }, 0);
        if (!d.canceled && d.delta !== 0) onRelease(d.key, d.side, d.delta);
      },
      onPointerCancel: () => setDrag(null),
      onClick: (ev) => {
        if (!swallow.current) return;
        swallow.current = false;
        ev.stopPropagation();
        ev.preventDefault();
      },
    }),
  };
}

/** The years an end of a span moves with Shift (the start) or Shift+Alt (the end) and an arrow. */
export function edgeKey(
  ev: ReactKeyboardEvent<HTMLElement>,
): { side: EdgeSide; delta: number } | null {
  if (!ev.shiftKey || (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight')) return null;
  return { side: ev.altKey ? 'end' : 'start', delta: ev.key === 'ArrowRight' ? 1 : -1 };
}

// ---------- the era band: edges, gaps, names (IP-4) ----------

export interface EraEdits {
  readOnly: boolean;
  /** Move an era's start or end by whole years; a shared edge moves both eras. */
  moveEdge: (id: string, side: EdgeSide, delta: number) => Promise<void>;
  /** Make an era over a gap, named from the template; its ID, or null when it failed. */
  createInGap: (gap: BandGap) => Promise<string | null>;
  rename: (id: string, name: string) => Promise<void>;
}

/**
 * IP-4: the writes behind the era band on both grids, each one undo step.
 * Moves run one after another and read the stored eras first, so quick key
 * presses add up. Errors go to the screen's alert in plain words.
 */
export function useEraEdits(o: {
  eras: GridEra[];
  span: YearSpan;
  readOnly: boolean;
  onError: (message: string | null) => void;
}): EraEdits {
  const { eras, span: axis, onError } = o;
  // ARCH-6: off while the host says so, and always while a snapshot is open read-only.
  const snapshot = useReadOnly();
  const readOnly = o.readOnly || snapshot !== null;
  const undo = useUndo();
  const { templates } = useBibleSettings();
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const run = (job: () => Promise<void>): Promise<void> => {
    const next = queue.current.then(async () => {
      try {
        await job();
      } catch (e) {
        onError(plainError(e));
      }
    });
    queue.current = next;
    return next;
  };
  const get = async (id: string) =>
    (await call('entry.get', { collection: 'eraStates', id })).entry as Record<string, unknown>;
  const update = async (id: string, patch: Record<string, unknown>) =>
    (await call('entry.update', { collection: 'eraStates', id, patch })).entry as Record<
      string,
      unknown
    >;
  const asSpan = (id: string, d: Record<string, unknown>) => ({
    id,
    name: typeof d.name === 'string' && d.name ? d.name : String(d.title ?? id),
    startYear: Number(d.startYear),
    endYear: Number(d.endYear),
  });

  return {
    readOnly,
    moveEdge: (id, side, delta) => {
      onError(null);
      if (readOnly || delta === 0) return Promise.resolve();
      return run(async () => {
        await undo.flush();
        const me0 = await get(id);
        const me = asSpan(id, me0);
        const nbId = neighbourAt(eras, id, side)?.id;
        const nb0 = nbId ? await get(nbId) : null;
        const nb = nbId && nb0 && !nb0.deletedAt ? asSpan(nbId, nb0) : null;
        const meets =
          nb !== null &&
          (side === 'end' ? me.endYear + 1 === nb.startYear : nb.endYear + 1 === me.startYear);
        if (nb && nb0 && meets) {
          const [b, b0, a, a0] = side === 'end' ? [me, me0, nb, nb0] : [nb, nb0, me, me0];
          const m = moveSharedEdge(b, a, delta);
          if (m.delta === 0) return;
          // Make room first: the era that grows waits for the one that shrinks.
          const first = m.delta > 0 ? 'after' : 'before';
          const writeBefore = () => update(b.id, { endYear: m.beforeEnd });
          const writeAfter = () => update(a.id, { startYear: m.afterStart });
          let b1: Record<string, unknown>;
          let a1: Record<string, unknown>;
          if (first === 'after') {
            a1 = await writeAfter();
            try {
              b1 = await writeBefore();
            } catch (e) {
              await update(a.id, { startYear: a.startYear });
              throw e;
            }
          } else {
            b1 = await writeBefore();
            try {
              a1 = await writeAfter();
            } catch (e) {
              await update(b.id, { endYear: b.endYear });
              throw e;
            }
          }
          undo.record(
            mergeCommands(
              `Moved the edge between ${b.name} and ${a.name}`,
              editCommand('', 'eraStates', b.id, b0, b1),
              editCommand('', 'eraStates', a.id, a0, a1),
            ),
          );
          return;
        }
        const moved = moveEdge(me.startYear, me.endYear, side, delta, axis);
        const year = side === 'start' ? moved.startYear : moved.endYear;
        if (year === (side === 'start' ? me.startYear : me.endYear)) return;
        const after = await update(id, side === 'start' ? { startYear: year } : { endYear: year });
        undo.record(
          editCommand(
            `Moved the ${side === 'start' ? 'start' : 'end'} of ${me.name} to ${year}`,
            'eraStates',
            id,
            me0,
            after,
          ),
        );
      });
    },
    createInGap: async (gap) => {
      onError(null);
      if (readOnly) return null;
      let made: string | null = null;
      await run(async () => {
        const name = templates.eraName;
        const { entry } = await call('entry.create', {
          collection: 'eraStates',
          data: {
            title: name,
            name,
            startYear: gap.startYear,
            endYear: gap.endYear,
          },
        });
        undo.record(
          createCommand('eraStates', entry._id, `${name}, ${span(gap.startYear, gap.endYear)}`),
        );
        made = entry._id;
      });
      return made;
    },
    rename: async (id, name) => {
      onError(null);
      await saveEntryField(undo, {
        collection: 'eraStates',
        id,
        path: 'name',
        value: name,
        label: 'Era name',
        extraPatch: (next) => ({ title: next }),
      });
    },
  };
}

/** IP-4: rename an entry's title in place, as one undo step through the write path. */
export function useTitleRename(collection: EntryCollection) {
  const undo = useUndo();
  return (id: string, title: string) =>
    saveEntryField(undo, { collection, id, path: 'title', value: title, label: 'Title' }).then(
      () => undefined,
    );
}

/** The eras as the band draws them while an edge is dragged: the moved ends where they would land. */
function previewEras(eras: GridEra[], drag: EdgeDrag, axis: YearSpan): GridEra[] {
  const a = drag.active;
  if (!a || a.delta === 0) return eras;
  const me = eras.find((e) => e.id === a.key);
  if (!me) return eras;
  const nb = neighbourAt(eras, me.id, a.side);
  if (nb) {
    const [b, af] = a.side === 'end' ? [me, nb] : [nb, me];
    const m = moveSharedEdge(b, af, a.delta);
    return eras.map((e) =>
      e.id === b.id
        ? { ...e, endYear: m.beforeEnd }
        : e.id === af.id
          ? { ...e, startYear: m.afterStart }
          : e,
    );
  }
  const moved = moveEdge(me.startYear, me.endYear, a.side, a.delta, axis);
  return eras.map((e) => (e.id === me.id ? { ...e, ...moved } : e));
}

/** The sticky year header: the corner, the year ticks, the story year tag, and the era band. */
export function GridHeader(props: {
  layout: GridLayout;
  storyYear: number;
  corner: string;
  eras: GridEra[];
  onOpenEra: (id: string) => void;
  /** IP-4: the band's edges drag, its gaps make eras, its names rename. Read only without. */
  edits?: EraEdits;
}) {
  const { layout, storyYear, edits } = props;
  const scale = layout.scale;
  const storyX =
    storyYear >= scale.from && storyYear <= scale.to ? yearMid(scale, storyYear) : null;
  const canEdit = edits !== undefined && !edits.readOnly;
  const drag = useEdgeDrag(scale.ppy, !canEdit, (id, side, delta) => {
    void edits?.moveEdge(id, side, delta);
  });
  const [renaming, setRenaming] = useState<string | null>(null);
  const shown = previewEras(props.eras, drag, scale);
  // Gaps count only inside the bible's timeline span, as the coverage check does (WE-2,
  // IP-11): an axis widened by an early event or a birth is not a stretch to fill with an era.
  const { numbers } = useBibleSettings();
  const gaps = useMemo(
    () =>
      bandGaps(props.eras, {
        from: Math.max(scale.from, numbers.timelineStart),
        to: Math.min(scale.to, numbers.timelineEnd),
      }),
    [props.eras, scale, numbers.timelineStart, numbers.timelineEnd],
  );

  const startRename = (id: string) => {
    if (canEdit) setRenaming(id);
  };
  const backTo = useRefocus(renaming, (id) => `.wg-era[data-id="${CSS.escape(id)}"]`);
  const endRename = () => {
    backTo(renaming);
    setRenaming(null);
  };
  // A57: one press makes one era, however many clicks land on the gap while it is made.
  const making = useRef(false);
  const makeEra = async (gap: BandGap) => {
    if (!edits || !canEdit || making.current) return;
    making.current = true;
    try {
      const id = await edits.createInGap(gap);
      if (id) setRenaming(id);
    } finally {
      making.current = false;
    }
  };

  const renamed = renaming ? props.eras.find((e) => e.id === renaming) : undefined;
  const renameAt = renamed ? spanExtent(scale, renamed.startYear, renamed.endYear) : null;

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
        {canEdit &&
          gaps.map((g) => {
            const x = spanExtent(scale, g.startYear, g.endYear);
            // A57: every gap shows a "+ era" ghost; one click (or Enter) fills it.
            return (
              <button
                key={`gap:${g.startYear}`}
                type="button"
                className="wg-gap"
                style={{ left: x.x, width: Math.max(2, x.width - 1) }}
                data-from={g.startYear}
                data-to={g.endYear}
                aria-label={`Add an era from ${span(g.startYear, g.endYear)}`}
                onClick={() => void makeEra(g)}
              >
                <span className="wg-gap-text" aria-hidden="true">
                  + era
                </span>
              </button>
            );
          })}
        {shown.map((era) => {
          if (era.endYear < scale.from || era.startYear > scale.to) return null;
          const x = spanExtent(scale, era.startYear, era.endYear);
          const live = drag.active?.key === era.id;
          return (
            <button
              key={era.id}
              type="button"
              className={`wg-era${canEdit ? ' editable-band' : ''}${live ? ' dragging' : ''}`}
              style={{ left: x.x, width: Math.max(2, x.width - 1) }}
              data-id={era.id}
              data-from={era.startYear}
              data-to={era.endYear}
              aria-label={`Era ${era.name}, ${span(era.startYear, era.endYear)}`}
              title={`${era.name}, ${span(era.startYear, era.endYear)}`}
              onClick={(ev) => {
                // The second click of a double-click (a rename, or a gap just filled) opens nothing.
                if (ev.detail > 1) return;
                props.onOpenEra(era.id);
              }}
              onDoubleClick={() => startRename(era.id)}
              onKeyDown={(ev) => {
                if (ev.key === 'F2') {
                  ev.preventDefault();
                  startRename(era.id);
                  return;
                }
                const k = edgeKey(ev);
                if (!k) return;
                ev.preventDefault();
                if (canEdit) void edits?.moveEdge(era.id, k.side, k.delta);
              }}
            >
              {canEdit && (
                <span
                  className="wg-handle start"
                  aria-hidden="true"
                  data-testid="era-handle-start"
                  {...drag.handle(era.id, 'start')}
                />
              )}
              <span className="wg-era-name">{era.name}</span>
              {canEdit && (
                <span
                  className="wg-handle end"
                  aria-hidden="true"
                  data-testid="era-handle-end"
                  {...drag.handle(era.id, 'end')}
                />
              )}
            </button>
          );
        })}
        {drag.active && (
          <span
            className="wg-drag-year wg-edge-year num"
            data-testid="edge-year"
            style={{
              left: (() => {
                const e = shown.find((x) => x.id === drag.active?.key);
                if (!e) return 0;
                const x = spanExtent(scale, e.startYear, e.endYear);
                return drag.active.side === 'start' ? x.x : x.x + x.width;
              })(),
            }}
          >
            {(() => {
              const e = shown.find((x) => x.id === drag.active?.key);
              return e ? (drag.active.side === 'start' ? e.startYear : e.endYear) : '';
            })()}
          </span>
        )}
        {renamed && renameAt && edits && (
          <span
            className="wg-era-rename"
            style={{ left: renameAt.x, minWidth: Math.max(2, renameAt.width - 1) }}
            data-testid="era-rename"
          >
            <Editable
              kind="text"
              label="Era name"
              value={renamed.name}
              allowEmpty={false}
              autoOpen
              onSave={(next) => edits.rename(renamed.id, next)}
              onClose={endRename}
            />
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * A row's track: the markers over the years; a click on an empty spot gives its year. On an
 * addable track a "+ year" ghost follows the pointer over empty spots, so the click's year
 * shows before the click (A57).
 */
export function GridTrack(props: {
  layout: GridLayout;
  onEmptyClick?: (year: number, e: ReactMouseEvent<HTMLDivElement>) => void;
  children?: ReactNode;
}) {
  const { layout, onEmptyClick } = props;
  const [ghost, setGhost] = useState<number | null>(null);
  const yearOf = (e: { clientX: number; currentTarget: HTMLElement }) =>
    yearAt(layout.scale, e.clientX - e.currentTarget.getBoundingClientRect().left);
  return (
    <div
      className={`wg-track${onEmptyClick ? ' addable' : ''}`}
      style={{ width: layout.width }}
      onPointerMove={
        onEmptyClick
          ? (e) => {
              const y = e.target === e.currentTarget && e.buttons === 0 ? yearOf(e) : null;
              if (y !== ghost) setGhost(y);
            }
          : undefined
      }
      onPointerLeave={onEmptyClick ? () => setGhost(null) : undefined}
      onClick={
        onEmptyClick
          ? (e) => {
              if (e.target !== e.currentTarget) return;
              setGhost(null);
              onEmptyClick(yearOf(e), e);
            }
          : undefined
      }
    >
      {props.children}
      {onEmptyClick && ghost !== null && (
        <span
          className="wg-ghost num"
          style={{ left: yearMid(layout.scale, ghost) }}
          aria-hidden="true"
          data-testid="track-ghost"
          data-year={ghost}
        >
          + {ghost}
        </span>
      )}
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
