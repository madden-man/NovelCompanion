import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import {
  EMPTY_OUTLINE,
  LEAD,
  MAX_YEAR,
  MIN_YEAR,
  composeFlow,
  continueBullet,
  edgeLimits,
  indentLines,
  moveEdge,
  moveOnto,
  neighbourOf,
  refitFlow,
  retext,
  sameBreaks,
  sameYears,
  sceneLines,
  sectionOf,
  sectionScenes,
  setSceneYear,
  shownYears,
  sliceSection,
  splitFlow,
  withSection,
} from '../../../../shared/domain/sceneOutline';
import type { Flow, SceneOutlineState, ShownYear } from '../../../../shared/domain/sceneOutline';
import { shiftStrand } from '../../../../shared/domain/strands';
import type { Response } from '../../../../shared/ipc';
import { entryTitle } from '../../../../shared/schema';
import type { EntryCollection } from '../../../../shared/schema';
import { useWriteGuard } from '../../connection';
import { call, plainError } from '../../api';
import { useEntries, useStore } from '../data';
import { useStoryTime } from '../storyTime';
import { useUndo } from '../undo';
import type { Op } from '../undo';
import { Zh } from '../Zh';
import { useOutlineWrites } from './actions';
import { InlineName } from './InlineName';

type Outline = Response<'outline.get'>;
type ChapterRow = Extract<Outline['rows'][number], { kind: 'chapter' }>;
type VersionSummary = Response<'sceneOutline.versions'>['versions'][number];
type Version = Response<'sceneOutline.version'>;
type Open = (collection: EntryCollection, id: string) => void;

/** Autosave timing for the scene outline, the same as an entry (ED-2). */
const SCENE_DEBOUNCE_MS = 500;
const SCENE_MAX_WAIT_MS = 700;

type SceneStatus = 'loading' | 'saved' | 'pending' | 'saving' | 'error';

const sameState = (a: SceneOutlineState | null, b: SceneOutlineState) =>
  a !== null && a.text === b.text && sameBreaks(a.breaks, b.breaks) && sameYears(a.years, b.years);

const stateOf = (r: SceneOutlineState): SceneOutlineState => ({
  text: r.text,
  breaks: r.breaks,
  years: r.years,
});

/**
 * The outline on screen, for undo steps that outlive it: an edge move undone
 * after leaving the screen writes the stored outline directly.
 */
const live: {
  current: { state(): SceneOutlineState | null; adopt(s: SceneOutlineState): Promise<void> } | null;
} = { current: null };

/** SM-7: an undo or redo step that puts the scene outline back to `to`, when it still holds `expect`. */
function outlineOp(expect: SceneOutlineState, to: SceneOutlineState): Op {
  return {
    kind: 'run',
    check: async () => {
      const now = live.current?.state() ?? stateOf(await call('sceneOutline.get', {}));
      return now && sameState(now, expect) ? null : 'the scene outline changed since';
    },
    apply: async () => {
      if (live.current) await live.current.adopt(to);
      else await call('sceneOutline.set', to);
    },
  };
}

/**
 * The scene outline as a flow with its autosave. The stored text is split
 * into the chapters' sections once the reading order is known; every change
 * updates the flow at once and is written, joined back in reading order, 500
 * ms after the last one and never more than 700 ms after the first unsaved
 * one. A new reading order (a chapter moved, made, or put in the trash) is
 * written too, since the text and its years follow their chapters.
 */
