import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import {
  EMPTY_OUTLINE,
  chaptersAtScene,
  continueBullet,
  indentLines,
  rangeIssues,
  sameRanges,
  sceneCount,
  sceneLines,
} from '../../../../shared/domain/sceneOutline';
import type { SceneRange, SceneRanges } from '../../../../shared/domain/sceneOutline';
import { shiftStrand } from '../../../../shared/domain/strands';
import type { Response } from '../../../../shared/ipc';
import { entryTitle } from '../../../../shared/schema';
import { useWriteGuard } from '../../connection';
import { call, plainError } from '../../api';
import { useEntries, useStore } from '../data';
import { UndoPanel } from '../editor';
import { useOutlineWrites } from './actions';

type Outline = Response<'outline.get'>;
type ChapterRow = Extract<Outline['rows'][number], { kind: 'chapter' }>;
type VersionSummary = Response<'sceneOutline.versions'>['versions'][number];
type Version = Response<'sceneOutline.version'>;

/** Autosave timing for the scene outline, the same as an entry (ED-2). */
const SCENE_DEBOUNCE_MS = 500;
const SCENE_MAX_WAIT_MS = 700;

type SceneStatus = 'loading' | 'saved' | 'pending' | 'saving' | 'error';

interface SceneDoc {
  text: string;
  ranges: SceneRanges;
}

/**
 * The scene outline document (text and ranges) with its autosave: every change
 * updates the draft at once and is written 500 ms after the last one, never
 * more than 700 ms after the first unsaved one. `saves` counts finished writes
 * so the versions list can reload.
 */
