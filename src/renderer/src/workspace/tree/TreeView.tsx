import { useBibleSettings } from '../bibleSettings';
import { familyToken } from '../../../../shared/domain/lists';
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
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
import { positionQueue } from './positionQueue';
import './tree.css';

type TreeData = Response<'tree.get'>;
type View = { x: number; y: number; w: number; h: number };

const PAD = 40;
/** A pointer that moves less than this many screen pixels is a click, not a drag (FT-11). */
const DRAG_START = 4;
/** A57: the drop zones a dragged person sees over another, in screen pixels. */
const ZONE_W = 210;
const ZONE_HEAD = 24;
const ZONE_ROW = 30;
const ZONE_H = ZONE_HEAD + 3 * ZONE_ROW;
const ZONE_KINDS = ['parent', 'partner', 'child'] as const;
type Zones = {
  id: string;
  onto: string;
  left: number;
  top: number;
  hot: StubKind | null;
  refused: StubKind[];
};
/** A57: how long the Tidy layout notice with its Undo button stays. */
const TOAST_MS = 8000;
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
  /** A57: the + parent, + partner and + child stubs; absent while read-only. */
  onAdd?: (id: string, kind: StubKind) => void;
}

type StubKind = 'parent' | 'partner' | 'child';
const STUB_W = 62;
const STUB_H = 18;
/** A57: where each stub sits on a person: parent on top, partner at the side, child below. */
const STUBS: { kind: StubKind; x: number; y: number }[] = [
  { kind: 'parent', x: (NODE_W - STUB_W) / 2, y: -STUB_H / 2 },
  { kind: 'partner', x: NODE_W - STUB_W + 16, y: 4 },
  { kind: 'child', x: (NODE_W - STUB_W) / 2, y: NODE_H - STUB_H / 2 },
];

