import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type {
  CSSProperties,
  PointerEvent as ReactPointerEvent,
  ReactNode,
  TouchEvent as ReactTouchEvent,
} from 'react';
import {
  LEAD,
  isSceneLine,
  moveBoundary,
  sceneLines,
  sectionOf,
  shownYears,
  setSceneYear,
  withSection,
} from '../../../../shared/domain/sceneOutline';
import type { Flow, ShownYear } from '../../../../shared/domain/sceneOutline';
import type { Response } from '../../../../shared/ipc';
import { entryTitle } from '../../../../shared/schema';
import type { EntryCollection } from '../../../../shared/schema';
import { useEntries } from '../data';
import { EntryEditable } from '../editable';
import { useStoryTime } from '../storyTime';
import { useStrandOptions } from '../timeline/StoryTimeDialog';
import { Zh } from '../Zh';
import { Icon } from '../phone/icons';
import { usePhoneNav } from '../phone/nav';
import { PhoneSheet } from '../phone/Sheet';
import { useOutlineWrites } from './actions';
import { useHold } from './holdDrag';
import {
  blockLength,
  deleteLine,
  indentLine,
  insertLine,
  moveLines,
  nextPrefix,
  setLineBody,
  splitLine,
  splitLineAt,
  stepLine,
} from './phoneLines';
import type { LineRef } from './phoneLines';
import './phone.css';

type Outline = Response<'outline.get'>;
export type ChapterRow = Extract<Outline['rows'][number], { kind: 'chapter' }>;
export type PartRow = Extract<Outline['rows'][number], { kind: 'part' }>;
type Open = (collection: EntryCollection, id: string) => void;

/** What the Outline's flow and writes give the phone's outline (`SceneOutline` owns them). */
export interface PhoneOutlineProps {
  chapters: readonly ChapterRow[];
  parts: readonly PartRow[];
  flow: Flow;
  /** The sections shown, in page order. */
  keys: readonly string[];
  firstScene: ReadonlyMap<string, number>;
  total: number;
  status: { key: string; label: string };
  readOnly: boolean;
  /** Typing: one undo step at the next pause. */
  type: (change: (f: Flow) => Flow) => void;
  /** A change of lines as one undo step; false when nothing changed. */
  step: (label: string, change: (f: Flow) => Flow | null) => boolean;
  save: () => Promise<boolean>;
  onOpen: Open;
  newChapterAt: (key: string, line: number) => void;
  addChapter: () => void;
  swap: (id: string, by: -1 | 1) => void;
  canSwap: (id: string, by: -1 | 1) => boolean;
  trashChapter: (id: string) => void;
  addDivider: (lowerId: string) => void;
  removeDivider: (lowerId: string) => void;
  removeFirstDivider: () => void;
  /** Errors and the trash notice, as the desk shows them. */
  notices: ReactNode;
  /** Parts and Versions, under the outline. */
  footer: ReactNode;
  /** The year field of a scene, as the desk has it beside the line. */
  yearField: (
    scene: number,
    shown: ShownYear | null,
    onCommit: (year: number | null) => void,
  ) => ReactNode;
}

const TINTS = ['series-1', 'series-2', 'series-3', 'series-4'];
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const depthOf = (line: string) => Math.floor((/^\s*/.exec(line)?.[0] ?? '').length / 2);
/** How near the bars a drag scrolls the page, and how fast. */
const EDGE = 64;
const STEP = 10;

type Drag =
  | {
      mode: 'line';
      from: LineRef;
      len: number;
      startY: number;
      dy: number;
      to: LineRef | null;
      guide: number | null;
    }
  | {
      mode: 'bar';
      upper: string;
      lower: string;
      startY: number;
      dy: number;
      at: number | null;
      guide: number | null;
    };

/** Where a drop would land, from the top of the list. */
interface Slot<T> {
  y: number;
  value: T;
}

/**
 * A58 U2 (PH-31, PH-32, PH-35): the Outline on the phone, one column in page
 * order. A chapter bar with its story year heads each chapter's scene lines.
 * A line edits on one tap; its ⋯ opens its actions (indent, outdent, move up
 * and down, a new chapter at it, delete), and held, it lifts and drags to any
 * place, into another chapter too. A held bar drags the line between its
 * chapter and the one above. The bar opens the chapter as a page; its ⋯
 * holds the chapter menu.
 */