function useSceneDoc() {
  const [doc, setDoc] = useState<SceneDoc | null>(null);
  const [status, setStatus] = useState<SceneStatus>('loading');
  const [error, setError] = useState<string | null>(null);
  const [saves, setSaves] = useState(0);
  const [reloads, setReloads] = useState(0);
  const current = useRef<SceneDoc | null>(null);
  const saved = useRef<SceneDoc | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const firstPending = useRef<number | null>(null);
  const inflight = useRef<Promise<void> | null>(null);

  const stored = (d: SceneDoc): SceneDoc =>
    d.text === EMPTY_OUTLINE ? { text: '', ranges: d.ranges } : d;
  const same = (a: SceneDoc | null, b: SceneDoc) =>
    a !== null && a.text === b.text && sameRanges(a.ranges, b.ranges);

  useEffect(() => {
    let live = true;
    void call('sceneOutline.get', {})
      .then((r) => {
        if (!live) return;
        const value = { text: r.text === '' ? EMPTY_OUTLINE : r.text, ranges: r.ranges };
        saved.current = { text: r.text, ranges: r.ranges };
        current.current = value;
        setDoc(value);
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
      const target = current.current;
      if (target === null) return;
      const next = stored(target);
      if (same(saved.current, next)) {
        firstPending.current = null;
        setStatus('saved');
        return;
      }
      setStatus('saving');
      const run = call('sceneOutline.set', next).then(
        (r) => {
          saved.current = { text: r.text, ranges: r.ranges };
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
      if (current.current === target) {
        firstPending.current = null;
        setStatus('saved');
        return;
      }
    }
  }, []);

  const schedule = useCallback(() => {
    setStatus('pending');
    if (timer.current) clearTimeout(timer.current);
    const now = Date.now();
    firstPending.current ??= now;
    const wait = Math.max(
      0,
      Math.min(SCENE_DEBOUNCE_MS, firstPending.current + SCENE_MAX_WAIT_MS - now),
    );
    timer.current = setTimeout(() => void save(), wait);
  }, [save]);

  // Leaving the screen writes what is pending.
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      const target = current.current;
      if (target && !same(saved.current, stored(target))) {
        void call('sceneOutline.set', stored(target));
      }
    },
    [],
  );

  const update = useCallback(
    (change: (d: SceneDoc) => SceneDoc) => {
      const base = current.current;
      if (!base) return;
      const next = change(base);
      current.current = next;
      setDoc(next);
      schedule();
    },
    [schedule],
  );

  /** After a restore the stored state is the new truth. */
  const replace = useCallback((r: { text: string; ranges: SceneRanges }) => {
    const value = { text: r.text === '' ? EMPTY_OUTLINE : r.text, ranges: r.ranges };
    saved.current = { text: r.text, ranges: r.ranges };
    current.current = value;
    setDoc(value);
    setStatus('saved');
    setSaves((n) => n + 1);
  }, []);

  return { doc, status, error, saves, update, save, replace };
}

/** Series tokens the chapter ranges cycle through, in reading order. */
const TINTS = ['series-1', 'series-2', 'series-3', 'series-4'];

/**
 * PL-5 (A36): the scene outline. One long bulleted text on the left with a
 * numbered gutter that tints each chapter's scenes; the chapters in reading
 * order on the right, each with its title, story year and scene range editable
 * in place and buttons to move it; and the saved versions below the text.
 */
export function SceneOutline({ toggle }: { toggle: ReactNode }) {
  const { version } = useStore();
  const [outline, setOutline] = useState<Outline | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const scene = useSceneDoc();

  useEffect(() => {
    let live = true;
    void call('outline.get', { order: 'reading', cursorYear: null }).then((r) => {
      if (live) setOutline(r);
    });
    return () => {
      live = false;
    };
  }, [version]);

  const chapterRows = useMemo(
    () => (outline?.rows ?? []).filter((r): r is ChapterRow => r.kind === 'chapter'),
    [outline],
  );
  const order = useMemo(() => chapterRows.map((c) => c.id), [chapterRows]);
  const tintOf = useMemo(
    () => new Map(order.map((id, i) => [id, TINTS[i % TINTS.length] ?? 'series-1'])),
    [order],
  );
  const numberOf = (id: string) => chapterRows.find((c) => c.id === id)?.readingOrder ?? '?';
  const text = scene.doc?.text ?? '';
  const scenes = sceneCount(text);
  const issues = useMemo(
    () => rangeIssues(scene.doc?.ranges ?? {}, scenes, numberOf),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scene.doc?.ranges, scenes, chapterRows],
  );

  return (
    <div className="ws-tree-area scenes" data-testid="outline-view">
      <section className="tree-main stack" aria-labelledby="outline-title">
        <div className="list-head">
          <h2 id="outline-title">Outline</h2>
          <span className="row tight">{toggle}</span>
        </div>
        <p className="example-note">
          One long list of scenes in page order, free of the chapter titles. Enter adds the next
          scene, Cmd+] indents, Cmd+[ outdents, and Enter on an empty bullet ends the list. A line
          without a bullet is a heading. On the right, give each chapter its title, its story year,
          and the scenes it covers; the gutter shows which chapter each scene belongs to.
        </p>
        <SceneEditor
          scene={scene}
          order={order}
          tintOf={tintOf}
          numberOf={numberOf}
          hover={hover}
        />
        <Versions saves={scene.saves} onRestore={scene.replace} />
      </section>
      <aside
        className="inspector tree-inspector"
        aria-label="Chapters"
        data-testid="outline-inspector"
      >
        <span className="eyebrow">Chapters in reading order</span>
        {!outline || !scene.doc ? (
          <p aria-live="polite">Loading the chapters.</p>
        ) : (
          <ChapterList
            rows={outline.rows}
            chapters={chapterRows}
            ranges={scene.doc.ranges}
            scenes={scenes}
            issues={issues}
            tintOf={tintOf}
            onRange={(id, range) =>
              scene.update((d) => {
                const rest = Object.fromEntries(Object.entries(d.ranges).filter(([k]) => k !== id));
                return { ...d, ranges: range ? { ...rest, [id]: range } : rest };
              })
            }
            onHover={setHover}
          />
        )}
        <UndoPanel />
      </aside>
    </div>
  );
}