function useSceneDoc(order: readonly string[] | null, readOnly: boolean) {
  const undo = useUndo();
  const [loaded, setLoaded] = useState<SceneOutlineState | null>(null);
  const [flow, setFlow] = useState<Flow | null>(null);
  const [status, setStatus] = useState<SceneStatus>('loading');
  const [error, setError] = useState<string | null>(null);
  const [saves, setSaves] = useState(0);
  const [reloads, setReloads] = useState(0);
  const current = useRef<Flow | null>(null);
  const orderRef = useRef<readonly string[]>([]);
  const saved = useRef<SceneOutlineState | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const firstPending = useRef<number | null>(null);
  const inflight = useRef<Promise<void> | null>(null);
  /** Lines waiting for a new chapter to reach the reading order (Cmd+Enter). */
  const split = useRef<{ id: string | null; change: (f: Flow, id: string) => Flow } | null>(null);

  const stored = () =>
    current.current === null ? null : composeFlow(current.current, orderRef.current);

  useEffect(() => {
    let live = true;
    void call('sceneOutline.get', {})
      .then((r) => {
        if (!live) return;
        saved.current = stateOf(r);
        current.current = null;
        setFlow(null);
        setLoaded(saved.current);
        setStatus('saved');
        setError(null);
      })
      .catch((e: unknown) => {
        if (!live) return;
        setError(plainError(e));
        setStatus('error');
      });
    const off = window.api.on('bible.reloaded', () => setReloads((n) => n + 1));
    return () => {
      live = false;
      off();
    };
  }, [reloads]);

  const save = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (inflight.current) await inflight.current;
    for (;;) {
      const target = stored();
      if (target === null) return;
      if (sameState(saved.current, target)) {
        firstPending.current = null;
        setStatus('saved');
        return;
      }
      setStatus('saving');
      const run = call('sceneOutline.set', target).then(
        (r) => {
          saved.current = stateOf(r);
          setError(null);
          setSaves((n) => n + 1);
          return true;
        },
        (e: unknown) => {
          setError(plainError(e));
          setStatus('error');
          return false;
        },
      );
      inflight.current = run.then(() => undefined);
      const ok = await run;
      inflight.current = null;
      if (!ok) return;
      const now = stored();
      if (now === null || sameState(saved.current, now)) {
        firstPending.current = null;
        setStatus('saved');
        return;
      }
    }
  }, []);

  const schedule = useCallback(() => {
    if (readOnly) return;
    setStatus('pending');
    if (timer.current) clearTimeout(timer.current);
    const now = Date.now();
    firstPending.current ??= now;
    const wait = Math.max(
      0,
      Math.min(SCENE_DEBOUNCE_MS, firstPending.current + SCENE_MAX_WAIT_MS - now),
    );
    timer.current = setTimeout(() => void save(), wait);
  }, [save, readOnly]);

  /** Move the waiting lines into the new chapter once it is in the reading order. */
  const takeSplit = () => {
    const s = split.current;
    if (!s?.id || !current.current || !orderRef.current.includes(s.id)) return;
    split.current = null;
    current.current = s.change(current.current, s.id);
    setFlow(current.current);
    schedule();
  };

  // The text is split once both it and the reading order are known; a new
  // order refits the sections and, when that changes what is stored, saves.
  const orderKey = order?.join('\n') ?? null;
  useEffect(() => {
    if (order === null || loaded === null) return;
    const before = orderRef.current;
    orderRef.current = order;
    if (current.current === null) {
      current.current = splitFlow(loaded, order);
      setFlow(current.current);
      return;
    }
    current.current = refitFlow(current.current, before, order);
    setFlow(current.current);
    takeSplit();
    const target = stored();
    if (target && !sameState(saved.current, target)) schedule();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderKey, loaded]);

  // Leaving the screen writes what is pending.
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      const target = stored();
      if (target && !sameState(saved.current, target)) void call('sceneOutline.set', target);
    },
    [],
  );

  // An undo or redo writes what is pending first, and outline steps reach this flow.
  useEffect(() => {
    const off = undo.registerFlush(save);
    live.current = {
      state: stored,
      adopt: async (s) => {
        current.current = splitFlow(s, orderRef.current);
        setFlow(current.current);
        await save();
      },
    };
    return () => {
      off();
      live.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [save]);

  const edit = useCallback(
    (change: (f: Flow) => Flow) => {
      const base = current.current;
      if (!base) return;
      const next = change(base);
      current.current = next;
      setFlow(next);
      // A change that stores nothing new (an empty bullet in an empty section) is not unsaved.
      const target = stored();
      if (target && sameState(saved.current, target) && !inflight.current) {
        if (timer.current) clearTimeout(timer.current);
        timer.current = null;
        firstPending.current = null;
        setStatus('saved');
        return;
      }
      schedule();
    },
    [schedule],
  );

  /**
   * SM-7: a change of the chapters' sections (an edge pulled) as one undo
   * step. Undo puts the outline back when nothing changed it since.
   */
  const step = (label: string, change: (f: Flow) => Flow | null): boolean => {
    const base = current.current;
    if (!base || readOnly) return false;
    const next = change(base);
    if (!next) return false;
    const before = composeFlow(base, orderRef.current);
    const after = composeFlow(next, orderRef.current);
    if (sameState(before, after)) return false;
    edit(() => next);
    undo.record({ label, undo: [outlineOp(after, before)], redo: [outlineOp(before, after)] });
    return true;
  };

  /** After a restore the stored state is the new truth. */
  const replace = useCallback((r: SceneOutlineState) => {
    saved.current = stateOf(r);
    current.current = splitFlow(saved.current, orderRef.current);
    setFlow(current.current);
    setStatus('saved');
    setSaves((n) => n + 1);
  }, []);

  /**
   * Cmd+Enter: `change` moves lines into a chapter that is being made. It runs
   * once `arrived` names the chapter and the reading order holds it, whichever
   * comes last; `arrived(null)` drops it when the chapter was not made.
   */
  const splitInto = (change: (f: Flow, id: string) => Flow) => {
    split.current = { id: null, change };
    return (id: string | null) => {
      if (id === null) split.current = null;
      else if (split.current) {
        split.current.id = id;
        takeSplit();
      }
    };
  };

  return { flow, status, error, saves, edit, step, save, replace, splitInto };
}

/** Series tokens the chapters cycle through, in reading order. */
const TINTS = ['series-1', 'series-2', 'series-3', 'series-4'];

/** Lines of a section, as a textarea holds them. */
const asText = (lines: readonly string[]) => lines.join('\n');
const asLines = (text: string) => (text === '' ? [] : text.split('\n'));

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** A bar or an edge being pulled with the pointer. */
type Grab =
  | { mode: 'move'; id: string; startY: number; dy: number; target: string | null }
  | { mode: 'start' | 'end'; id: string; by: number; guide: number | null };

/**
 * SM-7: the Outline. Two connected panels that scroll as one: on the left the
 * scene text (PL-5 editing rules) with a year field beside every scene
 * (SM-5); on the right one bar per chapter in reading order, beside the lines
 * of its section. Pulling a bar's top or bottom edge moves where the chapter
 * starts or ends; dragging a bar past a neighbour swaps the two chapters and
 * their scenes; from a focused bar the arrows swap it, Shift with the arrows
 * moves its end and Alt its start.
 */
export function SceneOutline({ onOpen }: { onOpen: Open }) {
  const { version } = useStore();
  const ro = useWriteGuard();
  const writes = useOutlineWrites();
  const story = useStoryTime();
  const [outline, setOutline] = useState<Outline | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [grab, setGrab] = useState<Grab | null>(null);
  const [refocus, setRefocus] = useState<string | null>(null);
  const areas = useRef(new Map<string, HTMLTextAreaElement>());
  const board = useRef<HTMLDivElement | null>(null);
  const jumpId = useId();

  useEffect(() => {
    let live = true;
    void call('outline.get', { order: 'reading', cursorYear: null }).then((r) => {
      if (live) setOutline(r);
    });
    return () => {
      live = false;
    };
  }, [version]);

  const chapters = useMemo(
    () => (outline?.rows ?? []).filter((r): r is ChapterRow => r.kind === 'chapter'),
    [outline],
  );
  const partLabel = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of outline?.rows ?? []) if (r.kind === 'part') m.set(r.id, r.label);
    return m;
  }, [outline]);
  const order = useMemo(() => (outline ? chapters.map((c) => c.id) : null), [outline, chapters]);
  const scene = useSceneDoc(order, ro.off);
  const flow = scene.flow;
  const tintOf = (id: string) => TINTS[(order?.indexOf(id) ?? 0) % TINTS.length] ?? 'series-1';

  const linesOf = (key: string): string[] => (flow ? sectionOf(flow, key).lines : []);

  // The scene numbers run on across the sections, in the order they are shown.
  const showLead = flow !== null && (flow.lead.lines.length > 0 || chapters.length === 0);
  const keys = [...(showLead ? [LEAD] : []), ...(order ?? [])];
  const firstScene = new Map<string, number>();
  let total = 0;
  for (const k of keys) {
    firstScene.set(k, total + 1);
    total += sectionScenes(linesOf(k));
  }

  // A bar moved from the keyboard keeps the focus once the chapters come back in their new order.
  useEffect(() => {
    if (!refocus) return;
    const el = board.current?.querySelector<HTMLElement>(
      `[data-testid="chapter-bar"][data-chapter="${CSS.escape(refocus)}"]`,
    );
    if (el && document.activeElement !== el) el.focus();
  }, [refocus, outline, flow]);

  const focusSection = (key: string, at: 'start' | 'end') => {
    const el = areas.current.get(key);
    if (!el) return;
    el.focus();
    const pos = at === 'start' ? 0 : el.value.length;
    el.setSelectionRange(pos, pos);
  };
  const neighbour = (key: string, by: -1 | 1) => keys[keys.indexOf(key) + by] ?? null;

  /**
   * Cmd+Enter in the text: a new chapter starts at the line with the caret,
   * after the chapter it was in, in the same part, set in that chapter's year.
   * The lines from the caret on move into it once it exists.
   */
  const newChapterAt = async (key: string, line: number) => {
    const row = chapters.find((c) => c.id === key);
    const partId =
      row?.partId ??
      outline?.rows.find((r) => r.kind === 'part' && !r.missing)?.id ??
      chapters[0]?.partId;
    if (!partId) {
      setNotice('This bible has no part yet, so a chapter cannot start here.');
      return;
    }
    const year = row?.storyYear ?? story.year;
    const arrived = scene.splitInto((f, id) => {
      const from = sectionOf(f, key);
      const keep = sliceSection(from, 0, line);
      const moved = sliceSection(from, line);
      return withSection(withSection(f, key, keep), id, moved);
    });
    const madeId = await writes.newChapter(partId, 'New chapter', year, row?.id);
    arrived(madeId ?? null);
    if (madeId) setRefocus(madeId);
  };

  const placed = chapters.map((c) => ({ id: c.id, partId: c.partId }));
  /** SM-7: the chapter goes just past `targetId`, its scenes with it; one undo step. */
  const moveChapter = (id: string, targetId: string) => {
    const req = moveOnto(placed, id, targetId);
    const row = chapters.find((c) => c.id === id);
    const target = chapters.find((c) => c.id === targetId);
    if (!req || !row || !target) return;
    setRefocus(id);
    void writes.reorder(req, `Swapped ${row.title} with ${target.title}`);
  };
  const swap = (id: string, by: -1 | 1) => {
    const other = neighbourOf(placed, id, by);
    if (other) moveChapter(id, other);
  };
  const pullEdge = (id: string, edge: 'start' | 'end', by: number) => {
    const row = chapters.find((c) => c.id === id);
    if (!row || by === 0) return;
    scene.step(
      `Moved where ${row.title} ${edge === 'start' ? 'starts' : 'ends'}`,
      (f) => order && moveEdge(f, order, id, edge, by),
    );
  };

  // ---------- pointer drags on the track ----------

  /** The scene lines of the board, top to bottom, with their middles. */
  const sceneBoxes = () => {
    const el = board.current;
    if (!el) return [];
    const base = el.getBoundingClientRect().top;
    return [...el.querySelectorAll<HTMLElement>('.sl[data-scene]')].map((n) => {
      const r = n.getBoundingClientRect();
      return { scene: Number(n.dataset.scene), top: r.top - base, bottom: r.bottom - base };
    });
  };
  /** How many scenes sit above a point on the board, by their middles, and where that boundary is drawn. */
  const boundaryAt = (clientY: number) => {
    const el = board.current;
    const boxes = sceneBoxes();
    if (!el || boxes.length === 0) return null;
    const y = clientY - el.getBoundingClientRect().top;
    const above = boxes.filter((b) => (b.top + b.bottom) / 2 < y);
    const guide = above.at(-1)?.bottom ?? boxes[0]?.top ?? 0;
    return { count: above.length, guide };
  };
  const edgeBy = (id: string, edge: 'start' | 'end', clientY: number) => {
    const at = boundaryAt(clientY);
    if (!at) return { by: 0, guide: null };
    const first = firstScene.get(id) ?? 1;
    const scenes = sectionScenes(linesOf(id));
    const by = edge === 'start' ? at.count + 1 - first : at.count - (first + scenes - 1);
    return { by, guide: at.guide };
  };
  /** The chapter whose bar is under a point, leaving out the bar being dragged. */
  const barAt = (clientY: number, skip: string): string | null => {
    const el = board.current;
    if (!el) return null;
    for (const bar of el.querySelectorAll<HTMLElement>('[data-testid="chapter-bar"]')) {
      if (bar.dataset.chapter === skip) continue;
      const r = bar.getBoundingClientRect();
      if (clientY >= r.top && clientY <= r.bottom) return bar.dataset.chapter ?? null;
    }
    return null;
  };

  const grabRef = useRef<Grab | null>(null);
  const changeGrab = (g: Grab | null) => {
    grabRef.current = g;
    setGrab(g);
  };
  /** What a drag does when it ends, as of the latest render. */
  const act = useRef({ edgeBy, barAt, moveChapter, pullEdge });
  useLayoutEffect(() => {
    act.current = { edgeBy, barAt, moveChapter, pullEdge };
  });
  const beginGrab = (e: ReactPointerEvent, id: string, mode: Grab['mode']) => {
    if (ro.off || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).closest<HTMLElement>('.cbar')?.focus({ preventScroll: true });
    setRefocus(null);
    changeGrab(
      mode === 'move'
        ? { mode, id, startY: e.clientY, dy: 0, target: null }
        : { mode, id, by: 0, guide: null },
    );
  };
  useEffect(() => {
    if (!grab) return;
    const move = (e: PointerEvent) => {
      const g = grabRef.current;
      if (!g) return;
      const a = act.current;
      if (g.mode === 'move') {
        const target = a.barAt(e.clientY, g.id);
        changeGrab({ ...g, dy: e.clientY - g.startY, target });
      } else changeGrab({ ...g, ...a.edgeBy(g.id, g.mode, e.clientY) });
    };
    const up = (e: PointerEvent) => {
      const g = grabRef.current;
      changeGrab(null);
      if (!g) return;
      const a = act.current;
      if (g.mode === 'move') {
        const target = a.barAt(e.clientY, g.id);
        if (target) a.moveChapter(g.id, target);
      } else a.pullEdge(g.id, g.mode, a.edgeBy(g.id, g.mode, e.clientY).by);
    };
    const cancel = () => changeGrab(null);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
    };
    // The listeners read the drag and the handlers through refs; they only need to exist while it lasts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grab !== null]);

  const label = {
    loading: 'Loading',
    saved: 'Saved',
    pending: 'Unsaved changes',
    saving: 'Saving',
    error: 'Not saved',
  }[scene.status];

  const handlers: SectionHandlers = {
    register: (key, el) => {
      if (el) areas.current.set(key, el);
      else areas.current.delete(key);
    },
    onLines: (key, lines) =>
      scene.edit((f) => withSection(f, key, retext(sectionOf(f, key), lines))),
    onYear: (key, line, year) =>
      scene.edit((f) => withSection(f, key, setSceneYear(sectionOf(f, key), line, year))),
    onBlur: () => void scene.save(),
    onLeave: (key, by) => {
      const next = neighbour(key, by);
      if (next) focusSection(next, by < 0 ? 'end' : 'start');
    },
    onNewChapter: (key, line) => void newChapterAt(key, line),
  };

  const guide = grab && grab.mode !== 'move' ? grab.guide : null;
  return (
    <div className="ws-tree-area scenes" data-testid="outline-view">
      <section
        className="tree-main stack"
        aria-labelledby="outline-title"
        data-testid="outline-scroll"
      >
        <div className="list-head scene-head">
          <h2 id="outline-title">Outline</h2>
          <span className="row tight">
            {chapters.length > 1 && (
              <>
                <label htmlFor={jumpId} className="sr-only">
                  Go to chapter
                </label>
                <select
                  id={jumpId}
                  value=""
                  data-testid="scene-jump"
                  onChange={(e) => {
                    board.current
                      ?.querySelector(`[data-row="${CSS.escape(e.target.value)}"]`)
                      ?.scrollIntoView({ block: 'start', behavior: 'smooth' });
                  }}
                >
                  <option value="">Go to chapter</option>
                  {chapters.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.readingOrder}. {c.title}
                    </option>
                  ))}
                </select>
              </>
            )}
            <UndoButtons />
            <span className="scene-status" data-testid="scene-count">
              {flow === null ? '' : plural(total, 'scene', 'scenes')}
            </span>
            <span
              className="scene-status"
              data-testid="scene-autosave"
              aria-live="polite"
              data-status={scene.status}
            >
              {label}
            </span>
          </span>
        </div>
        <p className="example-note">
          Scenes in page order on the left, each with its year; the chapters on the right, each bar
          beside its scenes. Enter adds the next scene, Cmd+] indents, Cmd+[ outdents, and Cmd+Enter
          starts a new chapter at the line you are on. Type a year beside a scene to set it; a faded
          year comes from the scene above or the chapter. Pull a bar&apos;s top or bottom edge to
          move where the chapter starts or ends, or drag the bar past another to swap them. On a
          focused bar, Up and Down swap it, Shift with the arrows moves its end, and Alt with the
          arrows moves its start.
        </p>
        {(scene.error ?? writes.error ?? notice) && (
          <p className="callout crit" role="alert">
            {scene.error ?? writes.error ?? notice}
          </p>
        )}
        {!outline || !flow ? (
          <p aria-live="polite">Loading the outline.</p>
        ) : (
          <div
            ref={board}
            className={`scene-board${grab ? ' grabbing' : ''}`}
            data-testid="scene-outline"
          >
            <div className="sb-colhead">Scenes</div>
            <div className="sb-colhead track">Chapters</div>
            {keys.map((key) => {
              const row = key === LEAD ? null : (chapters.find((c) => c.id === key) ?? null);
              const sec = sectionOf(flow, key);
              const years = shownYears(sec, row?.storyYear ?? null);
              const tint = row ? tintOf(row.id) : 'lead';
              const moving = grab?.mode === 'move' && grab.id === key ? grab : null;
              const scenes = sectionScenes(sec.lines);
              const limits = row && order ? edgeLimits(flow, order, row.id) : null;
              return (
                <div key={key} className={`sb-row ${tint}`} data-row={key}>
                  <SectionText
                    sectionKey={key}
                    lines={sec.lines}
                    years={years}
                    firstScene={firstScene.get(key) ?? 1}
                    disabled={ro.off}
                    tip={ro.tip}
                    handlers={handlers}
                    chapter={row?.readingOrder}
                    tall={chapters.length === 0}
                  />
                  <div className="sb-track">
                    {row ? (
                      <ChapterBar
                        row={row}
                        part={partLabel.get(row.partId) ?? ''}
                        scenes={scenes}
                        firstScene={firstScene.get(key) ?? 1}
                        canSwap={{
                          up: neighbourOf(placed, row.id, -1) !== null,
                          down: neighbourOf(placed, row.id, 1) !== null,
                        }}
                        limits={limits}
                        dy={moving?.dy ?? 0}
                        moving={moving !== null}
                        target={grab?.mode === 'move' && grab.target === row.id}
                        pulling={
                          grab && grab.mode !== 'move' && grab.id === row.id ? grab.mode : null
                        }
                        onGrab={(e, mode) => beginGrab(e, row.id, mode)}
                        onSwap={(by) => swap(row.id, by)}
                        onEdge={(edge, by) => pullEdge(row.id, edge, by)}
                        onFocusBar={() => setRefocus(null)}
                        onOpen={onOpen}
                      />
                    ) : (
                      <div className="sb-none">Not in a chapter</div>
                    )}
                  </div>
                </div>
              );
            })}
            {guide !== null && (
              <div className="sb-guide" style={{ top: guide }} aria-hidden="true" />
            )}
          </div>
        )}
        <Versions saves={scene.saves} onRestore={scene.replace} />
      </section>
    </div>
  );
}

