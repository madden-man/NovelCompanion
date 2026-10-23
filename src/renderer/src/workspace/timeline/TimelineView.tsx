import { useId, useMemo, useState } from 'react';
import { entryTitle, manifests } from '../../../../shared/schema';
import type { EntryCollection } from '../../../../shared/schema';
import { blankEntry } from '../../../../shared/domain/blank';
import {
  coverageMessages,
  eraCoverage,
  eraSpans,
  eventSpans,
  fromCollections,
  strandSpans,
} from '../../../../shared/domain/timeline';
import {
  categoryScope,
  gridSpan,
  inWindow,
  shiftEnd,
  shiftSpan,
  writingBand,
  yearWindow,
} from '../../../../shared/domain/worldGrid';
import type { Zoom } from '../../../../shared/domain/worldGrid';
import { createCommand, editCommand } from '../../../../shared/domain/undoRunner';
import { isPlainObject } from '../../../../shared/domain/paths';
import { useWriteGuard } from '../../connection';
import { call, plainError } from '../../api';
import { useEntries, useList } from '../data';
import { RowEditor } from '../rowEditor';
import { useStoryTime } from '../storyTime';
import { useUndo } from '../undo';
import { WorldEventsStrip } from './WorldEventsStrip';
import { WorldEventsGrid } from './WorldEventsGrid';
import { useEraEdits, useTitleRename } from './gridShared';
import type { GridEvent, NewEvent } from './WorldEventsGrid';
import './world.css';
import { useBibleSettings } from '../bibleSettings';

const ZOOMS: { zoom: Zoom; label: string }[] = [
  { zoom: 'fit', label: 'Whole span' },
  { zoom: 'default', label: 'Medium' },
  { zoom: 'close', label: 'Close' },
];

/**
 * The world events screen (SM-8): "The world around <story year>" (A33),
 * the zoom and region controls, then the grid of events by category and
 * year. Everything picked opens in an editor under the grid (ED-1, A43);
 * new events and moves go through the write path with one undo step each
 * (ED-3). A gap in the era coverage shows above the grid.
 */
