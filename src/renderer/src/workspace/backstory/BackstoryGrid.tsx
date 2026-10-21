import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
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
import type { PlacedMarker, RowLayout, YearSpan, Zoom } from '../../../../shared/domain/worldGrid';
import {
  NO_FAMILY,
  ageText,
  layoutBackstory,
  lifespanBar,
  lifespanOf,
  momentLabel,
} from '../../../../shared/domain/backstoryGrid';
import type {
  BackstoryGrid as Grid,
  BackstoryMoment,
  BackstoryPerson,
  WritingBand,
} from '../../../../shared/domain/backstoryGrid';
import { lifeYears } from '../../../../shared/domain/ages';
import { span } from '../timeline/common';
import '../timeline/grid.css';
import './backstory.css';

/** Width of the sticky row label column. */
const LABEL_W = 220;

export interface GridEra {
  id: string;
  name: string;
  startYear: number;
  endYear: number;
}

interface Drag {
  id: string;
  pointerId: number;
  startX: number;
  moved: boolean;
  delta: number;
}

/**
 * SM-9: the Backstory grid. The World events grid's axis, sticky year header,
 * era band, story year line, writing band and marker lanes (`worldGrid.ts`,
 * `grid.css`), with one row per character under a collapsible heading per
 * family, a lifespan bar in the family colour, and a marker per moment.
 */