/** Undo and Redo for the renames, year changes, moves and edges made here (ED-3). */
function UndoButtons() {
  const undo = useUndo();
  return (
    <span className="row tight" role="group" aria-label="Undo">
      <button
        type="button"
        className="btn small"
        disabled={!undo.canUndo}
        title={undo.history.undo[0]?.label ?? 'Cmd+Z'}
        onClick={() => void undo.undo()}
      >
        Undo
      </button>
      <button
        type="button"
        className="btn small"
        disabled={!undo.canRedo}
        title={undo.history.redo[0]?.label ?? 'Shift+Cmd+Z'}
        onClick={() => void undo.redo()}
      >
        Redo
      </button>
    </span>
  );
}

interface BarProps {
  row: ChapterRow;
  part: string;
  scenes: number;
  firstScene: number;
  canSwap: { up: boolean; down: boolean };
  limits: ReturnType<typeof edgeLimits> | null;
  dy: number;
  moving: boolean;
  target: boolean;
  pulling: 'start' | 'end' | null;
  onGrab: (e: ReactPointerEvent, mode: Grab['mode']) => void;
  onSwap: (by: -1 | 1) => void;
  onEdge: (edge: 'start' | 'end', by: -1 | 1) => void;
  onFocusBar: () => void;
  onOpen: Open;
}

