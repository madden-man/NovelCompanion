import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type {
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from 'react';
import {
  buildGroups,
  dragYears,
  layoutGrid,
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
  CategoryItem,
  GridItem,
  PlacedMarker,
  RowLayout,
  YearSpan,
  Zoom,
} from '../../../../shared/domain/worldGrid';
import { span } from './common';
import './grid.css';

/** Width of the sticky row label column. */
const LABEL_W = 200;

/** A world event as the grid draws it. */
export interface GridEvent {
  id: string;
  title: string;
  categoryId: string;
  startYear: number;
  endYear: number;
  formative: boolean;
  regions: string[];
}

export interface GridEra {
  id: string;
  name: string;
  startYear: number;
  endYear: number;
}

export interface NewEvent {
  categoryId: string;
  title: string;
  year: number;
  endYear: number | null;
  formative: boolean;
}

interface Draft {
  rowKey: string;
  rowLabel: string;
  year: number;
  /** Where the form opens, in canvas pixels. */
  left: number;
  top: number;
}

interface Drag {
  id: string;
  pointerId: number;
  startX: number;
  moved: boolean;
  delta: number;
}

/**
 * SM-8: world events as a grid. Years run left to right; one row per
 * subcategory under its collapsible group heading, in the category list's
 * order. A marker sits at its year (a bar to its end year), larger when
 * formative. The era band runs under the sticky year header, the story year
 * is a line, the chapter being written a band. Clicking an empty spot in a
 * row opens a small form to add an event there; a marker opens on click,
 * drags along its row, and moves with the arrow keys (Shift for the end).
 */
export function WorldEventsGrid(props: {
  events: GridEvent[];
  categories: CategoryItem[];
  eras: GridEra[];
  span: YearSpan;
  zoom: Zoom;
  storyYear: number;
  writing: { from: number; to: number; label: string } | null;
  selectedId: string | null;
  readOnly: boolean;
  onOpen: (id: string) => void;
  onOpenEra: (id: string) => void;
  /** Move an event by whole years: the whole span, or only its end. */
  onMove: (id: string, delta: number, part: 'span' | 'end') => Promise<void>;
  onCreate: (e: NewEvent) => Promise<void>;
}) {
  const { events, storyYear } = props;
  const scroller = useRef<HTMLDivElement>(null);
  const [viewWidth, setViewWidth] = useState(0);
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const [tip, setTip] = useState<{ id: string; left: number; top: number } | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const suppressClick = useRef(false);
  const scrolledFor = useRef<string | null>(null);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => setViewWidth(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const trackView = Math.max(120, viewWidth - LABEL_W - 2);
  const scale = useMemo(
    () => makeScale(props.span, zoomPpy(props.zoom, trackView, props.span)),
    [props.span, props.zoom, trackView],
  );

  const byId = useMemo(() => new Map(events.map((e) => [e.id, e])), [events]);
  const rows = useMemo(
    () =>
      buildGroups(
        props.categories,
        events.map((e) => e.categoryId),
        closed,
      ),
    [props.categories, events, closed],
  );
  const rowLabel = useMemo(() => {
    const m = new Map<string, string>();
    for (const g of rows.groups) {
      for (const r of g.rows) m.set(r.key, r.own && r.label === 'General' ? g.label : r.label);
    }
    return m;
  }, [rows]);
  const items = useMemo<GridItem[]>(
    () =>
      events.map((e) => ({
        id: e.id,
        row: rows.rowOf.get(e.categoryId) ?? e.categoryId,
        startYear: e.startYear,
        endYear: e.endYear,
        big: e.formative,
        label: e.title,
      })),
    [events, rows],
  );
  const layout = useMemo(() => layoutGrid(rows.groups, items, scale), [rows, items, scale]);
  const metrics = layout.metrics;
  /** Every marker in reading order: row by row, year by year. */
  const order = useMemo(
    () =>
      layout.lines.flatMap((l) =>
        (l.kind === 'row' ? l.layout.markers : (l.merged?.markers ?? [])).map((m) => m.id),
      ),
    [layout],
  );
  const [current, setCurrent] = useState<string | null>(null);
  /** The marker that holds the grid's one Tab stop: the last focused, else the first. */
  const active = current !== null && order.includes(current) ? current : order[0];

  // A vertical scrollbar that comes or goes with the rows narrows the panel without resizing it.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && el.clientWidth !== viewWidth) setViewWidth(el.clientWidth);
  }, [layout.height, viewWidth]);

  // Open scrolled so the story year is in view, and again when the zoom changes.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || viewWidth === 0) return;
    const key = `${props.zoom}`;
    if (scrolledFor.current === key) return;
    scrolledFor.current = key;
    el.scrollLeft = scrollToYear(scale, storyYear, trackView);
  }, [scale, storyYear, trackView, viewWidth, props.zoom]);

  useEffect(() => {
    if (!draft) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDraft(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [draft]);

  const toggleGroup = (id: string) =>
    setClosed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const openDraft = (rowKey: string, year: number, top: number) => {
    if (props.readOnly) return;
    const left = Math.min(
      LABEL_W + yearMid(scale, year),
      Math.max(LABEL_W, LABEL_W + layout.width - 280),
    );
    setDraft({ rowKey, rowLabel: rowLabel.get(rowKey) ?? rowKey, year, left, top });
  };

  const onTrackClick = (e: ReactMouseEvent<HTMLDivElement>, rowKey: string, top: number) => {
    if (e.target !== e.currentTarget) return;
    const x = e.clientX - e.currentTarget.getBoundingClientRect().left;
    openDraft(rowKey, yearAt(scale, x), top);
  };

  const describe = (e: GridEvent) =>
    [
      e.title,
      span(e.startYear, e.endYear),
      rowLabel.get(rows.rowOf.get(e.categoryId) ?? e.categoryId) ?? e.categoryId,
      e.regions.join(', '),
      e.formative ? 'formative' : '',
    ]
      .filter(Boolean)
      .join(', ');

  const onPointerDown = (ev: ReactPointerEvent<HTMLButtonElement>, id: string) => {
    // A new press starts fresh: a drag that ended with no click never swallows this one.
    suppressClick.current = false;
    if (ev.button !== 0 || props.readOnly) return;
    ev.currentTarget.setPointerCapture(ev.pointerId);
    setDrag({ id, pointerId: ev.pointerId, startX: ev.clientX, moved: false, delta: 0 });
  };
  const onPointerMove = (ev: ReactPointerEvent<HTMLButtonElement>) => {
    if (!drag || ev.pointerId !== drag.pointerId) return;
    const dx = ev.clientX - drag.startX;
    const e = byId.get(drag.id);
    if (!e) return;
    const moved = drag.moved || Math.abs(dx) > 3;
    const delta = shiftSpan(e.startYear, e.endYear, dragYears(dx, scale.ppy), scale).delta;
    if (moved !== drag.moved || delta !== drag.delta) setDrag({ ...drag, moved, delta });
  };
  const onPointerUp = (ev: ReactPointerEvent<HTMLButtonElement>) => {
    if (!drag || ev.pointerId !== drag.pointerId) return;
    const d = drag;
    setDrag(null);
    if (!d.moved) return;
    // The click that follows this release (if any) is part of the drag; nothing after it is.
    suppressClick.current = true;
    setTimeout(() => {
      suppressClick.current = false;
    }, 0);
    if (d.delta !== 0) void props.onMove(d.id, d.delta, 'span');
  };

  const focusMarker = (id: string) => {
    setCurrent(id);
    scroller.current
      ?.querySelector<HTMLElement>(`.wg-marker[data-id="${CSS.escape(id)}"]`)
      ?.focus();
  };

  const onMarkerKey = (ev: ReactKeyboardEvent<HTMLButtonElement>, id: string) => {
    if (ev.key === 'Escape') {
      setTip(null);
      return;
    }
    // One Tab stop for every marker: Up and Down walk them in reading order, Home and End jump.
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
      focusMarker(to);
      return;
    }
    if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
    ev.preventDefault();
    if (props.readOnly) return;
    void props.onMove(id, ev.key === 'ArrowRight' ? 1 : -1, ev.shiftKey ? 'end' : 'span');
  };

  const marker = (m: PlacedMarker, laneTop: number) => {
    const e = byId.get(m.id);
    if (!e) return null;
    const dragging = drag?.id === m.id && drag.moved;
    const shift = dragging ? drag.delta * scale.ppy : 0;
    const size = m.bar ? (m.big ? 12 : 8) : m.width;
    const top = laneTop + m.lane * metrics.lane + (metrics.lane - size) / 2;
    const liveYear = dragging ? m.startYear + drag.delta : null;
    return (
      <button
        key={m.id}
        type="button"
        className={`wg-marker${m.bar ? ' bar' : ' dot'}${m.big ? ' big' : ''}${props.selectedId === m.id ? ' selected' : ''}${dragging ? ' dragging' : ''}`}
        style={{ left: m.x + shift, top, width: m.width, height: size }}
        data-id={m.id}
        data-year={m.startYear}
        data-end-year={m.endYear}
        aria-label={describe(e)}
        aria-current={props.selectedId === m.id ? 'true' : undefined}
        tabIndex={m.id === active ? 0 : -1}
        onClick={() => {
          if (suppressClick.current) {
            suppressClick.current = false;
            return;
          }
          props.onOpen(m.id);
        }}
        onPointerDown={(ev) => onPointerDown(ev, m.id)}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => setDrag(null)}
        onKeyDown={(ev) => onMarkerKey(ev, m.id)}
        onMouseEnter={() => setTip({ id: m.id, left: m.x, top })}
        onMouseLeave={() => setTip((t) => (t?.id === m.id ? null : t))}
        onFocus={() => {
          setCurrent(m.id);
          setTip({ id: m.id, left: m.x, top });
        }}
        onBlur={() => setTip((t) => (t?.id === m.id ? null : t))}
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
  };

  const track = (l: RowLayout, onClick?: (e: ReactMouseEvent<HTMLDivElement>) => void) => (
    <div
      className={`wg-track${onClick && !props.readOnly ? ' addable' : ''}`}
      style={{ width: layout.width }}
      onClick={onClick}
    >
      {l.markers.map((m) => marker(m, metrics.rowPad))}
    </div>
  );

  const tipEvent = tip ? byId.get(tip.id) : undefined;
  const ticks = tickYears(scale);
  const storyX =
    storyYear >= scale.from && storyYear <= scale.to ? yearMid(scale, storyYear) : null;
  const band = props.writing ? spanExtent(scale, props.writing.from, props.writing.to) : null;

  return (
    <div
      className="wg-scroll"
      ref={scroller}
      data-testid="world-grid"
      data-ppy={scale.ppy}
      data-from={scale.from}
      data-to={scale.to}
      style={{ ['--wg-label' as string]: `${LABEL_W}px` }}
    >
      <div className="wg-canvas" style={{ width: LABEL_W + layout.width, height: layout.height }}>
        <div className="wg-head" style={{ height: metrics.header }}>
          <div className="wg-corner">
            <span>Category</span>
            <span className="wg-corner-sub">Era</span>
          </div>
          <div className="wg-years" style={{ width: layout.width }} aria-hidden="true">
            {ticks.map((y) => (
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
        {layout.lines.map((line) =>
          line.kind === 'group' ? (
            <div
              key={`g:${line.group.id}`}
              className={`wg-line wg-group${line.group.open ? '' : ' closed'}`}
              style={{ height: line.height }}
              data-group={line.group.id}
            >
              <button
                type="button"
                className="wg-label wg-group-label"
                aria-expanded={line.group.open}
                onClick={() => toggleGroup(line.group.id)}
              >
                <span className="wg-caret" aria-hidden="true">
                  {line.group.open ? '▾' : '▸'}
                </span>
                {line.group.label}
              </button>
              {line.merged ? (
                track(line.merged)
              ) : (
                <div className="wg-track wg-group-track" style={{ width: layout.width }} />
              )}
            </div>
          ) : (
            <div
              key={`r:${line.row.key}`}
              className="wg-line wg-row"
              style={{ height: line.height }}
              data-row={line.row.key}
              data-group={line.row.groupId}
            >
              <button
                type="button"
                className="wg-label wg-row-label"
                aria-label={`${line.row.label}, add an event in ${storyYear}`}
                disabled={props.readOnly}
                onClick={() => openDraft(line.row.key, storyYear, line.y + line.height)}
              >
                {line.row.label}
              </button>
              {track(line.layout, (e) => onTrackClick(e, line.row.key, line.y + line.height))}
            </div>
          ),
        )}
        <div
          className="wg-overlay"
          style={{ left: LABEL_W, top: metrics.header, height: layout.height - metrics.header }}
          aria-hidden="true"
        >
          {band && props.writing && (
            <div
              className="wg-writing"
              style={{ left: band.x, width: band.width }}
              data-testid="grid-writing"
              data-from={props.writing.from}
              data-to={props.writing.to}
              title={props.writing.label}
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
        {tip && tipEvent && !drag?.moved && (
          <TipFor
            event={tipEvent}
            left={Math.min(LABEL_W + tip.left, LABEL_W + layout.width - 300)}
            top={(layout.lines.find((l) => lineHas(l, tip.id))?.y ?? 0) + tip.top + 24}
            where={rowLabel.get(rows.rowOf.get(tipEvent.categoryId) ?? tipEvent.categoryId) ?? ''}
          />
        )}
        {draft && (
          <AddForm
            draft={draft}
            span={scale}
            onCancel={() => setDraft(null)}
            onSave={async (n) => {
              await props.onCreate({ ...n, categoryId: draft.rowKey });
              setDraft(null);
            }}
          />
        )}
      </div>
    </div>
  );
}

function lineHas(l: ReturnType<typeof layoutGrid>['lines'][number], id: string): boolean {
  const markers = l.kind === 'row' ? l.layout.markers : (l.merged?.markers ?? []);
  return markers.some((m) => m.id === id);
}

function TipFor(props: { event: GridEvent; left: number; top: number; where: string }) {
  const e = props.event;
  return (
    <div
      className="tooltip wg-tip"
      role="tooltip"
      style={{ left: Math.max(0, props.left), top: props.top }}
      data-testid="grid-tip"
    >
      <strong>
        {span(e.startYear, e.endYear)} {e.title}
      </strong>
      <br />
      {props.where}
      {e.regions.length ? `. ${e.regions.join(', ')}` : ''}
      {e.formative ? '. Formative' : ''}
    </div>
  );
}

/** The small form an empty-spot click opens: title, year, end year, formative. */
function AddForm(props: {
  draft: Draft;
  span: YearSpan;
  onCancel: () => void;
  onSave: (n: Omit<NewEvent, 'categoryId'>) => Promise<void>;
}) {
  const { draft } = props;
  const ids = { title: useId(), year: useId(), end: useId(), formative: useId() };
  const [title, setTitle] = useState('');
  const [year, setYear] = useState(String(draft.year));
  const [end, setEnd] = useState('');
  const [formative, setFormative] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const first = useRef<HTMLInputElement>(null);

  useEffect(() => {
    first.current?.focus();
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const y = Number(year);
    const t = title.trim();
    if (!t) return setError('Give the event a title.');
    if (!Number.isInteger(y)) return setError('The year is a whole number, such as 2042.');
    const endYear = end.trim() === '' ? null : Number(end);
    if (endYear !== null && !Number.isInteger(endYear)) {
      return setError('The end year is a whole number, or leave it blank.');
    }
    setBusy(true);
    setError(null);
    try {
      await props.onSave({ title: t, year: y, endYear, formative });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <form
      className="wg-add stack tight"
      role="dialog"
      aria-label={`New world event in ${draft.rowLabel}`}
      data-testid="grid-add"
      style={{ left: draft.left, top: draft.top }}
      onSubmit={(e) => void submit(e)}
    >
      <strong>New event in {draft.rowLabel}</strong>
      <div className="field">
        <label htmlFor={ids.title}>Title</label>
        <input
          id={ids.title}
          ref={first}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </div>
      <div className="wg-add-years">
        <div className="field">
          <label htmlFor={ids.year}>Year</label>
          <input
            id={ids.year}
            type="number"
            inputMode="numeric"
            value={year}
            onChange={(e) => setYear(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor={ids.end}>End year</label>
          <input
            id={ids.end}
            type="number"
            inputMode="numeric"
            value={end}
            placeholder="None"
            onChange={(e) => setEnd(e.target.value)}
          />
        </div>
      </div>
      <label className="wg-add-check" htmlFor={ids.formative}>
        <input
          id={ids.formative}
          type="checkbox"
          checked={formative}
          onChange={(e) => setFormative(e.target.checked)}
        />
        Formative
      </label>
      {error && (
        <p className="callout crit" role="alert">
          {error}
        </p>
      )}
      <span className="row tight">
        <button type="submit" className="btn small primary" disabled={busy}>
          Save
        </button>
        <button type="button" className="btn small" onClick={props.onCancel}>
          Cancel
        </button>
      </span>
    </form>
  );
}