export function BackstoryGrid(props: {
  grid: Grid;
  eras: GridEra[];
  span: YearSpan;
  zoom: Zoom;
  storyYear: number;
  writing: WritingBand | null;
  pickedId: string | null;
  selectedMomentId: string | null;
  readOnly: boolean;
  onPick: (characterId: string) => void;
  onPickMoment: (momentId: string, characterId: string) => void;
  onMove: (momentId: string, delta: number) => Promise<void>;
  onCreate: (characterId: string, year: number) => Promise<void>;
}) {
  const { grid, storyYear } = props;
  const scroller = useRef<HTMLDivElement>(null);
  const [viewWidth, setViewWidth] = useState(0);
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const [tip, setTip] = useState<{ id: string; left: number; top: number } | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
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
  const layout = useMemo(() => layoutBackstory(grid, scale, closed), [grid, scale, closed]);
  const metrics = layout.metrics;
  const byId = useMemo(() => new Map(grid.moments.map((m) => [m.id, m])), [grid.moments]);
  const colorOf = useMemo(
    () => new Map(grid.families.map((f) => [f.id, f.color] as const)),
    [grid.families],
  );
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

  const toggleFamily = (id: string) =>
    setClosed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const onTrackClick = (e: ReactMouseEvent<HTMLDivElement>, characterId: string) => {
    if (e.target !== e.currentTarget || props.readOnly) return;
    const x = e.clientX - e.currentTarget.getBoundingClientRect().left;
    void props.onCreate(characterId, yearAt(scale, x));
  };

  const personOf = (m: BackstoryMoment): BackstoryPerson | undefined =>
    grid.people.get(m.characterId);

  const describe = (m: BackstoryMoment) => {
    const p = personOf(m);
    const age = p ? ageText(p, m.year) : '';
    return [
      momentLabel(m),
      span(m.year, m.endYear ?? m.year),
      p ? `${p.name}${/^\d+$/.test(age) ? `, age ${age}` : ''}` : '',
    ]
      .filter(Boolean)
      .join(', ');
  };

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
    const m = byId.get(drag.id);
    if (!m) return;
    const moved = drag.moved || Math.abs(dx) > 3;
    const delta = shiftSpan(m.year, m.endYear ?? m.year, dragYears(dx, scale.ppy), scale).delta;
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
    if (d.delta !== 0) void props.onMove(d.id, d.delta);
  };

  const focusMarker = (id: string) => {
    setCurrent(id);
    scroller.current
      ?.querySelector<HTMLElement>(`.bs-marker[data-id="${CSS.escape(id)}"]`)
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
    void props.onMove(id, ev.key === 'ArrowRight' ? 1 : -1);
  };

  const marker = (m: PlacedMarker) => {
    const mo = byId.get(m.id);
    if (!mo) return null;
    const dragging = drag?.id === m.id && drag.moved;
    const shift = dragging ? drag.delta * scale.ppy : 0;
    const size = m.bar ? 8 : m.width;
    const top = metrics.rowPad + m.lane * metrics.lane + (metrics.lane - size) / 2;
    const liveYear = dragging ? m.startYear + drag.delta : null;
    const selected = props.selectedMomentId === m.id;
    return (
      <button
        key={m.id}
        type="button"
        className={`wg-marker bs-marker${m.bar ? ' bar' : ' dot'}${selected ? ' selected' : ''}${dragging ? ' dragging' : ''}`}
        style={{ left: m.x + shift, top, width: m.width, height: size }}
        data-id={m.id}
        data-person={mo.characterId}
        data-year={m.startYear}
        data-end-year={m.endYear}
        aria-label={describe(mo)}
        aria-current={selected ? 'true' : undefined}
        tabIndex={m.id === active ? 0 : -1}
        onClick={() => {
          if (suppressClick.current) {
            suppressClick.current = false;
            return;
          }
          props.onPickMoment(m.id, mo.characterId);
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

  const lifespan = (p: BackstoryPerson) => {
    const life = lifespanOf(p);
    const bar = lifespanBar(life, scale, storyYear);
    const color = colorOf.get(p.familyId);
    const style = {
      ['--bs-fam' as string]: color ? `var(--${color})` : 'var(--border-strong)',
    } as CSSProperties;
    if (!bar) {
      return (
        <span className="bs-life-unknown" data-testid="lifespan" data-kind={life.kind}>
          {life.kind === 'unknown' ? 'Birth year unknown' : ''}
        </span>
      );
    }
    const solid = bar.dashFrom === null ? bar.width : bar.dashFrom - bar.x;
    return (
      <span
        className="bs-life"
        data-testid="lifespan"
        data-kind={life.kind}
        data-from={life.from ?? ''}
        data-to={life.to ?? ''}
        data-dash-from={bar.dashFrom === null ? '' : storyYear + 1}
        style={{
          ...style,
          left: bar.x,
          width: bar.width,
        }}
        aria-hidden="true"
      >
        {solid > 0 && <span className="bs-life-solid" style={{ width: solid }} />}
        {bar.dashFrom !== null && (
          <span className="bs-life-dash" style={{ left: solid, width: bar.width - solid }} />
        )}
      </span>
    );
  };

  const track = (l: RowLayout, person: BackstoryPerson | null) => (
    <div
      className={`wg-track${person && !props.readOnly ? ' addable' : ''}`}
      style={{ width: layout.width }}
      onClick={person ? (e) => onTrackClick(e, person.id) : undefined}
    >
      {person && lifespan(person)}
      {l.markers.map(marker)}
    </div>
  );

  const tipMoment = tip ? byId.get(tip.id) : undefined;
  const ticks = tickYears(scale);
  const storyX =
    storyYear >= scale.from && storyYear <= scale.to ? yearMid(scale, storyYear) : null;
  const band = props.writing ? spanExtent(scale, props.writing.from, props.writing.to) : null;

  return (
    <div
      className="wg-scroll bs-scroll"
      ref={scroller}
      data-testid="backstory-grid"
      data-ppy={scale.ppy}
      data-from={scale.from}
      data-to={scale.to}
      style={{ ['--wg-label' as string]: `${LABEL_W}px` }}
    >
      <div className="wg-canvas" style={{ width: LABEL_W + layout.width, height: layout.height }}>
        <div className="wg-head" style={{ height: metrics.header }}>
          <div className="wg-corner">
            <span>Character</span>
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
          <div className="wg-eras" style={{ width: layout.width }} data-testid="era-band">
            {props.eras.map((era) => {
              if (era.endYear < scale.from || era.startYear > scale.to) return null;
              const x = spanExtent(scale, era.startYear, era.endYear);
              return (
                <span
                  key={era.id}
                  className="wg-era bs-era"
                  style={{ left: x.x, width: Math.max(2, x.width - 1) }}
                  data-id={era.id}
                  data-from={era.startYear}
                  data-to={era.endYear}
                  title={`${era.name}, ${span(era.startYear, era.endYear)}`}
                >
                  {era.name}
                </span>
              );
            })}
          </div>
        </div>
        {layout.lines.map((line) => {
          if (line.kind === 'group') {
            const fam = grid.families.find((f) => f.id === line.group.id);
            const color = fam?.color;
            return (
              <div
                key={`g:${line.group.id}`}
                className={`wg-line wg-group${line.group.open ? '' : ' closed'}`}
                style={{ height: line.height }}
                data-family={line.group.id}
              >
                <button
                  type="button"
                  className="wg-label wg-group-label"
                  aria-expanded={line.group.open}
                  onClick={() => toggleFamily(line.group.id)}
                >
                  <span className="wg-caret" aria-hidden="true">
                    {line.group.open ? '▾' : '▸'}
                  </span>
                  {line.group.id !== NO_FAMILY && (
                    <span
                      className="bs-swatch"
                      style={{ background: color ? `var(--${color})` : undefined }}
                      aria-hidden="true"
                    />
                  )}
                  {line.group.label}
                  <span className="bs-count">({fam?.people.length ?? 0})</span>
                </button>
                {line.merged ? (
                  track(line.merged, null)
                ) : (
                  <div className="wg-track wg-group-track" style={{ width: layout.width }} />
                )}
              </div>
            );
          }
          const p = grid.people.get(line.row.key);
          if (!p) return null;
          const life = lifespanOf(p);
          const picked = props.pickedId === p.id;
          return (
            <div
              key={`r:${p.id}`}
              className={`wg-line wg-row bs-row${picked ? ' picked' : ''}`}
              style={{ height: line.height }}
              data-person={p.id}
              data-family={line.row.groupId}
              data-life={life.kind}
              data-birth={life.from ?? ''}
              data-death={life.to ?? ''}
            >
              <button
                type="button"
                className="wg-label wg-row-label bs-row-label"
                aria-pressed={picked}
                aria-label={`${p.name}${p.chinese ? ` ${p.chinese}` : ''}, ${lifeYears(p)}, show their moments`}
                onClick={() => props.onPick(p.id)}
              >
                <span className="bs-name">{p.name}</span>
                {p.chinese && (
                  <span className="bs-zh" lang="zh">
                    {p.chinese}
                  </span>
                )}
              </button>
              {track(line.layout, p)}
            </div>
          );
        })}
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
        {tip && tipMoment && !drag?.moved && (
          <div
            className="tooltip wg-tip"
            role="tooltip"
            style={{
              left: Math.max(0, Math.min(LABEL_W + tip.left, LABEL_W + layout.width - 300)),
              top:
                (layout.lines.find((l) =>
                  (l.kind === 'row' ? l.layout.markers : (l.merged?.markers ?? [])).some(
                    (m) => m.id === tip.id,
                  ),
                )?.y ?? 0) +
                tip.top +
                24,
            }}
            data-testid="grid-tip"
          >
            <strong>
              {span(tipMoment.year, tipMoment.endYear ?? tipMoment.year)} {momentLabel(tipMoment)}
            </strong>
            <br />
            {describeWho(personOf(tipMoment), tipMoment.year)}
          </div>
        )}
      </div>
    </div>
  );
}

function describeWho(p: BackstoryPerson | undefined, year: number): string {
  if (!p) return '';
  const age = ageText(p, year);
  return /^\d+$/.test(age) ? `${p.name}, age ${age}` : `${p.name}, ${age.toLowerCase()}`;
}