/**
 * SM-7: one chapter's bar, as tall as its section, in its colour, with its
 * name (renamed in place), part, scene count and story year. Drag the bar to
 * swap it with another; pull its top or bottom edge to move where it starts
 * or ends. Focused: Up and Down swap it with its neighbour, Shift with the
 * arrows moves its end a scene, Alt with the arrows its start.
 */
function ChapterBar(p: BarProps) {
  const { row } = p;
  const stored = useEntries('chapters');
  const writes = useOutlineWrites();
  const doc = stored.find((c) => c._id === row.id);
  const title = doc ? entryTitle(doc) : row.title;
  const off = writes.ro.off;

  const rename = async (next: string) => {
    await writes.edit(
      'chapters',
      row.id,
      { title: next },
      `Renamed chapter ${row.readingOrder} to ${next}`,
    );
  };

  /** The story year is the primary strand's start year; moving it moves that strand (TM-5). */
  const setYear = async (y: number): Promise<boolean> => {
    const strands = Array.isArray(doc?.strands)
      ? (doc.strands as { id: string; primary?: boolean }[])
      : [];
    const primary = strands.find((s) => s.primary) ?? strands[0];
    if (!primary) return false;
    const shift = shiftStrand(strands, primary.id, y);
    if (!shift || shift.unchanged) return false;
    const ok = await writes.edit(
      'chapters',
      row.id,
      { strands: shift.next },
      `Moved chapter ${row.readingOrder} to ${y}`,
    );
    return ok === true;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget || off) return;
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    if (e.metaKey || e.ctrlKey) return;
    e.preventDefault();
    const by = e.key === 'ArrowUp' ? -1 : 1;
    if (e.shiftKey && !e.altKey) p.onEdge('end', by);
    else if (e.altKey && !e.shiftKey) p.onEdge('start', by);
    else if (!e.shiftKey && !e.altKey) p.onSwap(by);
  };

  const span =
    p.scenes === 0
      ? 'no scenes'
      : p.scenes === 1
        ? `scene ${p.firstScene}`
        : `scenes ${p.firstScene} to ${p.firstScene + p.scenes - 1}`;
  const grabBody = (e: ReactPointerEvent) => {
    if ((e.target as HTMLElement).closest('input, button, select, a')) return;
    p.onGrab(e, 'move');
  };
  return (
    <div
      className={`cbar${p.moving ? ' moving' : ''}${p.target ? ' target' : ''}${p.pulling ? ` pulling-${p.pulling}` : ''}${off ? ' off' : ''}`}
      style={p.dy ? { transform: `translateY(${p.dy}px)` } : undefined}
      role="group"
      tabIndex={0}
      aria-roledescription="chapter bar"
      aria-label={`Chapter ${row.readingOrder}, ${title}, ${span}`}
      aria-keyshortcuts="ArrowUp ArrowDown Shift+ArrowUp Shift+ArrowDown Alt+ArrowUp Alt+ArrowDown"
      title="Up and Down swap it with its neighbour. Shift with the arrows moves its end, Alt its start."
      data-testid="chapter-bar"
      data-chapter={row.id}
      onKeyDown={onKeyDown}
      onFocus={(e) => {
        if (e.target === e.currentTarget) p.onFocusBar();
      }}
      onPointerDown={grabBody}
    >
      <span
        className="cbar-edge top"
        aria-hidden="true"
        title="Pull to move where this chapter starts"
        data-testid="bar-start"
        onPointerDown={(e) => p.onGrab(e, 'start')}
      />
      <span className="cbar-main">
        <span className="cbar-line">
          <span className="cbar-no">Ch {row.readingOrder}</span>
          <InlineName
            value={title}
            label={`Title of chapter ${row.readingOrder}`}
            onSave={rename}
            disabled={off}
            className="cbar-title"
            testId="chapter-title"
          >
            <Zh text={title} actions={false} />
          </InlineName>
        </span>
        {p.part && (
          <span className="cbar-line cbar-sub" data-testid="chapter-part">
            {p.part}
          </span>
        )}
        <span className="cbar-line cbar-sub">
          <span data-testid="chapter-scenes">{plural(p.scenes, 'scene', 'scenes')}</span>
          <span className="cbar-year">
            <span>Year</span>
            <NumberField
              label={`Story year of chapter ${row.readingOrder}`}
              testId="chapter-year"
              value={row.storyYear}
              min={MIN_YEAR}
              max={MAX_YEAR}
              width="5.2em"
              disabled={off}
              tip={writes.ro.tip}
              onCommit={(y) => (y === null ? Promise.resolve(false) : setYear(y))}
            />
          </span>
          <button
            type="button"
            className="link-btn"
            onClick={() => p.onOpen('chapters', row.id)}
            data-testid="chapter-open"
          >
            Open
          </button>
        </span>
      </span>
      <span
        className="cbar-edge bottom"
        aria-hidden="true"
        title="Pull to move where this chapter ends"
        data-testid="bar-end"
        onPointerDown={(e) => p.onGrab(e, 'end')}
      />
    </div>
  );
}

