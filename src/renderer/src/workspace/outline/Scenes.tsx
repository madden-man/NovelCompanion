import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import {
  EMPTY_OUTLINE,
  LEAD,
  MAX_YEAR,
  MIN_YEAR,
  composeFlow,
  continueBullet,
  indentLines,
  moveBoundary,
  moveOnto,
  neighbourOf,
  refitFlow,
  retext,
  rollbackFlow,
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
import { createCommand, deleteCommand, editCommand } from '../../../../shared/domain/undoRunner';
import type { UndoCommand } from '../../../../shared/domain/undoRunner';
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
import { useBibleSettings } from '../bibleSettings';
import { autosaveMaxMs, fillTemplate } from '../../../../shared/schema/settings';
import { NumberField } from './NumberField';
import { InlineName } from './InlineName';

type Outline = Response<'outline.get'>;
type ChapterRow = Extract<Outline['rows'][number], { kind: 'chapter' }>;
type PartRow = Extract<Outline['rows'][number], { kind: 'part' }>;
type BookRow = Extract<Outline['rows'][number], { kind: 'book' }>;
type VersionSummary = Response<'sceneOutline.versions'>['versions'][number];
type Version = Response<'sceneOutline.version'>;
type Open = (collection: EntryCollection, id: string) => void;

/** Autosave timing for the scene outline, the same as an entry (ED-2). */

/** How long an undo step waits for a restored chapter to reach the reading order. */
const ADOPT_WAIT_MS = 10_000;

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

/**
 * SM-7: an undo or redo step that puts the scene outline back to `to`, when it
 * still holds `expect`. It resolves once the outline is stored and throws when
 * it could not be, so the step is reported and stays where it was.
 */
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
  const { numbers } = useBibleSettings();
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
  /**
   * An undo step's outline that names a chapter not yet back in the reading
   * order (a chapter restored from the trash): it is split again once the
   * order next changes, so the chapter gets its lines back.
   */
  const pending = useRef<{ state: SceneOutlineState; done: (ok: boolean) => void } | null>(null);
  /** Why the last save failed, for an undo step to report. */
  const lastError = useRef<string | null>(null);
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

  const save = useCallback(async (): Promise<boolean> => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (inflight.current) await inflight.current;
    for (;;) {
      const target = stored();
      if (target === null) return true;
      if (sameState(saved.current, target)) {
        firstPending.current = null;
        setStatus('saved');
        return true;
      }
      setStatus('saving');
      const run = call('sceneOutline.set', target).then(
        (r) => {
          saved.current = stateOf(r);
          lastError.current = null;
          setError(null);
          setSaves((n) => n + 1);
          return true;
        },
        (e: unknown) => {
          lastError.current = plainError(e);
          setError(lastError.current);
          setStatus('error');
          return false;
        },
      );
      inflight.current = run.then(() => undefined);
      const ok = await run;
      inflight.current = null;
      if (!ok) return false;
      const now = stored();
      if (now === null || sameState(saved.current, now)) {
        firstPending.current = null;
        setStatus('saved');
        return true;
      }
    }
  }, []);

  const schedule = useCallback(() => {
    if (readOnly) return;
    setStatus('pending');
    if (timer.current) clearTimeout(timer.current);
    const now = Date.now();
    firstPending.current ??= now;
    // IP-11: the bible's autosave delay, and the longest wait it allows.
    const wait = Math.max(
      0,
      Math.min(numbers.autosaveMs, firstPending.current + autosaveMaxMs(numbers) - now),
    );
    timer.current = setTimeout(() => void save(), wait);
  }, [save, readOnly, numbers]);

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
    const waiting = pending.current;
    pending.current = null;
    current.current = waiting
      ? splitFlow(waiting.state, order)
      : refitFlow(current.current, before, order);
    setFlow(current.current);
    takeSplit();
    if (waiting) {
      // An undo step waits for this write; it fails if the write does.
      void save().then(waiting.done);
      return;
    }
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
    const off = undo.registerFlush(async () => {
      await save();
    });
    const failed = () => new Error(lastError.current ?? 'The scene outline was not saved.');
    live.current = {
      state: stored,
      adopt: async (s) => {
        // On a failed write the screen goes back to what is stored, so it never runs ahead of the stack.
        const prior = current.current;
        const priorOrder = orderRef.current;
        const rollback = () => {
          if (!prior) return;
          current.current = rollbackFlow(prior, priorOrder, orderRef.current);
          setFlow(current.current);
          const target = stored();
          if (target && sameState(saved.current, target)) {
            if (timer.current) clearTimeout(timer.current);
            timer.current = null;
            firstPending.current = null;
            setStatus('saved');
          }
        };
        current.current = splitFlow(s, orderRef.current);
        setFlow(current.current);
        if (Object.keys(s.breaks).some((id) => !orderRef.current.includes(id))) {
          // A chapter in it is not back in the reading order yet: wait for it, then write.
          await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => {
              if (pending.current?.state !== s) return;
              pending.current = null;
              rollback();
              reject(new Error('The chapter did not come back in time to take its scenes.'));
            }, ADOPT_WAIT_MS);
            pending.current = {
              state: s,
              done: (ok) => {
                clearTimeout(timeout);
                if (ok) resolve();
                else {
                  rollback();
                  reject(failed());
                }
              },
            };
          });
          return;
        }
        if (!(await save())) {
          rollback();
          throw failed();
        }
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

  /** The flow and reading order as they are now, for a write that must know both. */
  const snapshot = () =>
    current.current === null ? null : { flow: current.current, order: orderRef.current };

  return { flow, status, error, saves, edit, step, save, replace, splitInto, snapshot };
}

