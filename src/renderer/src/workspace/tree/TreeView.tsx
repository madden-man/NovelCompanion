import { useBibleSettings, useDefaultStatus } from '../bibleSettings';
import { familyToken } from '../../../../shared/domain/lists';
import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { WriteFieldset, useWriteGuard } from '../../connection';
import type {
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from 'react';
import { ulid } from 'ulid';
import { entryTitle, fieldByName, manifests } from '../../../../shared/schema';
import type { EntryCollection } from '../../../../shared/schema';
import type { Response } from '../../../../shared/ipc';
import { lifeState, lifeYears } from '../../../../shared/domain/ages';
import type { LifeState } from '../../../../shared/domain/ages';
import {
  NODE_H,
  NODE_W,
  ROW_H,
  SIBLING_GAP,
  TreeActionError,
  assembleGraph,
  childrenOf,
  hasBranch,
  hideCollapsed,
  layoutFromPositions,
  parentsOf,
  partnersOf,
  planAddRelative,
  planLinkExisting,
  placeLayout,
  relativesOf,
  treeEdges,
  treeNodeKey,
} from '../../../../shared/domain/tree';
import type {
  PlannedEntry,
  RelativeKind,
  TreeGraph,
  TreePerson,
} from '../../../../shared/domain/tree';
import {
  createCommand,
  deleteCommand,
  editCommand,
  renameCommand,
} from '../../../../shared/domain/undoRunner';
import type { UndoCommand } from '../../../../shared/domain/undoRunner';
import { treeMoveCommand, treeMoves } from '../../../../shared/undoCommands';
import { call, plainError } from '../../api';
import { useEntries, useList, useStore } from '../data';
import { useGlossary } from '../Zh';
import { zhHint } from '../../../../shared/domain/zh';
import { EmbeddedEditor, SaveState, TrashControls, useAutosave } from '../editor';
import { Field } from '../fields';
import { openBackstory } from '../backstory/nav';
import { useStoryTime } from '../storyTime';
import { useUndo } from '../undo';
import { rasterize, standaloneSvg } from './exportImage';
import { Editable, mergeCommands, saveEntryField } from '../editable';
import { ColourBox } from '../colourBox';
import { ListSelect } from '../listSelect';

type TreeData = Response<'tree.get'>;
type View = { x: number; y: number; w: number; h: number };
type Status = 'canon' | 'planned' | 'idea';

const PAD = 40;
/** A pointer that moves less than this many screen pixels is a click, not a drag (FT-11). */
const DRAG_START = 4;
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
  /** FT-11: Alt with an arrow moves the person one slot, or one row. */
  onMove: (id: string, dx: number, dy: number) => void;
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
    if (e.altKey) {
      const step: Record<string, [number, number]> = {
        ArrowLeft: [-1, 0],
        ArrowRight: [1, 0],
        ArrowUp: [0, -1],
        ArrowDown: [0, 1],
      };
      const d = step[e.key];
      if (d) {
        e.preventDefault();
        p.onMove(p.person.id, d[0], d[1]);
      }
      return;
    }
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
      aria-keyshortcuts={p.branch ? 'Enter Space I Alt+ArrowKeys' : 'Enter Space I Alt+ArrowKeys'}
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
          className={c.startsWith('#') ? 'tnode-fam fam-hex' : `tnode-fam fam-${c}`}
          style={c.startsWith('#') ? { fill: c } : undefined}
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
 * The family tree (FT-1 to FT-11): one SVG of every family at the story year
 * (A45: the status bar and the Story time dialog set the year), pan and zoom,
 * collapse, PNG export, in-tree editing, and the FT-6 warnings in the
 * inspector. The layout and every age are pure code.
 */
export function TreeView(props: {
  onOpen: (collection: EntryCollection, id: string) => void;
  focus?: string;
}) {
  const { version } = useStore();
  const { year } = useStoryTime();
  const families = useEntries('families');
  const glossary = useGlossary();
  const [data, setData] = useState<TreeData | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [selected, setSelected] = useState<string | null>(props.focus ?? null);
  const [view, setView] = useState<View | null>(null);
  const [exportNote, setExportNote] = useState<{ text: string; bad: boolean } | null>(null);
  /** FT-11: the person being dragged and where they are right now, drawn live. */
  const [moving, setMoving] = useState<{ id: string; x: number; y: number } | null>(null);
  /** FT-11: a person dropped on another: the choice of link, or just the move, placed under the pointer. */
  const [drop, setDrop] = useState<{
    id: string;
    onto: string;
    x: number;
    y: number;
    left: number;
    top: number;
    error: string | null;
  } | null>(null);
  const [adding, setAdding] = useState<RelativeKind | null>(null);
  /** A45: the legend overlay in the tree's bottom left corner, closed until asked for. */
  const [legendOpen, setLegendOpen] = useState(false);
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
    const load = () =>
      void call('tree.get', {}).then((r) => {
        if (live) setData(r);
      });
    load();
    // A move written by an undo step (or another window) reaches the screen through this event.
    const off = window.api.on('tree.changed', load);
    return () => {
      live = false;
      off();
    };
  }, [version]);

  const graph = useMemo<TreeGraph | null>(
    () => (data ? assembleGraph(data.people, data.unions, data.links) : null),
    [data],
  );

  const saveSeq = useRef(0);
  const ro = useWriteGuard();
  const undo = useUndo();
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
    // FT-1 (A45): the tree always shows everyone; only collapsed branches are hidden.
    const everyone = new Set(graph.people.map((p) => p.id));
    const shown = hideCollapsed(graph, everyone, collapsed);
    const kept = new Map<string, { x: number; y: number }>();
    for (const [id, p] of placed.layout.nodes) if (shown.has(id)) kept.set(id, p);
    return layoutFromPositions(kept);
  }, [graph, placed, collapsed]);

  /** The layout with the dragged person where the pointer has them (FT-11). */
  const liveLayout = useMemo(() => {
    if (!layout || !moving || !layout.nodes.has(moving.id)) return layout;
    const m = new Map<string, { x: number; y: number }>();
    for (const [id, p] of layout.nodes) {
      m.set(id, id === moving.id ? { x: moving.x, y: moving.y } : { x: p.x, y: p.y });
    }
    return layoutFromPositions(m);
  }, [layout, moving]);

  const [confirmTidy, setConfirmTidy] = useState(false);
  const nameOf = useCallback((id: string) => graph?.byId.get(id)?.name ?? id, [graph]);
  const tidy = async () => {
    if (!graph) return;
    const { positions } = placeLayout(graph, null);
    saveSeq.current += 1;
    await call('tree.savePositions', { positions });
    const moves = treeMoves(data?.positions ?? null, positions);
    if (moves.length) undo.record(treeMoveCommand('Tidied the tree layout', call, moves, nameOf));
    setData((d) => (d ? { ...d, positions } : d));
    setConfirmTidy(false);
    fitted.current = false;
  };

  const edges = useMemo(
    () => (graph && liveLayout ? treeEdges(graph, liveLayout, year) : null),
    [graph, liveLayout, year],
  );

  /**
   * FT-11: put one person at a spot and keep it. The row snaps to the grid so
   * partners stay side by side and generations stay rows; someone with no ties
   * put in the row above the tree is loose there, as the layout would have them.
   */
  const moveTo = useCallback(
    async (id: string, x: number, y: number) => {
      if (!data || !graph || ro.off) return;
      const row = Math.round(y / ROW_H) * ROW_H;
      const ties =
        parentsOf(graph, id).length + childrenOf(graph, id).length + partnersOf(graph, id).length;
      const at =
        row === -ROW_H && ties === 0
          ? { x: Math.round(x), y: row, loose: true }
          : { x: Math.round(x), y: row };
      const before = data.positions?.[id] ?? null;
      const positions = { ...(data.positions ?? {}), [id]: at };
      saveSeq.current += 1;
      setData((d) => (d ? { ...d, positions } : d));
      await call('tree.savePositions', { positions });
      // One step per move (ED-3): undo puts the person back where they were.
      undo.record(
        treeMoveCommand(`Moved ${nameOf(id)}`, call, [{ id, before, after: at }], nameOf),
      );
    },
    [data, graph, ro.off, undo, nameOf],
  );
  const nudge = useCallback(
    (id: string, dx: number, dy: number) => {
      const at = layout?.nodes.get(id);
      if (!at) return;
      void moveTo(id, at.x + dx * (NODE_W + SIBLING_GAP), at.y + dy * ROW_H);
    },
    [layout, moveTo],
  );

  const colorOf = useMemo(() => {
    const m = new Map(families.map((f): [string, string] => [f._id, familyShade(f.color)]));
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
  /** FT-11: a press on a person; it becomes a drag once the pointer has moved DRAG_START. */
  const nodeDrag = useRef<{
    id: string;
    x: number;
    y: number;
    ox: number;
    oy: number;
    v: View;
    moved: boolean;
  } | null>(null);
  const toSvg = (el: SVGSVGElement, v: View, clientX: number, clientY: number) => {
    const r = el.getBoundingClientRect();
    return {
      x: v.x + ((clientX - r.left) / r.width) * v.w,
      y: v.y + ((clientY - r.top) / r.height) * v.h,
    };
  };
  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!view) return;
    const nodeEl = (e.target as Element).closest('.tnode');
    if (nodeEl) {
      if (ro.off || e.button !== 0 || (e.target as Element).closest('.tnode-toggle')) return;
      const id = nodeEl.getAttribute('data-person') ?? '';
      const at = layout?.nodes.get(id);
      if (!at) return;
      nodeDrag.current = {
        id,
        x: e.clientX,
        y: e.clientY,
        ox: at.x,
        oy: at.y,
        v: view,
        moved: false,
      };
      return;
    }
    drag.current = { x: e.clientX, y: e.clientY, v: view, id: e.pointerId };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.currentTarget.classList.add('dragging');
  };
  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const n = nodeDrag.current;
    if (n) {
      if (!n.moved) {
        if (Math.hypot(e.clientX - n.x, e.clientY - n.y) < DRAG_START) return;
        // Capture only once it is a drag, so a plain click still reaches the person.
        n.moved = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        e.currentTarget.classList.add('moving');
      }
      const k = n.v.w / e.currentTarget.clientWidth;
      setMoving({
        id: n.id,
        x: Math.round(n.ox + (e.clientX - n.x) * k),
        y: Math.round(n.oy + (e.clientY - n.y) * k),
      });
      return;
    }
    const d = drag.current;
    if (!d) return;
    const k = d.v.w / e.currentTarget.clientWidth;
    setView({ ...d.v, x: d.v.x - (e.clientX - d.x) * k, y: d.v.y - (e.clientY - d.y) * k });
  };
  const endDrag = (e: ReactPointerEvent<SVGSVGElement>) => {
    drag.current = null;
    e.currentTarget.classList.remove('dragging');
    const n = nodeDrag.current;
    if (!n) return;
    nodeDrag.current = null;
    e.currentTarget.classList.remove('moving');
    setMoving(null);
    if (!n.moved || e.type !== 'pointerup' || !layout) return;
    const k = n.v.w / e.currentTarget.clientWidth;
    const x = Math.round(n.ox + (e.clientX - n.x) * k);
    const y = Math.round(n.oy + (e.clientY - n.y) * k);
    // Dropped on someone: ask what the drop means before anything is written.
    const at = toSvg(e.currentTarget, n.v, e.clientX, e.clientY);
    let onto: string | null = null;
    for (const [id, p] of layout.nodes) {
      if (id === n.id) continue;
      if (at.x >= p.x && at.x <= p.x + NODE_W && at.y >= p.y && at.y <= p.y + NODE_H) onto = id;
    }
    if (onto) {
      const box = wrap.current?.getBoundingClientRect();
      setDrop({
        id: n.id,
        onto,
        x,
        y,
        left: Math.max(4, Math.min(e.clientX - (box?.left ?? 0), (box?.width ?? 400) - 300)),
        top: Math.max(4, Math.min(e.clientY - (box?.top ?? 0) + 4, (box?.height ?? 300) - 220)),
        error: null,
      });
      return;
    }
    void moveTo(n.id, x, y);
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

  /** FT-6 (A45): the warnings show in the inspector while nobody is selected. */
  const showWarnings = useCallback(() => {
    setSelected(null);
    setAdding(null);
  }, []);

  /** FT-9 (A45): one Export, always a PNG. */
  const exportPng = async () => {
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
      const png = await rasterize(markup, bbox.width, bbox.height, scale);
      const r = await call('tree.export', { png, fileName });
      setExportNote(
        r.saved
          ? { text: `Saved ${r.path ?? fileName}.`, bad: false }
          : { text: 'Export cancelled. Nothing was saved.', bad: false },
      );
    } catch (e) {
      setExportNote({ text: plainError(e), bad: true });
    }
  };

  if (!data || !graph || !layout || !liveLayout || !edges) {
    return (
      <div className="ws-tree-area tree-screen">
        <p aria-live="polite">Loading the family tree.</p>
      </div>
    );
  }
  const linkClass = (t: string) => (LINK_STYLES.has(t) ? t : 'other');
  const unionClass = (t: string) => (UNION_STYLES.has(t) ? t : 'other');

  return (
    <div className="ws-tree-area tree-screen" data-testid="tree-view" ref={area}>
      {/* A45: no heading or count; the toolbar and the tree fill the middle column. */}
      <section className="tree-main fill" aria-label="Family tree">
        <div className="tree-bar" role="toolbar" aria-label="Family tree tools">
          <button
            type="button"
            className="btn primary small"
            onClick={() => setAdding('person')}
            disabled={ro.off}
            {...ro.tip}
          >
            Add person
          </button>
          <button type="button" className="btn small" onClick={fit}>
            Fit to window
          </button>
          <button
            type="button"
            className="btn small"
            onClick={() => setConfirmTidy(true)}
            disabled={ro.off}
            {...ro.tip}
          >
            Tidy layout
          </button>
          <button type="button" className="btn small" onClick={() => void exportPng()}>
            Export
          </button>
          <button type="button" className="btn small" aria-pressed={full} onClick={toggleFull}>
            {full ? 'Exit full screen' : 'Full screen'}
          </button>
          {/* FT-6: the count clears the selection, so the inspector shows the warnings. */}
          <button
            type="button"
            className={`btn small tree-warn-count${data.warnings.length ? ' warn-chip' : ''}`}
            onClick={showWarnings}
            title="Show the warnings in the inspector"
            data-testid="tree-warn-count"
          >
            {data.warnings.length === 0
              ? 'No warnings'
              : `${data.warnings.length} ${data.warnings.length === 1 ? 'warning' : 'warnings'}`}
          </button>
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
              {[...graph.people]
                // The person being dragged is drawn last, over everyone.
                .sort((a, b) => (a.id === moving?.id ? 1 : b.id === moving?.id ? -1 : 0))
                .map((p) => {
                  const at = liveLayout.nodes.get(p.id);
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
                      onMove={nudge}
                      onCard={showCard}
                    />
                  );
                })}
            </g>
          </svg>
          {drop && (
            <DropMenu
              graph={graph}
              drop={drop}
              onMove={() => {
                const d = drop;
                setDrop(null);
                void moveTo(d.id, d.x, d.y);
              }}
              onError={(error) => setDrop((d) => (d ? { ...d, error } : d))}
              onDone={() => setDrop(null)}
            />
          )}
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
          <Legend
            open={legendOpen}
            onToggle={() => setLegendOpen((o) => !o)}
            families={families.map((f) => ({
              id: f._id,
              name: String(f.name),
              color: typeof f.color === 'string' ? f.color : null,
            }))}
          />
        </div>
      </section>
      <TreeInspector
        key={selected ?? 'none'}
        graph={graph}
        selected={selected}
        year={year}
        collapsed={selected ? collapsed.has(selected) : false}
        adding={adding}
        setAdding={setAdding}
        onSelect={setSelected}
        onToggle={toggle}
        onOpen={props.onOpen}
        warnings={data.warnings}
      />
    </div>
  );
}