/** What the flow does for a section, told which section it is. */
interface SectionHandlers {
  register: (key: string, el: HTMLTextAreaElement | null) => void;
  onLines: (key: string, lines: string[]) => void;
  onYear: (key: string, line: number, year: number | null) => void;
  onBlur: () => void;
  onLeave: (key: string, by: -1 | 1) => void;
  onNewChapter: (key: string, line: number) => void;
}

interface SectionProps {
  sectionKey: string;
  lines: string[];
  years: (ShownYear | null)[];
  firstScene: number;
  chapter?: number;
  tall?: boolean;
  disabled: boolean;
  tip: { title?: string; 'aria-describedby'?: string };
  handlers: SectionHandlers;
}

/**
 * One section of the text: a textarea that grows with its text, over a
 * backdrop that repeats the text invisibly in the same font and width so each
 * scene's number and year field sit beside its line even when the line
 * wraps. Up on the first line and Down on the last carry on into the next
 * section, so the text reads and moves as one.
 */
function SectionText(p: SectionProps) {
  const area = useRef<HTMLTextAreaElement | null>(null);
  const caret = useRef<{ start: number; end: number } | null>(null);
  const id = useId();
  const text = asText(p.lines);
  const numbers = useMemo(() => sceneLines(text), [text]);
  const shown = p.lines.length ? p.lines : [''];

  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
    if (caret.current && document.activeElement === el) {
      el.setSelectionRange(caret.current.start, caret.current.end);
    }
    caret.current = null;
  }, [text]);

  const h = p.handlers;
  const key = p.sectionKey;
  const apply = (value: string, start: number, end: number) => {
    caret.current = { start, end };
    h.onLines(key, asLines(value));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    const edit = {
      text: el.value,
      selectionStart: el.selectionStart,
      selectionEnd: el.selectionEnd,
    };
    const plain = !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey;
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      h.onNewChapter(key, el.value.slice(0, el.selectionStart).split('\n').length - 1);
    } else if (e.key === 'Enter' && plain) {
      const next = continueBullet(edit);
      if (next) {
        e.preventDefault();
        apply(next.text, next.selectionStart, next.selectionEnd);
      }
    } else if ((e.key === ']' || e.key === '[') && (e.metaKey || e.ctrlKey) && !e.altKey) {
      // Cmd+] indents and Cmd+[ outdents; Tab stays the key that leaves the field (NF-2).
      e.preventDefault();
      const next = indentLines(edit, e.key === '[');
      apply(next.text, next.selectionStart, next.selectionEnd);
    } else if (
      plain &&
      e.key === 'ArrowUp' &&
      !el.value.slice(0, el.selectionStart).includes('\n')
    ) {
      e.preventDefault();
      h.onLeave(key, -1);
    } else if (plain && e.key === 'ArrowDown' && !el.value.slice(el.selectionEnd).includes('\n')) {
      e.preventDefault();
      h.onLeave(key, 1);
    }
  };

  return (
    <div className={`scene-edit${p.tall ? ' tall' : ''}`}>
      <label htmlFor={id} className="sr-only">
        {p.chapter !== undefined
          ? `Scenes of chapter ${p.chapter}`
          : 'Scenes before the first chapter'}
      </label>
      <div className="scene-backdrop" data-testid="scene-gutter">
        {shown.map((line, i) => {
          const n = numbers[i] ?? null;
          const scene = n === null ? null : p.firstScene + n - 1;
          const year = p.years[i] ?? null;
          return (
            <div key={i} className="sl" data-scene={scene ?? undefined}>
              {scene !== null && (
                <span className="sl-gutter">
                  <span className="sl-no" aria-hidden="true">
                    {scene}
                  </span>
                  <SceneYear
                    scene={scene}
                    shown={year}
                    disabled={p.disabled}
                    tip={p.tip}
                    onCommit={(y) => h.onYear(key, i, y)}
                  />
                </span>
              )}
              <span className="sl-text" aria-hidden="true">
                {line === '' ? '​' : line}
              </span>
            </div>
          );
        })}
      </div>
      <textarea
        id={id}
        ref={(el) => {
          area.current = el;
          h.register(key, el);
        }}
        value={text}
        disabled={p.disabled}
        {...p.tip}
        spellCheck
        rows={1}
        placeholder={p.chapter !== undefined ? '- The first scene of this chapter' : undefined}
        data-testid="scene-text"
        data-section={p.sectionKey}
        onFocus={() => {
          // An empty section starts with a bullet, so the first keystroke writes a scene.
          if (p.lines.length === 0 && !p.disabled) apply(EMPTY_OUTLINE, 2, 2);
        }}
        onChange={(e) => h.onLines(key, asLines(e.target.value))}
        onKeyDown={onKeyDown}
        onBlur={h.onBlur}
      />
    </div>
  );
}