/** Series tokens the chapters cycle through, in reading order. */
const TINTS = ['series-1', 'series-2', 'series-3', 'series-4'];

/** Lines of a section, as a textarea holds them. */
const asText = (lines: readonly string[]) => lines.join('\n');
const asLines = (text: string) => (text === '' ? [] : text.split('\n'));

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Where a dragged bar would land: before the `index`th of the other chapters, in `partId`. */
interface Slot {
  index: number;
  partId: string;
  /** Where the drop line is drawn, from the top of the board. */
  guide: number;
}

/** A bar being dragged, or the line between two chapters. */
type Grab =
  | {
      mode: 'move';
      id: string;
      startY: number;
      startScroll: number;
      dy: number;
      slot: Slot | null;
      trash: boolean;
    }
  | { mode: 'line'; upper: string; lower: string; at: number | null; guide: number | null };

/** How near the top or bottom of the outline a drag scrolls it, and how fast. */
const SCROLL_EDGE = 48;
const SCROLL_STEP = 14;

/**
 * A46: the Outline. The scene text on the left with a year beside every
 * scene (SM-5); on the right one bar per chapter in reading order, beside the
 * lines of its section, in one flat list. Between two chapters is a line that
 * drags up and down a line of text at a time, moving lines from one chapter
 * to the other. A bar drags to a new place, across a divider too, or onto the
 * trash pinned at the top. A divider starts a new section of chapters (a part
 * in the store) and is added or removed between any two chapters.
 */