export function TimelineView() {
  const story = useStoryTime();
  const year = story.year;
  const undo = useUndo();
  const ro = useWriteGuard();
  const entries = useEntries('worldEvents');
  const eraEntries = useEntries('eraStates');
  const chapters = useEntries('chapters');
  const categories = useList('eventCategories');
  // A47: the bible's numbers (IP-11) and its regions list, in its order, by label (IP-8).
  const { numbers } = useBibleSettings();
  const regionItems = useList('regions')?.items;
  const [selected, setSelected] = useState<{ collection: EntryCollection; id: string } | null>(
    null,
  );
  const [zoom, setZoom] = useState<Zoom>('fit');
  const [regions, setRegions] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [groupId, setGroupId] = useState<string | null>(null);
  const [subId, setSubId] = useState<string | null>(null);
  const ids = { group: useId(), sub: useId() };

  const spans = useMemo(() => eventSpans(fromCollections({ worldEvents: entries })), [entries]);
  const eras = useMemo(() => eraSpans(fromCollections({ eraStates: eraEntries })), [eraEntries]);
  const coverage = useMemo(
    () => coverageMessages(eraCoverage(eras, numbers.timelineStart, numbers.timelineEnd)),
    [eras, numbers],
  );
  const span = useMemo(
    () =>
      gridSpan(spans.flatMap((e) => [e.startYear, e.endYear]).concat(year), {
        from: numbers.timelineStart,
        to: numbers.timelineEnd,
      }),
    [spans, year, numbers],
  );
  const regionLabel = useMemo(
    () => new Map((regionItems ?? []).map((i) => [i.id, i.label])),
    [regionItems],
  );
  const allRegions = useMemo(() => {
    const used = new Set(spans.flatMap((e) => e.regions));
    const order = (regionItems ?? []).map((i) => i.id);
    return [...order.filter((r) => used.has(r)), ...[...used].filter((r) => !order.includes(r))];
  }, [spans, regionItems]);
  // WE-1: the category filter narrows the rows, and the events with them.
  const categoryItems = useMemo(() => categories?.items ?? [], [categories]);
  const groups = useMemo(() => categoryItems.filter((i) => !i.parentId), [categoryItems]);
  const subs = useMemo(
    () => (groupId ? categoryItems.filter((i) => i.parentId === groupId) : []),
    [categoryItems, groupId],
  );
  const scope = useMemo(
    () => categoryScope(categoryItems, groupId, subId),
    [categoryItems, groupId, subId],
  );
  const gridEvents = useMemo<GridEvent[]>(
    () =>
      spans
        .filter((e) => regions.size === 0 || e.regions.some((r) => regions.has(r)))
        .filter((e) => !scope || scope.keep.has(e.categoryId))
        .map((e) => ({
          id: e.id,
          title: e.title,
          categoryId: e.categoryId,
          startYear: e.startYear,
          endYear: e.endYear,
          formative: e.formative,
          regions: e.regions.map((r) => regionLabel.get(r) ?? r),
        })),
    [spans, regions, scope, regionLabel],
  );

  // The chapter being written: the strand the Writing picker holds (A27), else its primary strand.
  const writing = useMemo(
    () =>
      writingBand(
        strandSpans(fromCollections({ chapters })),
        story.time?.chapterId,
        story.time?.strandId,
      ),
    [story.time?.chapterId, story.time?.strandId, chapters],
  );

  const win = useMemo(
    () => yearWindow(year, numbers.windowBefore, numbers.windowAfter),
    [year, numbers],
  );
  const around = useMemo(
    () =>
      inWindow(spans, win).map((e) => ({
        id: e.id,
        title: e.title,
        startYear: e.startYear,
        endYear: e.endYear,
        formative: e.formative,
      })),
    [spans, win],
  );

  // IP-4: the era band's edges, gaps and names, and the markers' labels, edit in place.
  const eraEdits = useEraEdits({ eras, span, readOnly: ro.off, onError: setError });
  const renameEvent = useTitleRename('worldEvents');

  const openEvent = (id: string) => setSelected({ collection: 'worldEvents', id });

  const toggleRegion = (r: string | null) =>
    setRegions((prev) => {
      if (r === null) return new Set();
      const next = new Set(prev);
      if (next.has(r)) next.delete(r);
      else next.add(r);
      return next;
    });

  const move = async (id: string, delta: number, part: 'span' | 'end') => {
    setError(null);
    const before = entries.find((e) => e._id === id);
    const s = spans.find((e) => e.id === id);
    if (!before || !s) return;
    const start = isPlainObject(before.start) ? before.start : { year: s.startYear };
    const end = isPlainObject(before.end) ? before.end : null;
    let patch: Record<string, unknown>;
    let label: string;
    if (part === 'span') {
      const moved = shiftSpan(s.startYear, s.endYear, delta, span);
      if (moved.delta === 0) return;
      patch = {
        start: { ...start, year: moved.startYear },
        end: end ? { ...end, year: s.endYear + moved.delta } : null,
      };
      label = `Moved ${s.title} to ${moved.startYear}`;
    } else {
      const to = shiftEnd(s.startYear, s.endYear, delta, span);
      if (to === s.endYear) return;
      patch = { end: to === s.startYear && !end ? null : { ...(end ?? {}), year: to } };
      label = `Set the end of ${s.title} to ${to}`;
    }
    try {
      const { entry } = await call('entry.update', { collection: 'worldEvents', id, patch });
      undo.record(editCommand(label, 'worldEvents', id, before, entry));
    } catch (e) {
      setError(plainError(e));
    }
  };

  const create = async (n: NewEvent) => {
    setError(null);
    const base = blankEntry(manifests.worldEvents);
    const data: Record<string, unknown> = {
      ...base,
      title: n.title,
      start: { year: n.year },
      end: n.endYear !== null && n.endYear !== n.year ? { year: n.endYear } : null,
      categoryId: n.categoryId,
      formative: n.formative,
    };
    // Real or invented is provenance once the model drops `reality` (SM-4); until then, invented.
    if ('reality' in base) data.reality = 'invented';
    try {
      const { entry } = await call('entry.create', { collection: 'worldEvents', data });
      undo.record(createCommand('worldEvents', entry._id, entryTitle(entry)));
      openEvent(entry._id);
    } catch (e) {
      throw new Error(plainError(e), { cause: e });
    }
  };

  return (
    <div className="ws-tree-area wg-area" data-testid="timeline-view">
      <section className="tree-main stack wg-main" aria-labelledby="timeline-title">
        <div className="list-head">
          <h2 id="timeline-title">World events</h2>
          <span className="row tight">
            <span className="chip time" data-testid="timeline-time">
              Story time {year}
            </span>
            <button type="button" className="btn small" onClick={story.openDialog}>
              Change
            </button>
          </span>
        </div>
        <section
          className="panel stack tight wg-around"
          aria-labelledby="world-around-title"
          data-testid="world-around"
        >
          <h3 id="world-around-title">The world around {year}</h3>
          <WorldEventsStrip
            events={around}
            from={win.from}
            to={win.to}
            year={year}
            everyYear
            onOpen={openEvent}
            label={`World events from ${win.from} to ${win.to}`}
            testid="world-around-strip"
          />
        </section>
        <div className="tree-toolbar wg-toolbar">
          <div className="row tight" role="group" aria-label="Zoom">
            <span className="wg-toolbar-label">Zoom</span>
            {ZOOMS.map((z) => (
              <button
                key={z.zoom}
                type="button"
                className="btn small"
                aria-pressed={zoom === z.zoom}
                onClick={() => setZoom(z.zoom)}
              >
                {z.label}
              </button>
            ))}
          </div>
          <div className="row tight wg-categories" role="group" aria-label="Categories">
            <div className="field">
              <label htmlFor={ids.group}>Category</label>
              <select
                id={ids.group}
                value={groupId ?? ''}
                onChange={(e) => {
                  setGroupId(e.target.value || null);
                  setSubId(null);
                }}
              >
                <option value="">All categories</option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.label}
                  </option>
                ))}
              </select>
            </div>
            {subs.length > 0 && (
              <div className="field">
                <label htmlFor={ids.sub}>Subcategory</label>
                <select
                  id={ids.sub}
                  value={subId ?? ''}
                  onChange={(e) => setSubId(e.target.value || null)}
                >
                  <option value="">All subcategories</option>
                  {subs.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
          <div className="row tight wg-regions" role="group" aria-label="Regions">
            <span className="wg-toolbar-label">Regions</span>
            <button
              type="button"
              className="btn small wg-chip"
              aria-pressed={regions.size === 0}
              onClick={() => toggleRegion(null)}
            >
              All regions
            </button>
            {allRegions.map((r) => (
              <button
                key={r}
                type="button"
                className="btn small wg-chip"
                aria-pressed={regions.has(r)}
                data-region={r}
                onClick={() => toggleRegion(r)}
              >
                {regionLabel.get(r) ?? r}
              </button>
            ))}
          </div>
        </div>
        {error && (
          <p className="callout crit" role="alert">
            {error}
          </p>
        )}
        <p className="example-note">
          Click an empty spot in a row, or a row name, to add an event there. Click a marker, an
          era, or a title above to edit it under the grid. Drag a marker to change its year, and
          double-click it or press F2 to rename it. Drag the end of an era to move it, and
          double-click a gap in the era band to add an era there. From the keyboard, Tab to the
          markers, Up and Down move between them, Enter opens one, Left and Right change its year,
          and Shift with Left or Right changes the end year. On an era, Shift with Left or Right
          moves its start, Shift and Alt with Left or Right its end.
        </p>
        {/* A43: one coverage problem shows as it is; several fold under a count, so the grid stays in view. */}
        {coverage.length === 1 && (
          <p className="callout warn" data-testid="timeline-coverage">
            <strong>Era coverage:</strong> {coverage[0]}
          </p>
        )}
        {coverage.length > 1 && (
          <details className="callout warn wg-coverage" data-testid="timeline-coverage">
            <summary>
              <strong>Era coverage</strong>: {coverage.length} problems
            </summary>
            <div className="stack tight">
              {coverage.map((c) => (
                <span key={c}>{c}</span>
              ))}
            </div>
          </details>
        )}
        {categories ? (
          <WorldEventsGrid
            events={gridEvents}
            categories={scope ? scope.items : categoryItems}
            eras={eras}
            span={span}
            zoom={zoom}
            storyYear={year}
            writing={writing}
            selectedId={selected?.collection === 'worldEvents' ? selected.id : null}
            readOnly={ro.off}
            onOpen={openEvent}
            onOpenEra={(id) => setSelected({ collection: 'eraStates', id })}
            onMove={move}
            onCreate={create}
            eraEdits={eraEdits}
            onRename={ro.off ? undefined : renameEvent}
          />
        ) : (
          <p aria-live="polite">Loading the categories.</p>
        )}
        <div className="legend" aria-label="Grid legend">
          <span>
            <span className="wg-key dot" aria-hidden="true" />
            World event
          </span>
          <span>
            <span className="wg-key dot big" aria-hidden="true" />
            Formative event
          </span>
          <span>
            <span className="wg-key bar" aria-hidden="true" />
            Event over several years
          </span>
          <span>
            <span className="wg-key story" aria-hidden="true" />
            Story year
          </span>
          <span>
            <span className="wg-key writing" aria-hidden="true" />
            Chapter being written
          </span>
        </div>
        {selected && (
          <RowEditor
            key={`${selected.collection}:${selected.id}`}
            open={selected}
            onClose={() => setSelected(null)}
            testId="timeline-editor"
          />
        )}
      </section>
    </div>
  );
}