export function PhoneOutline(p: PhoneOutlineProps) {
  const nav = usePhoneNav();
  const { flow, keys, chapters } = p;
  const [editing, setEditing] = useState<{ at: LineRef } | null>(null);
  /** Where the caret goes once the line being edited is on screen. */
  const caret = useRef<number | null>(null);
  const [lineMenu, setLineMenu] = useState<LineRef | null>(null);
  const [chapterMenu, setChapterMenu] = useState<string | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const list = useRef<HTMLDivElement | null>(null);
  const pointer = useRef({ x: 0, y: 0 });
  const input = useRef<HTMLTextAreaElement | null>(null);

  const linesOf = (key: string) => sectionOf(flow, key).lines;
  const rowOf = (key: string) => chapters.find((c) => c.id === key) ?? null;
  const tintOf = (key: string) =>
    TINTS[
      Math.max(
        0,
        chapters.findIndex((c) => c.id === key),
      ) % TINTS.length
    ] ?? 'series-1';

  // The line being edited takes the focus, with the caret where it was asked for.
  useLayoutEffect(() => {
    const el = input.current;
    if (!editing || !el) return;
    if (document.activeElement !== el) el.focus({ preventScroll: true });
    if (caret.current !== null) {
      el.setSelectionRange(caret.current, caret.current);
      caret.current = null;
    }
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  });

  const changeDrag = (d: Drag | null) => {
    dragRef.current = d;
    setDrag(d);
  };

  // ---------- drops ----------

  const base = () => list.current?.getBoundingClientRect().top ?? 0;
  const rowBox = (key: string, line: number) =>
    list.current
      ?.querySelector<HTMLElement>(
        `[data-testid="ph-line"][data-key="${CSS.escape(key)}"][data-line="${line}"]`,
      )
      ?.getBoundingClientRect() ?? null;
  const sectionEnd = (key: string) =>
    list.current
      ?.querySelector<HTMLElement>(`[data-ph-end="${CSS.escape(key)}"]`)
      ?.getBoundingClientRect() ?? null;

  /** Every place a dragged line could go, top to bottom: before each line, and at each section's end. */
  const lineSlots = (from: LineRef, len: number): Slot<LineRef>[] => {
    const top = base();
    const out: Slot<LineRef>[] = [];
    for (const key of keys) {
      const n = linesOf(key).length;
      for (let i = 0; i <= n; i++) {
        if (key === from.key && i > from.line && i <= from.line + len - 1) continue;
        const r = i < n ? rowBox(key, i) : sectionEnd(key);
        if (r) out.push({ y: r.top - top, value: { key, line: i } });
      }
    }
    return out;
  };
  /** Where the line between two chapters could go: before each of their lines, or after the last. */
  const barSlots = (upper: string, lower: string): Slot<number>[] => {
    const top = base();
    const out: Slot<number>[] = [];
    let at = 0;
    for (const key of [upper, lower]) {
      const n = linesOf(key).length;
      for (let i = 0; i < n; i++) {
        const r = rowBox(key, i);
        if (r) out.push({ y: r.top - top, value: at });
        at++;
      }
    }
    const end = sectionEnd(lower);
    if (end) out.push({ y: end.top - top, value: at });
    return out;
  };
  const nearest = <T,>(slots: Slot<T>[], clientY: number): Slot<T> | null => {
    const y = clientY - base();
    let best: Slot<T> | null = null;
    for (const s of slots) if (!best || Math.abs(s.y - y) < Math.abs(best.y - y)) best = s;
    return best;
  };

  const track = (d: Drag, y: number): Drag => {
    if (d.mode === 'line') {
      const s = nearest(lineSlots(d.from, d.len), y);
      return { ...d, dy: y - d.startY, to: s?.value ?? null, guide: s?.y ?? null };
    }
    const s = nearest(barSlots(d.upper, d.lower), y);
    return { ...d, dy: y - d.startY, at: s?.value ?? null, guide: s?.y ?? null };
  };

  const hold = useHold<{ kind: 'line'; at: LineRef } | { kind: 'bar'; id: string }>({
    lift: (what, _x, y) => {
      if (p.readOnly || editing) return false;
      pointer.current = { x: 0, y };
      if (what.kind === 'line') {
        const len = blockLength(linesOf(what.at.key), what.at.line);
        changeDrag({ mode: 'line', from: what.at, len, startY: y, dy: 0, to: null, guide: null });
        return true;
      }
      const i = keys.indexOf(what.id);
      const upper = keys[i - 1] ?? LEAD;
      changeDrag({ mode: 'bar', upper, lower: what.id, startY: y, dy: 0, at: null, guide: null });
      return true;
    },
    move: (x, y) => {
      pointer.current = { x, y };
      const d = dragRef.current;
      if (d) changeDrag(track(d, y));
    },
    drop: (_x, y) => {
      const d = dragRef.current;
      changeDrag(null);
      if (!d) return;
      const done = track(d, y);
      if (done.mode === 'line') {
        if (done.to) {
          const to = done.to;
          p.step('Moved a scene line', (f) => moveLines(f, done.from, done.len, to));
        }
      } else if (done.at !== null) {
        const at = done.at;
        const upperName = rowOf(done.upper)?.title ?? 'the lines before the first chapter';
        const lowerName = rowOf(done.lower)?.title ?? 'a chapter';
        p.step(`Moved the line between ${upperName} and ${lowerName}`, (f) =>
          moveBoundary(f, done.upper, done.lower, at),
        );
      }
    },
    cancel: () => changeDrag(null),
  });

  // While something is lifted, the page scrolls near the bars, so it can reach any chapter.
  const lifted = drag !== null;
  useEffect(() => {
    if (!lifted) return;
    let frame = 0;
    const tick = () => {
      const y = pointer.current.y;
      const by = y < EDGE + 52 ? -STEP : y > window.innerHeight - EDGE - 58 ? STEP : 0;
      if (by !== 0) {
        window.scrollBy(0, by);
        const d = dragRef.current;
        if (d) changeDrag(track({ ...d, startY: d.startY - by }, y));
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
    // The loop reads the drag through refs; it only needs to run while something is lifted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lifted]);

  // ---------- line actions ----------

  const edit = (at: LineRef, caretAt: number | null = null) => {
    if (p.readOnly) return;
    caret.current = caretAt;
    setEditing({ at });
  };
  const stopEditing = () => {
    setEditing(null);
    void p.save();
  };
  const newScene = (key: string) => {
    if (p.readOnly) return;
    const lines = linesOf(key);
    const at = { key, line: lines.length };
    let last: string | undefined;
    for (const l of lines) if (l.trim() !== '') last = l;
    p.type((f) => insertLine(f, at, nextPrefix(last)));
    edit(at, 0);
  };
  const openLineMenu = (at: LineRef) => {
    setLineMenu(at);
    nav.openSheet('outline-line');
  };
  const openChapterMenu = (id: string) => {
    setChapterMenu(id);
    nav.openSheet('outline-chapter');
  };

  const guide = drag?.guide ?? null;

  return (
    <div className="ph-outline" data-testid="outline-view">
      <div className="ph-ol-head">
        <h2>Outline</h2>
        <span className="ph-ol-status" data-testid="scene-count">
          {plural(p.total, 'scene', 'scenes')}
        </span>
        <span
          className="ph-ol-status"
          data-testid="scene-autosave"
          data-status={p.status.key}
          aria-live="polite"
        >
          {p.status.label}
        </span>
      </div>
      {p.notices}
      <div
        ref={list}
        className={`ph-ol-list${drag ? ' dragging' : ''}`}
        data-testid="scene-outline"
      >
        {keys.map((key, i) => {
          const row = rowOf(key);
          const above = rowOf(keys[i - 1] ?? '');
          const split = row && above && above.partId !== row.partId;
          const part = split ? p.parts.find((x) => x.id === row.partId) : undefined;
          const firstPart =
            row && row.id === chapters[0]?.id ? p.parts.find((x) => x.id === row.partId) : null;
          const lines = linesOf(key);
          const numbers = sceneLines(lines.join('\n'));
          const years = shownYears(sectionOf(flow, key), row?.storyYear ?? null);
          const first = p.firstScene.get(key) ?? 1;
          const barDrag = drag?.mode === 'bar' && drag.lower === key ? drag : null;
          return (
            <Fragment key={key}>
              {firstPart && (
                <Divider
                  partId={firstPart.id}
                  title={firstPart.title}
                  onRemove={
                    chapters.some((c) => c.partId !== firstPart.id)
                      ? p.removeFirstDivider
                      : undefined
                  }
                  disabled={p.readOnly}
                />
              )}
              {split && (
                <Divider
                  partId={part?.id ?? null}
                  title={part?.title ?? 'Section'}
                  onRemove={() => p.removeDivider(key)}
                  disabled={p.readOnly}
                />
              )}
              {row ? (
                <ChapterBar
                  row={row}
                  tint={tintOf(key)}
                  scenes={numbers.filter((n) => n !== null).length}
                  dy={barDrag?.dy ?? 0}
                  lifted={barDrag !== null}
                  readOnly={p.readOnly}
                  onOpen={() => p.onOpen('chapters', row.id)}
                  onMenu={() => openChapterMenu(row.id)}
                  onHold={(e) => hold.start(e, { kind: 'bar', id: row.id })}
                  clickBlocked={hold.clickBlocked}
                />
              ) : (
                <h3 className="ph-ol-lead">Not in a chapter</h3>
              )}
              <ol className={`ph-ol-lines ${row ? tintOf(key) : 'lead'}`} data-section={key}>
                {lines.map((line, n) => {
                  const at = { key, line: n };
                  const isEditing = editing?.at.key === key && editing.at.line === n;
                  const scene = numbers[n] == null ? null : first + (numbers[n] as number) - 1;
                  const year = years[n] ?? null;
                  const lineDrag =
                    drag?.mode === 'line' &&
                    drag.from.key === key &&
                    n >= drag.from.line &&
                    n < drag.from.line + drag.len
                      ? drag
                      : null;
                  return (
                    <LineRow
                      key={n}
                      at={at}
                      line={line}
                      scene={scene}
                      year={year}
                      editing={isEditing}
                      setInput={(el) => {
                        input.current = el;
                      }}
                      dy={lineDrag?.dy ?? 0}
                      lifted={lineDrag !== null}
                      readOnly={p.readOnly}
                      onEdit={() => edit(at)}
                      onMenu={() => openLineMenu(at)}
                      onHold={(e) => hold.start(e, { kind: 'line', at })}
                      clickBlocked={hold.clickBlocked}
                      onBody={(body) => p.type((f) => setLineBody(f, at, body))}
                      onSplit={(pos) => {
                        p.type((f) => splitLineAt(f, at, pos));
                        edit({ key, line: n + 1 }, 0);
                      }}
                      onJoinUp={() => {
                        if (n === 0) return;
                        const prev = splitLine(lines[n - 1] as string).body.length;
                        p.type((f) => deleteLine(f, at));
                        edit({ key, line: n - 1 }, prev);
                      }}
                      onDone={stopEditing}
                    />
                  );
                })}
              </ol>
              <div className="ph-ol-end" data-ph-end={key}>
                <button
                  type="button"
                  className="ph-ol-add"
                  disabled={p.readOnly}
                  data-testid="ph-new-scene"
                  aria-label={row ? `New scene in chapter ${row.number}` : 'New scene'}
                  onClick={() => newScene(key)}
                >
                  <Icon name="plus" />
                  <span>Scene</span>
                </button>
              </div>
            </Fragment>
          );
        })}
        {guide !== null && (
          <div
            className="ph-ol-guide"
            style={{ top: guide }}
            aria-hidden="true"
            data-testid="drop-guide"
          />
        )}
      </div>
      <div className="ph-ol-foot">
        <button
          type="button"
          className="btn"
          disabled={p.readOnly}
          data-testid="new-chapter"
          onClick={p.addChapter}
        >
          New chapter
        </button>
      </div>
      {p.footer}
      <LineSheet {...p} at={lineMenu} onEdit={edit} onMoved={setLineMenu} />
      <ChapterSheet {...p} id={chapterMenu} />
    </div>
  );
}

/** A section's divider: its name, edited in place, and its removal. */
function Divider(props: {
  partId: string | null;
  title: string;
  onRemove?: () => void;
  disabled: boolean;
}) {
  return (
    <div className="ph-ol-divider" data-testid="divider">
      {props.partId ? (
        <EntryEditable
          collection="parts"
          id={props.partId}
          path="title"
          kind="text"
          label="Divider name"
          allowEmpty={false}
          testId="divider-name"
        />
      ) : (
        <span>{props.title}</span>
      )}
      {props.onRemove && (
        <button
          type="button"
          className="ph-icon-btn"
          disabled={props.disabled}
          aria-label={`Remove the divider ${props.title}`}
          data-testid="remove-divider"
          onClick={props.onRemove}
        >
          <span aria-hidden="true">×</span>
        </button>
      )}
    </div>
  );
}

function ChapterBar(props: {
  row: ChapterRow;
  tint: string;
  scenes: number;
  dy: number;
  lifted: boolean;
  readOnly: boolean;
  onOpen: () => void;
  onMenu: () => void;
  onHold: (e: ReactTouchEvent | ReactPointerEvent) => void;
  clickBlocked: () => boolean;
}) {
  const { row } = props;
  const docs = useEntries('chapters');
  const doc = docs.find((c) => c._id === row.id);
  const title = doc ? entryTitle(doc) : row.title;
  const written = doc?.written === true;
  return (
    <div
      className={`ph-ol-bar ${props.tint}${props.lifted ? ' lifted' : ''}`}
      style={props.dy ? { transform: `translateY(${props.dy}px)` } : undefined}
      data-testid="chapter-bar"
      data-chapter={row.id}
      data-written={written ? 'true' : 'false'}
      onTouchStart={props.onHold}
      onPointerDown={props.onHold}
    >
      {!props.readOnly && (
        <span className="ph-ol-grip" aria-hidden="true" data-testid="chapter-grip">
          ⋮⋮
        </span>
      )}
      <button
        type="button"
        className="ph-ol-bar-open"
        data-testid="chapter-open"
        aria-label={`Open chapter ${row.number}, ${title}`}
        onClick={() => {
          if (!props.clickBlocked()) props.onOpen();
        }}
      >
        <span className="ph-ol-bar-title">
          <span className="ph-ol-bar-no">Ch {row.number}</span>{' '}
          <span data-testid="chapter-title">
            <Zh text={title} actions={false} />
          </span>
        </span>
        <span className="ph-ol-bar-sub">
          <span data-testid="chapter-scenes">{plural(props.scenes, 'scene', 'scenes')}</span>
          {row.storyYear !== null && (
            <span className="ph-ol-bar-year" data-testid="chapter-year">
              {row.storyYear}
            </span>
          )}
          {written && <span className="ph-ol-written">Written</span>}
        </span>
      </button>
      <button
        type="button"
        className="ph-icon-btn"
        aria-label={`Chapter ${row.number} actions`}
        data-no-hold
        aria-haspopup="dialog"
        data-testid="chapter-more"
        onClick={props.onMenu}
      >
        <Icon name="more" />
      </button>
    </div>
  );
}

function LineRow(all: {
  at: LineRef;
  line: string;
  scene: number | null;
  year: { year: number | null; own: boolean } | null;
  editing: boolean;
  setInput: (el: HTMLTextAreaElement | null) => void;
  dy: number;
  lifted: boolean;
  readOnly: boolean;
  onEdit: () => void;
  onMenu: () => void;
  onHold: (e: ReactTouchEvent | ReactPointerEvent) => void;
  clickBlocked: () => boolean;
  onBody: (body: string) => void;
  onSplit: (caret: number) => void;
  onJoinUp: () => void;
  onDone: () => void;
}) {
  const { setInput, ...props } = all;
  const { body } = splitLine(props.line);
  const depth = depthOf(props.line);
  const bullet = props.line.trimStart().match(/^[-*•]/) !== null;
  const scene = props.scene !== null;
  return (
    <li
      className={`ph-ol-line${scene ? ' scene' : ''}${props.lifted ? ' lifted' : ''}${props.editing ? ' editing' : ''}`}
      style={
        {
          '--depth': depth,
          ...(props.dy ? { transform: `translateY(${props.dy}px)` } : {}),
        } as CSSProperties
      }
      data-testid="ph-line"
      data-key={props.at.key}
      data-line={props.at.line}
      data-scene={props.scene ?? undefined}
      onTouchStart={props.editing ? undefined : props.onHold}
      onPointerDown={props.editing ? undefined : props.onHold}
    >
      <span className="ph-ol-no" aria-hidden="true">
        {props.scene ?? (bullet ? '•' : '')}
      </span>
      {props.editing ? (
        <textarea
          ref={setInput}
          className="ph-ol-input"
          rows={1}
          value={body}
          enterKeyHint="next"
          spellCheck
          aria-label={props.scene !== null ? `Scene ${props.scene}` : 'Line'}
          placeholder="Scene"
          data-testid="ph-line-input"
          data-field={`scene:${props.at.key}:${props.at.line}`}
          onChange={(e) => props.onBody(e.target.value.replace(/\n/g, ' '))}
          onKeyDown={(e) => {
            const el = e.currentTarget;
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              props.onSplit(el.selectionStart);
            } else if (
              e.key === 'Backspace' &&
              el.selectionStart === 0 &&
              el.selectionEnd === 0 &&
              el.value === ''
            ) {
              e.preventDefault();
              props.onJoinUp();
            } else if (e.key === 'Escape') {
              el.blur();
            }
          }}
          onBlur={props.onDone}
        />
      ) : (
        <button
          type="button"
          className={`ph-ol-text${body.trim() === '' ? ' empty' : ''}`}
          disabled={props.readOnly}
          data-testid="ph-line-text"
          onClick={() => {
            if (!props.clickBlocked()) props.onEdit();
          }}
        >
          {body.trim() === '' ? 'Scene' : <Zh text={body} actions={false} />}
        </button>
      )}
      {props.year && props.year.year !== null && (
        <span
          className={`ph-ol-year${props.year.own ? '' : ' inherited'}`}
          data-testid="ph-line-year"
          data-own={props.year.own ? 'true' : 'false'}
        >
          {props.year.year}
        </span>
      )}
      <button
        type="button"
        className="ph-icon-btn ph-ol-more"
        aria-label={props.scene !== null ? `Scene ${props.scene} actions` : 'Line actions'}
        data-no-hold
        aria-haspopup="dialog"
        data-testid="ph-line-more"
        onClick={props.onMenu}
      >
        <Icon name="more" />
      </button>
    </li>
  );
}

/** A scene line's actions, each one tap. Move and indent keep the sheet open on the line. */
function LineSheet(
  props: PhoneOutlineProps & {
    at: LineRef | null;
    onEdit: (at: LineRef, caret: number | null) => void;
    onMoved: (at: LineRef) => void;
  },
) {
  const nav = usePhoneNav();
  const { at, flow, keys } = props;
  const lines = at ? sectionOf(flow, at.key).lines : [];
  const line = at ? lines[at.line] : undefined;
  const live = at !== null && line !== undefined;
  const scene = live && isSceneLine(line);
  const row = at ? props.chapters.find((c) => c.id === at.key) : undefined;
  const years = at ? shownYears(sectionOf(flow, at.key), row?.storyYear ?? null) : [];
  const sceneNo = (() => {
    if (!at || !scene) return null;
    const n = sceneLines(lines.join('\n'))[at.line];
    return n == null ? null : (props.firstScene.get(at.key) ?? 1) + n - 1;
  })();
  const ro = props.readOnly || !live;
  const close = () => nav.closeSheet();
  const indent = (outdent: boolean) => {
    if (!at) return;
    props.step(outdent ? 'Outdented a scene line' : 'Indented a scene line', (f) =>
      indentLine(f, keys, at, outdent),
    );
  };
  const move = (by: -1 | 1) => {
    if (!at) return;
    const moved = stepLine(flow, keys, at, by);
    if (!moved) return;
    if (
      props.step(by < 0 ? 'Moved a scene line up' : 'Moved a scene line down', () => moved.flow)
    ) {
      props.onMoved(moved.at);
    }
  };
  const canUp = live && at !== null && stepLine(flow, keys, at, -1) !== null;
  const canDown = live && at !== null && stepLine(flow, keys, at, 1) !== null;
  const canIndent = live && at !== null && indentLine(flow, keys, at, false) !== null;
  const canOutdent = live && at !== null && indentLine(flow, keys, at, true) !== null;
  const label = sceneNo !== null ? `Scene ${sceneNo}` : 'Line';
  return (
    <PhoneSheet name="outline-line" label={label} title testId="line-sheet">
      {live && (
        <p className="ph-ol-sheet-quote" data-testid="line-sheet-text">
          {splitLine(line).body || 'Empty line'}
        </p>
      )}
      <div className="ph-ol-sheet-grid">
        <button
          type="button"
          className="btn"
          disabled={ro || !canOutdent}
          data-testid="ph-line-outdent"
          onClick={() => indent(true)}
        >
          Outdent
        </button>
        <button
          type="button"
          className="btn"
          disabled={ro || !canIndent}
          data-testid="ph-line-indent"
          onClick={() => indent(false)}
        >
          Indent
        </button>
        <button
          type="button"
          className="btn"
          disabled={ro || !canUp}
          data-testid="ph-line-up"
          onClick={() => move(-1)}
        >
          Move up
        </button>
        <button
          type="button"
          className="btn"
          disabled={ro || !canDown}
          data-testid="ph-line-down"
          onClick={() => move(1)}
        >
          Move down
        </button>
      </div>
      {scene && at && sceneNo !== null && (
        <label className="field ph-ol-sheet-year">
          Year
          {props.yearField(sceneNo, years[at.line] ?? null, (y) =>
            sceneYearStep(props.step, at, y),
          )}
        </label>
      )}
      <ul className="ph-list">
        <li>
          <button
            type="button"
            className="ph-row"
            disabled={ro}
            data-testid="ph-line-edit"
            onClick={() => {
              if (!at || !line) return;
              close();
              props.onEdit(at, splitLine(line).body.length);
            }}
          >
            Edit
          </button>
        </li>
        <li>
          <button
            type="button"
            className="ph-row"
            disabled={ro}
            data-testid="ph-line-new-chapter"
            onClick={() => {
              if (!at) return;
              close();
              props.newChapterAt(at.key, at.line);
            }}
          >
            New chapter at this line
          </button>
        </li>
        <li>
          <button
            type="button"
            className="ph-row danger"
            disabled={ro}
            data-testid="ph-line-delete"
            onClick={() => {
              if (!at) return;
              close();
              props.step('Deleted a scene line', (f) => deleteLine(f, at));
            }}
          >
            Delete line
          </button>
        </li>
      </ul>
    </PhoneSheet>
  );
}

/** The chapter menu on the phone: what the desk's ⋯ and the bar's keys do, and the chapter's pages. */
function ChapterSheet(props: PhoneOutlineProps & { id: string | null }) {
  const nav = usePhoneNav();
  const writes = useOutlineWrites();
  const docs = useEntries('chapters');
  const { id } = props;
  const row = props.chapters.find((c) => c.id === id) ?? null;
  const doc = docs.find((c) => c._id === id);
  const title = doc ? entryTitle(doc) : (row?.title ?? '');
  const i = row ? props.keys.indexOf(row.id) : -1;
  const above = props.chapters.find((c) => c.id === props.keys[i - 1]);
  const canDivide = row !== null && above !== undefined && above.partId === row.partId && i > 0;
  const ro = props.readOnly || row === null;
  const written = doc?.written === true;
  const close = () => nav.closeSheet();

  const openRelevant = useOpenRelevant();
  const relevant = () => row && openRelevant(row.id);

  return (
    <PhoneSheet
      name="outline-chapter"
      label={row ? `Chapter ${row.number}: ${title}` : 'Chapter'}
      title
      testId="chapter-sheet"
    >
      <ul className="ph-list">
        <li>
          <button
            type="button"
            className="ph-row"
            disabled={!row}
            data-testid="ph-chapter-page"
            onClick={() => row && nav.push({ kind: 'entry', collection: 'chapters', id: row.id })}
          >
            Open chapter
          </button>
        </li>
        <li>
          <button
            type="button"
            className="ph-row"
            disabled={!row}
            data-testid="ph-chapter-relevant"
            onClick={relevant}
          >
            Relevant to Session
          </button>
        </li>
      </ul>
      <div className="ph-ol-sheet-grid">
        <button
          type="button"
          className="btn"
          disabled={ro || !props.canSwap(row?.id ?? '', -1)}
          data-testid="chapter-move-up"
          onClick={() => row && props.swap(row.id, -1)}
        >
          Move up
        </button>
        <button
          type="button"
          className="btn"
          disabled={ro || !props.canSwap(row?.id ?? '', 1)}
          data-testid="chapter-move-down"
          onClick={() => row && props.swap(row.id, 1)}
        >
          Move down
        </button>
      </div>
      <label className="ph-ol-check">
        <input
          type="checkbox"
          checked={written}
          disabled={ro || !doc}
          data-testid="chapter-written"
          onChange={(e) =>
            row &&
            void writes.edit(
              'chapters',
              row.id,
              { written: e.target.checked },
              e.target.checked ? `Marked ${title} as written` : `Marked ${title} as not written`,
            )
          }
        />
        Written
      </label>
      <ul className="ph-list">
        <li>
          <button
            type="button"
            className="ph-row"
            disabled={ro}
            data-testid="chapter-new-here"
            onClick={() => {
              if (!row) return;
              close();
              props.newChapterAt(row.id, sectionOf(props.flow, row.id).lines.length);
            }}
          >
            New chapter after this one
          </button>
        </li>
        {canDivide && (
          <li>
            <button
              type="button"
              className="ph-row"
              disabled={ro}
              data-testid="add-divider"
              onClick={() => {
                if (!row) return;
                close();
                props.addDivider(row.id);
              }}
            >
              New section from here
            </button>
          </li>
        )}
        <li>
          <button
            type="button"
            className="ph-row danger"
            disabled={ro}
            data-testid="chapter-delete"
            onClick={() => {
              if (!row) return;
              close();
              props.trashChapter(row.id);
            }}
          >
            Delete chapter
          </button>
        </li>
      </ul>
    </PhoneSheet>
  );
}

/** A scene's year set from the line sheet, as one undo step (SM-5). */
function sceneYearStep(step: PhoneOutlineProps['step'], at: LineRef, year: number | null): void {
  step(year === null ? "Cleared a scene's year" : `Set a scene's year to ${year}`, (f) =>
    withSection(f, at.key, setSceneYear(sectionOf(f, at.key), at.line, year)),
  );
}

/** Relevant to Session on a chapter: the story time moves to its writing strand, and the screen opens. */
function useOpenRelevant(): (chapterId: string) => void {
  const nav = usePhoneNav();
  const story = useStoryTime();
  const strands = useStrandOptions();
  const docs = useEntries('chapters');
  return (chapterId) => {
    const doc = docs.find((c) => c._id === chapterId);
    const list = Array.isArray(doc?.strands)
      ? (doc.strands as { id: string; primary?: boolean; startYear?: number | null }[])
      : [];
    const primary = list.find((s) => s.primary) ?? list[0];
    const s =
      strands.find((o) => o.chapterId === chapterId && o.strandId === primary?.id) ??
      strands.find((o) => o.chapterId === chapterId);
    story.set({
      year: s?.year ?? story.year,
      chapterId,
      ...(s ? { strandId: s.strandId } : {}),
    });
    nav.push({ kind: 'screen', screen: 'relevant' });
  };
}

/** A58 U2: under a chapter's fields on the phone, its Relevant to Session. */
export function ChapterPageLinks({ id }: { id: string }) {
  const openRelevant = useOpenRelevant();
  return (
    <ul className="ph-list ph-chapter-links" data-testid="chapter-links">
      <li>
        <button
          type="button"
          className="ph-row"
          data-testid="chapter-relevant"
          onClick={() => openRelevant(id)}
        >
          Relevant to Session
        </button>
      </li>
    </ul>
  );
}