/**
 * IP-12: how a family colour draws: one of the four series tokens (so it
 * follows the theme) or, for any other stored hex, the hex itself.
 */
function familyShade(color: unknown): string {
  const token = familyToken(color);
  if (token) return token;
  return typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color)
    ? color.toLowerCase()
    : 'series-1';
}

/**
 * The key to the tree's marks, a small overlay in its bottom left corner that
 * opens on request (A45). IP-12: each family renames in place and has a colour
 * box; the tree redraws with the new colour.
 */
function Legend(props: {
  open: boolean;
  onToggle: () => void;
  families: { id: string; name: string; color: string | null }[];
}) {
  const id = useId();
  const undo = useUndo();
  const ro = useWriteGuard();
  // A47 (IP-14): the link type labels are the bible's templates.
  const labels = useBibleSettings().templates.linkTypeLabels;
  return (
    <div className="tree-legend">
      {props.open && (
        <div className="legend panel" id={id} role="region" aria-label="Tree legend">
          {props.families.map((f) => (
            <span key={f.id} className="legend-family" data-family-id={f.id}>
              <ColourBox
                label={`Colour of ${f.name}`}
                value={f.color && /^#[0-9a-f]{6}$/i.test(f.color) ? f.color.toLowerCase() : null}
                disabled={ro.off}
                testId="legend-colour"
                onPick={async (hex) => {
                  await saveEntryField(undo, {
                    collection: 'families',
                    id: f.id,
                    path: 'color',
                    value: hex,
                    label: 'Display color',
                  });
                }}
              />
              <Editable
                kind="text"
                label={`Name of the ${f.name} family`}
                value={f.name}
                allowEmpty={false}
                testId="legend-family-name"
                onSave={async (next) => {
                  const to = next.trim();
                  const r = await call('lists.rename', {
                    listId: 'families',
                    itemId: f.id,
                    label: to,
                  });
                  undo.record(renameCommand('Families', 'families', f.id, r.from, to));
                }}
              />
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
            {labels.married}
          </span>
          <span>
            <svg className="ln" width="26" height="8" aria-hidden="true">
              <line x1="0" y1="4" x2="26" y2="4" className="tunion partnered" />
            </svg>
            {labels.partnered}
          </span>
          {['biological', 'adoptive', 'step', 'guardian'].map((t) => (
            <span key={t}>
              <svg className="ln" width="26" height="8" aria-hidden="true">
                <line x1="0" y1="4" x2="26" y2="4" className={`tlink ${t}`} />
              </svg>
              {labels[t]}
            </span>
          ))}
          <span className="legend-note">
            Faint dashed box: not yet born. Heavy border: dead by this year. Dotted: birth unknown.
          </span>
          <span className="legend-note" data-testid="tree-keys">
            Drag a person to move them. Drop them on someone to make them that person&apos;s parent,
            child or partner. Keys on a person: Enter or Space collapses or expands their branch
            when they have one, and opens the inspector when they do not. I opens the inspector for
            anyone. Alt with an arrow moves them one slot.
          </span>
        </div>
      )}
      <button
        type="button"
        className="btn small"
        aria-expanded={props.open}
        aria-controls={props.open ? id : undefined}
        onClick={props.onToggle}
      >
        {props.open ? 'Hide legend' : 'Legend'}
      </button>
    </div>
  );
}

/**
 * The tree's inspector, the one inspector this screen keeps (A45). With nobody
 * selected it shows the FT-6 warnings. With a person selected it shows their
 * name and state in the year, the character fields that matter here (FT-7),
 * then their family from the top down (FT-2), then the branch, page and
 * Remove controls.
 */
function TreeInspector(props: {
  graph: TreeGraph;
  selected: string | null;
  year: number;
  collapsed: boolean;
  adding: RelativeKind | null;
  setAdding: (kind: RelativeKind | null) => void;
  onSelect: (id: string | null) => void;
  onToggle: (id: string) => void;
  onOpen: (collection: EntryCollection, id: string) => void;
  warnings: TreeData['warnings'];
}) {
  const { graph, selected, adding, setAdding } = props;
  const name = (id: string) => graph.byId.get(id)?.name ?? id;
  const undo = useUndo();
  const person = selected ? graph.byId.get(selected) : undefined;
  const [editing, setEditing] = useState<{ collection: EntryCollection; id: string } | null>(null);

  return (
    <aside
      className="inspector tree-inspector"
      aria-label="Tree inspector"
      data-testid="tree-inspector"
    >
      <span className="eyebrow">Inspector</span>
      {!selected && adding !== 'person' && (
        <p className="example-note">
          Add person above the tree starts someone new. Pick a person in the tree to edit them here.
          Drag a person to move them, and drop them on someone to make them that person&apos;s
          parent, child or partner.
        </p>
      )}
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
      {!selected && (
        <section className="stack tight" aria-labelledby="warn-title">
          <h3 id="warn-title">Warnings</h3>
          <p className="example-note">
            Warnings never block saving. The one thing the tree refuses is a person becoming their
            own ancestor.
          </p>
          {props.warnings.length === 0 ? (
            <p data-testid="no-tree-warnings">No warnings in the tree.</p>
          ) : (
            <ul className="warn-list" data-testid="tree-warnings">
              {props.warnings.map((w, i) => (
                <li key={i} className="status warning">
                  <span>{w.message}</span>{' '}
                  <button
                    type="button"
                    className="btn small"
                    onClick={() => props.onSelect(w.personIds[0] ?? null)}
                  >
                    Show {name(w.personIds[0] ?? '')}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      {selected && person && (
        <div className="stack tight">
          <h3 data-testid="inspector-name">{person.name}</h3>
          <p data-testid="inspector-state">
            {stateWords(lifeState(person, props.year), props.year)}
          </p>
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
          <TreePersonForm key={`characters:${selected}`} id={selected} />
        ))}
      {selected && person && (
        <>
          <FamilyList
            graph={graph}
            person={person}
            adding={adding}
            setAdding={setAdding}
            onEdit={setEditing}
            onSelect={props.onSelect}
          />
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
          <TrashControls
            collection="characters"
            id={person.id}
            title={person.name}
            inTrash={false}
            label={`Remove ${person.name}`}
            beforeDelete={undo.flush}
            onChanged={() => undefined}
          />
        </>
      )}
    </aside>
  );
}

/**
 * FT-7 (A45): the selected person's own fields in the tree inspector: Name,
 * the name in Chinese characters, In the story, Description, Birth, Death and
 * Families, with the same autosave, warnings and undo as every editor (ED-2,
 * ED-3). Backstory is a link to the Backstory screen. Status, provenance,
 * source, tags and links are left to the character's own page; they stay stored.
 */
function TreePersonForm({ id }: { id: string }) {
  const ed = useAutosave('characters', id);
  const draft = ed.draft;
  if (ed.status === 'missing') return <p className="callout warn">This person no longer exists.</p>;
  if (!draft) return <p aria-live="polite">Loading the person.</p>;
  const inTrash = Boolean(draft.deletedAt);
  const messages = { warnings: ed.warnings, issues: ed.issues };
  const onMention = (targetId: string) => {
    const links = Array.isArray(draft.links)
      ? (draft.links as { targetId: string; kind: string }[])
      : [];
    if (!links.some((l) => l.targetId === targetId)) {
      ed.setField('links', [...links, { targetId, kind: 'mention' }]);
    }
  };
  const field = (name: string, opts: { label?: string; grow?: boolean } = {}) => {
    const base = fieldByName(PERSON_FIELDS, name);
    if (!base) return null;
    return (
      <Field
        key={name}
        spec={opts.label ? { ...base, label: opts.label } : base}
        value={draft[name]}
        path={name}
        messages={messages}
        root={draft}
        grow={opts.grow}
        onMention={onMention}
        onChange={(v) => ed.setField(name, v)}
      />
    );
  };
  const names = (draft.names ?? {}) as Record<string, unknown>;
  const nameSpec = (part: 'full' | 'chinese', label: string) => {
    const base = NAME_PARTS.find((s) => s.name === part);
    if (!base) return null;
    return (
      <Field
        key={part}
        spec={{ ...base, label }}
        value={names[part] ?? ''}
        path={`names.${part}`}
        messages={messages}
        root={draft}
        onMention={onMention}
        onChange={(v) => {
          const text = typeof v === 'string' ? v : '';
          ed.setField('names', { ...names, [part]: text });
          // The title is the name the app shows everywhere; it follows the full name.
          if (part === 'full') ed.setField('title', text);
        }}
      />
    );
  };

  return (
    <section
      className="stack embedded-editor tree-person"
      aria-label={`Edit ${entryTitle(draft)}`}
      data-testid="editor"
      data-entry-id={id}
    >
      <div className="row tight tree-person-head">
        <span className="eyebrow">Character</span>
        <SaveState status={ed.status} error={ed.error} />
      </div>
      {inTrash && (
        <>
          <p className="callout warn" role="status">
            This person is in the trash. Restore them to bring them back with their links.
          </p>
          <TrashControls
            collection="characters"
            id={id}
            title={entryTitle(draft)}
            inTrash
            beforeDelete={ed.flush}
            onChanged={ed.reload}
          />
        </>
      )}
      {ed.warnings.length > 0 && (
        <p className="callout warn" data-testid="warning-count">
          {ed.warnings.length === 1
            ? '1 field has a warning. It still saved.'
            : `${ed.warnings.length} fields have warnings. They still saved.`}
        </p>
      )}
      <form className="editor-fields" onSubmit={(e) => e.preventDefault()}>
        <WriteFieldset>
          {nameSpec('full', 'Name')}
          {nameSpec('chinese', 'Name in Chinese characters')}
          {field('role', { grow: true })}
          {field('body', { label: 'Description', grow: true })}
          {field('birth')}
          {field('death')}
          {field('familyIds')}
        </WriteFieldset>
      </form>
      <p className="tree-backstory">
        <span className="ed-label">Backstory</span>{' '}
        <button type="button" className="link-btn" onClick={() => openBackstory(id)}>
          Open in Backstory
        </button>
      </p>
    </section>
  );
}

/** The character fields the tree inspector edits (A45), from the one manifest. */
const PERSON_FIELDS = manifests.characters;
const NAME_PARTS = fieldByName(PERSON_FIELDS, 'names')?.fields ?? [];

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
  const defaultStatus = useDefaultStatus();
  const [status, setStatus] = useState<Status>(() => defaultStatus('idea') as Status);
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
          <ListSelect
            id={ids.status}
            listId="statuses"
            value={status}
            onChange={(v) => setStatus((v ?? defaultStatus('idea')) as Status)}
          />
        </div>
        {(kind === 'parent' || kind === 'child' || kind === 'sibling') && (
          <div className="field">
            <label htmlFor={ids.type}>Link type</label>
            <ListSelect
              id={ids.type}
              listId="parentLinkTypes"
              value={linkType}
              onChange={(v) => setLinkType(v ?? linkTypes[0]?.id ?? 'biological')}
            />
          </div>
        )}
        {kind === 'partner' && (
          <div className="field">
            <label htmlFor={ids.type}>Union type</label>
            <ListSelect
              id={ids.type}
              listId="unionTypes"
              value={unionType}
              onChange={(v) => setUnionType(v ?? unionTypes[0]?.id ?? 'married')}
            />
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

type FamilyRow = {
  /** The union or parent link, or for a sibling the sibling's own id. */
  id: string;
  other: string;
  detail: string;
  link: {
    collection: 'unions' | 'parentLinks';
    type: string;
    title: string;
  } | null;
};

/**
 * FT-2 (A45): the selected person's family at the foot of the inspector, from
 * the top down: Parents, then Partners and Siblings, then Children. Each union
 * and parent link has its type, an editor for its years, and Remove; siblings
 * follow from shared parents and only select. Each group adds its own kind of
 * relative, and the form opens under that group.
 */
function FamilyList(props: {
  graph: TreeGraph;
  person: TreePerson;
  adding: RelativeKind | null;
  setAdding: (kind: RelativeKind | null) => void;
  onEdit: (e: { collection: EntryCollection; id: string }) => void;
  onSelect: (id: string) => void;
}) {
  const { graph, person, adding, setAdding } = props;
  const undo = useUndo();
  const ro = useWriteGuard();
  const linkTypes = useListItems('parentLinkTypes');
  const unionTypes = useListItems('unionTypes');
  const [error, setError] = useState<string | null>(null);
  const name = (id: string) => graph.byId.get(id)?.name ?? id;
  const rel = relativesOf(graph, person.id);

  /** IP-8: a type Add new made on the way joins the change as one undo step. */
  const setType = async (
    collection: 'unions' | 'parentLinks',
    id: string,
    type: string,
    added?: UndoCommand,
  ) => {
    setError(null);
    try {
      const before = (await call('entry.get', { collection, id })).entry;
      const { entry } = await call('entry.update', { collection, id, patch: { type } });
      const step = editCommand(
        `Changed the type of ${String(before.title ?? 'a link')} to ${type}`,
        collection,
        id,
        before,
        entry,
      );
      undo.record(added ? mergeCommands(step.label, added, step) : step);
    } catch (e) {
      // The new type is in the list even though the link kept its old one: undo can take it out.
      if (added) undo.record(added);
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

  const since = (type: string, start: number | null) =>
    start !== null && type !== 'biological' ? `from ${start}` : '';
  const groups: {
    kind: 'parent' | 'partner' | 'sibling' | 'child';
    title: string;
    rows: FamilyRow[];
  }[] = [
    {
      kind: 'parent',
      title: 'Parents',
      rows: rel.parents.map((p) => ({
        id: p.linkId,
        other: p.id,
        detail: since(p.type, p.startYear),
        link: {
          collection: 'parentLinks',
          type: p.type,
          title: `${name(p.id)} parent of ${person.name}`,
        },
      })),
    },
    {
      kind: 'partner',
      title: 'Partners',
      rows: rel.partners.map((p) => ({
        id: p.unionId,
        other: p.id,
        detail:
          p.startYear === null && p.endYear === null
            ? 'years unknown'
            : `${p.startYear ?? '?'} to ${p.endYear ?? 'now'}`,
        link: {
          collection: 'unions',
          type: p.type,
          title: `${name(person.id)} and ${name(p.id)}`,
        },
      })),
    },
    {
      kind: 'sibling',
      title: 'Siblings',
      rows: rel.siblings.map((s) => ({
        id: s.id,
        other: s.id,
        detail: s.kind === 'half' ? 'half sibling' : '',
        link: null,
      })),
    },
    {
      kind: 'child',
      title: 'Children',
      rows: rel.children.map((c) => ({
        id: c.linkId,
        other: c.id,
        detail: since(c.type, c.startYear),
        link: {
          collection: 'parentLinks',
          type: c.type,
          title: `${person.name} parent of ${name(c.id)}`,
        },
      })),
    },
  ];

  return (
    <section className="stack tree-family" aria-labelledby="tree-family-title">
      <h3 id="tree-family-title">Family</h3>
      {groups.map((g) => (
        <div key={g.kind} className="stack tight" data-group={g.kind}>
          <div className="row tight tree-family-head">
            <span className="eyebrow">{g.title}</span>
            <WriteFieldset>
              <button
                type="button"
                className="btn small"
                aria-pressed={adding === g.kind}
                onClick={() => setAdding(g.kind)}
              >
                Add {g.kind}
              </button>
            </WriteFieldset>
          </div>
          {g.rows.length === 0 ? (
            <p className="example-note">None yet.</p>
          ) : (
            <ul className="link-rows" data-testid="link-list">
              {g.rows.map((r) => (
                <li key={r.id} data-entry={r.link ? r.id : undefined}>
                  <span>
                    <button
                      type="button"
                      className="link-btn"
                      onClick={() => props.onSelect(r.other)}
                    >
                      {name(r.other)}
                    </button>
                    {r.detail && <span className="example-note"> {r.detail}</span>}
                  </span>
                  {r.link && (
                    <FamilyRowControls
                      row={{ ...r, link: r.link }}
                      name={name(r.other)}
                      types={r.link.collection === 'unions' ? unionTypes : linkTypes}
                      listId={r.link.collection === 'unions' ? 'unionTypes' : 'parentLinkTypes'}
                      ro={ro}
                      onType={(type, added) =>
                        r.link && void setType(r.link.collection, r.id, type, added)
                      }
                      onEdit={() =>
                        r.link && props.onEdit({ collection: r.link.collection, id: r.id })
                      }
                      onRemove={() => r.link && void remove(r.link.collection, r.id, r.link.title)}
                    />
                  )}
                </li>
              ))}
            </ul>
          )}
          {adding === g.kind && (
            <AddRelativeForm
              graph={graph}
              kind={g.kind}
              anchor={person}
              onDone={(id) => {
                setAdding(null);
                if (id) props.onSelect(id);
              }}
            />
          )}
        </div>
      ))}
      {error && (
        <p className="callout crit" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

/** A link row's type, Edit (for its years) and Remove (FT-2). */
function FamilyRowControls(props: {
  row: FamilyRow & { link: NonNullable<FamilyRow['link']> };
  name: string;
  types: { id: string; label: string }[];
  /** IP-8: the list the types come from, for Add new. */
  listId: 'unionTypes' | 'parentLinkTypes';
  ro: ReturnType<typeof useWriteGuard>;
  onType: (type: string, added?: UndoCommand) => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const { row, name, ro } = props;
  return (
    <span className="row tight">
      <label className="sr-only" htmlFor={`type-${row.id}`}>
        Type of the link with {name}
      </label>
      <ListSelect
        id={`type-${row.id}`}
        listId={props.listId}
        value={row.link.type}
        disabled={ro.off}
        joinAdd
        onChange={(v, added) => {
          if (v) props.onType(v, added);
        }}
      />
      <button
        type="button"
        className="btn small"
        aria-label={`Edit the link with ${name}`}
        onClick={props.onEdit}
      >
        Edit
      </button>
      <button
        type="button"
        className="btn small danger"
        aria-label={`Remove the link with ${name}`}
        onClick={props.onRemove}
        disabled={ro.off}
        {...ro.tip}
      >
        Remove
      </button>
    </span>
  );
}

/**
 * FT-11: one person was dropped on another. The link is made with the first
 * link or union type, which the Links list can change; self-ancestry is refused
 * in plain words and nothing is written. Just move puts them where they were dropped.
 */
function DropMenu(props: {
  graph: TreeGraph;
  drop: { id: string; onto: string; left: number; top: number; error: string | null };
  onMove: () => void;
  onError: (message: string) => void;
  onDone: () => void;
}) {
  const { graph, drop } = props;
  const undo = useUndo();
  const linkTypes = useListItems('parentLinkTypes');
  const unionTypes = useListItems('unionTypes');
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    first.current?.focus();
  }, []);
  const A = graph.byId.get(drop.id)?.name ?? drop.id;
  const B = graph.byId.get(drop.onto)?.name ?? drop.onto;

  const link = async (kind: 'parent' | 'child' | 'partner') => {
    try {
      const type =
        kind === 'partner'
          ? (unionTypes.find((t) => t.id === 'married')?.id ?? unionTypes[0]?.id ?? 'married')
          : (linkTypes.find((t) => t.id === 'biological')?.id ?? linkTypes[0]?.id ?? 'biological');
      // The dropped person is the parent, child or partner of the one they landed on.
      const plan = planLinkExisting(
        graph,
        { kind, anchorId: drop.onto, otherId: drop.id, type, status: 'idea' },
        () => ulid(),
      );
      const { entry } = await call('entry.create', {
        collection: plan.collection,
        data: plan.data,
      });
      undo.record(createCommand(plan.collection, entry._id, String(plan.data.title)));
      props.onDone();
    } catch (err) {
      props.onError(err instanceof TreeActionError ? err.message : plainError(err));
    }
  };

  return (
    <div
      className="tree-drop panel stack tight"
      role="dialog"
      aria-label={`${A} dropped on ${B}`}
      data-testid="tree-drop"
      style={{ left: drop.left, top: drop.top }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          props.onDone();
        }
      }}
    >
      <strong>
        {A} on {B}
      </strong>
      <button ref={first} type="button" className="btn small" onClick={() => void link('parent')}>
        Make {A} a parent of {B}
      </button>
      <button type="button" className="btn small" onClick={() => void link('child')}>
        Make {A} a child of {B}
      </button>
      <button type="button" className="btn small" onClick={() => void link('partner')}>
        Make {A} and {B} partners
      </button>
      <button type="button" className="btn small" onClick={props.onMove}>
        Just move {A} here
      </button>
      <button type="button" className="btn small" onClick={props.onDone}>
        Cancel
      </button>
      {drop.error && (
        <p className="callout crit" role="alert">
          {drop.error}
        </p>
      )}
    </div>
  );
}
