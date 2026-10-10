import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import type { Response } from '../../../../shared/ipc';
import type { EntryCollection } from '../../../../shared/schema';
import { coverageMessages } from '../../../../shared/domain/timeline';
import { itemPath } from '../../../../shared/domain/lists';
import { call } from '../../api';
import { useEntries, useList, useStore } from '../data';
import { EmbeddedEditor, UndoPanel } from '../editor';
import { useStoryTime } from '../storyTime';
import { span, useFamilies } from './common';

type Chart = Response<'timeline.chart'>;

/** Pixels per year, and the lanes from the top. */
const PPY = 12;
const LEFT = 16;
const RIGHT = 24;
const ERA_Y = 26;
const ERA_H = 24;
const EVENT_ROWS = 3;
const ROW = 16;
const LIFE_H = 8;
/** Each lifespan row: the bar, then its direct label under it. */
const LIFE_ROW = 26;

interface Mark {
  key: string;
  kind: 'era' | 'event' | 'strand' | 'life';
  collection: EntryCollection;
  id: string;
  label: string;
  /** Plain words for the tooltip and the screen reader. */
  tip: ReactNode;
  aria: string;
  x: number;
  y: number;
  node: ReactNode;
}

interface Filters {
  familyId: string | null;
  placeId: string | null;
  status: string | null;
  categoryId: string | null;
}

const NONE: Filters = { familyId: null, placeId: null, status: null, categoryId: null };

/**
 * The timeline (TL-6): one horizontal axis with era bands, world events,
 * chapter strands, and lifespans; filters for family, place, status, and
 * category; the story-time cursor; and editing in the inspector. Arrow keys
 * move between marks and Enter opens one (NF-2).
 */