/** One person in the tree (FT-7): name, years, and their state in the year (FT-5). */
const TreeNode = memo(function TreeNode(p: NodeProps) {
  const s = lifeState(p.person, p.year);
  const years = lifeYears(p.person);
  const label = p.person.chinese ? `${p.person.name} ${p.person.chinese}` : p.person.name;
  const aria = `${label}, ${years === 'unknown' ? 'born unknown' : years}, ${stateText(s)}${p.hint ? `, ${p.hint}` : ''}`;
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
      {p.onAdd &&
        STUBS.map((st) => {
          const add = () => p.onAdd?.(p.person.id, st.kind);
          return (
            <g
              key={st.kind}
              className={`tnode-stub stub-${st.kind}`}
              data-export="skip"
              data-stub={st.kind}
              tabIndex={0}
              role="button"
              aria-label={`Add a ${st.kind} of ${p.person.name}`}
              transform={`translate(${st.x},${st.y})`}
              onClick={(e) => {
                e.stopPropagation();
                add();
              }}
              onDoubleClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  e.stopPropagation();
                  add();
                }
              }}
            >
              <rect width={STUB_W} height={STUB_H} rx={STUB_H / 2} />
              <text x={STUB_W / 2} y={13} textAnchor="middle">
                + {st.kind}
              </text>
            </g>
          );
        })}
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
  /** A57: while a person is dragged over another, that person's three drop zones. */
  const [zones, setZones] = useState<Zones | null>(null);
  const zonesRef = useRef<Zones | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  /**
   * A57: Tidy layout's notice, with an Undo button for its own step only. It
   * shows while that step is the latest one; another step or an undo hides it.
   */
  const [toast, setToast] = useState<{ text: string; cmd: UndoCommand } | null>(null);
  /** Tidy layout runs once at a time, so a double click records one step. */
  const tidying = useRef(false);
  const [tidyBusy, setTidyBusy] = useState(false);
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
  /** The positions as last read or written, the base each queued position write builds on. */
  const stored = useRef<TreeData['positions']>(null);
  /** A57: position writes queued or running, and how many were ever queued. */
  const queue = useRef(positionQueue());
  /** A57: a read set aside while writes were queued, read again once they are done. */
  const reloadTree = useRef<() => void>(() => undefined);

  useEffect(() => {
    let live = true;
    const load = () => {
      const ticket = queue.current.ticket();
      void call('tree.get', {}).then((r) => {
        if (!live) return;
        // A read from before a queued write landed would set the queue's base back and
        // drop that write's move from the next one: it is read again when the queue is idle.
        const take = queue.current.fresh(ticket);
        if (take === 'again') return load();
        if (take === 'skip') return;
        stored.current = r.positions ?? null;
        setData(r);
      });
    };
    reloadTree.current = load;
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
  /**
   * Position writes go one after another: two in flight at once (the save that
   * places someone just added, then Tidy layout) can land in either order, and
   * the older layout would win.
   */
  const writes = useRef<Promise<unknown>>(Promise.resolve());
  /**
   * Each write builds its positions when its turn comes, from the positions the
   * write before it left, so a queued write never carries a stale base. A failed
   * write leaves that base as it was and the queue goes on.
   */
  const savePositions = useCallback(
    (build: (base: TreeData['positions']) => NonNullable<TreeData['positions']>) => {
      queue.current.enter();
      const next = writes.current.then(async () => {
        const base = stored.current;
        const positions = build(base);
        await call('tree.savePositions', { positions });
        stored.current = positions;
        return { base, positions };
      });
      writes.current = next
        .catch(() => undefined)
        .finally(() => {
          if (queue.current.leave()) reloadTree.current();
        });
      return next;
    },
    [],
  );
  const ro = useWriteGuard();
  const undo = useUndo();
  // Stored positions are kept; only new people are placed (FT-10).
  const placed = useMemo(
    () => (graph && data ? placeLayout(graph, data.positions) : null),
    [graph, data],
  );

  useEffect(() => {
    // ARCH-6: a read-only snapshot places new people on screen without saving them.
    if (!placed?.changed || ro.off || !graph) return;
    const seq = ++saveSeq.current;
    savePositions((base) => placeLayout(graph, base).positions).then(
      ({ positions }) => {
        if (seq === saveSeq.current) setData((d) => (d ? { ...d, positions } : d));
      },
      (err: unknown) => setLinkError(`Could not save the layout: ${plainError(err)}`),
    );
  }, [placed, graph, ro.off, savePositions]);

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

  const nameOf = useCallback((id: string) => graph?.byId.get(id)?.name ?? id, [graph]);
  const tidy = async () => {
    if (!graph || tidying.current) return;
    tidying.current = true;
    setTidyBusy(true);
    setLinkError(null);
    try {
      const { positions } = placeLayout(graph, null);
      saveSeq.current += 1;
      const { base } = await savePositions(() => positions);
      const moves = treeMoves(base, positions);
      if (moves.length) {
        const cmd = treeMoveCommand('Tidied the tree layout', call, moves, nameOf);
        undo.record(cmd);
        setToast({ text: 'Layout tidied', cmd });
      }
      setData((d) => (d ? { ...d, positions } : d));
      fitted.current = false;
    } catch (err) {
      setLinkError(`Could not tidy the layout: ${plainError(err)}`);
    } finally {
      tidying.current = false;
      setTidyBusy(false);
    }
  };
  const toastLive = toast !== null && undo.history.undo[0] === toast.cmd;
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(t);
  }, [toast]);

  const linkTypes = useListItems('parentLinkTypes');
  const unionTypes = useListItems('unionTypes');
  /** The drop zones a link would be refused on: self-ancestry, or a parent link that exists. */
  const refusedKinds = useCallback(
    (id: string, onto: string): StubKind[] =>
      graph
        ? ZONE_KINDS.filter((kind) => {
            try {
              planLinkExisting(graph, { kind, anchorId: onto, otherId: id, type: 'x' }, () => 'x');
              return false;
            } catch {
              return true;
            }
          })
        : [],
    [graph],
  );
  /** FT-11: the dropped person becomes the parent, partner or child of the one under them. */
  const linkDrop = async (id: string, onto: string, kind: StubKind) => {
    if (!graph) return;
    setLinkError(null);
    try {
      const type =
        kind === 'partner'
          ? (unionTypes.find((t) => t.id === 'married')?.id ?? unionTypes[0]?.id ?? 'married')
          : (linkTypes.find((t) => t.id === 'biological')?.id ?? linkTypes[0]?.id ?? 'biological');
      const plan = planLinkExisting(graph, { kind, anchorId: onto, otherId: id, type }, () =>
        ulid(),
      );
      const { entry } = await call('entry.create', {
        collection: plan.collection,
        data: plan.data,
      });
      undo.record(createCommand(plan.collection, entry._id, String(plan.data.title)));
    } catch (err) {
      setLinkError(err instanceof TreeActionError ? err.message : plainError(err));
    }
  };
  /** A57: a stub on a person selects them and opens the add form for that kind. */
  const addFrom = useCallback((id: string, kind: StubKind) => {
    setSelected(id);
    setAdding(kind);
  }, []);

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
      saveSeq.current += 1;
      setData((d) => (d ? { ...d, positions: { ...(d.positions ?? {}), [id]: at } } : d));
      try {
        const { base } = await savePositions((b) => ({ ...(b ?? {}), [id]: at }));
        // One step per move (ED-3): undo puts the person back where they were.
        const before = base?.[id] ?? null;
        undo.record(
          treeMoveCommand(`Moved ${nameOf(id)}`, call, [{ id, before, after: at }], nameOf),
        );
      } catch (err) {
        setLinkError(`Could not move ${nameOf(id)}: ${plainError(err)}`);
        // The screen goes back to what is stored.
        setData((d) => (d ? { ...d, positions: stored.current } : d));
      }
    },
    [data, graph, ro.off, undo, nameOf, savePositions],
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

  /** The tree box's size when the view last matched it, so a resize keeps everyone in place. */
  const boxSize = useRef<{ w: number; h: number } | null>(null);
  const fit = useCallback(() => {
    const el = wrap.current;
    if (el && el.clientWidth > 0) boxSize.current = { w: el.clientWidth, h: el.clientHeight };
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

  /**
   * A57: the tree box changed size (the inspector came or went, or the window
   * resized): widen or narrow the view with it, so the people stay where they
   * are on screen.
   */
  const followBox = useCallback(() => {
    const el = wrap.current;
    if (!el) return;
    const w = el.clientWidth;
    const h = el.clientHeight;
    const was = boxSize.current;
    boxSize.current = { w, h };
    if (!was || !was.w || !was.h || !w || !h || (was.w === w && was.h === h)) return;
    setView((v) => (v ? { ...v, w: (v.w * w) / was.w, h: (v.h * h) / was.h } : v));
  }, []);
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(followBox);
    ro.observe(el);
    return () => ro.disconnect();
  }, [data, followBox]);

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

  const drag = useRef<{ x: number; y: number; v: View; id: number; moved: boolean } | null>(null);
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
      const el = e.target as Element;
      if (ro.off || e.button !== 0 || el.closest('.tnode-toggle, .tnode-stub')) return;
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
    drag.current = { x: e.clientX, y: e.clientY, v: view, id: e.pointerId, moved: false };
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
      trackZones(e.currentTarget, n, e.clientX, e.clientY);
      return;
    }
    const d = drag.current;
    if (!d) return;
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) >= DRAG_START) d.moved = true;
    const k = d.v.w / e.currentTarget.clientWidth;
    setView({ ...d.v, x: d.v.x - (e.clientX - d.x) * k, y: d.v.y - (e.clientY - d.y) * k });
  };
  /**
   * A57: over another person, a dragged person sees that person's three drop
   * zones (parent above, partner in the middle, child below); the one under the
   * pointer is hot. A zone the link would be refused on is drawn disabled.
   */
  const trackZones = (
    el: SVGSVGElement,
    n: { id: string; v: View },
    clientX: number,
    clientY: number,
  ) => {
    const box = wrap.current?.getBoundingClientRect();
    if (!box || !layout) return;
    const px = clientX - box.left;
    const py = clientY - box.top;
    let z = zonesRef.current;
    const inside = (q: Zones) =>
      px >= q.left && px <= q.left + ZONE_W && py >= q.top && py <= q.top + ZONE_H;
    if (z && !inside(z)) z = null;
    if (!z) {
      const at = toSvg(el, n.v, clientX, clientY);
      let onto: string | null = null;
      for (const [id, p] of layout.nodes) {
        if (id === n.id) continue;
        if (at.x >= p.x && at.x <= p.x + NODE_W && at.y >= p.y && at.y <= p.y + NODE_H) onto = id;
      }
      const p = onto ? layout.nodes.get(onto) : undefined;
      if (onto && p) {
        const r = el.getBoundingClientRect();
        const cx = ((p.x + NODE_W / 2 - n.v.x) / n.v.w) * r.width + r.left - box.left;
        const cy = ((p.y + NODE_H / 2 - n.v.y) / n.v.h) * r.height + r.top - box.top;
        z = {
          id: n.id,
          onto,
          left: Math.max(4, Math.min(cx - ZONE_W / 2, box.width - ZONE_W - 4)),
          top: Math.max(4, Math.min(cy - ZONE_HEAD - ZONE_ROW * 1.5, box.height - ZONE_H - 4)),
          hot: null,
          refused: refusedKinds(n.id, onto),
        };
      }
    }
    if (z) {
      const row = Math.floor((py - z.top - ZONE_HEAD) / ZONE_ROW);
      z = { ...z, hot: ZONE_KINDS[row] ?? null };
    }
    const was = zonesRef.current;
    zonesRef.current = z;
    if (was?.onto !== z?.onto || was?.hot !== z?.hot || was?.left !== z?.left) setZones(z);
  };

  const endDrag = (e: ReactPointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    drag.current = null;
    e.currentTarget.classList.remove('dragging');
    // A click on the empty tree, without a pan, puts the selection down.
    if (d && !d.moved && e.type === 'pointerup') {
      setSelected(null);
      setAdding(null);
    }
    const z = zonesRef.current;
    zonesRef.current = null;
    setZones(null);
    const n = nodeDrag.current;
    if (!n) return;
    nodeDrag.current = null;
    e.currentTarget.classList.remove('moving');
    setMoving(null);
    if (!n.moved || e.type !== 'pointerup' || !layout) return;
    // Dropped on someone: the zone under the pointer says how they are linked.
    // Released on a refused zone, or between zones, nothing is written and nobody moves.
    if (z) {
      if (z.hot && !z.refused.includes(z.hot)) void linkDrop(n.id, z.onto, z.hot);
      return;
    }
    const k = n.v.w / e.currentTarget.clientWidth;
    void moveTo(
      n.id,
      Math.round(n.ox + (e.clientX - n.x) * k),
      Math.round(n.oy + (e.clientY - n.y) * k),
    );
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

  // A57: the inspector shows with a selection, the Add person form, or warnings to show.
  const inspecting = Boolean(selected) || adding === 'person' || Boolean(data?.warnings.length);
  // The column changes in this commit: follow it before the paint, not a frame later,
  // or the tree is drawn centred in the new box for a moment and people jump sideways.
  useLayoutEffect(() => {
    followBox();
  }, [inspecting, followBox]);

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
    <div
      className={`ws-tree-area tree-screen${inspecting ? '' : ' tree-solo'}`}
      data-testid="tree-view"
      ref={area}
    >
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
            onClick={() => void tidy()}
            disabled={ro.off || tidyBusy}
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
            data-testid="tree-warn-count"
          >
            {data.warnings.length === 0
              ? 'No warnings'
              : `${data.warnings.length} ${data.warnings.length === 1 ? 'warning' : 'warnings'}`}
          </button>
        </div>
        {exportNote && (
          <p
            className={exportNote.bad ? 'callout crit' : 'callout'}
            role="status"
            data-testid="export-note"
          >
            {exportNote.text}
          </p>
        )}
        {linkError && (
          <p className="callout crit" role="alert" data-testid="tree-link-error">
            {linkError}
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
                      onAdd={ro.off ? undefined : addFrom}
                    />
                  );
                })}
            </g>
          </svg>
          {zones && <DropZones graph={graph} zones={zones} />}
          {toast && toastLive && (
            <div className="tree-toast" role="status" data-testid="tree-toast">
              <span>{toast.text}</span>
              <button
                type="button"
                className="btn small"
                onClick={() => {
                  setToast(null);
                  // Only its own step: anything recorded since has hidden the notice.
                  if (undo.history.undo[0] === toast.cmd) void undo.undo();
                }}
              >
                Undo
              </button>
            </div>
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
            year={year}
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
      {inspecting && (
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
      )}
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
  year: number;
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
        </div>
      )}
      <div className="tree-key-row">
        <button
          type="button"
          className="btn small"
          aria-expanded={props.open}
          aria-controls={props.open ? id : undefined}
          onClick={props.onToggle}
        >
          {props.open ? 'Hide legend' : 'Legend'}
        </button>
        {/* A57: the life states as drawn swatches, a key and not a sentence. */}
        <ul className="tree-key" aria-label="Key" data-testid="tree-key">
          {(
            [
              ['unborn', 'not born yet'],
              ['dead', `dead by ${props.year}`],
              ['unknown', 'birth unknown'],
            ] as const
          ).map(([state, label]) => (
            <li key={state} data-key={state}>
              <svg width="22" height="14" aria-hidden="true">
                <rect
                  className={`tkey-box ${state}`}
                  x={1.5}
                  y={1.5}
                  width={19}
                  height={11}
                  rx={3}
                />
              </svg>
              {label}
            </li>
          ))}
        </ul>
      </div>
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
      {!selected && props.warnings.length > 0 && (
        <section className="stack tight" aria-labelledby="warn-title">
          <h3 id="warn-title">Warnings</h3>
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
                {props.collapsed ? 'Expand branch' : 'Collapse branch'} <kbd>Enter</kbd>
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
 * ED-3). Backstory is a link to the Backstory screen.
 */
function TreePersonForm({ id }: { id: string }) {
  const ed = useAutosave('characters', id);
  const draft = ed.draft;
  if (ed.status === 'missing') return <p className="callout warn">This person no longer exists.</p>;
  if (!draft) return <p aria-live="polite">Loading the person.</p>;
  const inTrash = Boolean(draft.deletedAt);
  const messages = { warnings: ed.warnings, issues: ed.issues };
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
            This person is in the trash.
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
            ? '1 field has a warning.'
            : `${ed.warnings.length} fields have warnings.`}
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

/** A57: a year box keeps only the digits typed into it. */
const digits = (t: string): string => t.replace(/\D/g, '').slice(0, 5);

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
  const [linkType, setLinkType] = useState('biological');
  const [unionType, setUnionType] = useState('married');
  const [coParent, setCoParent] = useState(partners[0] ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ids = { name: useId(), born: useId(), type: useId(), co: useId() };
  const noParents =
    kind === 'sibling' && anchor !== null && parentsOf(graph, anchor.id).length === 0;
  const title =
    kind === 'person' ? 'Add a person' : `Add a ${kind} of ${anchor?.name ?? 'this person'}`;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    // A57: the box takes digits only; empty means the year is unknown.
    const year = born === '' ? null : Number(born);
    try {
      const plan = planAddRelative(
        graph,
        {
          kind,
          anchorId: anchor?.id ?? null,
          name,
          birthYear: year,
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
        {noParents && <p className="callout warn">{anchor?.name} has no known parents.</p>}
        <div className="field">
          <label htmlFor={ids.name}>Name</label>
          <input id={ids.name} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </div>
        <div className="field">
          <label htmlFor={ids.born}>Birth year</label>
          <input
            id={ids.born}
            className="num"
            inputMode="numeric"
            value={born}
            onChange={(e) => setBorn(digits(e.target.value))}
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

  const { lists } = useStore();
  /** The type's name for the undo label, from its list; read afresh for an item Add new just made. */
  const typeLabel = async (collection: 'unions' | 'parentLinks', type: string) => {
    const listId = collection === 'unions' ? 'unionTypes' : 'parentLinkTypes';
    const find = (all: readonly { _id: string; items: { id: string; label: string }[] }[]) =>
      all.find((l) => l._id === listId)?.items.find((i) => i.id === type)?.label;
    return find(lists) ?? find((await call('lists.get', {})).lists) ?? type;
  };
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
        `Changed the type of ${String(before.title ?? 'a link')} to ${await typeLabel(collection, type)}`,
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
 * A57 (FT-11): the three drop zones over the person a dragged person is held
 * above. The zone under the pointer is hot; a zone the link would be refused
 * on (self-ancestry, a parent link that exists) is drawn disabled.
 */
function DropZones(props: { graph: TreeGraph; zones: Zones }) {
  const { graph, zones } = props;
  const A = graph.byId.get(zones.id)?.name ?? zones.id;
  const B = graph.byId.get(zones.onto)?.name ?? zones.onto;
  return (
    <div
      className="tree-zones"
      role="group"
      aria-label={`Drop ${A} on ${B}`}
      data-testid="tree-zones"
      data-onto={zones.onto}
      style={{ left: zones.left, top: zones.top, width: ZONE_W }}
    >
      <div className="tree-zones-head" style={{ height: ZONE_HEAD }}>
        {B}
      </div>
      {ZONE_KINDS.map((kind) => {
        const refused = zones.refused.includes(kind);
        return (
          <div
            key={kind}
            className={`tree-zone${zones.hot === kind ? ' hot' : ''}${refused ? ' refused' : ''}`}
            data-zone={kind}
            aria-disabled={refused || undefined}
            style={{ height: ZONE_ROW }}
          >
            as {B}&apos;s {kind}
          </div>
        );
      })}
    </div>
  );
}
