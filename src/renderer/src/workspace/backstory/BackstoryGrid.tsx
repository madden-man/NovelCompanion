import { familyColorCss } from '../../../../shared/domain/lists';
import { useMemo, useState } from 'react';
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from 'react';
import type {
  EdgeSide,
  GridLine,
  YearScale,
  YearSpan,
  Zoom,
} from '../../../../shared/domain/worldGrid';
import {
  NO_FAMILY,
  PERSON_METRICS,
  ageText,
  layoutBackstory,
  layoutPerson,
  lifespanBar,
  lifespanOf,
  momentLabel,
  moveLifeEnd,
} from '../../../../shared/domain/backstoryGrid';
import type { Lifespan as Life } from '../../../../shared/domain/backstoryGrid';
import type {
  BackstoryGrid as Grid,
  BackstoryMoment,
  BackstoryPerson,
} from '../../../../shared/domain/backstoryGrid';
import { lifeYears } from '../../../../shared/domain/ages';
import { span } from '../timeline/common';
import {
  GridFrame,
  GridHeader,
  GridMarker,
  GridOverlay,
  GridTip,
  GridTrack,
  GroupLine,
  lineMarkers,
  edgeKey,
  useClosedGroups,
  useEdgeDrag,
  useGridMarkers,
  useGridViewport,
} from '../timeline/gridShared';
import type { EdgeDrag, EraEdits, GridBand, GridEra, MovePart } from '../timeline/gridShared';
import './backstory.css';

/**
 * SM-9: the Backstory grid. The World events grid's axis, header, era band,
 * group lines, markers, story year line and writing band (`gridShared.tsx`),
 * with one row per character under a collapsible heading per family, a
 * lifespan bar in the family colour, and a marker per moment.
 *
 * A50: with `personId` set it draws that one person's timeline instead: one
 * row that fills the frame, the markers larger, every title drawn. The name
 * cell leaves it again, and so does Escape anywhere in the frame that no
 * field or dialog takes.
 */