export function TimelineView() {
  const { version } = useStore();
  const story = useStoryTime();
  const year = story.year;
  const families = useFamilies();
  const familyList = useEntries('families');
  const places = useEntries('places');
  const categories = useList('eventCategories');
  const [filters, setFilters] = useState<Filters>(NONE);
  const [chart, setChart] = useState<Chart | null>(null);
  const [selected, setSelected] = useState<{ collection: EntryCollection; id: string } | null>(
    null,
  );
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [tip, setTip] = useState<{ x: number; y: number; body: ReactNode } | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const scrolled = useRef(false);
  const ids = { family: useId(), place: useId(), status: useId(), category: useId() };

  useEffect(() => {
    let live = true;
    void call('timeline.chart', { filters }).then((r) => {
      if (live) setChart(r);
    });
    return () => {
      live = false;
    };
  }, [filters, version]);

  const range = useMemo(() => {
    const ys: number[] = [year, 2025, 2100];
    for (const e of chart?.eras ?? []) ys.push(e.startYear, e.endYear);
    for (const e of chart?.events ?? []) ys.push(e.startYear, e.endYear);
    for (const s of chart?.strands ?? []) ys.push(s.startYear, s.endYear);
    for (const l of chart?.lifespans ?? []) ys.push(l.birthYear, l.deathYear ?? l.birthYear);
    const lo = Math.floor((Math.min(...ys) - 2) / 10) * 10;
    const hi = Math.ceil((Math.max(...ys) + 2) / 10) * 10;
    return { lo, hi };
  }, [chart, year]);

  const x = useCallback((y: number) => LEFT + (y - range.lo) * PPY, [range.lo]);
  const mid = useCallback((y: number) => x(y) + PPY / 2, [x]);

  const layout = useMemo(() => {
    if (!chart) return null;
    const marks: Mark[] = [];
    const eventY = ERA_Y + ERA_H + 30;
    const chapterY = eventY + EVENT_ROWS * ROW + 26;
    const strandRows = new Map<string, number>();
    for (const s of chart.strands) {
      if (!strandRows.has(s.chapterId)) strandRows.set(s.chapterId, strandRows.size);
    }
    const chapterRows = Math.max(1, Math.min(strandRows.size, 12));
    const lifeY = chapterY + chapterRows * 20 + 30;
    const height = lifeY + chart.lifespans.length * LIFE_ROW + 44;
    const width = x(range.hi) + RIGHT;

    for (const e of chart.eras) {
      const x0 = x(e.startYear);
      const w = Math.max(x(e.endYear + 1) - x0 - 2, 6);
      marks.push({
        key: `era:${e.id}`,
        kind: 'era',
        collection: 'eraStates',
        id: e.id,
        label: e.name,
        aria: `Era ${e.name}, ${span(e.startYear, e.endYear)}`,
        tip: (
          <>
            <strong>{e.name}</strong>
            <br />
            {span(e.startYear, e.endYear)}
          </>
        ),
        x: x0,
        y: ERA_Y,
        node: (
          <>
            <rect className="tl-era" x={x0} y={ERA_Y} width={w} height={ERA_H} rx={3} />
            {w > 40 && (
              <text className="tl-text" x={x0 + 5} y={ERA_Y + 16}>
                {e.name.length * 6.5 > w - 8
                  ? `${e.name.slice(0, Math.max(1, Math.floor((w - 8) / 6.5) - 1))}...`
                  : e.name}
              </text>
            )}
          </>
        ),
      });
    }
    const perYear = new Map<number, number>();
    for (const e of chart.events) {
      const n = perYear.get(e.startYear) ?? 0;
      perYear.set(e.startYear, n + 1);
      const cy = eventY + (n % EVENT_ROWS) * ROW;
      const cx = mid(e.startYear);
      const x1 = mid(e.endYear);
      const where = e.regions.join(', ') || 'no region';
      marks.push({
        key: `event:${e.id}`,
        kind: 'event',
        collection: 'worldEvents',
        id: e.id,
        label: e.title,
        aria: `World event ${e.title}, ${span(e.startYear, e.endYear)}, ${e.categoryPath}, ${where}${e.formative ? ', formative' : ''}`,
        tip: (
          <>
            <strong>
              {span(e.startYear, e.endYear)} {e.title}
            </strong>
            <br />
            {e.categoryPath}. {where}
            {e.formative ? '. Formative' : ''}
          </>
        ),
        x: cx,
        y: cy,
        node: (
          <>
            {x1 > cx && <line className="tl-ev-range" x1={cx} y1={cy} x2={x1} y2={cy} />}
            <circle
              className={`tl-ev-dot${e.formative ? ' formative' : ''}`}
              cx={cx}
              cy={cy}
              r={5}
            />
            <circle cx={cx} cy={cy} r={9} fill="transparent" />
          </>
        ),
      });
    }
    const byChapter = new Map<string, Chart['strands']>();
    for (const s of chart.strands) {
      const list = byChapter.get(s.chapterId) ?? [];
      list.push(s);
      byChapter.set(s.chapterId, list);
    }
    for (const [chapterId, list] of byChapter) {
      const row = (strandRows.get(chapterId) ?? 0) % chapterRows;
      const cy = chapterY + row * 20 + 8;
      const primary = list.find((s) => s.primary) ?? list[0];
      if (!primary) continue;
      const others = list.filter((s) => s !== primary);
      const joins = others.map((o) => (
        <line
          key={`join-${o.strandId}`}
          className="tl-chap-link"
          x1={mid(primary.startYear)}
          y1={cy}
          x2={mid(o.startYear)}
          y2={cy}
        />
      ));
      for (const s of list) {
        const cx = mid(s.startYear);
        const isPrimary = s === primary;
        marks.push({
          key: `strand:${chapterId}:${s.strandId}`,
          kind: 'strand',
          collection: 'chapters',
          id: chapterId,
          label: `${s.chapterTitle}, ${s.label}`,
          aria: `Chapter ${s.readingOrder ?? ''} ${s.chapterTitle}, ${s.label} strand, ${span(s.startYear, s.endYear)}${isPrimary ? ', primary' : ''}, ${s.chapterStatus}`,
          tip: (
            <>
              <strong>
                Chapter {s.readingOrder ?? '?'}: {s.chapterTitle}
              </strong>
              <br />
              {s.label}, {span(s.startYear, s.endYear)}
              {isPrimary ? ' (primary)' : ' (not primary)'}. {s.chapterStatus}
            </>
          ),
          x: cx,
          y: cy,
          node: (
            <>
              {isPrimary && joins}
              {isPrimary ? (
                <rect className="tl-chap-p" x={cx - 4} y={cy - 8} width={8} height={16} rx={2} />
              ) : (
                <rect className="tl-chap-b" x={cx - 4} y={cy - 4} width={8} height={8} rx={2} />
              )}
            </>
          ),
        });
      }
    }
    chart.lifespans.forEach((l, i) => {
      const y = lifeY + i * LIFE_ROW;
      const x0 = x(l.birthYear);
      const x1 = x(l.deathYear !== null ? l.deathYear + 1 : range.hi);
      const w = Math.max(x1 - x0, 3);
      const colors = l.familyIds.map((f) => families.get(f)?.color ?? 'series-4');
      const stripes = colors.length ? colors : ['none'];
      const life =
        l.deathYear === null ? `born ${l.birthYear}` : `${l.birthYear} to ${l.deathYear}`;
      const fams = l.familyIds.map((f) => families.get(f)?.name ?? f).join(' and ') || 'no family';
      marks.push({
        key: `life:${l.id}`,
        kind: 'life',
        collection: 'characters',
        id: l.id,
        label: l.name,
        aria: `${l.name}, ${life}, ${fams}, ${l.status}`,
        tip: (
          <>
            <strong>{l.name}</strong> {life}
            <br />
            {fams}. {l.status}
          </>
        ),
        x: x0,
        y: y + 2,
        node: (
          <>
            {stripes.map((c, k) => (
              <rect
                key={k}
                className={`tl-life fam-${c}`}
                x={x0}
                y={y + 2 + (k * LIFE_H) / stripes.length}
                width={w}
                height={LIFE_H / stripes.length}
                data-family={c}
              />
            ))}
            <text className="tl-text" x={x0 + 4} y={y + 2 + LIFE_H + 10}>
              {l.name}
            </text>
          </>
        ),
      });
    });
    return { marks, width, height, eventY, chapterY, lifeY };
  }, [chart, x, mid, range.hi, families]);

  const marks = useMemo(() => layout?.marks ?? [], [layout]);
  const active = focusKey && marks.some((m) => m.key === focusKey) ? focusKey : marks[0]?.key;

  // Start scrolled to the story time.
  useLayoutEffect(() => {
    if (!layout || scrolled.current || !wrap.current) return;
    scrolled.current = true;
    wrap.current.scrollLeft = Math.max(0, mid(year) - wrap.current.clientWidth / 2);
  }, [layout, mid, year]);

  const open = (m: Mark) => {
    setSelected({ collection: m.collection, id: m.id });
    setFocusKey(m.key);
  };
  const showTip = (m: Mark) => setTip({ x: m.x, y: m.y, body: m.tip });

  const onMarkKey = (e: ReactKeyboardEvent, i: number) => {
    const m = marks[i];
    if (!m) return;
    let next: number | null = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = Math.min(marks.length - 1, i + 1);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = Math.max(0, i - 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = marks.length - 1;
    else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      open(m);
      return;
    } else if (e.key === 'Escape') {
      setTip(null);
      return;
    }
    if (next === null) return;
    e.preventDefault();
    const target = marks[next];
    if (!target) return;
    setFocusKey(target.key);
    const el = wrap.current?.querySelector<SVGGElement>(`[data-key="${CSS.escape(target.key)}"]`);
    el?.focus();
  };

  const set = (k: keyof Filters, v: string) => setFilters((f) => ({ ...f, [k]: v || null }));
  const statuses = useList('statuses')?.items ?? [];
  const coverage = chart ? coverageMessages(chart.coverage) : [];

  return (
    <div className="ws-tree-area" data-testid="timeline-view">
      <section className="tree-main stack" aria-labelledby="timeline-title">
        <div className="list-head">
          <h2 id="timeline-title">Timeline</h2>
          <span className="row tight">
            <span className="chip time" data-testid="timeline-time">
              Story time {year}
            </span>
            <button type="button" className="btn small" onClick={story.openDialog}>
              Change
            </button>
          </span>
        </div>
        <p className="example-note">
          Eras, world events, chapter strands, and lifespans on one axis. Hover or focus a mark for
          detail. Click it, or press Enter, to edit it in the inspector. Arrow keys move between
          marks.
        </p>
        <div className="tree-toolbar tl-filters" role="group" aria-label="Timeline filters">
          <div className="field">
            <label htmlFor={ids.family}>Family</label>
            <select
              id={ids.family}
              value={filters.familyId ?? ''}
              onChange={(e) => set('familyId', e.target.value)}
            >
              <option value="">All families</option>
              {familyList.map((f) => (
                <option key={f._id} value={f._id}>
                  {String(f.name)}
                </option>
              ))}
              <option value="none">No family</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor={ids.place}>Place</label>
            <select
              id={ids.place}
              value={filters.placeId ?? ''}
              onChange={(e) => set('placeId', e.target.value)}
            >
              <option value="">All places</option>
              {places.map((p) => (
                <option key={p._id} value={p._id}>
                  {String(p.title)}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor={ids.status}>Status</label>
            <select
              id={ids.status}
              value={filters.status ?? ''}
              onChange={(e) => set('status', e.target.value)}
            >
              <option value="">All statuses</option>
              {statuses.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor={ids.category}>Category</label>
            <select
              id={ids.category}
              value={filters.categoryId ?? ''}
              onChange={(e) => set('categoryId', e.target.value)}
            >
              <option value="">All categories</option>
              {(categories?.items ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {categories ? itemPath(categories, c.id) : c.label}
                </option>
              ))}
            </select>
          </div>
          {filters !== NONE && (
            <button type="button" className="btn small" onClick={() => setFilters(NONE)}>
              Clear filters
            </button>
          )}
        </div>
        {!chart || !layout ? (
          <p aria-live="polite">Loading the timeline.</p>
        ) : (
          <>
            <div className="tl-frame">
              <div className="tl-wrap" ref={wrap} onMouseLeave={() => setTip(null)}>
                <svg
                  className="tl-svg"
                  width={layout.width}
                  height={layout.height}
                  viewBox={`0 0 ${layout.width} ${layout.height}`}
                  role="group"
                  aria-label={`Timeline from ${range.lo} to ${range.hi}, story time ${year}`}
                  data-testid="timeline-svg"
                >
                  {Array.from({ length: (range.hi - range.lo) / 10 + 1 }, (_, k) => {
                    const y = range.lo + k * 10;
                    return (
                      <g key={y}>
                        <line
                          className="tl-grid"
                          x1={x(y)}
                          y1={ERA_Y}
                          x2={x(y)}
                          y2={layout.height - 28}
                        />
                        <text
                          className="tl-text sec num"
                          x={x(y)}
                          y={layout.height - 10}
                          textAnchor="middle"
                        >
                          {y}
                        </text>
                      </g>
                    );
                  })}
                  <line
                    className="tl-axis"
                    x1={LEFT}
                    y1={layout.height - 28}
                    x2={layout.width - RIGHT}
                    y2={layout.height - 28}
                  />
                  {marks.map((m, i) => (
                    <g
                      key={m.key}
                      className={`tl-mark ${m.kind}${selected?.id === m.id && selected.collection === m.collection ? ' selected' : ''}`}
                      data-key={m.key}
                      data-kind={m.kind}
                      data-id={m.id}
                      role="button"
                      tabIndex={m.key === active ? 0 : -1}
                      aria-label={m.aria}
                      onClick={() => open(m)}
                      onMouseEnter={() => showTip(m)}
                      onFocus={() => {
                        setFocusKey(m.key);
                        showTip(m);
                      }}
                      onBlur={() => setTip(null)}
                      onKeyDown={(e) => onMarkKey(e, i)}
                    >
                      {m.node}
                    </g>
                  ))}
                  <line
                    className="tl-cursor"
                    x1={mid(year)}
                    y1={ERA_Y - 18}
                    x2={mid(year)}
                    y2={layout.height - 28}
                    data-testid="timeline-cursor"
                    data-year={year}
                  />
                  <text className="tl-text tl-cursor-label num" x={mid(year) + 5} y={ERA_Y - 16}>
                    story time {year}
                  </text>
                </svg>
                {tip && (
                  <div
                    className="tooltip"
                    role="tooltip"
                    style={{ left: Math.max(0, tip.x - 20), top: tip.y + 16 }}
                    data-testid="timeline-tip"
                  >
                    {tip.body}
                  </div>
                )}
              </div>
              <div className="tl-lanes" aria-hidden="true">
                {(
                  [
                    ['Eras', ERA_Y - 20],
                    ['World events', layout.eventY - 26],
                    ['Chapter strands', layout.chapterY - 24],
                    ['Lifespans', layout.lifeY - 20],
                  ] as const
                ).map(([t, y]) => (
                  <span key={t} style={{ top: y }}>
                    {t}
                  </span>
                ))}
              </div>
            </div>
            <div className="legend" aria-label="Timeline legend">
              {familyList.map((f) => (
                <span key={f._id}>
                  <span className={`sw fam-${String(f.color || 'series-4')}`} />
                  {String(f.name)} lifespan
                </span>
              ))}
              <span>
                <span className="sw fam-none" />
                No family
              </span>
              <span>
                <svg className="ln" width="12" height="12" aria-hidden="true">
                  <circle className="tl-ev-dot" cx="6" cy="6" r="5" />
                </svg>
                World event
              </span>
              <span>
                <svg className="ln" width="12" height="12" aria-hidden="true">
                  <circle className="tl-ev-dot formative" cx="6" cy="6" r="4.5" />
                </svg>
                Formative event (ringed)
              </span>
              <span>
                <svg className="ln" width="10" height="16" aria-hidden="true">
                  <rect className="tl-chap-p" x="1" y="0" width="8" height="16" rx="2" />
                </svg>
                Primary strand
              </span>
              <span>
                <svg className="ln" width="12" height="12" aria-hidden="true">
                  <rect className="tl-chap-b" x="2" y="2" width="8" height="8" rx="2" />
                </svg>
                Other strand, joined to its chapter
              </span>
              <span>
                <svg className="ln" width="6" height="16" aria-hidden="true">
                  <line className="tl-cursor" x1="3" y1="0" x2="3" y2="16" />
                </svg>
                Story time
              </span>
            </div>
            {chart.undrawn.length > 0 && (
              <p className="example-note" data-testid="timeline-undrawn">
                Not drawn, birth unknown: {chart.undrawn.map((u) => u.name).join(', ')}.
              </p>
            )}
          </>
        )}
      </section>
      <aside
        className="inspector tree-inspector"
        aria-label="Timeline inspector"
        data-testid="timeline-inspector"
      >
        <span className="eyebrow">Inspector</span>
        {coverage.length > 0 && (
          <div className="callout warn stack tight" data-testid="timeline-coverage">
            <strong>Era coverage</strong>
            {coverage.map((c) => (
              <span key={c}>{c}</span>
            ))}
          </div>
        )}
        {selected ? (
          <>
            <button type="button" className="btn small" onClick={() => setSelected(null)}>
              Close the editor
            </button>
            <EmbeddedEditor
              key={`${selected.collection}:${selected.id}`}
              collection={selected.collection}
              id={selected.id}
            />
          </>
        ) : (
          <p className="example-note">Pick a mark on the timeline to edit it here.</p>
        )}
        <UndoPanel />
      </aside>
    </div>
  );
}
