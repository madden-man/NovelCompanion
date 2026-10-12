import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { WriteFieldset, useWriteGuard } from '../../connection';
import type {
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from 'react';
import { ulid } from 'ulid';
import type { EntryCollection } from '../../../../shared/schema';
import type { Response } from '../../../../shared/ipc';
import { lifeState, lifeYears } from '../../../../shared/domain/ages';
import type { LifeState } from '../../../../shared/domain/ages';
import {
  NODE_H,
  NODE_W,
  TreeActionError,
  assembleGraph,
  filterPeople,
  hasBranch,
  hideCollapsed,
  layoutFromPositions,
  parentsOf,
  partnersOf,
  planAddRelative,
  planLinkExisting,
  placeLayout,
  treeEdges,
  treeNodeKey,
} from '../../../../shared/domain/tree';
import type {
  PlannedEntry,
  RelativeKind,
  TreeFilter,
  TreeGraph,
  TreePerson,
} from '../../../../shared/domain/tree';
import { createCommand, deleteCommand, editCommand } from '../../../../shared/domain/undoRunner';
import type { UndoCommand } from '../../../../shared/domain/undoRunner';
import { call, plainError } from '../../api';
import { useEntries, useList, useStore } from '../data';
import { useGlossary } from '../Zh';
import { zhHint } from '../../../../shared/domain/zh';
import { EmbeddedEditor, UndoPanel } from '../editor';
import { useStoryTime } from '../storyTime';
import { useUndo } from '../undo';
import { rasterize, standaloneSvg } from './exportImage';

type TreeData = Response<'tree.get'>;
type View = { x: number; y: number; w: number; h: number };
type Status = 'canon' | 'planned' | 'idea';

const PAD = 40;
const LINK_STYLES = new Set(['biological', 'adoptive', 'step', 'guardian']);
const UNION_STYLES = new Set(['married', 'partnered']);

function stateText(s: LifeState): string {
  switch (s.state) {
    case 'alive':
      return s.dyingThisYear ? `dies at ${s.age}` : `age ${s.age}`;
    case 'dead':
      return `d. ${s.deathYear}`;
    case 'unborn':
      return 'unborn';
    case 'unknown':
      return 'age unknown';
  }
}

function stateWords(s: LifeState, year: number): string {
  switch (s.state) {
    case 'alive':
      return s.dyingThisYear
        ? `In ${year}: alive, age ${s.age}, dies this year`
        : `In ${year}: alive, age ${s.age}`;
    case 'dead':
      return `In ${year}: dead since ${s.deathYear}`;
    case 'unborn':
      return `In ${year}: not yet born`;
    case 'unknown':
      return `In ${year}: age unknown`;
  }
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The commands an in-tree action records: undo moves its entries to the trash, redo brings them back. */
function addCommand(label: string, plan: PlannedEntry[]): UndoCommand {
  return {
    label,
    undo: [...plan]
      .reverse()
      .map((p) => ({ kind: 'delete', collection: p.collection, id: p.data._id })),
    redo: plan.map((p) => ({ kind: 'restore', collection: p.collection, id: p.data._id })),
  };
}

interface NodeProps {
  person: TreePerson;
  /** Glossary detail for the Chinese name, shown as the node tooltip and read aloud (GL-3). */
  hint: string;
  x: number;
  y: number;
  year: number;
  selected: boolean;
  collapsed: boolean;
  branch: boolean;
  colors: string[];
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
  /** GL-3: show or hide the visible meaning card for this node's Chinese name. */
  onCard: (card: { text: string; el: Element } | null) => void;
}

/** One person in the tree (FT-7): name, years, status, and their state in the year (FT-5). */
const TreeNode = memo(function TreeNode(p: NodeProps) {
  const s = lifeState(p.person, p.year);
  const years = lifeYears(p.person);
  const label = p.person.chinese ? `${p.person.name} ${p.person.chinese}` : p.person.name;
  const aria = `${label}, ${years === 'unknown' ? 'born unknown' : years}, ${p.person.status}, ${stateText(s)}${p.hint ? `, ${p.hint}` : ''}`;
  const onKey = (e: ReactKeyboardEvent) => {
    const k = treeNodeKey(e.key, p.branch);
    if (!k) return;
    e.preventDefault();
    if (k === 'toggle') p.onToggle(p.person.id);
    else p.onSelect(p.person.id);
  };
  // GL-3: a node with a Chinese name shows a visible card on hover and on keyboard focus.
  const cardText = p.person.chinese ? p.hint || `${p.person.chinese}: not in the glossary yet` : '';
  const showCard = (e: { currentTarget: Element }) => {
    if (cardText) p.onCard({ text: cardText, el: e.currentTarget });
  };
  const stripes = p.colors.length ? p.colors : ['none'];
  const h = NODE_H / stripes.length;
  return (
    <g
      className={`tnode ${s.state}${s.state === 'alive' && s.dyingThisYear ? ' dying' : ''}${p.selected ? ' selected' : ''}${p.collapsed ? ' collapsed' : ''}`}
      transform={`translate(${p.x},${p.y})`}
      tabIndex={0}
      role="button"
      aria-label={aria}
      aria-pressed={p.selected}
      aria-expanded={p.branch ? !p.collapsed : undefined}
      aria-keyshortcuts={p.branch ? 'Enter Space I' : 'Enter Space'}
      data-person={p.person.id}
      data-state={s.state === 'alive' && s.dyingThisYear ? 'dying' : s.state}
      data-age={s.state === 'alive' ? s.age : undefined}
      onClick={() => p.onSelect(p.person.id)}
      onDoubleClick={() => p.onToggle(p.person.id)}
      onKeyDown={onKey}
      onFocus={showCard}
      onBlur={() => p.onCard(null)}
      onMouseEnter={showCard}
      onMouseLeave={() => p.onCard(null)}
    >
      <title>{aria}</title>
      <rect className="tnode-box" width={NODE_W} height={NODE_H} rx={6} />
      {stripes.map((c, i) => (
        <rect
          key={i}
          className={`tnode-fam fam-${c}`}
          x={0}
          y={i * h}
          width={6}
          height={h}
          data-family={c}
        />
      ))}
      <text className="tnode-name" x={14} y={20}>
        {clip(label, 21)}
      </text>
      <text className="tnode-years" x={14} y={38}>
        {years === 'unknown' ? 'born ?' : years}
      </text>
      <text className="tnode-state" x={NODE_W - 8} y={38} textAnchor="end" data-testid="node-state">
        {stateText(s)}
      </text>
      <rect className={`tchip ${p.person.status}`} x={14} y={46} width={52} height={14} rx={7} />
      <text className="tchip-text" x={40} y={56.5} textAnchor="middle">
        {p.person.status}
      </text>
      {p.branch && (
        <g
          className="tnode-toggle"
          data-export="skip"
          tabIndex={0}
          role="button"
          aria-label={`${p.collapsed ? 'Expand' : 'Collapse'} the branch of ${p.person.name}`}
          aria-expanded={!p.collapsed}
          onClick={(e) => {
            e.stopPropagation();
            p.onToggle(p.person.id);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              e.stopPropagation();
              p.onToggle(p.person.id);
            }
          }}
        >
          <circle cx={NODE_W - 14} cy={53} r={8} />
          <text x={NODE_W - 14} y={57} textAnchor="middle">
            {p.collapsed ? '+' : '−'}
          </text>
        </g>
      )}
    </g>
  );
});

/**
 * The family tree (FT-1 to FT-10): one SVG for every family, a year control
 * bound to the story time, filters, pan and zoom, collapse, export, in-tree
 * editing, and the FT-6 warnings. The layout and every age are pure code.
 */
export function TreeView(props: { onOpen: (collection: EntryCollection, id: string) => void }) {
  const { version } = useStore();
  const story = useStoryTime();
  const year = story.year;
  const families = useEntries('families');
  const glossary = useGlossary();
  const [data, setData] = useState<TreeData | null>(null);
  const [filterKey, setFilterKey] = useState('all');
  const [lineage, setLineage] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [exportNote, setExportNote] = useState<{ text: string; bad: boolean } | null>(null);
  /** What is typed in the year box while it is not a whole year yet, such as a blank. */
  const [yearDraft, setYearDraft] = useState<string | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  /** The tree and its inspector fill the screen; Escape (or the button) leaves. */
  const area = useRef<HTMLDivElement>(null);
  const [full, setFull] = useState(false);
  /** GL-3: the meaning card of the focused node, placed under it. */
  const [card, setCard] = useState<{ text: string; x: number; y: number } | null>(null);
  const showCard = useCallback((c: { text: string; el: Element } | null) => {
    if (!c || !wrap.current) {
      setCard(null);
      return;
    }
    const box = c.el.getBoundingClientRect();
    const area = wrap.current.getBoundingClientRect();
    setCard({
      text: c.text,
      x: Math.max(4, Math.min(box.left - area.left, area.width - 288)),
      y: Math.min(box.bottom - area.top + 4, area.height - 40),
    });
  }, []);
  const fitted = useRef(false);

  useEffect(() => {
    let live = true;
    void call('tree.get', {}).then((r) => {
      if (live) setData(r);
    });
    return () => {
      live = false;
    };
  }, [version]);

  const graph = useMemo<TreeGraph | null>(
    () => (data ? assembleGraph(data.people, data.unions, data.links) : null),
    [data],
  );

  const filter = useMemo<TreeFilter>(() => {
    if (filterKey.startsWith('family:')) return { kind: 'family', familyId: filterKey.slice(7) };
    if (filterKey === 'lineage' && lineage) return { kind: 'lineage', personId: lineage };
    return { kind: 'all' };
  }, [filterKey, lineage]);

  const saveSeq = useRef(0);
  const ro = useWriteGuard();
  // Stored positions are kept; only new people are placed (FT-10).
  const placed = useMemo(
    () => (graph && data ? placeLayout(graph, data.positions) : null),
    [graph, data],
  );

  useEffect(() => {
    // ARCH-6: a read-only snapshot places new people on screen without saving them.
    if (!placed?.changed || ro.off) return;
    const positions = placed.positions;
    const seq = ++saveSeq.current;
    void call('tree.savePositions', { positions }).then(() => {
      if (seq === saveSeq.current) setData((d) => (d ? { ...d, positions } : d));
    });
  }, [placed, ro.off]);

  const layout = useMemo(() => {
    if (!graph || !placed) return null;
    const shown = hideCollapsed(graph, filterPeople(graph, filter), collapsed);
    const kept = new Map<string, { x: number; y: number }>();
    for (const [id, p] of placed.layout.nodes) if (shown.has(id)) kept.set(id, p);
    return layoutFromPositions(kept);
  }, [graph, placed, filter, collapsed]);

  const [confirmTidy, setConfirmTidy] = useState(false);
  const tidy = async () => {
    if (!graph) return;
    const { positions } = placeLayout(graph, null);
    saveSeq.current += 1;
    await call('tree.savePositions', { positions });
    setData((d) => (d ? { ...d, positions } : d));
    setConfirmTidy(false);
    fitted.current = false;
  };

  const edges = useMemo(
    () => (graph && layout ? treeEdges(graph, layout, year) : null),
    [graph, layout, year],
  );

  const colorOf = useMemo(() => {
    const m = new Map(
      families.map((f) => [f._id, typeof f.color === 'string' ? f.color : 'series-1']),
    );
    return (ids: string[]) => ids.map((id) => m.get(id)).filter((c): c is string => Boolean(c));
  }, [families]);

  const bbox = useMemo(
    () =>
      layout
        ? {
            x: (layout.minX ?? 0) - PAD,
            y: layout.minY - PAD,
            width: Math.max(layout.width, NODE_W) + 2 * PAD,
            height: Math.max(layout.height, NODE_H) + 2 * PAD,
          }
        : { x: 0, y: 0, width: 800, height: 400 },
    [layout],
  );

  const fit = useCallback(() => {
    const el = wrap.current;
    const ar = el && el.clientHeight > 0 ? el.clientWidth / el.clientHeight : 2;
    let w = bbox.width;
    let h = bbox.height;
    if (w / h < ar) w = h * ar;
    else h = w / ar;
    setView({ x: bbox.x - (w - bbox.width) / 2, y: bbox.y - (h - bbox.height) / 2, w, h });
  }, [bbox]);

  useEffect(() => {
    const sync = () => setFull(document.fullscreenElement === area.current);
    // Electron does not leave HTML full screen on Escape by itself, as a browser does.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && document.fullscreenElement) void document.exitFullscreen();
    };
    document.addEventListener('fullscreenchange', sync);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('fullscreenchange', sync);
      document.removeEventListener('keydown', onKey);
    };
  }, []);
  const toggleFull = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void area.current?.requestFullscreen();
  }, []);
  // The tree box changes size on entering or leaving full screen: fit the people to it.
  useEffect(() => {
    if (!fitted.current) return;
    const frame = requestAnimationFrame(() => fit());
    return () => cancelAnimationFrame(frame);
  }, [full, fit]);

  useEffect(() => {
    if (layout && !fitted.current) {
      fitted.current = true;
      fit();
    }
  }, [layout, fit]);

  // A new filter shows a different set of people: fit them.
  useEffect(() => {
    fitted.current = false;
  }, [filter]);

  const zoom = useCallback((factor: number, cx?: number, cy?: number) => {
    setView((v) => {
      if (!v) return v;
      const px = cx ?? v.x + v.w / 2;
      const py = cy ?? v.y + v.h / 2;
      const w = Math.min(Math.max(v.w * factor, 120), 40_000);
      const k = w / v.w;
      return { x: px - (px - v.x) * k, y: py - (py - v.y) * k, w, h: v.h * k };
    });
  }, []);

  // Wheel zoom about the pointer; a native listener so the page does not scroll.
  useEffect(() => {
    const el = svg.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      setView((v) => {
        if (!v) return v;
        const px = v.x + ((e.clientX - r.left) / r.width) * v.w;
        const py = v.y + ((e.clientY - r.top) / r.height) * v.h;
        const factor = Math.exp(e.deltaY * 0.0015);
        const w = Math.min(Math.max(v.w * factor, 120), 40_000);
        const k = w / v.w;
        return { x: px - (px - v.x) * k, y: py - (py - v.y) * k, w, h: v.h * k };
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [data]);

  /** NF-2: arrows pan (Shift for larger steps), + and - zoom, F fits. */
  const onTreeKey = (e: ReactKeyboardEvent<SVGSVGElement>) => {
    const pan: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    };
    const dir = pan[e.key];
    if (dir) {
      e.preventDefault();
      const k = e.shiftKey ? 0.4 : 0.1;
      setView((v) => (v ? { ...v, x: v.x + dir[0] * v.w * k, y: v.y + dir[1] * v.h * k } : v));
    } else if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      zoom(0.8);
    } else if (e.key === '-' || e.key === '_') {
      e.preventDefault();
      zoom(1.25);
    } else if (e.key === 'f' || e.key === 'F') {
      e.preventDefault();
      fit();
    }
  };

  const drag = useRef<{ x: number; y: number; v: View; id: number } | null>(null);
  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!view || (e.target as Element).closest('.tnode')) return;
    drag.current = { x: e.clientX, y: e.clientY, v: view, id: e.pointerId };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.currentTarget.classList.add('dragging');
  };
  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    if (!d) return;
    const k = d.v.w / e.currentTarget.clientWidth;
    setView({ ...d.v, x: d.v.x - (e.clientX - d.x) * k, y: d.v.y - (e.clientY - d.y) * k });
  };
  const endDrag = (e: ReactPointerEvent<SVGSVGElement>) => {
    drag.current = null;
    e.currentTarget.classList.remove('dragging');
  };

  const toggle = useCallback(
    (id: string) => {
      if (!graph || !hasBranch(graph, id)) return;
      setCollapsed((c) => {
        const next = new Set(c);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    },
    [graph],
  );

  const exportAs = async (format: 'png' | 'pdf') => {
    setExportNote(null);
    const el = svg.current;
    if (!el) return;
    try {
      // Exports always use the light theme, so the tree reads on a white page.
      const root = document.documentElement;
      const before = root.getAttribute('data-theme');
      root.setAttribute('data-theme', 'light');
      let markup: string;
      try {
        const bg = getComputedStyle(el).getPropertyValue('--chart-surface').trim() || '#ffffff';
        markup = standaloneSvg(el, bbox, bg);
      } finally {
        if (before === null) root.removeAttribute('data-theme');
        else root.setAttribute('data-theme', before);
      }
      const fileName = `family-tree-${year}`;
      const scale = Math.min(2, 16_000 / Math.max(bbox.width, bbox.height));
      const png =
        format === 'png' ? await rasterize(markup, bbox.width, bbox.height, scale) : undefined;
      const r = await call('tree.export', {
        format,
        svg: markup,
        ...(png ? { png } : {}),
        width: bbox.width,
        height: bbox.height,
        fileName,
      });
      setExportNote(
        r.saved
          ? { text: `Saved ${r.path ?? fileName}.`, bad: false }
          : { text: 'Export cancelled. Nothing was saved.', bad: false },
      );
    } catch (e) {
      setExportNote({ text: plainError(e), bad: true });
    }
  };

  const setYearFrom = (text: string) => {
    if (/^-?\d{1,5}$/.test(text.trim())) {
      setYearDraft(null);
      story.setYear(Number(text));
    } else setYearDraft(text);
  };

  const years = useMemo(() => {
    const ys: number[] = [year];
    for (const p of data?.people ?? []) {
      for (const d of [p.birth, p.death]) if (d && 'year' in d) ys.push(d.year);
    }
    return { min: Math.min(...ys) - 5, max: Math.max(...ys) + 40 };
  }, [data, year]);

  const filterId = useId();
  const personId = useId();
  const rangeId = useId();
  const yearId = useId();

  if (!data || !graph || !layout || !edges) {
    return (
      <div className="ws-tree-area">
        <p aria-live="polite">Loading the family tree.</p>
      </div>
    );
  }
  const linkClass = (t: string) => (LINK_STYLES.has(t) ? t : 'other');
  const unionClass = (t: string) => (UNION_STYLES.has(t) ? t : 'other');
  const name = (id: string) => graph.byId.get(id)?.name ?? id;

  return (
    <div className="ws-tree-area" data-testid="tree-view" ref={area}>
      <section className="tree-main fill stack" aria-labelledby="tree-title">
        <div className="tree-stage stack">
          <div className="list-head">
            <h2 id="tree-title">Family tree</h2>
            <span className="example-note">
              {layout.nodes.size} of {graph.people.length} people shown
            </span>
          </div>
          <div className="tree-toolbar">
            <div className="field">
              <label htmlFor={filterId}>Show</label>
              <select
                id={filterId}
                value={filterKey}
                onChange={(e) => setFilterKey(e.target.value)}
              >
                <option value="all">All families</option>
                {families.map((f) => (
                  <option key={f._id} value={`family:${f._id}`}>
                    {String(f.name)} only
                  </option>
                ))}
                <option value="lineage">Ancestors and descendants of a person</option>
              </select>
            </div>
            {filterKey === 'lineage' && (
              <div className="field">
                <label htmlFor={personId}>Person</label>
                <select id={personId} value={lineage} onChange={(e) => setLineage(e.target.value)}>
                  <option value="">Pick a person</option>
                  {graph.people.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className="field year-slider">
              <label htmlFor={rangeId}>Year slider</label>
              <input
                id={rangeId}
                type="range"
                min={years.min}
                max={years.max}
                step={1}
                value={year}
                onChange={(e) => story.setYear(Number(e.target.value))}
              />
            </div>
            <div className="field year-field">
              <label htmlFor={yearId}>Year</label>
              <input
                id={yearId}
                type="number"
                className="num"
                value={yearDraft ?? String(year)}
                onBlur={() => setYearDraft(null)}
                onChange={(e) => setYearFrom(e.target.value)}
                data-testid="tree-year"
              />
            </div>
            <div className="row tight tree-buttons">
              <button type="button" className="btn" onClick={fit}>
                Fit to window
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => setConfirmTidy(true)}
                disabled={ro.off}
                {...ro.tip}
              >
                Tidy layout
              </button>
              <button type="button" className="btn" onClick={() => void exportAs('png')}>
                Export PNG
              </button>
              <button type="button" className="btn" onClick={() => void exportAs('pdf')}>
                Export PDF
              </button>
              <button type="button" className="btn" aria-pressed={full} onClick={toggleFull}>
                {full ? 'Exit full screen' : 'Full screen'}
              </button>
            </div>
          </div>
          {confirmTidy && (
            <div className="panel stack confirm" role="dialog" aria-label="Tidy layout">
              <strong>Tidy the whole layout?</strong>
              <p>
                This lays out the tree again from scratch, so every person may move. People you add
                later are placed without moving anyone.
              </p>
              <div className="row">
                <button type="button" className="btn primary" onClick={() => void tidy()}>
                  Tidy layout
                </button>
                <button type="button" className="btn" onClick={() => setConfirmTidy(false)}>
                  Keep the layout
                </button>
              </div>
            </div>
          )}
          {exportNote && (
            <p
              className={exportNote.bad ? 'callout crit' : 'callout'}
              role="status"
              data-testid="export-note"
            >
              {exportNote.text}
            </p>
          )}
          <div className="tree-wrap" ref={wrap}>
            <svg
              ref={svg}
              className="tree-svg"
              viewBox={
                view
                  ? `${view.x} ${view.y} ${view.w} ${view.h}`
                  : `${bbox.x} ${bbox.y} ${bbox.width} ${bbox.height}`
              }
              role="group"
              aria-label={`Family tree in ${year}`}
              data-testid="tree-svg"
              data-year={year}
              tabIndex={0}
              onKeyDown={onTreeKey}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
            >
              <g className="tree-edges">
                {edges.unions.map((u) => (
                  <g key={u.id} data-union={u.id} data-state={u.state}>
                    <path
                      className={`tunion ${unionClass(u.type)} ${u.state}`}
                      d={u.path}
                      data-type={u.type}
                    />
                    {u.label && u.endYear !== null && (
                      <text
                        className="tunion-end"
                        x={u.label.x}
                        y={u.label.y - 6}
                        textAnchor="middle"
                      >
                        ended {u.endYear}
                      </text>
                    )}
                  </g>
                ))}
                {edges.links.map((l) => (
                  <path
                    key={l.ids.join('+')}
                    className={`tlink ${linkClass(l.type)}`}
                    d={l.path}
                    data-links={l.ids.join(' ')}
                    data-type={l.type}
                  />
                ))}
              </g>
              <g className="tree-nodes">
                {graph.people.map((p) => {
                  const at = layout.nodes.get(p.id);
                  if (!at) return null;
                  return (
                    <TreeNode
                      key={p.id}
                      person={p}
                      hint={zhHint(p.chinese, glossary)}
                      x={at.x}
                      y={at.y}
                      year={year}
                      selected={selected === p.id}
                      collapsed={collapsed.has(p.id)}
                      branch={hasBranch(graph, p.id)}
                      colors={colorOf(p.familyIds)}
                      onSelect={setSelected}
                      onToggle={toggle}
                      onCard={showCard}
                    />
                  );
                })}
              </g>
            </svg>
            {card && (
              <div
                className="tree-card"
                role="tooltip"
                data-testid="tree-card"
                style={{ left: card.x, top: card.y }}
              >
                {card.text}
              </div>
            )}
            <div className="tree-ctl">
              <button
                type="button"
                className="btn small"
                aria-label="Zoom in"
                onClick={() => zoom(0.8)}
              >
                +
              </button>
              <button
                type="button"
                className="btn small"
                aria-label="Zoom out"
                onClick={() => zoom(1.25)}
              >
                −
              </button>
            </div>
          </div>
        </div>
        <Legend
          families={families.map((f) => ({
            id: f._id,
            name: String(f.name),
            color: String(f.color),
          }))}
        />
        <section className="panel stack" aria-labelledby="warn-title">
          <h3 id="warn-title">Warnings</h3>
          <p className="example-note">
            Warnings never block saving. The one thing the tree refuses is a person becoming their
            own ancestor.
          </p>
          {data.warnings.length === 0 ? (
            <p data-testid="no-tree-warnings">No warnings in the tree.</p>
          ) : (
            <ul className="warn-list" data-testid="tree-warnings">
              {data.warnings.map((w, i) => (
                <li key={i} className="status warning">
                  <span>{w.message}</span>{' '}
                  <button
                    type="button"
                    className="btn small"
                    onClick={() => setSelected(w.personIds[0] ?? null)}
                  >
                    Show {name(w.personIds[0] ?? '')}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </section>
      <TreeInspector
        key={selected ?? 'none'}
        graph={graph}
        selected={selected}
        year={year}
        collapsed={selected ? collapsed.has(selected) : false}
        onSelect={setSelected}
        onToggle={toggle}
        onOpen={props.onOpen}
      />
    </div>
  );
}

function Legend({ families }: { families: { id: string; name: string; color: string }[] }) {
  return (
    <div className="legend" aria-label="Tree legend">
      {families.map((f) => (
        <span key={f.id}>
          <span className={`sw fam-${f.color}`} />
          {f.name}
        </span>
      ))}
      <span>
        <span className="sw fam-none" />
        No family
      </span>
      <span>
        <svg className="ln" width="26" height="8" aria-hidden="true">
          <line x1="0" y1="4" x2="26" y2="4" className="tunion married" />
        </svg>
        Married
      </span>
      <span>
        <svg className="ln" width="26" height="8" aria-hidden="true">
          <line x1="0" y1="4" x2="26" y2="4" className="tunion partnered" />
        </svg>
        Partnered
      </span>
      {['biological', 'adoptive', 'step', 'guardian'].map((t) => (
        <span key={t}>
          <svg className="ln" width="26" height="8" aria-hidden="true">
            <line x1="0" y1="4" x2="26" y2="4" className={`tlink ${t}`} />
          </svg>
          {t[0]?.toUpperCase()}
          {t.slice(1)} parent
        </span>
      ))}
      <span className="example-note">
        Faint dashed box: not yet born. Heavy border: dead by this year. Dotted: birth unknown.
      </span>
      <span className="example-note" data-testid="tree-keys">
        Keys on a person: Enter or Space collapses or expands their branch when they have one, and
        opens the inspector when they do not. I opens the inspector for anyone.
      </span>
    </div>
  );
}

function TreeInspector(props: {
  graph: TreeGraph;
  selected: string | null;
  year: number;
  collapsed: boolean;
  onSelect: (id: string | null) => void;
  onToggle: (id: string) => void;
  onOpen: (collection: EntryCollection, id: string) => void;
}) {
  const { graph, selected } = props;
  const person = selected ? graph.byId.get(selected) : undefined;
  const [adding, setAdding] = useState<RelativeKind | null>(null);
  const [editing, setEditing] = useState<{ collection: EntryCollection; id: string } | null>(null);

  return (
    <aside
      className="inspector tree-inspector"
      aria-label="Tree inspector"
      data-testid="tree-inspector"
    >
      <span className="eyebrow">Inspector</span>
      <div className="row">
        <button type="button" className="btn primary small" onClick={() => setAdding('person')}>
          Add person
        </button>
      </div>
      {adding === 'person' && (
        <AddRelativeForm
          graph={graph}
          kind="person"
          anchor={null}
          onDone={(id) => {
            setAdding(null);
            if (id) props.onSelect(id);
          }}
        />
      )}
      {!selected && <p className="example-note">Pick a person in the tree to edit them here.</p>}
      {selected && person && (
        <div className="stack">
          <div className="stack tight">
            <h3 data-testid="inspector-name">{person.name}</h3>
            <p data-testid="inspector-state">
              {stateWords(lifeState(person, props.year), props.year)}
            </p>
          </div>
          <div className="row tight" role="group" aria-label={`Add a relative of ${person.name}`}>
            {(['parent', 'child', 'sibling', 'partner'] as const).map((k) => (
              <button
                key={k}
                type="button"
                className="btn small"
                aria-pressed={adding === k}
                onClick={() => setAdding(k)}
              >
                Add {k}
              </button>
            ))}
          </div>
          {adding && adding !== 'person' && (
            <AddRelativeForm
              graph={graph}
              kind={adding}
              anchor={person}
              onDone={(id) => {
                setAdding(null);
                if (id) props.onSelect(id);
              }}
            />
          )}
          <div className="row tight">
            {hasBranch(graph, person.id) && (
              <button type="button" className="btn small" onClick={() => props.onToggle(person.id)}>
                {props.collapsed ? 'Expand branch' : 'Collapse branch'}
              </button>
            )}
            <button
              type="button"
              className="btn small"
              onClick={() => props.onOpen('characters', person.id)}
            >
              Open the character page
            </button>
          </div>
          <LinkList graph={graph} person={person} onEdit={setEditing} onSelect={props.onSelect} />
          <LinkExistingForm graph={graph} person={person} />
        </div>
      )}
      {selected &&
        (editing ? (
          <div className="stack">
            <button type="button" className="btn small" onClick={() => setEditing(null)}>
              Back to {person?.name ?? 'the person'}
            </button>
            <EmbeddedEditor
              key={`${editing.collection}:${editing.id}`}
              collection={editing.collection}
              id={editing.id}
            />
          </div>
        ) : (
          <EmbeddedEditor key={`characters:${selected}`} collection="characters" id={selected} />
        ))}
      <UndoPanel />
    </aside>
  );
}

function useListItems(listId: string) {
  return useList(listId)?.items ?? [];
}

/** Add a person, or a parent, child, sibling, or partner of the selected person (FT-2). */
function AddRelativeForm(props: {
  graph: TreeGraph;
  kind: RelativeKind;
  anchor: TreePerson | null;
  onDone: (newId: string | null) => void;
}) {
  const { graph, kind, anchor } = props;
  const undo = useUndo();
  const linkTypes = useListItems('parentLinkTypes');
  const unionTypes = useListItems('unionTypes');
  const partners = anchor ? partnersOf(graph, anchor.id) : [];
  const [name, setName] = useState('');
  const [born, setBorn] = useState('');
  const [status, setStatus] = useState<Status>('idea');
  const [linkType, setLinkType] = useState('biological');
  const [unionType, setUnionType] = useState('married');
  const [coParent, setCoParent] = useState(partners[0] ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ids = { name: useId(), born: useId(), status: useId(), type: useId(), co: useId() };
  const noParents =
    kind === 'sibling' && anchor !== null && parentsOf(graph, anchor.id).length === 0;
  const title =
    kind === 'person' ? 'Add a person' : `Add a ${kind} of ${anchor?.name ?? 'this person'}`;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const year = born.trim() === '' ? null : Number(born);
    if (year !== null && !Number.isInteger(year)) {
      setError('The birth year must be a whole number, or blank for unknown.');
      return;
    }
    try {
      const plan = planAddRelative(
        graph,
        {
          kind,
          anchorId: anchor?.id ?? null,
          name,
          birthYear: year,
          status,
          linkType,
          unionType,
          coParentId: kind === 'child' && coParent ? coParent : null,
        },
        () => ulid(),
      );
      setBusy(true);
      await call('entry.createMany', {
        items: plan.map((p) => ({ collection: p.collection, data: p.data })),
      });
      const label =
        kind === 'person'
          ? `Added ${name.trim()}`
          : `Added ${name.trim()} as a ${kind} of ${anchor?.name}`;
      undo.record(addCommand(label, plan));
      props.onDone(plan[0]?.data._id ?? null);
    } catch (err) {
      setError(err instanceof TreeActionError ? err.message : plainError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <WriteFieldset>
      <form
        className="panel stack"
        onSubmit={(e) => void submit(e)}
        aria-label={title}
        data-testid="add-form"
      >
        <strong>{title}</strong>
        {noParents && (
          <p className="callout warn">
            {anchor?.name} has no known parents, so a sibling has no one to link to. Add a parent
            first.
          </p>
        )}
        <div className="field">
          <label htmlFor={ids.name}>Name</label>
          <input id={ids.name} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </div>
        <div className="field">
          <label htmlFor={ids.born}>Birth year</label>
          <input
            id={ids.born}
            type="number"
            className="num"
            value={born}
            placeholder="Blank for unknown"
            onChange={(e) => setBorn(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor={ids.status}>Status</label>
          <select
            id={ids.status}
            value={status}
            onChange={(e) => setStatus(e.target.value as Status)}
          >
            <option value="canon">Canon</option>
            <option value="planned">Planned</option>
            <option value="idea">Idea</option>
          </select>
        </div>
        {(kind === 'parent' || kind === 'child' || kind === 'sibling') && (
          <div className="field">
            <label htmlFor={ids.type}>Link type</label>
            <select id={ids.type} value={linkType} onChange={(e) => setLinkType(e.target.value)}>
              {linkTypes.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>
        )}
        {kind === 'partner' && (
          <div className="field">
            <label htmlFor={ids.type}>Union type</label>
            <select id={ids.type} value={unionType} onChange={(e) => setUnionType(e.target.value)}>
              {unionTypes.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>
        )}
        {kind === 'child' && (
          <div className="field">
            <label htmlFor={ids.co}>Other parent</label>
            <select id={ids.co} value={coParent} onChange={(e) => setCoParent(e.target.value)}>
              <option value="">No other parent</option>
              {partners.map((p) => (
                <option key={p} value={p}>
                  {graph.byId.get(p)?.name ?? p}
                </option>
              ))}
            </select>
          </div>
        )}
        {error && (
          <p className="callout crit" role="alert">
            {error}
          </p>
        )}
        <div className="row tight">
          <button
            type="submit"
            className="btn primary small"
            disabled={busy || !name.trim() || noParents}
          >
            {kind === 'person' ? 'Add the person' : `Add the ${kind}`}
          </button>
          <button type="button" className="btn small" onClick={() => props.onDone(null)}>
            Cancel
          </button>
        </div>
      </form>
    </WriteFieldset>
  );
}

/** Every union and parent link of the selected person, each with its type, an editor, and remove (FT-2). */
function LinkList(props: {
  graph: TreeGraph;
  person: TreePerson;
  onEdit: (e: { collection: EntryCollection; id: string }) => void;
  onSelect: (id: string) => void;
}) {
  const { graph, person } = props;
  const undo = useUndo();
  const ro = useWriteGuard();
  const linkTypes = useListItems('parentLinkTypes');
  const unionTypes = useListItems('unionTypes');
  const [error, setError] = useState<string | null>(null);
  const name = (id: string) => graph.byId.get(id)?.name ?? id;

  const setType = async (collection: 'unions' | 'parentLinks', id: string, type: string) => {
    setError(null);
    try {
      const before = (await call('entry.get', { collection, id })).entry;
      const { entry } = await call('entry.update', { collection, id, patch: { type } });
      undo.record(
        editCommand(
          `Changed the type of ${String(before.title ?? 'a link')} to ${type}`,
          collection,
          id,
          before,
          entry,
        ),
      );
    } catch (e) {
      setError(plainError(e));
    }
  };
  const remove = async (collection: 'unions' | 'parentLinks', id: string, title: string) => {
    setError(null);
    try {
      await call('entry.delete', { collection, id });
      undo.record(deleteCommand(collection, id, title));
    } catch (e) {
      setError(plainError(e));
    }
  };

  const rows = [
    ...(graph.parentLinks.get(person.id) ?? []).map((l) => ({
      collection: 'parentLinks' as const,
      id: l.id,
      role: 'Parent',
      other: l.parentId,
      type: l.type,
      detail: l.startYear !== null && l.type !== 'biological' ? `from ${l.startYear}` : '',
      title: `${name(l.parentId)} parent of ${person.name}`,
    })),
    ...(graph.childLinks.get(person.id) ?? []).map((l) => ({
      collection: 'parentLinks' as const,
      id: l.id,
      role: 'Child',
      other: l.childId,
      type: l.type,
      detail: l.startYear !== null && l.type !== 'biological' ? `from ${l.startYear}` : '',
      title: `${person.name} parent of ${name(l.childId)}`,
    })),
    ...(graph.unionsOf.get(person.id) ?? []).map((u) => ({
      collection: 'unions' as const,
      id: u.id,
      role: 'Partner',
      other: u.a === person.id ? u.b : u.a,
      type: u.type,
      detail:
        u.startYear === null && u.endYear === null
          ? 'years unknown'
          : `${u.startYear ?? '?'} to ${u.endYear ?? 'now'}`,
      title: `${name(u.a)} and ${name(u.b)}`,
    })),
  ];

  return (
    <div className="stack tight">
      <span className="eyebrow">Links</span>
      {rows.length === 0 ? (
        <p className="example-note">No unions or parent links yet.</p>
      ) : (
        <ul className="link-rows" data-testid="link-list">
          {rows.map((r) => (
            <li key={r.id} data-entry={r.id}>
              <span>
                {r.role}:{' '}
                <button type="button" className="link-btn" onClick={() => props.onSelect(r.other)}>
                  {name(r.other)}
                </button>
                {r.detail && <span className="example-note"> {r.detail}</span>}
              </span>
              <span className="row tight">
                <label className="sr-only" htmlFor={`type-${r.id}`}>
                  Type of the link with {name(r.other)}
                </label>
                <select
                  id={`type-${r.id}`}
                  value={r.type}
                  disabled={ro.off}
                  {...ro.tip}
                  onChange={(e) => void setType(r.collection, r.id, e.target.value)}
                >
                  {(r.collection === 'unions' ? unionTypes : linkTypes).map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.label}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="btn small"
                  aria-label={`Edit the link with ${name(r.other)}`}
                  onClick={() => props.onEdit({ collection: r.collection, id: r.id })}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="btn small danger"
                  aria-label={`Remove the link with ${name(r.other)}`}
                  onClick={() => void remove(r.collection, r.id, r.title)}
                  disabled={ro.off}
                  {...ro.tip}
                >
                  Remove
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p className="callout crit" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** Link the selected person to someone already in the tree. Self-ancestry is refused in plain words. */
function LinkExistingForm({ graph, person }: { graph: TreeGraph; person: TreePerson }) {
  const undo = useUndo();
  const linkTypes = useListItems('parentLinkTypes');
  const unionTypes = useListItems('unionTypes');
  const [kind, setKind] = useState<'parent' | 'child' | 'partner'>('child');
  const [other, setOther] = useState('');
  const [type, setType] = useState('biological');
  const [message, setMessage] = useState<{ text: string; bad: boolean } | null>(null);
  const ids = { kind: useId(), other: useId(), type: useId() };
  const types = kind === 'partner' ? unionTypes : linkTypes;
  const shownType = types.some((t) => t.id === type) ? type : (types[0]?.id ?? '');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setMessage(null);
    try {
      const plan = planLinkExisting(
        graph,
        { kind, anchorId: person.id, otherId: other, type: shownType, status: 'idea' },
        () => ulid(),
      );
      const { entry } = await call('entry.create', {
        collection: plan.collection,
        data: plan.data,
      });
      undo.record(createCommand(plan.collection, entry._id, String(plan.data.title)));
      setMessage({ text: `Linked. ${String(plan.data.title)}.`, bad: false });
      setOther('');
    } catch (err) {
      setMessage({
        text: err instanceof TreeActionError ? err.message : plainError(err),
        bad: true,
      });
    }
  };

  return (
    <WriteFieldset>
      <form
        className="panel stack"
        onSubmit={(e) => void submit(e)}
        aria-label="Link someone already in the tree"
      >
        <strong>Link someone already in the tree</strong>
        <div className="field">
          <label htmlFor={ids.kind}>They are {person.name}&apos;s</label>
          <select
            id={ids.kind}
            value={kind}
            onChange={(e) => setKind(e.target.value as typeof kind)}
          >
            <option value="parent">Parent</option>
            <option value="child">Child</option>
            <option value="partner">Partner</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor={ids.other}>Person</label>
          <select id={ids.other} value={other} onChange={(e) => setOther(e.target.value)}>
            <option value="">Pick a person</option>
            {graph.people
              .filter((p) => p.id !== person.id)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={ids.type}>{kind === 'partner' ? 'Union type' : 'Link type'}</label>
          <select id={ids.type} value={shownType} onChange={(e) => setType(e.target.value)}>
            {types.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
        <div className="row tight">
          <button type="submit" className="btn small" disabled={!other}>
            Link
          </button>
        </div>
        {message && (
          <p
            className={message.bad ? 'callout crit' : 'callout'}
            role={message.bad ? 'alert' : 'status'}
            data-testid="link-message"
          >
            {message.text}
          </p>
        )}
      </form>
    </WriteFieldset>
  );
}