/**
 * SM-5: the year field beside a scene. Its own year shows plainly; an
 * inherited one shows faded and dashed, as the field's placeholder, so typing
 * sets the scene's own year and clearing the field returns it to inheritance.
 */
function SceneYear(props: {
  scene: number;
  shown: ShownYear | null;
  disabled: boolean;
  tip: { title?: string; 'aria-describedby'?: string };
  onCommit: (year: number | null) => void;
}) {
  const own = props.shown?.own ? props.shown.year : null;
  const inherited = props.shown && !props.shown.own ? props.shown.year : null;
  const value = own === null ? '' : String(own);
  const [draft, setDraft] = useState(value);
  const [seen, setSeen] = useState(value);
  if (seen !== value) {
    setSeen(value);
    setDraft(value);
  }
  const commit = () => {
    const t = draft.trim();
    if (t === value) return;
    if (t === '') return props.onCommit(null);
    const n = Number(t);
    if (Number.isInteger(n) && n >= MIN_YEAR && n <= MAX_YEAR) props.onCommit(n);
    else setDraft(value);
  };
  return (
    <input
      type="text"
      inputMode="numeric"
      className={`sl-year${own === null ? ' inherited' : ''}`}
      value={draft}
      placeholder={inherited === null ? '' : String(inherited)}
      disabled={props.disabled}
      {...props.tip}
      aria-label={
        own === null
          ? `Year of scene ${props.scene}${inherited === null ? '' : `, ${inherited} from above`}`
          : `Year of scene ${props.scene}`
      }
      data-testid="scene-year"
      data-own={own === null ? 'false' : 'true'}
      data-year={own ?? inherited ?? ''}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        } else if (e.key === 'Escape') {
          setDraft(value);
        }
      }}
    />
  );
}

