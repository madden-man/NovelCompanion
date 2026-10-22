import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { buildGroups, layoutGrid, yearMid } from '../../../../shared/domain/worldGrid';
import type { CategoryItem, GridItem, YearSpan, Zoom } from '../../../../shared/domain/worldGrid';
import { span } from './common';
import {
  GridFrame,
  GridHeader,
  GridMarker,
  GridOverlay,
  GridTip,
  GridTrack,
  GroupLine,
  LABEL_W,
  lineMarkers,
  useClosedGroups,
  useGridMarkers,
  useGridViewport,
} from './gridShared';
import type { EraEdits, GridBand, GridEra, MovePart } from './gridShared';

export type { GridEra } from './gridShared';

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

/**
 * SM-8: world events as a grid. Years run left to right; one row per
 * subcategory under its collapsible group heading, in the category list's
 * order. A marker sits at its year (a bar to its end year), larger when
 * formative. The era band runs under the sticky year header, the story year
 * is a line, the chapter being written a band. Clicking an empty spot in a
 * row opens a small form to add an event there; a marker opens on click,
 * drags along its row, and moves with the arrow keys (Shift for the end);
 * F2 or a double-click renames its label in place (IP-4). The era band's
 * edges drag and its gaps make eras (`GridHeader`).
 * The axis, header, lines and markers are shared with Backstory (`gridShared.tsx`).
 */
export function WorldEventsGrid(props: {
  events: GridEvent[];
  categories: CategoryItem[];
  eras: GridEra[];
  span: YearSpan;
  zoom: Zoom;
  storyYear: number;
  writing: GridBand | null;
  selectedId: string | null;
  readOnly: boolean;
  onOpen: (id: string) => void;
  onOpenEra: (id: string) => void;
  /** Move an event by whole years: the whole span, or only its end. */
  onMove: (id: string, delta: number, part: MovePart) => Promise<void>;
  onCreate: (e: NewEvent) => Promise<void>;
  /** IP-4: the era band's edges, gaps and names. */
  eraEdits?: EraEdits;
  /** IP-4: a marker's label renamed in place (F2 or a double-click). */
  onRename?: (id: string, title: string) => Promise<void>;
}) {
  const { events, storyYear } = props;
  const vp = useGridViewport(props.span, props.zoom, storyYear);
  const scale = vp.scale;
  const [closed, toggleGroup] = useClosedGroups();
  const [draft, setDraft] = useState<Draft | null>(null);

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
  const ctl = useGridMarkers({
    layout,
    scale,
    readOnly: props.readOnly,
    yearsOf: (id) => byId.get(id),
    onMove: props.onMove,
  });

  useEffect(() => {
    if (!draft) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDraft(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [draft]);

  const openDraft = (rowKey: string, year: number, top: number) => {
    if (props.readOnly) return;
    const left = Math.min(
      LABEL_W + yearMid(scale, year),
      Math.max(LABEL_W, LABEL_W + layout.width - 280),
    );
    setDraft({ rowKey, rowLabel: rowLabel.get(rowKey) ?? rowKey, year, left, top });
  };

  const where = (e: GridEvent) =>
    rowLabel.get(rows.rowOf.get(e.categoryId) ?? e.categoryId) ?? e.categoryId;
  const describe = (e: GridEvent) =>
    [
      e.title,
      span(e.startYear, e.endYear),
      where(e),
      e.regions.join(', '),
      e.formative ? 'formative' : '',
    ]
      .filter(Boolean)
      .join(', ');

  const rename = props.onRename;
  const markers = (line: Parameters<typeof lineMarkers>[0]) =>
    lineMarkers(line).map((m) => {
      const e = byId.get(m.id);
      if (!e) return null;
      return (
        <GridMarker
          key={m.id}
          m={m}
          ctl={ctl}
          layout={layout}
          label={describe(e)}
          selected={props.selectedId === m.id}
          onActivate={() => props.onOpen(m.id)}
          title={e.title}
          onRename={rename ? (t) => rename(m.id, t) : undefined}
        />
      );
    });

  const tipEvent = ctl.tip ? byId.get(ctl.tip.id) : undefined;

  return (
    <GridFrame vp={vp} layout={layout} testid="world-grid">
      <GridHeader
        layout={layout}
        storyYear={storyYear}
        corner="Category"
        eras={props.eras}
        onOpenEra={props.onOpenEra}
        edits={props.eraEdits}
      />
      {layout.lines.map((line) =>
        line.kind === 'group' ? (
          <GroupLine
            key={`g:${line.group.id}`}
            line={line}
            layout={layout}
            onToggle={toggleGroup}
            merged={markers(line)}
          >
            {line.group.label}
          </GroupLine>
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
            <GridTrack
              layout={layout}
              onEmptyClick={
                props.readOnly
                  ? undefined
                  : (year) => openDraft(line.row.key, year, line.y + line.height)
              }
            >
              {markers(line)}
            </GridTrack>
          </div>
        ),
      )}
      <GridOverlay layout={layout} storyYear={storyYear} writing={props.writing} />
      {ctl.tip && tipEvent && !ctl.drag?.moved && (
        <GridTip layout={layout} tip={ctl.tip}>
          <strong>
            {span(tipEvent.startYear, tipEvent.endYear)} {tipEvent.title}
          </strong>
          <br />
          {where(tipEvent)}
          {tipEvent.regions.length ? `. ${tipEvent.regions.join(', ')}` : ''}
          {tipEvent.formative ? '. Formative' : ''}
        </GridTip>
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
    </GridFrame>
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