export function BackstoryGrid(props: {
  grid: Grid;
  eras: GridEra[];
  span: YearSpan;
  zoom: Zoom;
  storyYear: number;
  writing: GridBand | null;
  pickedId: string | null;
  /** A50: the person whose timeline fills the frame, or null for everyone. */
  personId?: string | null;
  selectedMomentId: string | null;
  readOnly: boolean;
  /** The name cell: a click or Enter opens the person's timeline, or leaves it when open. */
  onPick: (characterId: string) => void;
  /** A50: back to everyone from the person view (Escape in the frame). */
  onLeavePerson?: () => void;
  onPickMoment: (momentId: string, characterId: string) => void;
  /** A49: a double-click opens the moment with What happens open as a field. */
  onOpenMoment?: (momentId: string, characterId: string) => void;
  onOpenEra: (id: string) => void;
  onMove: (momentId: string, delta: number, part: MovePart) => Promise<void>;
  onCreate: (characterId: string, year: number) => Promise<void>;
  /** IP-4: a lifespan end moved by whole years: the birth (start) or the death (end). */
  onLifeEnd?: (characterId: string, side: EdgeSide, delta: number) => Promise<void>;
  /** IP-4: the person's page, from the name. */
  onOpenPerson?: (characterId: string) => void;
  /** IP-4: a moment's label renamed in place. */
  onRename?: (momentId: string, title: string) => Promise<void>;
  eraEdits?: EraEdits;
}) {
  const { grid, storyYear } = props;
  const vp = useGridViewport(props.span, props.zoom, storyYear);
  const scale = vp.scale;
  const [closed, toggleFamily] = useClosedGroups();
  const personId = props.personId && grid.people.has(props.personId) ? props.personId : null;
  // A50: back from a person's timeline, their family opens if it was collapsed, so their row
  // is there to scroll to and to take the focus.
  const [shownPerson, setShownPerson] = useState(personId);
  if (shownPerson !== personId) {
    setShownPerson(personId);
    const fam = personId === null && shownPerson ? grid.people.get(shownPerson)?.familyId : null;
    if (fam && closed.has(fam)) toggleFamily(fam);
  }
  const fill = vp.viewHeight - PERSON_METRICS.header;
  const layout = useMemo(
    () =>
      personId !== null
        ? layoutPerson(grid, personId, scale, fill)
        : layoutBackstory(grid, scale, closed),
    [grid, personId, scale, fill, closed],
  );
  const byId = useMemo(() => new Map(grid.moments.map((m) => [m.id, m])), [grid.moments]);
  const families = useMemo(() => new Map(grid.families.map((f) => [f.id, f])), [grid.families]);
  const ctl = useGridMarkers({
    layout,
    scale,
    readOnly: props.readOnly,
    yearsOf: (id) => {
      const m = byId.get(id);
      return m && { startYear: m.year, endYear: m.endYear ?? m.year };
    },
    onMove: props.onMove,
  });

  // A49: a click or Enter opens the moment; a double-click opens it with What happens open;
  // F2 renames the label in place (IP-4).
  const rename = props.onRename;
  const openMoment = props.onOpenMoment;
  const markers = (line: GridLine) =>
    lineMarkers(line).map((m) => {
      const mo = byId.get(m.id);
      if (!mo) return null;
      return (
        <GridMarker
          key={m.id}
          m={m}
          ctl={ctl}
          layout={layout}
          label={describe(mo, grid.people.get(mo.characterId))}
          selected={props.selectedMomentId === m.id}
          className="bs-marker"
          data={{ person: mo.characterId }}
          onActivate={() => props.onPickMoment(m.id, mo.characterId)}
          title={mo.title}
          onRename={rename && !props.readOnly ? (t) => rename(m.id, t) : undefined}
          onDoubleClick={openMoment ? () => openMoment(m.id, mo.characterId) : undefined}
        />
      );
    });

  const tipMoment = ctl.tip ? byId.get(ctl.tip.id) : undefined;

  // IP-4: the lifespan bars drag at their ends and are one Tab stop, Up and Down between them.
  const canEdit = !props.readOnly && props.onLifeEnd !== undefined;
  const lifeDrag = useEdgeDrag(scale.ppy, !canEdit, (id, side, delta) => {
    void props.onLifeEnd?.(id, side, delta);
  });
  const bars = useMemo(
    () =>
      layout.lines.flatMap((l) => {
        if (l.kind !== 'row') return [];
        const p = grid.people.get(l.row.key);
        return p && lifespanBar(lifespanOf(p), scale, storyYear) ? [p.id] : [];
      }),
    [layout, grid.people, scale, storyYear],
  );
  const [lifeStop, setLifeStop] = useState<string | null>(null);
  const activeBar = lifeStop !== null && bars.includes(lifeStop) ? lifeStop : bars[0];
  const lifeKey = (ev: ReactKeyboardEvent<HTMLElement>, id: string) => {
    const i = bars.indexOf(id);
    const to =
      ev.key === 'ArrowDown' && !ev.shiftKey
        ? bars[Math.min(bars.length - 1, i + 1)]
        : ev.key === 'ArrowUp' && !ev.shiftKey
          ? bars[Math.max(0, i - 1)]
          : undefined;
    if (to !== undefined) {
      ev.preventDefault();
      setLifeStop(to);
      (ev.currentTarget.closest('.wg-scroll') ?? document)
        .querySelector<HTMLElement>(`.bs-life[data-person="${CSS.escape(to)}"]`)
        ?.focus();
      return;
    }
    const k = edgeKey(ev);
    if (!k) return;
    ev.preventDefault();
    if (canEdit) void props.onLifeEnd?.(id, k.side, k.delta);
  };

  // A50: Escape leaves the person view unless a field, a rename or a dialog takes it first.
  // During a marker or lifespan drag it calls the drag off instead (gridShared marks it taken),
  // and the next Escape leaves.
  const leave = props.onLeavePerson;
  const onFrameKey =
    personId !== null && leave
      ? (ev: ReactKeyboardEvent<HTMLDivElement>) => {
          if (ev.key !== 'Escape' || ev.defaultPrevented) return;
          if (ctl.dragging || lifeDrag.dragging) return;
          const t = ev.target as HTMLElement;
          if (t.closest('input, textarea, select, [contenteditable="true"], .wg-rename')) return;
          if (document.querySelector('[aria-modal="true"]')) return;
          ev.preventDefault();
          ctl.setTip(null);
          leave();
        }
      : undefined;

  return (
    <GridFrame
      vp={vp}
      layout={layout}
      testid="backstory-grid"
      className={`bs-scroll${personId !== null ? ' bs-person' : ''}`}
      onKeyDown={onFrameKey}
    >
      <GridHeader
        layout={layout}
        storyYear={storyYear}
        corner="Character"
        eras={props.eras}
        onOpenEra={props.onOpenEra}
        edits={props.eraEdits}
      />
      {layout.lines.map((line) => {
        if (line.kind === 'group') {
          const fam = families.get(line.group.id);
          return (
            <GroupLine
              key={`g:${line.group.id}`}
              line={line}
              layout={layout}
              onToggle={toggleFamily}
              merged={markers(line)}
            >
              {line.group.id !== NO_FAMILY && (
                <span
                  className="bs-swatch"
                  style={{ background: familyColorCss(fam?.color) ?? undefined }}
                  aria-hidden="true"
                />
              )}
              {line.group.label}
              <span className="bs-count">({fam?.people.length ?? 0})</span>
            </GroupLine>
          );
        }
        const p = grid.people.get(line.row.key);
        if (!p) return null;
        const life = lifespanOf(p);
        const picked = props.pickedId === p.id;
        const alone = personId === p.id;
        const fam = families.get(p.familyId);
        const nameLink = props.onOpenPerson ? (
          <a
            className="bs-name bs-name-link"
            href={`#characters/${encodeURIComponent(p.id)}`}
            aria-label={`Open the page of ${p.name}`}
            title={`Open the page of ${p.name}`}
            onClick={(e) => {
              e.preventDefault();
              props.onOpenPerson?.(p.id);
            }}
          >
            {p.name}
          </a>
        ) : (
          <span className="bs-name">{p.name}</span>
        );
        const zh = p.chinese && (
          <span className="bs-zh" lang="zh">
            {p.chinese}
          </span>
        );
        return (
          <div
            key={`r:${p.id}`}
            className={`wg-line wg-row bs-row${picked ? ' picked' : ''}${alone ? ' bs-person-row' : ''}`}
            style={{ height: line.height }}
            data-person={p.id}
            data-group={line.row.groupId}
            data-life={life.kind}
            data-birth={life.from ?? ''}
            data-death={life.to ?? ''}
          >
            {/* IP-4: the name opens the person's page; anywhere else in the cell opens their
                timeline, or in the timeline goes back to everyone (A50). */}
            <div className={`wg-label wg-row-label bs-row-cell${picked ? ' picked' : ''}`}>
              <button
                type="button"
                className="bs-row-label"
                aria-pressed={alone || picked}
                aria-label={`${p.name}${p.chinese ? ` ${p.chinese}` : ''}, ${lifeYears(p)}, ${alone ? 'show everyone' : 'show their moments'}`}
                onClick={() => props.onPick(p.id)}
              >
                {/* The name drawn beside it is the link; the button carries it too, for a reader. */}
                <span className="sr-only">
                  {p.name}
                  {p.chinese}
                </span>
              </button>
              {alone ? (
                <span className="bs-row-text bs-person-text">
                  <span className="bs-person-names">
                    {p.familyId !== NO_FAMILY && (
                      <span
                        className="bs-swatch"
                        style={{ background: familyColorCss(fam?.color) ?? undefined }}
                        aria-hidden="true"
                      />
                    )}
                    {nameLink}
                    {zh}
                  </span>
                  <span className="bs-years" data-testid="person-years">
                    {lifeYears(p)}
                  </span>
                </span>
              ) : (
                <span className="bs-row-text">
                  {nameLink}
                  {zh}
                </span>
              )}
            </div>
            <GridTrack
              layout={layout}
              onEmptyClick={props.readOnly ? undefined : (year) => void props.onCreate(p.id, year)}
            >
              <Lifespan
                person={p}
                scale={scale}
                storyYear={storyYear}
                color={families.get(p.familyId)?.color ?? null}
                drag={lifeDrag}
                canEdit={canEdit}
                tabbable={activeBar === p.id}
                onFocus={() => setLifeStop(p.id)}
                onKeyDown={(ev) => lifeKey(ev, p.id)}
              />
              {markers(line)}
            </GridTrack>
          </div>
        );
      })}
      <GridOverlay layout={layout} storyYear={storyYear} writing={props.writing} />
      {ctl.tip && tipMoment && !ctl.drag?.moved && (
        <GridTip layout={layout} tip={ctl.tip}>
          <strong>
            {span(tipMoment.year, tipMoment.endYear ?? tipMoment.year)} {momentLabel(tipMoment)}
          </strong>
          <br />
          {describeWho(grid.people.get(tipMoment.characterId), tipMoment.year)}
        </GridTip>
      )}
    </GridFrame>
  );
}

