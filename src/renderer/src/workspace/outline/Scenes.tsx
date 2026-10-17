import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent, KeyboardEvent, ReactNode } from 'react';
import {
  EMPTY_OUTLINE,
  composeFlow,
  continueBullet,
  giveFirstScene,
  indentLines,
  refitFlow,
  sameBreaks,
  sameRanges,
  sceneLines,
  sectionScenes,
  splitFlow,
  takeSceneAbove,
} from '../../../../shared/domain/sceneOutline';
import type { Flow, SceneOutlineState } from '../../../../shared/domain/sceneOutline';
import { eraAt, eventsBetween, eventsIn, yearGap } from '../../../../shared/domain/outlineWorld';
import { shiftStrand } from '../../../../shared/domain/strands';
import type { Response } from '../../../../shared/ipc';
import { entryTitle } from '../../../../shared/schema';
import type { EntryCollection } from '../../../../shared/schema';
import { useWriteGuard } from '../../connection';
import { call, plainError } from '../../api';
import { useEntries, useStore } from '../data';
import { useStoryTime } from '../storyTime';
import { useUndo } from '../undo';
import { Zh } from '../Zh';
import { useOutlineWrites } from './actions';
import { useWorld } from './world';
import type { World } from './world';

type Outline = Response<'outline.get'>;
type ChapterRow = Extract<Outline['rows'][number], { kind: 'chapter' }>;
type VersionSummary = Response<'sceneOutline.versions'>['versions'][number];
type Version = Response<'sceneOutline.version'>;
type Open = (collection: EntryCollection, id: string) => void;

/** Autosave timing for the scene outline, the same as an entry (ED-2). */
const SCENE_DEBOUNCE_MS = 500;
const SCENE_MAX_WAIT_MS = 700;

type SceneStatus = 'loading' | 'saved' | 'pending' | 'saving' | 'error';

/** The key of the section before the first chapter. */
const LEAD = 'lead';

/** The drag type a chapter heading puts on the data transfer. */
const CHAPTER_MIME = 'application/x-novel-companion-chapter';

const sameState = (a: SceneOutlineState | null, b: SceneOutlineState) =>
  a !== null &&
  a.text === b.text &&
  sameRanges(a.ranges, b.ranges) &&
  sameBreaks(a.breaks, b.breaks);

/**
 * The scene outline as a flow (A37) with its autosave. The stored text is
 * split into the chapters' sections once the reading order is known; every
 * change updates the flow at once and is written, joined back in reading
 * order, 500 ms after the last one and never more than 700 ms after the first
 * unsaved one. A new reading order (a chapter moved, made, or put in the
 * trash) is written too, since the text follows its chapters.
 */
