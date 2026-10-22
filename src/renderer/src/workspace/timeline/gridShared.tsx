import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from 'react';
import {
  bandGaps,
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
import { useBibleSettings, useDefaultStatus } from '../bibleSettings';
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
  /** IP-4: the marker whose label is open as a field, if any. */
  renaming: string | null;
  startRename: (id: string) => void;
  /** Close the rename field and put the focus back on its marker. */
  endRename: () => void;
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
    renaming,
    startRename: (id) => {
      if (readOnly) return;
      setTip(null);
      setCurrent(id);
      setRenaming(id);
    },
    endRename: () => {
      const id = renaming;
      setRenaming(null);
      if (id === null) return;
      // The field is gone after this render; the focus goes back to its marker.
      requestAnimationFrame(() => {
        // Only when the focus has nowhere else to be: a click elsewhere keeps its own focus.
        const now = document.activeElement;
        if (now && now !== document.body) return;
        document
          .querySelector<HTMLElement>(`.wg-marker[data-id="${CSS.escape(id)}"]`)
          ?.focus({ preventScroll: true });
      });
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
  /** IP-4: the title as stored, and its save, for renaming the label in place. */
  title?: string;
  onRename?: (title: string) => Promise<void>;
}) {
  const { m, ctl, layout } = props;
  const metrics = layout.metrics;
  const drag = ctl.drag;
  const dragging = drag?.id === m.id && drag.moved;
  const shift = dragging ? drag.delta * layout.scale.ppy : 0;
  const size = m.bar ? (m.big ? 12 : 8) : m.width;
  const top = metrics.rowPad + m.lane * metrics.lane + (metrics.lane - size) / 2;
  const liveYear = dragging ? m.startYear + drag.delta : null;
  const renaming = ctl.renaming === m.id && props.onRename !== undefined;
  return (
    <>
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
        onDoubleClick={() => {
          if (props.onRename) ctl.startRename(m.id);
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

// ---------- grab handles at the ends of a span (IP-4) ----------

interface EdgeDragState {
  key: string;
  side: EdgeSide;
  pointerId: number;
  startX: number;
  moved: boolean;
  delta: number;
}

export interface EdgeDrag {
  /** The years an end is dragged by right now, or 0. */
  deltaFor: (key: string, side: EdgeSide) => number;
  /** The end being dragged, once it has moved. */
  active: { key: string; side: EdgeSide; delta: number } | null;
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
  return {
    deltaFor: (key, side) =>
      drag && drag.moved && drag.key === key && drag.side === side ? drag.delta : 0,
    active: drag && drag.moved ? { key: drag.key, side: drag.side, delta: drag.delta } : null,
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
        if (!drag || ev.pointerId !== drag.pointerId) return;
        const dx = ev.clientX - drag.startX;
        const moved = drag.moved || Math.abs(dx) > 3;
        const delta = dragYears(dx, ppy);
        if (moved !== drag.moved || delta !== drag.delta) setDrag({ ...drag, moved, delta });
      },
      onPointerUp: (ev) => {
        if (!drag || ev.pointerId !== drag.pointerId) return;
        const d = drag;
        setDrag(null);
        if (!d.moved) return;
        swallow.current = true;
        setTimeout(() => {
          swallow.current = false;
        }, 0);
        if (d.delta !== 0) onRelease(d.key, d.side, d.delta);
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
  const { eras, span: axis, readOnly, onError } = o;
  const undo = useUndo();
  const { templates } = useBibleSettings();
  const statusOf = useDefaultStatus();
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
            status: statusOf('idea'),
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
  const gaps = useMemo(() => bandGaps(props.eras, scale), [props.eras, scale]);
  const band = useRef<HTMLDivElement>(null);

  const startRename = (id: string) => {
    if (canEdit) setRenaming(id);
  };
  const endRename = () => {
    const id = renaming;
    setRenaming(null);
    requestAnimationFrame(() => {
      const now = document.activeElement;
      if (id === null || (now && now !== document.body)) return;
      band.current
        ?.querySelector<HTMLElement>(`.wg-era[data-id="${CSS.escape(id)}"]`)
        ?.focus({ preventScroll: true });
    });
  };
  const makeEra = async (gap: BandGap) => {
    if (!edits || !canEdit) return;
    const id = await edits.createInGap(gap);
    if (id) setRenaming(id);
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
        ref={band}
        className="wg-eras"
        style={{ width: layout.width }}
        role="group"
        aria-label="Eras"
        data-testid="era-band"
      >
        {canEdit &&
          gaps.map((g) => {
            const x = spanExtent(scale, g.startYear, g.endYear);
            const words = `No era from ${span(g.startYear, g.endYear)}`;
            return (
              <button
                key={`gap:${g.startYear}`}
                type="button"
                className="wg-gap"
                style={{ left: x.x, width: Math.max(2, x.width - 1) }}
                data-from={g.startYear}
                data-to={g.endYear}
                aria-label={`${words}. Press Enter to add an era here`}
                title={`${words}. Double-click or press Enter to add an era here.`}
                onDoubleClick={() => void makeEra(g)}
                onKeyDown={(ev) => {
                  if (ev.key === 'Enter') {
                    ev.preventDefault();
                    void makeEra(g);
                  }
                }}
              />
            );
          })}
        {shown.map((era) => {
          if (era.endYear < scale.from || era.startYear > scale.to) return null;
          const x = spanExtent(scale, era.startYear, era.endYear);
          const live = drag.active?.key === era.id;
          const keys = canEdit
            ? ' Shift with Left or Right moves its start a year, Shift and Alt with Left or Right its end, F2 renames it.'
            : '';
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
              title={`${era.name}, ${span(era.startYear, era.endYear)}.${keys}`}
              onClick={() => props.onOpenEra(era.id)}
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