/** The life a drag shows: the dragged end where it would land, in order for drawing. */
function draggedLife(life: Life, drag: EdgeDrag, id: string, s: YearSpan) {
  for (const side of ['start', 'end'] as const) {
    const d = drag.deltaFor(id, side);
    if (d === 0) continue;
    const moved = moveLifeEnd(life, side, d, s);
    if (!moved) return { life, side, refused: false };
    // An open life's end pushed out stays open: nothing to show or write.
    if (side === 'end' && moved.to === null) return { life, side: null, refused: false };
    const refused = moved.to !== null && moved.to < moved.from;
    const from = refused ? (moved.to as number) : moved.from;
    const to = refused ? moved.from : moved.to;
    const shown: Life = { kind: to === null ? 'alive' : 'dead', from, to };
    return { life: shown, side, year: side === 'start' ? moved.from : moved.to, refused };
  }
  return { life, side: null, refused: false };
}

/**
 * The lifespan along the foot of a row: solid in the family colour, dashed
 * past the story year. IP-4: a grab handle at each end drags the birth or the
 * death; from the keyboard the bar takes Shift with Left or Right for the
 * birth, and Shift and Alt with Left or Right for the death.
 */
function Lifespan(props: {
  person: BackstoryPerson;
  scale: YearScale;
  storyYear: number;
  color: string | null;
  drag: EdgeDrag;
  canEdit: boolean;
  tabbable: boolean;
  onFocus: () => void;
  onKeyDown: (ev: ReactKeyboardEvent<HTMLElement>) => void;
}) {
  const { person: p } = props;
  const stored = lifespanOf(p);
  const shown = draggedLife(stored, props.drag, p.id, props.scale);
  const life = shown.life;
  const bar = lifespanBar(life, props.scale, props.storyYear);
  if (!bar) {
    return (
      <span className="bs-life-unknown" data-testid="lifespan" data-kind={life.kind}>
        {life.kind === 'unknown' ? 'Birth year unknown' : ''}
      </span>
    );
  }
  const solid = bar.dashFrom === null ? bar.width : bar.dashFrom - bar.x;
  const style = {
    ['--bs-fam' as string]: familyColorCss(props.color) ?? 'var(--border-strong)',
    left: bar.x,
    width: bar.width,
  } as CSSProperties;
  const years =
    stored.to === null
      ? `born ${stored.from}, no death on record`
      : `${stored.from} to ${stored.to}`;
  const keys = props.canEdit
    ? ' Shift with Left or Right moves the birth a year; Shift and Alt with Left or Right move the death.'
    : '';
  return (
    <span
      className={`bs-life${shown.side ? ' dragging' : ''}${shown.refused ? ' refused' : ''}`}
      data-testid="lifespan"
      data-person={p.id}
      data-kind={stored.kind}
      data-from={stored.from ?? ''}
      data-to={stored.to ?? ''}
      data-dash-from={bar.dashFrom === null ? '' : props.storyYear + 1}
      style={style}
      role="group"
      tabIndex={props.tabbable ? 0 : -1}
      aria-label={`Lifespan of ${p.name}, ${years}`}
      title={`Lifespan of ${p.name}, ${years}.${keys}`}
      onFocus={props.onFocus}
      onKeyDown={props.onKeyDown}
    >
      {solid > 0 && <span className="bs-life-solid" style={{ width: solid }} />}
      {bar.dashFrom !== null && (
        <span className="bs-life-dash" style={{ left: solid, width: bar.width - solid }} />
      )}
      {props.canEdit && (
        <>
          <span
            className="wg-handle start bs-handle"
            aria-hidden="true"
            data-testid="life-handle-start"
            {...props.drag.handle(p.id, 'start')}
          />
          <span
            className="wg-handle end bs-handle"
            aria-hidden="true"
            data-testid="life-handle-end"
            {...props.drag.handle(p.id, 'end')}
          />
        </>
      )}
      {shown.side && 'year' in shown && (
        <span
          className={`wg-drag-year bs-life-year num ${shown.side}`}
          data-testid="drag-year"
          aria-live="polite"
        >
          {shown.side === 'start' ? 'Birth' : 'Death'} {shown.year}
        </span>
      )}
    </span>
  );
}

function describe(m: BackstoryMoment, p: BackstoryPerson | undefined): string {
  const age = p ? ageText(p, m.year) : '';
  return [
    momentLabel(m),
    span(m.year, m.endYear ?? m.year),
    p ? `${p.name}${/^\d+$/.test(age) ? `, age ${age}` : ''}` : '',
  ]
    .filter(Boolean)
    .join(', ');
}

function describeWho(p: BackstoryPerson | undefined, year: number): string {
  if (!p) return '';
  const age = ageText(p, year);
  return /^\d+$/.test(age) ? `${p.name}, age ${age}` : `${p.name}, ${age.toLowerCase()}`;
}