function useSceneDoc(order: readonly string[] | null, readOnly: boolean) {
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
        saved.current = { text: r.text, ranges: r.ranges, breaks: r.breaks };
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
          saved.current = { text: r.text, ranges: r.ranges, breaks: r.breaks };
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

  /** After a restore the stored state is the new truth. */
  const replace = useCallback((r: SceneOutlineState) => {
    saved.current = { text: r.text, ranges: r.ranges, breaks: r.breaks };
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

  return { flow, status, error, saves, edit, save, replace, splitInto };
}

/** Series tokens the chapters cycle through, in reading order. */
const TINTS = ['series-1', 'series-2', 'series-3', 'series-4'];

/** Lines of a section, as a textarea holds them. */
const asText = (lines: readonly string[]) => lines.join('\n');
const asLines = (text: string) => (text === '' ? [] : text.split('\n'));

/**
 * PL-5 (A36, A37): the scene outline as one flow. The chapters are headings in
 * the text, in reading order, each with its title and story year editable in
 * place, the era and the world events of that year, and its own scenes below
 * it; between two chapters a line says how much time passes and what happens
 * in the world meanwhile. Everything scrolls together.
 */
export function SceneOutline({ toggle, onOpen }: { toggle: ReactNode; onOpen: Open }) {
  const { version } = useStore();
  const ro = useWriteGuard();
  const writes = useOutlineWrites();
  const story = useStoryTime();
  const world = useWorld();
  const [outline, setOutline] = useState<Outline | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [titleFocus, setTitleFocus] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const areas = useRef(new Map<string, HTMLTextAreaElement>());
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
  const order = useMemo(() => (outline ? chapters.map((c) => c.id) : null), [outline, chapters]);
  const scene = useSceneDoc(order, ro.off);
  const flow = scene.flow;
  const tintOf = (id: string) => TINTS[(order?.indexOf(id) ?? 0) % TINTS.length] ?? 'series-1';

  const linesOf = (key: string): string[] =>
    !flow ? [] : key === LEAD ? flow.lead : (flow.bodies[key] ?? []);
  const setSection = (key: string, lines: string[]) =>
    scene.edit((f) =>
      key === LEAD ? { ...f, lead: lines } : { ...f, bodies: { ...f.bodies, [key]: lines } },
    );

  // The scene numbers run on across the sections, in the order they are shown.
  const showLead = flow !== null && (flow.lead.length > 0 || chapters.length === 0);
  const keys = [...(showLead ? [LEAD] : []), ...(order ?? [])];
  const firstScene = new Map<string, number>();
  let total = 0;
  for (const k of keys) {
    firstScene.set(k, total + 1);
    total += sectionScenes(linesOf(k));
  }

  const focusSection = (key: string, at: 'start' | 'end') => {
    const el = areas.current.get(key);
    if (!el) return;
    el.focus();
    const pos = at === 'start' ? 0 : el.value.length;
    el.setSelectionRange(pos, pos);
  };
  const neighbour = (key: string, by: -1 | 1) => keys[keys.indexOf(key) + by] ?? null;

  /** The section above a chapter: the chapter before it, or the lead. */
  const aboveKey = (id: string) => {
    const i = order?.indexOf(id) ?? -1;
    return i > 0 ? (order?.[i - 1] ?? LEAD) : LEAD;
  };
  const shiftStart = (id: string, by: -1 | 1) => {
    const above = aboveKey(id);
    const r =
      by < 0
        ? takeSceneAbove(linesOf(above), linesOf(id))
        : giveFirstScene(linesOf(above), linesOf(id));
    if (!r) return;
    scene.edit((f) => {
      const bodies = { ...f.bodies, [id]: r.own };
      if (above === LEAD) return { lead: r.above, bodies };
      return { ...f, bodies: { ...bodies, [above]: r.above } };
    });
  };

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
      setNotice('Add a book and a part in the year grid first; then chapters can start here.');
      return;
    }
    const year = row?.storyYear ?? story.year;
    const arrived = scene.splitInto((f, id) => {
      const from = key === LEAD ? f.lead : (f.bodies[key] ?? []);
      const keep = from.slice(0, line);
      const moved = from.slice(line);
      const bodies = { ...f.bodies, [id]: moved };
      return key === LEAD ? { lead: keep, bodies } : { ...f, bodies: { ...bodies, [key]: keep } };
    });
    const madeId = await writes.newChapter(partId, 'New chapter', year, row?.id);
    arrived(madeId ?? null);
    if (madeId) setTitleFocus(madeId);
  };

  const inPart = (partId: string) => chapters.filter((c) => c.partId === partId);
  /** Dropped on a heading: the chapter, with its scenes, takes that chapter's place (PL-3). */
  const dropOn = (target: ChapterRow) => {
    const moved = chapters.find((c) => c.id === dragging);
    if (!moved || moved.id === target.id) return;
    const toIndex = inPart(target.partId).findIndex((c) => c.id === target.id);
    void writes.reorder(
      { kind: 'chapters', groupId: target.partId, movedId: moved.id, toIndex },
      `Moved ${moved.title}`,
    );
  };
  /** Dropped on a part: first in another part, last in its own. */
  const dropOnPart = (partId: string) => {
    const moved = chapters.find((c) => c.id === dragging);
    if (!moved) return;
    const same = moved.partId === partId;
    void writes.reorder(
      {
        kind: 'chapters',
        groupId: partId,
        movedId: moved.id,
        toIndex: same ? inPart(partId).length - 1 : 0,
      },
      `Moved ${moved.title}`,
    );
  };
  const move = (row: ChapterRow, by: -1 | 1) => {
    const siblings = inPart(row.partId);
    const to = siblings.findIndex((s) => s.id === row.id) + by;
    if (to < 0 || to >= siblings.length) return;
    void writes.reorder(
      { kind: 'chapters', groupId: row.partId, movedId: row.id, toIndex: to },
      `Moved ${row.title} ${by < 0 ? 'earlier' : 'later'}`,
    );
  };
  const drag = {
    start: (e: DragEvent, row: ChapterRow) => {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData(CHAPTER_MIME, row.id);
      e.dataTransfer.setData('text/plain', row.title);
      setDragging(row.id);
    },
    end: () => {
      setDragging(null);
      setOver(null);
    },
    over: (e: DragEvent, key: string) => {
      if (!dragging || key === dragging) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      setOver(key);
    },
  };

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
    onLines: setSection,
    onBlur: () => void scene.save(),
    onLeave: (key, by) => {
      const next = neighbour(key, by);
      if (next) focusSection(next, by < 0 ? 'end' : 'start');
    },
    onNewChapter: (key, line) => void newChapterAt(key, line),
  };
  // The year of the chapter before each one, for the time between them.
  const yearBefore = new Map<string, number | null>();
  let lastYear: number | null = null;
  for (const c of chapters) {
    yearBefore.set(c.id, lastYear);
    if (c.storyYear !== null) lastYear = c.storyYear;
  }
  return (
    <div className="ws-tree-area scenes" data-testid="outline-view">
      <section className="tree-main stack" aria-labelledby="outline-title">
        <div className="list-head scene-head">
          <h2 id="outline-title">Outline</h2>
          <span className="row tight">
            {toggle}
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
                    document
                      .querySelector(`[data-head="${CSS.escape(e.target.value)}"]`)
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
              {flow === null ? '' : `${total} ${total === 1 ? 'scene' : 'scenes'}`}
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
          Scenes in page order, with each chapter as a heading above its own scenes. Enter adds the
          next scene, Cmd+] indents, Cmd+[ outdents, and Cmd+Enter starts a new chapter at the line
          you are on. Drag a chapter&apos;s grip onto another chapter to move it with its scenes.
          The arrows on a heading move where the chapter starts by one scene.
        </p>
        {(scene.error ?? writes.error ?? notice) && (
          <p className="callout crit" role="alert">
            {scene.error ?? writes.error ?? notice}
          </p>
        )}
        {!outline || !flow ? (
          <p aria-live="polite">Loading the outline.</p>
        ) : (
          <div className="scene-flow" data-testid="scene-outline">
            {showLead && (
              <div className="scene-sec lead" data-section={LEAD}>
                {chapters.length > 0 && (
                  <div className="scene-lead-head">Before the first chapter</div>
                )}
                <SectionText
                  sectionKey={LEAD}
                  lines={linesOf(LEAD)}
                  firstScene={firstScene.get(LEAD) ?? 1}
                  disabled={ro.off}
                  tip={ro.tip}
                  handlers={handlers}
                  tall={chapters.length === 0}
                />
              </div>
            )}
            {outline.rows.map((row) => {
              if (row.kind !== 'chapter') {
                const partDrop = row.kind === 'part' && !row.missing;
                return (
                  <div
                    key={`${row.kind}:${row.id}`}
                    className={`scene-group ${row.kind}${over === `part:${row.id}` ? ' over' : ''}`}
                    onDragOver={partDrop ? (e) => drag.over(e, `part:${row.id}`) : undefined}
                    onDragLeave={() => setOver(null)}
                    onDrop={
                      partDrop
                        ? (e) => {
                            e.preventDefault();
                            setOver(null);
                            dropOnPart(row.id);
                          }
                        : undefined
                    }
                  >
                    {row.label}
                  </div>
                );
              }
              const gapFrom = yearBefore.get(row.id) ?? null;
              return (
                <div
                  key={row.id}
                  className={`scene-sec ${tintOf(row.id)}${dragging === row.id ? ' dragging' : ''}`}
                  data-section={row.id}
                >
                  {gapFrom !== null && row.storyYear !== null && (
                    <TimeGap from={gapFrom} to={row.storyYear} world={world} onOpen={onOpen} />
                  )}
                  <ChapterHead
                    row={row}
                    scenes={sectionScenes(linesOf(row.id))}
                    world={world}
                    over={over === row.id}
                    focusTitle={titleFocus === row.id}
                    canEarlier={sectionScenes(linesOf(aboveKey(row.id))) > 0}
                    canLater={sectionScenes(linesOf(row.id)) > 0}
                    onFocused={() => setTitleFocus(null)}
                    onShift={(by) => shiftStart(row.id, by)}
                    onMove={(by) => move(row, by)}
                    onEnterText={() => focusSection(row.id, 'start')}
                    onOpen={onOpen}
                    onDragStart={(e) => drag.start(e, row)}
                    onDragEnd={drag.end}
                    onDragOver={(e) => drag.over(e, row.id)}
                    onDragLeave={() => setOver((o) => (o === row.id ? null : o))}
                    onDrop={(e) => {
                      e.preventDefault();
                      setOver(null);
                      dropOn(row);
                    }}
                  />
                  <SectionText
                    sectionKey={row.id}
                    lines={linesOf(row.id)}
                    firstScene={firstScene.get(row.id) ?? 1}
                    disabled={ro.off}
                    tip={ro.tip}
                    handlers={handlers}
                    chapter={row.readingOrder}
                  />
                </div>
              );
            })}
          </div>
        )}
        <Versions saves={scene.saves} onRestore={scene.replace} />
      </section>
    </div>
  );
}