export function SceneOutline(props: { onOpen: Open }) {
  const { version } = useStore();
  const { templates } = useBibleSettings();
  const ro = useWriteGuard();
  const writes = useOutlineWrites();
  const story = useStoryTime();
  const undo = useUndo();
  const [outline, setOutline] = useState<Outline | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [grab, setGrab] = useState<Grab | null>(null);
  const [refocus, setRefocus] = useState<string | null>(null);
  const [focusText, setFocusText] = useState<string | null>(null);
  const areas = useRef(new Map<string, HTMLTextAreaElement>());
  const board = useRef<HTMLDivElement | null>(null);
  const head = useRef<HTMLDivElement | null>(null);
  const trash = useRef<HTMLDivElement | null>(null);
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
  const parts = useMemo(
    () => (outline?.rows ?? []).filter((r): r is PartRow => r.kind === 'part' && !r.missing),
    [outline],
  );
  const books = useMemo(
    () => (outline?.rows ?? []).filter((r): r is BookRow => r.kind === 'book' && !r.missing),
    [outline],
  );
  const order = useMemo(() => (outline ? chapters.map((c) => c.id) : null), [outline, chapters]);
  const scene = useSceneDoc(order, ro.off);
  const flow = scene.flow;
  const tintOf = (id: string) => TINTS[(order?.indexOf(id) ?? 0) % TINTS.length] ?? 'series-1';

  const linesOf = (key: string): string[] => (flow ? sectionOf(flow, key).lines : []);
  const nameOf = (key: string) =>
    key === LEAD
      ? 'the lines before the first chapter'
      : (chapters.find((c) => c.id === key)?.title ?? 'a chapter');

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

  // A new chapter's text takes the focus once it is on screen, with its first bullet.
  useEffect(() => {
    if (!focusText) return;
    const el = areas.current.get(focusText);
    if (!el) return;
    setFocusText(null);
    el.focus();
    el.scrollIntoView({ block: 'center' });
  }, [focusText, flow]);

  const focusSection = (key: string, at: 'start' | 'end') => {
    const el = areas.current.get(key);
    if (!el) return;
    el.focus();
    const pos = at === 'start' ? 0 : el.value.length;
    el.setSelectionRange(pos, pos);
  };
  const neighbour = (key: string, by: -1 | 1) => keys[keys.indexOf(key) + by] ?? null;

  /** The part a new chapter goes in when there is no chapter to follow: the last, made when there is none. */
  const ensurePart = async (): Promise<string | undefined> => {
    const last = parts.at(-1);
    if (last) return last.id;
    const bookId =
      books.at(-1)?.id ??
      (await writes.create('books', {
        title: fillTemplate(templates.bookTitle, 1),
        number: 1,
        status: 'idea',
      }));
    if (!bookId) return undefined;
    const title = fillTemplate(templates.partTitle, 1);
    return writes.create('parts', { title, bookId, number: 1, status: 'idea' });
  };

  /**
   * Cmd+Enter in the text: a new chapter starts at the line with the caret,
   * after the chapter it was in, in the same section, set in that chapter's
   * year. The lines from the caret on move into it once it exists.
   */
  const newChapterAt = async (key: string, line: number) => {
    const row = chapters.find((c) => c.id === key);
    const partId = row?.partId ?? chapters[0]?.partId ?? (await ensurePart());
    if (!partId) return;
    const year = row?.storyYear ?? story.year;
    const arrived = scene.splitInto((f, id) => {
      const from = sectionOf(f, key);
      const keep = sliceSection(from, 0, line);
      const moved = sliceSection(from, line);
      return withSection(withSection(f, key, keep), id, moved);
    });
    const madeId = await writes.newChapter(partId, templates.chapterTitle, year, row?.id);
    arrived(madeId ?? null);
    if (madeId) setRefocus(madeId);
  };

  /** New chapter at the foot: last, in the year of the chapter before it; one undo step. */
  const addChapter = async () => {
    setNotice(null);
    const partId = chapters.at(-1)?.partId ?? (await ensurePart());
    if (!partId) return;
    const year = chapters.at(-1)?.storyYear ?? story.year;
    const id = await writes.newChapter(partId, templates.chapterTitle, year);
    if (id) setFocusText(id);
  };

  const placed = chapters.map((c) => ({ id: c.id, partId: c.partId }));
  /** From the keyboard: the chapter goes just past `targetId`, its scenes with it; one undo step. */
  const swap = (id: string, by: -1 | 1) => {
    const other = neighbourOf(placed, id, by);
    const req = other && moveOnto(placed, id, other);
    const row = chapters.find((c) => c.id === id);
    if (!req || !row) return;
    setRefocus(id);
    void writes.reorder(req, `Moved ${row.title} ${by < 0 ? 'up' : 'down'}`);
  };
  /** A dropped bar: the chapter takes the slot, in the slot's section, its scenes with it; one undo step. */
  const place = (id: string, slot: Slot) => {
    const row = chapters.find((c) => c.id === id);
    if (!row) return;
    const others = chapters.filter((c) => c.id !== id);
    if (slot.index === chapters.indexOf(row) && slot.partId === row.partId) return;
    const toIndex = others.slice(0, slot.index).filter((c) => c.partId === slot.partId).length;
    setRefocus(id);
    void writes.reorder(
      { kind: 'chapters', groupId: slot.partId, movedId: id, toIndex },
      `Moved ${row.title}`,
    );
  };
  /** The line between two sections moves to `at` lines into the upper one; one undo step. */
  const moveLine = (upper: string, lower: string, at: number) => {
    scene.step(`Moved the line between ${nameOf(upper)} and ${nameOf(lower)}`, (f) =>
      moveBoundary(f, upper, lower, at),
    );
  };

  /**
   * The trash: the chapter goes, its lines join the section above so no scene
   * is lost, and one undo step brings back both.
   */
  const trashChapter = async (id: string): Promise<boolean> => {
    const row = chapters.find((c) => c.id === id);
    await scene.save();
    const snap = scene.snapshot();
    if (!row || !snap || ro.off) return false;
    setNotice(null);
    const without = snap.order.filter((c) => c !== id);
    const before = composeFlow(snap.flow, snap.order);
    const after = composeFlow(refitFlow(snap.flow, snap.order, without), without);
    try {
      await call('entry.delete', { collection: 'chapters', id });
    } catch (e) {
      setNotice(plainError(e));
      return false;
    }
    const del = deleteCommand('chapters', id, row.title);
    undo.record({
      label: del.label,
      undo: [...del.undo, outlineOp(after, before)],
      redo: [...del.redo, outlineOp(before, after)],
    });
    setDone(
      sectionScenes(linesOf(id)) > 0
        ? `${row.title} is in the trash. Its lines stay in the outline, in the chapter above. Undo brings it back.`
        : `${row.title} is in the trash. Undo brings it back.`,
    );
    return true;
  };

  // ---------- dividers: the sections of chapters, kept as parts ----------

  /** One field change through the write path, as an undo step to fold into a bigger one. */
  const update = async (
    collection: EntryCollection,
    id: string,
    patch: Record<string, unknown>,
  ): Promise<UndoCommand> => {
    const { entry: before } = await call('entry.get', { collection, id });
    const { entry: after } = await call('entry.update', { collection, id, patch });
    return editCommand('', collection, id, before, after);
  };
  /** Several writes as one undo step; what was written before a failure is still one step. */
  const together = async (
    label: string,
    run: (steps: UndoCommand[]) => Promise<void>,
  ): Promise<void> => {
    if (ro.off) return;
    setNotice(null);
    const steps: UndoCommand[] = [];
    try {
      await run(steps);
    } catch (e) {
      setNotice(plainError(e));
    }
    if (steps.length === 0) return;
    undo.record({
      label,
      undo: [...steps].reverse().flatMap((s) => s.undo),
      redo: steps.flatMap((s) => s.redo),
    });
  };

  /** A divider before `lowerId`: it and the chapters after it in its section start a new section. */
  const addDivider = (lowerId: string) => {
    const at = chapters.findIndex((c) => c.id === lowerId);
    const lower = chapters[at];
    const part = lower && parts.find((p) => p.id === lower.partId);
    if (!lower || !part || at <= 0) return;
    const moving = chapters.slice(at).filter((c) => c.partId === part.id);
    const n = part.number ?? 0;
    void together(`Added a divider before ${lower.title}`, async (steps) => {
      for (const p of parts) {
        if (p.bookId === part.bookId && p.id !== part.id && (p.number ?? 0) > n) {
          steps.push(await update('parts', p.id, { number: (p.number ?? 0) + 1 }));
        }
      }
      const { entry } = await call('entry.create', {
        collection: 'parts',
        data: {
          title: fillTemplate(templates.sectionTitle, n + 1),
          bookId: part.bookId,
          number: n + 1,
          status: 'idea',
        },
      });
      steps.push(createCommand('parts', entry._id, entryTitle(entry)));
      for (const c of moving) steps.push(await update('chapters', c.id, { partId: entry._id }));
    });
  };

  /** The divider before `lowerId` goes: the chapters below it join the section above, and its part goes to the trash. */
  const removeDivider = (lowerId: string) => {
    const at = chapters.findIndex((c) => c.id === lowerId);
    const upper = chapters[at - 1];
    const lower = chapters[at];
    if (!upper || !lower || upper.partId === lower.partId) return;
    const moving = chapters.filter((c) => c.partId === lower.partId);
    const top = Math.max(
      ...chapters.filter((c) => c.partId === upper.partId).map((c) => c.readingOrder),
    );
    const renumber = moving.some((c) => c.readingOrder <= top);
    const gone = parts.find((p) => p.id === lower.partId);
    void together(`Removed the divider before ${lower.title}`, async (steps) => {
      for (const [i, c] of moving.entries()) {
        steps.push(
          await update('chapters', c.id, {
            partId: upper.partId,
            ...(renumber ? { readingOrder: top + 1 + i } : {}),
          }),
        );
      }
      if (gone) {
        await call('entry.delete', { collection: 'parts', id: gone.id });
        steps.push(deleteCommand('parts', gone.id, gone.title));
      }
    });
  };

  // ---------- pointer drags ----------

  const scroller = () => board.current?.closest<HTMLElement>('[data-testid="outline-scroll"]');

  /** The lines of two sections, top to bottom, from the top of the board. */
  const lineBoxes = (pair: readonly string[]) => {
    const el = board.current;
    if (!el) return [];
    const base = el.getBoundingClientRect().top;
    return pair.flatMap((k) =>
      [...el.querySelectorAll<HTMLElement>(`[data-row="${CSS.escape(k)}"] .sl[data-line]`)].map(
        (n) => {
          const r = n.getBoundingClientRect();
          return { top: r.top - base, bottom: r.bottom - base };
        },
      ),
    );
  };
  /** How many of the two sections' lines sit above a point, and where that line is drawn. */
  const lineAt = (upper: string, lower: string, clientY: number) => {
    const el = board.current;
    const boxes = lineBoxes([upper, lower]);
    if (!el || boxes.length === 0) return { at: null, guide: null };
    const y = clientY - el.getBoundingClientRect().top;
    const at = boxes.filter((b) => (b.top + b.bottom) / 2 < y).length;
    const guide = at === 0 ? (boxes[0]?.top ?? 0) : (boxes[at - 1]?.bottom ?? 0);
    return { at, guide };
  };
  /** Where a dragged bar would land. Next to a divider, above its middle is the end of the section above. */
  const slotAt = (id: string, clientY: number): Slot | null => {
    const el = board.current;
    if (!el) return null;
    const base = el.getBoundingClientRect().top;
    const others = chapters.flatMap((c) => {
      if (c.id === id) return [];
      const bar = el.querySelector(
        `[data-testid="chapter-bar"][data-chapter="${CSS.escape(c.id)}"]`,
      );
      const r = bar?.getBoundingClientRect();
      return r ? [{ c, top: r.top, bottom: r.bottom, mid: (r.top + r.bottom) / 2 }] : [];
    });
    const last = others.at(-1);
    if (!last) return null;
    for (const [i, o] of others.entries()) {
      const prev = others[i - 1];
      if (prev && prev.c.partId !== o.c.partId && clientY < (prev.bottom + o.top) / 2) {
        return { index: i, partId: prev.c.partId, guide: prev.bottom - base + 3 };
      }
      if (clientY < o.mid) return { index: i, partId: o.c.partId, guide: o.top - base - 3 };
    }
    return { index: others.length, partId: last.c.partId, guide: last.bottom - base + 3 };
  };
  const overTrash = (x: number, y: number) => {
    const r = trash.current?.getBoundingClientRect();
    return !!r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  };

  const grabRef = useRef<Grab | null>(null);
  const pointer = useRef({ x: 0, y: 0 });
  const changeGrab = (g: Grab | null) => {
    grabRef.current = g;
    setGrab(g);
  };
  /** What a drag does as the pointer moves and when it ends, as of the latest render. */
  const track = (g: Grab, x: number, y: number): Grab => {
    if (g.mode === 'line') return { ...g, ...lineAt(g.upper, g.lower, y) };
    const onTrash = overTrash(x, y);
    return {
      ...g,
      dy: y - g.startY + (scroller()?.scrollTop ?? 0) - g.startScroll,
      trash: onTrash,
      slot: onTrash ? null : slotAt(g.id, y),
    };
  };
  const finish = (g: Grab) => {
    if (g.mode === 'line') {
      if (g.at !== null) moveLine(g.upper, g.lower, g.at);
    } else if (g.trash) void trashChapter(g.id);
    else if (g.slot) place(g.id, g.slot);
  };
  const act = useRef({ track, finish });
  useLayoutEffect(() => {
    act.current = { track, finish };
  });

  const beginMove = (e: ReactPointerEvent, id: string) => {
    if (ro.off || e.button !== 0) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).focus({ preventScroll: true });
    setRefocus(null);
    setDone(null);
    pointer.current = { x: e.clientX, y: e.clientY };
    changeGrab({
      mode: 'move',
      id,
      startY: e.clientY,
      startScroll: scroller()?.scrollTop ?? 0,
      dy: 0,
      slot: null,
      trash: false,
    });
  };
  const beginLine = (e: ReactPointerEvent, upper: string, lower: string) => {
    if (ro.off || e.button !== 0) return;
    e.preventDefault();
    pointer.current = { x: e.clientX, y: e.clientY };
    changeGrab({ mode: 'line', upper, lower, at: null, guide: null });
  };

  useEffect(() => {
    if (!grab) return;
    const follow = () => {
      const g = grabRef.current;
      if (g) changeGrab(act.current.track(g, pointer.current.x, pointer.current.y));
    };
    const move = (e: PointerEvent) => {
      pointer.current = { x: e.clientX, y: e.clientY };
      follow();
    };
    const up = (e: PointerEvent) => {
      const g = grabRef.current;
      changeGrab(null);
      if (g) act.current.finish(act.current.track(g, e.clientX, e.clientY));
    };
    const cancel = () => changeGrab(null);
    const esc = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') cancel();
    };
    // Near the top or bottom of the outline the drag scrolls it, so a bar can reach the trash from far down.
    let frame = 0;
    const scroll = () => {
      const sc = scroller();
      if (sc) {
        const r = sc.getBoundingClientRect();
        const top = head.current?.getBoundingClientRect().bottom ?? r.top;
        const y = pointer.current.y;
        const by =
          y > top && y < top + SCROLL_EDGE
            ? -SCROLL_STEP
            : y > r.bottom - SCROLL_EDGE
              ? SCROLL_STEP
              : 0;
        if (by !== 0) {
          sc.scrollTop += by;
          follow();
        }
      }
      frame = requestAnimationFrame(scroll);
    };
    frame = requestAnimationFrame(scroll);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', esc);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', esc);
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
    // SM-5: a committed year is one undo step, as the story year field is.
    onYear: (key, line, year) =>
      void scene.step(
        year === null ? "Cleared a scene's year" : `Set a scene's year to ${year}`,
        (f) => withSection(f, key, setSceneYear(sectionOf(f, key), line, year)),
      ),
    onBlur: () => void scene.save(),
    onLeave: (key, by) => {
      const next = neighbour(key, by);
      if (next) focusSection(next, by < 0 ? 'end' : 'start');
    },
    onNewChapter: (key, line) => void newChapterAt(key, line),
  };

  const moving = grab?.mode === 'move' ? grab : null;
  const guide = grab?.mode === 'line' ? grab.guide : (moving?.slot?.guide ?? null);
  return (
    <div className="ws-tree-area scenes" data-testid="outline-view">
      <section
        className="tree-main stack"
        aria-labelledby="outline-title"
        data-testid="outline-scroll"
      >
        <div className="list-head scene-head" ref={head}>
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
          <div
            ref={trash}
            className={`scene-trash${moving ? ' armed' : ''}${moving?.trash ? ' over' : ''}`}
            data-testid="scene-trash"
            aria-label="Trash: drag a chapter here to delete it"
            title="Drag a chapter here to delete it. Undo brings it back."
          >
            <TrashIcon />
            <span>{moving ? 'Drop here to delete' : 'Trash'}</span>
          </div>
        </div>
        <p className="example-note">
          Drag the line between two chapters to move lines from one to the other. Drag a chapter to
          a new place, or onto the trash to delete it. Add a divider between two chapters to start a
          new section. Enter adds the next scene, Cmd+] indents, Cmd+[ outdents, and Cmd+Enter
          starts a new chapter at the line you are on.
        </p>
        {(scene.error ?? writes.error ?? notice) && (
          <p className="callout crit" role="alert">
            {scene.error ?? writes.error ?? notice}
          </p>
        )}
        {done && (
          <p className="callout" role="status" data-testid="scene-done">
            {done}
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
            {keys.map((key, i) => {
              const row = key === LEAD ? null : (chapters.find((c) => c.id === key) ?? null);
              const above = keys[i - 1];
              const aboveRow = chapters.find((c) => c.id === above) ?? null;
              const sec = sectionOf(flow, key);
              const years = shownYears(sec, row?.storyYear ?? null);
              const tint = row ? tintOf(row.id) : 'lead';
              const split = row !== null && aboveRow !== null && aboveRow.partId !== row.partId;
              const part = split ? parts.find((p) => p.id === row.partId) : undefined;
              return (
                <Fragment key={key}>
                  {above !== undefined && (
                    <Boundary
                      upper={above}
                      lower={key}
                      upperLines={linesOf(above).length}
                      lowerLines={sec.lines.length}
                      label={`Line between ${nameOf(above)} and ${nameOf(key)}`}
                      divider={
                        split
                          ? {
                              title: part?.title ?? 'Section',
                              label: part?.label ?? 'Section',
                              partId: part?.id ?? null,
                            }
                          : null
                      }
                      canDivide={
                        !split &&
                        row !== null &&
                        aboveRow !== null &&
                        parts.some((p) => p.id === row.partId)
                      }
                      active={grab?.mode === 'line' && grab.upper === above && grab.lower === key}
                      disabled={ro.off}
                      onGrab={(e) => beginLine(e, above, key)}
                      onStep={(by) => moveLine(above, key, linesOf(above).length + by)}
                      onAddDivider={() => addDivider(key)}
                      onRemoveDivider={() => removeDivider(key)}
                    />
                  )}
                  <div className={`sb-row ${tint}`} data-row={key}>
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
                          scenes={sectionScenes(sec.lines)}
                          firstScene={firstScene.get(key) ?? 1}
                          dy={moving?.id === key ? moving.dy : 0}
                          moving={moving?.id === key}
                          onGrab={(e) => beginMove(e, row.id)}
                          onSwap={(by) => swap(row.id, by)}
                          onFocusBar={() => setRefocus(null)}
                          onOpen={props.onOpen}
                          onTrash={() => void trashChapter(row.id)}
                        />
                      ) : (
                        <div className="sb-none">Not in a chapter</div>
                      )}
                    </div>
                  </div>
                </Fragment>
              );
            })}
            <div className="sb-row sb-foot-row">
              <div className="sb-gap" aria-hidden="true" />
              <div className="sb-track foot" data-testid="track-foot">
                <button
                  type="button"
                  className="btn small"
                  disabled={ro.off}
                  {...ro.tip}
                  data-testid="new-chapter"
                  onClick={() => void addChapter()}
                >
                  New chapter
                </button>
              </div>
            </div>
            {guide !== null && (
              <div
                className={`sb-guide${grab?.mode === 'move' ? ' slot' : ''}`}
                style={{ top: guide }}
                aria-hidden="true"
                data-testid="drop-guide"
              />
            )}
          </div>
        )}
        <Versions
          saves={scene.saves}
          onRestore={(r) => {
            // ED-3: a restored version is one step; undo puts the outline back as it was.
            const snap = scene.snapshot();
            const before = snap ? composeFlow(snap.flow, snap.order) : null;
            scene.replace(r);
            const after = stateOf(r);
            if (before && !sameState(before, after)) {
              undo.record({
                label: 'Restored an outline version',
                undo: [outlineOp(after, before)],
                redo: [outlineOp(before, after)],
              });
            }
          }}
        />
      </section>
    </div>
  );
}

function TrashIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * A46: the line between two sections. It drags up and down a line of text at
 * a time (Up and Down from the keyboard), moving lines between the two. When
 * the two chapters are in different sections it is a divider, named in place
 * and removable; otherwise it offers to add one.
 */
function Boundary(p: {
  upper: string;
  lower: string;
  upperLines: number;
  lowerLines: number;
  label: string;
  divider: { title: string; label: string; partId: string | null } | null;
  canDivide: boolean;
  active: boolean;
  disabled: boolean;
  onGrab: (e: ReactPointerEvent) => void;
  onStep: (by: -1 | 1) => void;
  onAddDivider: () => void;
  onRemoveDivider: () => void;
}) {
  const writes = useOutlineWrites();
  const { divider } = p;
  const canMove = p.upperLines + p.lowerLines > 0;
  return (
    <div
      className={`sb-boundary${divider ? ' divider' : ''}${p.active ? ' active' : ''}${p.disabled || !canMove ? ' off' : ''}`}
      data-testid="boundary"
      data-upper={p.upper}
      data-lower={p.lower}
      onPointerDown={(e) => {
        if ((e.target as HTMLElement).closest('input, button')) return;
        if (canMove) p.onGrab(e);
      }}
    >
      <span
        className="sb-grip"
        role="separator"
        tabIndex={p.disabled || !canMove ? -1 : 0}
        aria-orientation="horizontal"
        aria-valuemin={0}
        aria-valuemax={p.upperLines + p.lowerLines}
        aria-valuenow={p.upperLines}
        aria-label={`${p.label}. Up and Down move it a line.`}
        title="Drag to move lines between these chapters"
        data-testid="boundary-grip"
        onKeyDown={(e) => {
          if (p.disabled || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
          if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
          e.preventDefault();
          p.onStep(e.key === 'ArrowUp' ? -1 : 1);
        }}
      />
      {divider ? (
        <span className="sb-divider-label" data-testid="divider">
          {divider.partId ? (
            <InlineName
              value={divider.title}
              label="Divider name"
              disabled={writes.ro.off}
              testId="divider-name"
              onSave={(t) =>
                divider.partId &&
                writes.edit('parts', divider.partId, { title: t }, `Renamed ${divider.label}`)
              }
            >
              {divider.title}
            </InlineName>
          ) : (
            <span className="ol-name missing">{divider.title}</span>
          )}
          <button
            type="button"
            className="btn small sb-divider-remove"
            disabled={p.disabled}
            aria-label={`Remove the divider ${divider.title}`}
            title="Remove this divider"
            data-testid="remove-divider"
            onClick={p.onRemoveDivider}
          >
            ×
          </button>
        </span>
      ) : (
        p.canDivide && (
          <button
            type="button"
            className="btn small sb-add-divider"
            disabled={p.disabled}
            title="Start a new section of chapters here"
            data-testid="add-divider"
            onClick={p.onAddDivider}
          >
            + Divider
          </button>
        )
      )}
    </div>
  );
}

interface BarProps {
  row: ChapterRow;
  scenes: number;
  firstScene: number;
  dy: number;
  moving: boolean;
  onGrab: (e: ReactPointerEvent) => void;
  onSwap: (by: -1 | 1) => void;
  onFocusBar: () => void;
  onOpen: Open;
  onTrash: () => void;
}

/**
 * One chapter's bar, as tall as its section, in its colour, with its name
 * (renamed in place), scene count and story year. Drag it to a new place or
 * onto the trash. Focused: Up and Down move it past its neighbour, Delete
 * puts it in the trash.
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
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      p.onSwap(e.key === 'ArrowUp' ? -1 : 1);
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      p.onTrash();
    }
  };

  const span =
    p.scenes === 0
      ? 'no scenes'
      : p.scenes === 1
        ? `scene ${p.firstScene}`
        : `scenes ${p.firstScene} to ${p.firstScene + p.scenes - 1}`;
  return (
    <div
      className={`cbar${p.moving ? ' moving' : ''}${off ? ' off' : ''}`}
      style={p.dy ? { transform: `translateY(${p.dy}px)` } : undefined}
      role="group"
      tabIndex={0}
      aria-roledescription="chapter bar"
      aria-label={`Chapter ${row.readingOrder}, ${title}, ${span}`}
      aria-keyshortcuts="ArrowUp ArrowDown Delete"
      title="Drag to move this chapter, or onto the trash to delete it. Up and Down move it, Delete deletes it."
      data-testid="chapter-bar"
      data-chapter={row.id}
      onKeyDown={onKeyDown}
      onFocus={(e) => {
        if (e.target === e.currentTarget) p.onFocusBar();
      }}
      onPointerDown={(e) => {
        if ((e.target as HTMLElement).closest('input, button, select, a')) return;
        p.onGrab(e);
      }}
    >
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
            className="link-btn cbar-open"
            data-testid="chapter-open"
            aria-label={`Open chapter ${row.readingOrder}, ${title}`}
            onClick={() => p.onOpen('chapters', row.id)}
          >
            Open
          </button>
        </span>
      </span>
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
            <div
              key={i}
              className="sl"
              data-scene={scene ?? undefined}
              data-line={p.lines.length ? i : undefined}
            >
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
  const input = useRef<HTMLInputElement | null>(null);
  const selectAll = useRef(false);
  useLayoutEffect(() => {
    if (!selectAll.current) return;
    selectAll.current = false;
    input.current?.select();
  }, [draft]);
  const commit = () => {
    const t = draft.trim();
    // An inherited year filled in on focus and left as it was stays inherited.
    if (t === value) return;
    if (own === null && inherited !== null && t === String(inherited)) {
      setDraft(value);
      return;
    }
    if (t === '') return props.onCommit(null);
    const n = Number(t);
    if (Number.isInteger(n) && n >= MIN_YEAR && n <= MAX_YEAR) props.onCommit(n);
    else setDraft(value);
  };
  return (
    <input
      ref={input}
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
      onFocus={(e) => {
        // A46: an inherited year is filled in and selected, so it can be typed over or edited.
        if (own !== null || inherited === null || props.disabled) return;
        if (e.currentTarget.value !== '') return;
        selectAll.current = true;
        setDraft(String(inherited));
      }}
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