/** When a version was saved, in plain words. */
function when(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (sameDay) return `Today ${time}`;
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })} ${time}`;
}

/** PL-5: the saved versions, newest first; one opens for a look and can be restored. */
function Versions(props: { saves: number; onRestore: (r: SceneOutlineState) => void }) {
  const ro = useWriteGuard();
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<VersionSummary[] | null>(null);
  const [picked, setPicked] = useState<Version | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let live = true;
    void call('sceneOutline.versions', {})
      .then((r) => {
        if (live) setList(r.versions);
      })
      .catch((e: unknown) => {
        if (live) setError(plainError(e));
      });
    return () => {
      live = false;
    };
  }, [open, props.saves]);

  const look = async (id: string) => {
    setError(null);
    try {
      setPicked(await call('sceneOutline.version', { id }));
    } catch (e) {
      setError(plainError(e));
    }
  };

  const restore = async (id: string) => {
    setError(null);
    try {
      const r = await call('sceneOutline.restore', { id });
      props.onRestore(r);
      setPicked(null);
    } catch (e) {
      setError(plainError(e));
    }
  };

  return (
    <details
      className="scene-versions"
      data-testid="scene-versions"
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary>Versions{list ? ` (${list.length})` : ''}</summary>
      <p className="example-note">
        Every change is kept, with the years of the scenes. Edits within ten minutes of each other
        make one version. Restoring an older version is itself a new version, so nothing is ever
        lost.
      </p>
      {error && (
        <p className="callout crit" role="alert">
          {error}
        </p>
      )}
      {list === null ? (
        <p aria-live="polite">Loading the versions.</p>
      ) : list.length === 0 ? (
        <p className="example-note">No versions yet. The first change makes one.</p>
      ) : (
        <ul className="stack-list scene-version-list">
          {list.map((v, i) => (
            <li key={v.id} data-testid="scene-version" data-version={v.id}>
              <button
                type="button"
                className="btn small"
                aria-pressed={picked?.id === v.id}
                onClick={() => (picked?.id === v.id ? setPicked(null) : void look(v.id))}
              >
                {when(v.at)}
                {v.until !== v.at ? ` to ${when(v.until)}` : ''}
              </button>{' '}
              <span className="example-note">
                {plural(v.scenes, 'scene', 'scenes')}, {v.chars} characters
                {i === 0 ? ', current' : ''}
              </span>
              {picked?.id === v.id && (
                <div className="stack tight scene-version-view">
                  <textarea
                    readOnly
                    value={picked.text}
                    aria-label={`Version from ${when(picked.at)}`}
                    rows={Math.min(16, Math.max(3, picked.text.split('\n').length + 1))}
                  />
                  {i > 0 && (
                    <span className="row tight">
                      <button
                        type="button"
                        className="btn small primary"
                        disabled={ro.off}
                        {...ro.tip}
                        onClick={() => void restore(v.id)}
                      >
                        Restore this version
                      </button>
                    </span>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}

/** A small whole-number field that commits on Enter or blur; empty clears. */
function NumberField(props: {
  label: string;
  testId: string;
  value: number | null;
  min: number;
  max: number;
  width: string;
  disabled: boolean;
  tip: { title?: string; 'aria-describedby'?: string };
  onCommit: (value: number | null) => Promise<boolean>;
}) {
  const shown = props.value === null ? '' : String(props.value);
  const [draft, setDraft] = useState(shown);
  const [editing, setEditing] = useState(false);
  const [seen, setSeen] = useState(shown);
  if (seen !== shown) {
    setSeen(shown);
    if (!editing) setDraft(shown);
  }
  const commit = async () => {
    setEditing(false);
    const t = draft.trim();
    if (t === shown) return;
    const n = t === '' ? null : Number(t);
    const valid = n === null || (Number.isInteger(n) && n >= props.min && n <= props.max);
    const ok = valid && (await props.onCommit(n));
    if (!ok) setDraft(shown);
  };
  return (
    <input
      type="number"
      inputMode="numeric"
      className="ch-number"
      style={{ width: props.width }}
      value={draft}
      min={props.min}
      max={props.max}
      step={1}
      disabled={props.disabled}
      {...props.tip}
      aria-label={props.label}
      data-testid={props.testId}
      onFocus={() => setEditing(true)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => void commit()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          void commit();
        } else if (e.key === 'Escape') {
          setDraft(shown);
          setEditing(false);
        }
      }}
    />
  );
}