/**
 * The text with a gutter. A backdrop behind the textarea repeats the text,
 * invisibly, in the same font and width, so each line's number and tint sit
 * exactly beside the line even when it wraps; the textarea grows with its
 * content so the two never scroll apart.
 */
function SceneEditor(props: {
  scene: ReturnType<typeof useSceneDoc>;
  order: readonly string[];
  tintOf: Map<string, string>;
  numberOf: (id: string) => number | string;
  hover: string | null;
}) {
  const { scene } = props;
  const ro = useWriteGuard();
  const area = useRef<HTMLTextAreaElement>(null);
  const caret = useRef<{ start: number; end: number } | null>(null);
  const id = useId();
  const text = scene.doc?.text ?? null;
  const ranges = scene.doc?.ranges ?? {};
  const lines = useMemo(() => (text ?? '').split('\n'), [text]);
  const numbers = useMemo(() => sceneLines(text ?? ''), [text]);

  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
    if (caret.current) {
      el.setSelectionRange(caret.current.start, caret.current.end);
      caret.current = null;
    }
  }, [text]);

  const apply = (value: string, start: number, end: number) => {
    caret.current = { start, end };
    scene.update((d) => ({ ...d, text: value }));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    const edit = {
      text: el.value,
      selectionStart: el.selectionStart,
      selectionEnd: el.selectionEnd,
    };
    if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
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
    }
  };

  const label = {
    loading: 'Loading',
    saved: 'Saved',
    pending: 'Unsaved changes',
    saving: 'Saving',
    error: 'Not saved',
  }[scene.status];

  // The first scene of each chapter carries its label in the gutter.
  const starts = new Map<number, string[]>();
  for (const cid of props.order) {
    const r = ranges[cid];
    if (r) starts.set(r.from, [...(starts.get(r.from) ?? []), cid]);
  }

  return (
    <div className="scene-outline stack tight" data-testid="scene-outline">
      <label htmlFor={`${id}-text`} className="sr-only">
        Scene outline
      </label>
      <div className="scene-edit">
        <div className="scene-backdrop" aria-hidden="true" data-testid="scene-gutter">
          {lines.map((line, i) => {
            const n = numbers[i] ?? null;
            const owners = n === null ? [] : chaptersAtScene(ranges, props.order, n);
            const owner = owners[owners.length - 1] ?? null;
            const tint = owner ? props.tintOf.get(owner) : null;
            const hot = owner !== null && owner === props.hover;
            return (
              <div
                key={i}
                className={`sl${tint ? ` tint ${tint}` : ''}${hot ? ' hot' : ''}${owners.length > 1 ? ' shared' : ''}`}
                data-scene={n ?? undefined}
                data-chapter={owner ?? undefined}
              >
                {n !== null && (
                  <span className="sl-gutter">
                    {(starts.get(n) ?? []).map((cid) => (
                      <span key={cid} className="sl-ch">
                        Ch {props.numberOf(cid)}
                      </span>
                    ))}
                    <span className="sl-no">{n}</span>
                  </span>
                )}
                <span className="sl-text">{line === '' ? '​' : line}</span>
              </div>
            );
          })}
        </div>
        <textarea
          id={`${id}-text`}
          ref={area}
          value={text ?? ''}
          disabled={text === null || ro.off}
          {...ro.tip}
          spellCheck
          rows={1}
          data-testid="scene-text"
          onChange={(e) => {
            const value = e.target.value;
            scene.update((d) => ({ ...d, text: value }));
          }}
          onKeyDown={onKeyDown}
          onBlur={() => void scene.save()}
        />
      </div>
      <div className="scene-foot">
        <span data-testid="scene-count">
          {text === null
            ? ''
            : `${sceneCount(text)} ${sceneCount(text) === 1 ? 'scene' : 'scenes'}`}
        </span>
        <span data-testid="scene-autosave" aria-live="polite" data-status={scene.status}>
          {label}
        </span>
      </div>
      {scene.error && (
        <p className="callout crit" role="alert">
          {scene.error}
        </p>
      )}
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
function Versions(props: {
  saves: number;
  onRestore: (r: { text: string; ranges: SceneRanges }) => void;
}) {
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

/** The chapters in reading order, grouped by book and part, each editable in place. */
function ChapterList(props: {
  rows: Outline['rows'];
  chapters: ChapterRow[];
  ranges: SceneRanges;
  scenes: number;
  issues: { chapterId: string; message: string }[];
  tintOf: Map<string, string>;
  onRange: (chapterId: string, range: SceneRange | null) => void;
  onHover: (chapterId: string | null) => void;
}) {
  const stored = useEntries('chapters');
  const writes = useOutlineWrites();
  const titleInputs = useRef<(HTMLInputElement | null)[]>([]);
  const byId = useMemo(() => new Map(stored.map((c) => [c._id, c])), [stored]);
  const position = new Map(props.chapters.map((c, i) => [c.id, i]));
  const inPart = (partId: string) => props.chapters.filter((c) => c.partId === partId);

  const rename = async (row: ChapterRow, title: string): Promise<boolean> => {
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
  const setYear = async (row: ChapterRow, year: number): Promise<boolean> => {
    const doc = byId.get(row.id);
    const strands = Array.isArray(doc?.strands)
      ? (doc.strands as { id: string; primary?: boolean }[])
      : [];
    const primary = strands.find((s) => s.primary) ?? strands[0];
    if (!primary) return false;
    const shift = shiftStrand(strands, primary.id, year);
    if (!shift || shift.unchanged) return false;
    const ok = await writes.edit(
      'chapters',
      row.id,
      { strands: shift.next },
      `Moved chapter ${row.readingOrder} to ${year}`,
    );
    return ok === true;
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

  if (props.chapters.length === 0) {
    return <p className="example-note">No chapters yet. Add one in the year grid.</p>;
  }
  return (
    <div className="stack tight">
      {writes.error && (
        <p className="callout crit" role="alert">
          {writes.error}
        </p>
      )}
      <ul
        className="ch-titles"
        data-testid="chapter-titles"
        onMouseLeave={() => props.onHover(null)}
      >
        {props.rows.map((row) => {
          if (row.kind !== 'chapter') {
            return (
              <li key={`${row.kind}:${row.id}`} className={`group ${row.kind}`}>
                {row.kind === 'book' ? 'Book' : 'Part'}: {row.title}
              </li>
            );
          }
          const at = position.get(row.id) ?? 0;
          const doc = byId.get(row.id);
          const siblings = inPart(row.partId);
          const index = siblings.findIndex((s) => s.id === row.id);
          const issue = props.issues.find((i) => i.chapterId === row.id)?.message ?? null;
          return (
            <li
              key={row.id}
              className={`ch ${props.tintOf.get(row.id) ?? ''}`}
              data-chapter={row.id}
              onMouseEnter={() => props.onHover(row.id)}
              onFocus={() => props.onHover(row.id)}
            >
              <span className="ch-swatch" aria-hidden="true" />
              <span className="num">{row.readingOrder}</span>
              <TitleInput
                ref={(el) => {
                  titleInputs.current[at] = el;
                }}
                row={row}
                title={doc ? entryTitle(doc) : row.title}
                disabled={writes.ro.off}
                tip={writes.ro.tip}
                onRename={(t) => rename(row, t)}
                onNext={() => titleInputs.current[at + 1]?.focus()}
                onMove={(by) => move(row, by)}
              />
              <span className="ch-moves row tight">
                <button
                  type="button"
                  className="btn small"
                  disabled={writes.ro.off || index <= 0}
                  aria-label={`Move chapter ${row.readingOrder} up`}
                  data-testid="chapter-move-up"
                  onClick={() => move(row, -1)}
                >
                  Up
                </button>
                <button
                  type="button"
                  className="btn small"
                  disabled={writes.ro.off || index < 0 || index >= siblings.length - 1}
                  aria-label={`Move chapter ${row.readingOrder} down`}
                  data-testid="chapter-move-down"
                  onClick={() => move(row, 1)}
                >
                  Down
                </button>
              </span>
              <span className="ch-details">
                <NumberField
                  label={`Story year of chapter ${row.readingOrder}`}
                  testId="chapter-year"
                  value={row.storyYear}
                  min={-10000}
                  max={10000}
                  width="5.5em"
                  disabled={writes.ro.off}
                  tip={writes.ro.tip}
                  onCommit={(y) => (y === null ? Promise.resolve(false) : setYear(row, y))}
                />
                <span className="ch-range">
                  <span className="ch-range-label">Scenes</span>
                  <NumberField
                    label={`First scene of chapter ${row.readingOrder}`}
                    testId="scene-range-from"
                    value={props.ranges[row.id]?.from ?? null}
                    min={1}
                    max={100000}
                    width="3.6em"
                    disabled={writes.ro.off}
                    tip={writes.ro.tip}
                    onCommit={(from) => {
                      const to = props.ranges[row.id]?.to ?? from;
                      props.onRange(
                        row.id,
                        from === null ? null : { from, to: Math.max(from, to ?? from) },
                      );
                      return Promise.resolve(true);
                    }}
                  />
                  <span className="ch-range-label">to</span>
                  <NumberField
                    label={`Last scene of chapter ${row.readingOrder}`}
                    testId="scene-range-to"
                    value={props.ranges[row.id]?.to ?? null}
                    min={1}
                    max={100000}
                    width="3.6em"
                    disabled={writes.ro.off}
                    tip={writes.ro.tip}
                    onCommit={(to) => {
                      const from = props.ranges[row.id]?.from ?? to;
                      props.onRange(
                        row.id,
                        to === null ? null : { from: Math.min(from ?? to, to), to },
                      );
                      return Promise.resolve(true);
                    }}
                  />
                </span>
                {issue && (
                  <span className="ch-issue" role="status" data-testid="scene-range-issue">
                    {issue}
                  </span>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

interface TitleInputProps {
  row: ChapterRow;
  title: string;
  disabled: boolean;
  tip: { title?: string; 'aria-describedby'?: string };
  onRename: (title: string) => Promise<boolean>;
  onNext: () => void;
  onMove: (by: -1 | 1) => void;
  ref: (el: HTMLInputElement | null) => void;
}

/** One chapter title: edits are written on Enter or when the field loses focus; Alt+Up and Alt+Down move the chapter. */
function TitleInput({ row, title, disabled, tip, onRename, onNext, onMove, ref }: TitleInputProps) {
  const [draft, setDraft] = useState(title);
  const [editing, setEditing] = useState(false);
  const [seen, setSeen] = useState(title);
  // A rename from elsewhere (undo, the editor) replaces a draft nobody is typing in.
  if (seen !== title) {
    setSeen(title);
    if (!editing) setDraft(title);
  }

  const commit = async () => {
    setEditing(false);
    if (draft.trim() === title) return;
    const ok = await onRename(draft);
    if (!ok) setDraft(title);
  };

  return (
    <input
      ref={ref}
      type="text"
      className="ch-title"
      value={draft}
      disabled={disabled}
      {...tip}
      aria-label={`Title of chapter ${row.readingOrder}`}
      data-testid="chapter-title"
      onFocus={() => setEditing(true)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => void commit()}
      onKeyDown={(e) => {
        if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
          e.preventDefault();
          onMove(e.key === 'ArrowUp' ? -1 : 1);
        } else if (e.key === 'Enter') {
          e.preventDefault();
          void commit().then(onNext);
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