/** Undo and Redo for the renames, year changes and moves made here (ED-3). */
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

/**
 * A37: between two chapters, the time that passes and the world events that
 * begin in it, each opening its event.
 */
function TimeGap(props: { from: number; to: number; world: World | null; onOpen: Open }) {
  const between = props.world ? eventsBetween(props.world.events, props.from, props.to) : [];
  const back = props.to < props.from;
  return (
    <div className={`scene-gap${back ? ' back' : ''}`} data-testid="scene-gap">
      <span className="scene-gap-years">{yearGap(props.from, props.to)}</span>
      {between.length > 0 && (
        <span className="scene-gap-events">
          <span>Meanwhile:</span>
          <EventChips events={between} withYear onOpen={props.onOpen} limit={4} />
        </span>
      )}
    </div>
  );
}

/** World events as chips that open the event; past `limit` the rest wait behind a More button. */
function EventChips(props: {
  events: World['events'];
  withYear?: boolean;
  limit: number;
  onOpen: Open;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? props.events : props.events.slice(0, props.limit);
  const rest = props.events.length - shown.length;
  return (
    <span className="we-chips">
      {shown.map((e) => (
        <button
          key={e.id}
          type="button"
          className="we-chip"
          data-testid="scene-event"
          title={`${e.title}, ${e.startYear === e.endYear ? e.startYear : `${e.startYear} to ${e.endYear}`}`}
          onClick={() => props.onOpen('worldEvents', e.id)}
        >
          {props.withYear && <span className="num">{e.startYear} </span>}
          <Zh text={e.title} actions={false} />
        </button>
      ))}
      {rest > 0 && (
        <button type="button" className="link-btn" onClick={() => setAll(true)}>
          {rest} more
        </button>
      )}
    </span>
  );
}

interface HeadProps {
  row: ChapterRow;
  scenes: number;
  world: World | null;
  over: boolean;
  focusTitle: boolean;
  canEarlier: boolean;
  canLater: boolean;
  onFocused: () => void;
  onShift: (by: -1 | 1) => void;
  onMove: (by: -1 | 1) => void;
  onEnterText: () => void;
  onOpen: Open;
  onDragStart: (e: DragEvent) => void;
  onDragEnd: () => void;
  onDragOver: (e: DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: DragEvent) => void;
}

/**
 * A chapter heading in the flow: grip, number, title and story year in place,
 * scene count, the moves of its start, and the world of its year (era and
 * the events going on). Alt+Up and Alt+Down on the title move the chapter with
 * its scenes; Enter on the title goes down into its first scene.
 */
function ChapterHead(p: HeadProps) {
  const { row } = p;
  const stored = useEntries('chapters');
  const writes = useOutlineWrites();
  const doc = stored.find((c) => c._id === row.id);
  const year = row.storyYear;
  const era = p.world && year !== null ? eraAt(p.world.eras, year) : null;
  const events = p.world && year !== null ? eventsIn(p.world.events, year) : [];

  const rename = async (title: string): Promise<boolean> => {
    const next = title.trim();
    if (!next) return false;
    const ok = await writes.edit(
      'chapters',
      row.id,
      { title: next },
      `Renamed chapter ${row.readingOrder} to ${next}`,
    );
    return ok === true;
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

  return (
    <div
      className={`scene-ch${p.over ? ' over' : ''}`}
      data-head={row.id}
      data-chapter={row.id}
      data-testid="scene-chapter"
      onDragOver={p.onDragOver}
      onDragLeave={p.onDragLeave}
      onDrop={p.onDrop}
    >
      <div className="scene-ch-main">
        <span
          className="ch-grip"
          role="img"
          aria-label={`Drag chapter ${row.readingOrder}`}
          title="Drag onto another chapter to move this one there, with its scenes"
          draggable={!writes.ro.off}
          data-testid="chapter-grip"
          onDragStart={p.onDragStart}
          onDragEnd={p.onDragEnd}
        />
        <span className="scene-ch-no">Ch {row.readingOrder}</span>
        <TitleInput
          row={row}
          title={doc ? entryTitle(doc) : row.title}
          disabled={writes.ro.off}
          tip={writes.ro.tip}
          autoFocus={p.focusTitle}
          onFocused={p.onFocused}
          onRename={rename}
          onNext={p.onEnterText}
          onMove={p.onMove}
        />
        <span className="scene-ch-year">
          <span className="ch-label">Year</span>
          <NumberField
            label={`Story year of chapter ${row.readingOrder}`}
            testId="chapter-year"
            value={year}
            min={-10000}
            max={10000}
            width="5.5em"
            disabled={writes.ro.off}
            tip={writes.ro.tip}
            onCommit={(y) => (y === null ? Promise.resolve(false) : setYear(y))}
          />
        </span>
        <span className="scene-ch-count" data-testid="chapter-scenes">
          {p.scenes} {p.scenes === 1 ? 'scene' : 'scenes'}
        </span>
        <span className="row tight scene-ch-shift" role="group" aria-label="Where it starts">
          <button
            type="button"
            className="btn small"
            disabled={writes.ro.off || !p.canEarlier}
            {...writes.ro.tip}
            title="Start one scene earlier: take the last scene of the section above"
            aria-label={`Start chapter ${row.readingOrder} one scene earlier`}
            data-testid="chapter-earlier"
            onClick={() => p.onShift(-1)}
          >
            ↑ Scene
          </button>
          <button
            type="button"
            className="btn small"
            disabled={writes.ro.off || !p.canLater}
            {...writes.ro.tip}
            title="Start one scene later: hand the first scene to the section above"
            aria-label={`Start chapter ${row.readingOrder} one scene later`}
            data-testid="chapter-later"
            onClick={() => p.onShift(1)}
          >
            ↓ Scene
          </button>
        </span>
        <button
          type="button"
          className="link-btn"
          onClick={() => p.onOpen('chapters', row.id)}
          data-testid="chapter-open"
        >
          Open
        </button>
      </div>
      {year !== null && (era || events.length > 0) && (
        <div className="scene-world" data-testid="scene-world">
          {era && (
            <button
              type="button"
              className="era-chip"
              title={`${era.name}, ${era.startYear} to ${era.endYear}`}
              onClick={() => p.onOpen('eraStates', era.id)}
            >
              {era.name}
            </button>
          )}
          {events.length > 0 && (
            <>
              <span className="scene-world-label">In the world in {year}:</span>
              <EventChips events={events} limit={3} onOpen={p.onOpen} />
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** What the flow does for a section, told which section it is. */
interface SectionHandlers {
  register: (key: string, el: HTMLTextAreaElement | null) => void;
  onLines: (key: string, lines: string[]) => void;
  onBlur: () => void;
  onLeave: (key: string, by: -1 | 1) => void;
  onNewChapter: (key: string, line: number) => void;
}

interface SectionProps {
  sectionKey: string;
  lines: string[];
  firstScene: number;
  chapter?: number;
  tall?: boolean;
  disabled: boolean;
  tip: { title?: string; 'aria-describedby'?: string };
  handlers: SectionHandlers;
}

/**
 * One section of the flow: a textarea that grows with its text, over a
 * backdrop that repeats the text invisibly in the same font and width so each
 * scene number sits beside its line even when the line wraps. Up on the first
 * line and Down on the last carry on into the next section, so the flow reads
 * and moves as one text.
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
        {p.chapter !== undefined ? `Scenes of chapter ${p.chapter}` : 'Scene outline'}
      </label>
      <div className="scene-backdrop" aria-hidden="true" data-testid="scene-gutter">
        {shown.map((line, i) => {
          const n = numbers[i] ?? null;
          return (
            <div key={i} className="sl" data-scene={n === null ? undefined : p.firstScene + n - 1}>
              {n !== null && <span className="sl-no">{p.firstScene + n - 1}</span>}
              <span className="sl-text">{line === '' ? '​' : line}</span>
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
        Every change is kept. Edits within ten minutes of each other make one version. Restoring an
        older version is itself a new version, so nothing is ever lost.
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
                {v.scenes} {v.scenes === 1 ? 'scene' : 'scenes'}, {v.chars} characters
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

interface TitleInputProps {
  row: ChapterRow;
  title: string;
  disabled: boolean;
  tip: { title?: string; 'aria-describedby'?: string };
  autoFocus: boolean;
  onFocused: () => void;
  onRename: (title: string) => Promise<boolean>;
  onNext: () => void;
  onMove: (by: -1 | 1) => void;
}

/**
 * One chapter title: edits are written on Enter or when the field loses focus;
 * Enter then goes down into the chapter's scenes; Alt+Up and Alt+Down move the
 * chapter, with its scenes.
 */
function TitleInput(p: TitleInputProps) {
  const { row, title } = p;
  const [draft, setDraft] = useState(title);
  const [editing, setEditing] = useState(false);
  const [seen, setSeen] = useState(title);
  const el = useRef<HTMLInputElement | null>(null);
  // A rename from elsewhere (undo, the editor) replaces a draft nobody is typing in.
  if (seen !== title) {
    setSeen(title);
    if (!editing) setDraft(title);
  }
  useEffect(() => {
    if (!p.autoFocus || !el.current) return;
    el.current.focus();
    el.current.select();
    el.current.scrollIntoView({ block: 'center' });
    p.onFocused();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.autoFocus]);

  const commit = async () => {
    setEditing(false);
    if (draft.trim() === title) return;
    const ok = await p.onRename(draft);
    if (!ok) setDraft(title);
  };

  return (
    <input
      ref={el}
      type="text"
      className="ch-title"
      value={draft}
      disabled={p.disabled}
      {...p.tip}
      aria-label={`Title of chapter ${row.readingOrder}`}
      data-testid="chapter-title"
      onFocus={() => setEditing(true)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => void commit()}
      onKeyDown={(e) => {
        if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
          e.preventDefault();
          p.onMove(e.key === 'ArrowUp' ? -1 : 1);
        } else if (e.key === 'Enter') {
          e.preventDefault();
          void commit().then(p.onNext);
        } else if (e.key === 'Escape') {
          setDraft(title);
          setEditing(false);
        }
      }}
    />
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
