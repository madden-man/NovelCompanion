import { familyColorCss } from '../../../../shared/domain/lists';
import { useMemo } from 'react';
import type { CSSProperties } from 'react';
import type { GridLine, YearScale, YearSpan, Zoom } from '../../../../shared/domain/worldGrid';
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
  useClosedGroups,
  useGridMarkers,
  useGridViewport,
} from '../timeline/gridShared';
import type { GridBand, GridEra, MovePart } from '../timeline/gridShared';
import './backstory.css';

/**
 * SM-9: the Backstory grid. The World events grid's axis, header, era band,
 * group lines, markers, story year line and writing band (`gridShared.tsx`),
 * with one row per character under a collapsible heading per family, a
 * lifespan bar in the family colour, and a marker per moment.
 */
export function BackstoryGrid(props: {
  grid: Grid;
  eras: GridEra[];
  span: YearSpan;
  zoom: Zoom;
  storyYear: number;
  writing: GridBand | null;
  pickedId: string | null;
  selectedMomentId: string | null;
  readOnly: boolean;
  onPick: (characterId: string) => void;
  onPickMoment: (momentId: string, characterId: string) => void;
  onOpenEra: (id: string) => void;
  onMove: (momentId: string, delta: number, part: MovePart) => Promise<void>;
  onCreate: (characterId: string, year: number) => Promise<void>;
}) {
  const { grid, storyYear } = props;
  const vp = useGridViewport(props.span, props.zoom, storyYear);
  const scale = vp.scale;
  const [closed, toggleFamily] = useClosedGroups();
  const layout = useMemo(() => layoutBackstory(grid, scale, closed), [grid, scale, closed]);
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
        />
      );
    });

  const tipMoment = ctl.tip ? byId.get(ctl.tip.id) : undefined;

  return (
    <GridFrame vp={vp} layout={layout} testid="backstory-grid" className="bs-scroll">
      <GridHeader
        layout={layout}
        storyYear={storyYear}
        corner="Character"
        eras={props.eras}
        onOpenEra={props.onOpenEra}
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
        return (
          <div
            key={`r:${p.id}`}
            className={`wg-line wg-row bs-row${picked ? ' picked' : ''}`}
            style={{ height: line.height }}
            data-person={p.id}
            data-group={line.row.groupId}
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
            <GridTrack
              layout={layout}
              onEmptyClick={props.readOnly ? undefined : (year) => void props.onCreate(p.id, year)}
            >
              <Lifespan
                person={p}
                scale={scale}
                storyYear={storyYear}
                color={families.get(p.familyId)?.color ?? null}
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

/** The lifespan along the foot of a row: solid in the family colour, dashed past the story year. */
function Lifespan(props: {
  person: BackstoryPerson;
  scale: YearScale;
  storyYear: number;
  color: string | null;
}) {
  const life = lifespanOf(props.person);
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
  return (
    <span
      className="bs-life"
      data-testid="lifespan"
      data-kind={life.kind}
      data-from={life.from ?? ''}
      data-to={life.to ?? ''}
      data-dash-from={bar.dashFrom === null ? '' : props.storyYear + 1}
      style={style}
      aria-hidden="true"
    >
      {solid > 0 && <span className="bs-life-solid" style={{ width: solid }} />}
      {bar.dashFrom !== null && (
        <span className="bs-life-dash" style={{ left: solid, width: bar.width - solid }} />
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
