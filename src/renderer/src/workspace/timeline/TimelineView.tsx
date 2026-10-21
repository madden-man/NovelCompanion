import { useMemo, useState } from 'react';
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
  gridSpan,
  inWindow,
  shiftEnd,
  shiftSpan,
  yearWindow,
} from '../../../../shared/domain/worldGrid';
import type { Zoom } from '../../../../shared/domain/worldGrid';
import { createCommand, editCommand } from '../../../../shared/domain/undoRunner';
import { isPlainObject } from '../../../../shared/domain/paths';
import { useWriteGuard } from '../../connection';
import { call, plainError } from '../../api';
import { useEntries, useList } from '../data';
import { EmbeddedEditor, UndoPanel } from '../editor';
import { useStoryTime } from '../storyTime';
import { useUndo } from '../undo';
import { WorldEventsStrip } from './WorldEventsStrip';
import { WorldEventsGrid } from './WorldEventsGrid';
import type { GridEvent, NewEvent } from './WorldEventsGrid';
import './world.css';

const ZOOMS: { zoom: Zoom; label: string }[] = [
  { zoom: 'fit', label: 'Whole span' },
  { zoom: 'default', label: 'Medium' },
  { zoom: 'close', label: 'Close' },
];

/**
 * The world events screen (SM-8): "The world around <story year>" (A33),
 * the zoom and region controls, then the grid of events by category and
 * year. Everything picked opens in the inspector (ED-1); new events and
 * moves go through the write path with one undo step each (ED-3).
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
  const [selected, setSelected] = useState<{ collection: EntryCollection; id: string } | null>(
    null,
  );
  const [zoom, setZoom] = useState<Zoom>('fit');
  const [regions, setRegions] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const spans = useMemo(() => eventSpans(fromCollections({ worldEvents: entries })), [entries]);
  const eras = useMemo(() => eraSpans(fromCollections({ eraStates: eraEntries })), [eraEntries]);
  const coverage = useMemo(() => coverageMessages(eraCoverage(eras)), [eras]);
  const span = useMemo(
    () => gridSpan(spans.flatMap((e) => [e.startYear, e.endYear]).concat(year)),
    [spans, year],
  );
  const allRegions = useMemo(
    () => [...new Set(spans.flatMap((e) => e.regions))].sort((a, b) => a.localeCompare(b)),
    [spans],
  );
  const gridEvents = useMemo<GridEvent[]>(
    () =>
      spans
        .filter((e) => regions.size === 0 || e.regions.some((r) => regions.has(r)))
        .map((e) => ({
          id: e.id,
          title: e.title,
          categoryId: e.categoryId,
          startYear: e.startYear,
          endYear: e.endYear,
          formative: e.formative,
          regions: e.regions,
        })),
    [spans, regions],
  );

  // The chapter being written: its primary strand's years (A27's Writing picker).
  const writing = useMemo(() => {
    const chapterId = story.time?.chapterId;
    if (!chapterId) return null;
    const strands = strandSpans(fromCollections({ chapters })).filter(
      (s) => s.chapterId === chapterId,
    );
    const s = strands.find((x) => x.primary) ?? strands[0];
    if (!s) return null;
    return {
      from: s.startYear,
      to: s.endYear,
      label: `Chapter ${s.readingOrder ?? '?'}: ${s.chapterTitle}, being written (${s.startYear === s.endYear ? s.startYear : `${s.startYear} to ${s.endYear}`})`,
    };
  }, [story.time?.chapterId, chapters]);

  const win = useMemo(() => yearWindow(year), [year]);
  const around = useMemo(
    () =>
      inWindow(spans, win).map((e) => ({
        id: e.id,
        title: e.title,
        status: e.status,
        startYear: e.startYear,
        endYear: e.endYear,
        formative: e.formative,
      })),
    [spans, win],
  );

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
      status: 'idea',
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
    <div className="ws-tree-area" data-testid="timeline-view">
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
                {r}
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
          Click an empty spot in a row to add an event there. Drag a marker, or focus it and press
          the Left and Right arrows, to change its year; Shift with an arrow changes the end year.
        </p>
        {categories ? (
          <WorldEventsGrid
            events={gridEvents}
            categories={categories.items}
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
      </section>
      <aside
        className="inspector tree-inspector"
        aria-label="World events inspector"
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
          <p className="example-note">
            Pick a marker, an era, or a title in the world around {year} to edit it here.
          </p>
        )}
        <UndoPanel />
      </aside>
    </div>
  );
}
