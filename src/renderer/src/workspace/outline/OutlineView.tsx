import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { DragEvent, KeyboardEvent } from 'react';
import { nextNumber } from '../../../../shared/domain/outline';
import type { Response } from '../../../../shared/ipc';
import { call } from '../../api';
import { useStore } from '../data';
import { EmbeddedEditor, TrashControls, UndoPanel } from '../editor';
import { useStoryTime } from '../storyTime';
import { Zh } from '../Zh';
import { useOutlineWrites } from './actions';
import type { OutlineWrites } from './actions';
import { ArcPanel, ArcsList } from './Arcs';
import { ChapterPanel } from './ChapterPage';
import { InlineName, NameForm } from './InlineName';
import './outline.css';

type Outline = Response<'outline.get'>;
type Row = Outline['rows'][number];
type ChapterRow = Extract<Row, { kind: 'chapter' }>;
type BookRow = Extract<Row, { kind: 'book' }>;
type PartRow = Extract<Row, { kind: 'part' }>;

/** What the inspector shows. A beat remembers where it was opened from. */
type Focus =
  | { kind: 'chapter'; id: string }
  | { kind: 'arc'; id: string }
  | { kind: 'book' | 'part'; id: string }
  | { kind: 'beat'; id: string; back: Focus | null };

type Adding =
  { kind: 'book' } | { kind: 'part'; bookId: string } | { kind: 'chapter'; partId: string };

/** Width of one year column, in pixels. */
const COL = 26;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * The one outline (PL-2, PL-3, KB-3): one row per chapter, one column per
 * story year, grouped under book and part headings. Books, parts, chapters,
 * arcs and beats are made, renamed, moved and deleted here: a heading renames
 * in place, New part and New chapter sit on the headings, rows move by drag or
 * Alt+Up and Alt+Down, and the inspector edits the open chapter, arc, or beat.
 * Strands are marks (primary filled, backstory hollow), arcs are spans in the
 * owner's family color, and a line marks the story time.
 */
export function OutlineView() {
  const { version } = useStore();
  const story = useStoryTime();
  const writes = useOutlineWrites();
  const [order, setOrder] = useState<'reading' | 'story'>('reading');
  const [outline, setOutline] = useState<Outline | null>(null);
  const [focus, setFocus] = useState<Focus | null>(null);
  const [adding, setAdding] = useState<Adding | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  /** The control to give focus back to once the outline reloads after a keyboard move. */
  const refocus = useRef<string | null>(null);
  const orderId = useId();

  useEffect(() => {
    let live = true;
    void call('outline.get', { order, cursorYear: story.year }).then((r) => {
      if (live) setOutline(r);
    });
    return () => {
      live = false;
    };
  }, [order, story.year, version]);

  useEffect(() => {
    const key = refocus.current;
    if (!key) return;
    const slot = document.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(key)}"]`);
    const el = slot?.matches('button') ? slot : slot?.querySelector<HTMLElement>('button');
    if (!el) return;
    // Once only: a later reload must not pull focus back from wherever the person went.
    refocus.current = null;
    if (document.activeElement !== el) el.focus();
  }, [outline]);

  const first = outline?.years[0] ?? 0;
  const x = (year: number) => (year - first) * COL;
  const rows = useMemo(() => outline?.rows ?? [], [outline]);
  const chapters = useMemo(() => rows.filter((r): r is ChapterRow => r.kind === 'chapter'), [rows]);
  const books = rows.filter((r): r is BookRow => r.kind === 'book' && !r.missing);
  const partsIn = (bookId: string) =>
    rows.filter((r): r is PartRow => r.kind === 'part' && !r.missing && r.bookId === bookId);
  const inPart = (partId: string) => chapters.filter((c) => c.partId === partId);
  const reading = outline?.order === 'reading';
  const arcFocus = focus?.kind === 'arc' ? focus.id : null;

  const moveChapter = (c: ChapterRow, by: -1 | 1) => {
    if (!reading) return;
    const siblings = inPart(c.partId);
    const to = siblings.findIndex((s) => s.id === c.id) + by;
    if (to < 0 || to >= siblings.length) return;
    refocus.current = `chapter:${c.id}`;
    void writes.reorder(
      { kind: 'chapters', groupId: c.partId, movedId: c.id, toIndex: to },
      `Moved ${c.title} ${by < 0 ? 'earlier' : 'later'}`,
    );
  };

  /** Move to part is a select in the inspector, which keeps focus, so no row is refocused. */
  const toPart = (c: ChapterRow, partId: string) => {
    if (!partId || partId === c.partId) return;
    refocus.current = null;
    void writes.reorder(
      { kind: 'chapters', groupId: partId, movedId: c.id, toIndex: inPart(partId).length },
      `Moved ${c.title} to another part`,
    );
  };

  const moveHeading = (row: BookRow | PartRow, by: -1 | 1) => {
    const siblings: (BookRow | PartRow)[] = row.kind === 'book' ? books : partsIn(row.bookId);
    const to = siblings.findIndex((s) => s.id === row.id) + by;
    if (to < 0 || to >= siblings.length) return;
    refocus.current = `${row.kind}:${row.id}`;
    const label = `Moved ${row.label} ${by < 0 ? 'earlier' : 'later'}`;
    void writes.reorder(
      row.kind === 'book'
        ? { kind: 'books', movedId: row.id, toIndex: to }
        : { kind: 'parts', groupId: row.bookId, movedId: row.id, toIndex: to },
      label,
    );
  };

  const drop = (e: DragEvent, target: ChapterRow) => {
    e.preventDefault();
    setOver(null);
    const moved = chapters.find((c) => c.id === dragging);
    setDragging(null);
    if (!moved || moved.id === target.id) return;
    // The chapter takes the target's place, in its own part or another (PL-3): moving
    // down it lands after the target, moving up before it, as the arc beats do.
    const toIndex = inPart(target.partId).findIndex((c) => c.id === target.id);
    void writes.reorder(
      { kind: 'chapters', groupId: target.partId, movedId: moved.id, toIndex },
      `Moved ${moved.title}`,
    );
  };

  /**
   * Drop on a part heading: into another part the chapter goes first in it;
   * on its own part's heading it goes last.
   */
  const dropOnPart = (e: DragEvent, partId: string) => {
    e.preventDefault();
    setOver(null);
    const moved = chapters.find((c) => c.id === dragging);
    setDragging(null);
    if (!moved) return;
    const same = moved.partId === partId;
    void writes.reorder(
      {
        kind: 'chapters',
        groupId: partId,
        movedId: moved.id,
        toIndex: same ? inPart(partId).length - 1 : 0,
      },
      same ? `Moved ${moved.title} to the end of its part` : `Moved ${moved.title}`,
    );
  };

  const newBook = async (title: string) => {
    const id = await writes.create('books', {
      title,
      number: nextNumber(books.map((b) => ({ number: b.number }))),
      status: 'idea',
    });
    if (id) setAdding(null);
  };
  const newPart = async (bookId: string, title: string) => {
    const id = await writes.create('parts', {
      title,
      bookId,
      number: nextNumber(partsIn(bookId).map((p) => ({ number: p.number }))),
      status: 'idea',
    });
    if (id) setAdding(null);
  };
  const newChapter = async (partId: string, title: string) => {
    const id = await writes.newChapter(partId, title, story.year);
    if (id) {
      setAdding(null);
      setFocus({ kind: 'chapter', id });
    }
  };

  const selected = focus?.kind === 'chapter' ? focus.id : null;
  const sel = chapters.find((c) => c.id === selected) ?? null;
  const selSiblings = sel ? inPart(sel.partId) : [];
  const selIndex = sel ? selSiblings.findIndex((c) => c.id === sel.id) : -1;

  return (
    <div className="ws-tree-area" data-testid="outline-view">
      <section className="tree-main stack" aria-labelledby="outline-title">
        <div className="list-head">
          <h2 id="outline-title">Outline</h2>
          <span className="row tight">
            <span className="chip time" data-testid="outline-time">
              Story time {story.year}
            </span>
            <label htmlFor={orderId} className="sr-only">
              Row order
            </label>
            <select
              id={orderId}
              value={order}
              onChange={(e) => setOrder(e.target.value === 'story' ? 'story' : 'reading')}
            >
              <option value="reading">Reading order</option>
              <option value="story">Story-year order</option>
            </select>
            {order === 'reading' && adding?.kind !== 'book' && (
              <button
                type="button"
                className="btn small"
                disabled={writes.ro.off}
                {...writes.ro.tip}
                onClick={() => setAdding({ kind: 'book' })}
              >
                New book
              </button>
            )}
          </span>
        </div>
        {adding?.kind === 'book' && (
          <NameForm
            label="Book title"
            submit="Create book"
            testId="new-book"
            onSubmit={newBook}
            onCancel={() => setAdding(null)}
          />
        )}
        <p className="example-note">
          {order === 'reading'
            ? 'Click a title to rename it. Drag a chapter, or focus it and press Alt+Up or Alt+Down; headings move the same way.'
            : 'Chapters sorted by story year. Switch to reading order to move them.'}
        </p>
        {writes.error && (
          <p className="callout crit" role="alert">
            {writes.error}
          </p>
        )}
        {!outline ? (
          <p aria-live="polite">Loading the outline.</p>
        ) : rows.length === 0 ? (
          <p className="example-note">No books yet. Start with New book.</p>
        ) : (
          <div className="ol-scroll" role="region" aria-label="Outline grid" tabIndex={0}>
            <div className="ol-grid" data-testid="outline-grid" data-order={outline.order}>
              <div className="ol-row ol-head">
                <div className="ol-label">Chapter</div>
                <div className="ol-track" style={{ width: outline.years.length * COL }}>
                  {outline.years.map((y) => (
                    <span
                      key={y}
                      className={`ol-year${y === outline.cursorYear ? ' now' : ''}`}
                      style={{ left: x(y), width: COL }}
                    >
                      {y}
                    </span>
                  ))}
                </div>
              </div>
              {rows.map((row) =>
                row.kind !== 'chapter' ? (
                  <div
                    key={`${row.kind}:${row.id}`}
                    className={`ol-group ${row.kind}${over === `part:${row.id}` ? ' over' : ''}`}
                    data-book={row.kind === 'book' ? row.id : undefined}
                    data-part={row.kind === 'part' ? row.id : undefined}
                    onDragOver={
                      row.kind === 'part' && !row.missing
                        ? (e) => {
                            if (dragging) {
                              e.preventDefault();
                              setOver(`part:${row.id}`);
                            }
                          }
                        : undefined
                    }
                    onDragLeave={row.kind === 'part' ? () => setOver(null) : undefined}
                    onDrop={
                      row.kind === 'part' && !row.missing ? (e) => dropOnPart(e, row.id) : undefined
                    }
                  >
                    <Heading
                      row={row}
                      writes={writes}
                      canMove={row.kind === 'book' || books.some((b) => b.id === row.bookId)}
                      onMove={(by) => moveHeading(row, by)}
                      onAdd={() =>
                        setAdding(
                          row.kind === 'book'
                            ? { kind: 'part', bookId: row.id }
                            : { kind: 'chapter', partId: row.id },
                        )
                      }
                      onDetails={() => setFocus({ kind: row.kind, id: row.id })}
                    />
                    {adding?.kind === 'part' && row.kind === 'book' && adding.bookId === row.id && (
                      <NameForm
                        label="Part title"
                        submit="Create part"
                        testId="new-part"
                        onSubmit={(t) => newPart(row.id, t)}
                        onCancel={() => setAdding(null)}
                      />
                    )}
                    {adding?.kind === 'chapter' &&
                      row.kind === 'part' &&
                      adding.partId === row.id && (
                        <NameForm
                          label={`Chapter title (story year ${story.year})`}
                          submit="Create chapter"
                          testId="new-chapter"
                          onSubmit={(t) => newChapter(row.id, t)}
                          onCancel={() => setAdding(null)}
                        />
                      )}
                  </div>
                ) : (
                  <div
                    key={row.id}
                    className={`ol-row${selected === row.id ? ' selected' : ''}${over === row.id ? ' over' : ''}`}
                    data-chapter={row.id}
                    onDragOver={(e) => {
                      if (dragging) {
                        e.preventDefault();
                        setOver(row.id);
                      }
                    }}
                    onDragLeave={() => setOver(null)}
                    onDrop={(e) => drop(e, row)}
                  >
                    <div
                      className="ol-label"
                      draggable={reading && !writes.ro.off}
                      onDragStart={(e) => {
                        setDragging(row.id);
                        e.dataTransfer.effectAllowed = 'move';
                        e.dataTransfer.setData('text/plain', row.id);
                      }}
                      onDragEnd={() => {
                        setDragging(null);
                        setOver(null);
                      }}
                    >
                      <span className="ol-no num">{row.readingOrder}</span>
                      <button
                        type="button"
                        className="ol-open"
                        aria-current={selected === row.id ? 'true' : undefined}
                        aria-keyshortcuts={reading ? 'Alt+ArrowUp Alt+ArrowDown' : undefined}
                        data-testid="outline-label"
                        data-focus-key={`chapter:${row.id}`}
                        onClick={() => setFocus({ kind: 'chapter', id: row.id })}
                        onKeyDown={(e: KeyboardEvent) => {
                          if (!e.altKey || e.metaKey || e.ctrlKey) return;
                          if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
                          e.preventDefault();
                          moveChapter(row, e.key === 'ArrowUp' ? -1 : 1);
                        }}
                      >
                        <span className="ol-title">
                          <Zh text={row.title} actions={false} />
                        </span>
                      </button>
                    </div>
                    <div className="ol-track" style={{ width: outline.years.length * COL }}>
                      {outline.cursorYear !== null && (
                        <span
                          className="ol-cursor"
                          style={{ left: x(outline.cursorYear) + COL / 2 }}
                          aria-hidden="true"
                        />
                      )}
                      {row.arcSpans.map((a, i) => (
                        <span
                          key={a.arcId}
                          className={`ol-arc ${a.color}${arcFocus ? (a.arcId === arcFocus ? ' hl' : ' dim') : ''}`}
                          style={{
                            left: x(a.from),
                            width: (a.to - a.from + 1) * COL,
                            top: 3 + i * 6,
                          }}
                          title={`${a.name}, ${a.from} to ${a.to}`}
                          data-arc={a.arcId}
                        />
                      ))}
                      {row.strands.map((s) => {
                        const years = `${s.startYear}${s.endYear > s.startYear ? ` to ${s.endYear}` : ''}`;
                        const pov = s.pov ? `, point of view ${s.pov}` : '';
                        return (
                          <span
                            key={s.id}
                            role="img"
                            className={`ol-mark ${s.primary ? 'primary' : 'backstory'}`}
                            style={{
                              left: x(s.startYear) + 3,
                              width: (s.endYear - s.startYear + 1) * COL - 6,
                            }}
                            title={`${s.label}, ${years}${pov}${s.present.length ? `; present: ${s.present.join(', ')}` : ''}`}
                            aria-label={`${s.primary ? 'Primary' : 'Backstory'} strand ${s.label}, ${years}${pov}`}
                            data-strand={s.id}
                          />
                        );
                      })}
                    </div>
                  </div>
                ),
              )}
            </div>
          </div>
        )}
        <div className="ol-legend row tight" aria-label="Legend">
          <span>
            <span className="ol-mark primary swatch" aria-hidden="true" /> Primary strand
          </span>
          <span>
            <span className="ol-mark backstory swatch" aria-hidden="true" /> Backstory strand
          </span>
          <span>
            <span className="ol-arc series-1 swatch" aria-hidden="true" /> Arc, in the owner&apos;s
            family color
          </span>
          <span>
            <span className="ol-cursor swatch" aria-hidden="true" /> Story time
          </span>
        </div>
        <ArcsList
          selected={arcFocus}
          writes={writes}
          onOpen={(id) => setFocus({ kind: 'arc', id })}
        />
      </section>
      <aside
        className="inspector tree-inspector"
        aria-label="Outline inspector"
        data-testid="outline-inspector"
      >
        <span className="eyebrow">Inspector</span>
        {focus?.kind === 'chapter' && sel && outline ? (
          <ChapterPanel
            key={`c:${sel.id}`}
            id={sel.id}
            outline={outline}
            writes={writes}
            onClose={() => setFocus(null)}
            canMove={{
              up: reading && selIndex > 0,
              down: reading && selIndex >= 0 && selIndex < selSiblings.length - 1,
            }}
            onMove={(by) => moveChapter(sel, by)}
            onToPart={(partId) => toPart(sel, partId)}
            onOpenBeat={(id) => setFocus({ kind: 'beat', id, back: focus })}
          />
        ) : focus?.kind === 'arc' ? (
          <ArcPanel
            key={`a:${focus.id}`}
            id={focus.id}
            writes={writes}
            onClose={() => setFocus(null)}
            onOpenBeat={(id) => setFocus({ kind: 'beat', id, back: focus })}
          />
        ) : focus?.kind === 'beat' ? (
          <div className="stack">
            <div className="row tight">
              <button type="button" className="btn small" onClick={() => setFocus(focus.back)}>
                {focus.back?.kind === 'arc'
                  ? 'Back to the arc'
                  : focus.back?.kind === 'chapter'
                    ? 'Back to the chapter'
                    : 'Close the beat'}
              </button>
            </div>
            <EmbeddedEditor key={`b:${focus.id}`} collection="plotBeats" id={focus.id} />
          </div>
        ) : focus?.kind === 'book' || focus?.kind === 'part' ? (
          <div className="stack">
            <div className="row tight">
              <button type="button" className="btn small" onClick={() => setFocus(null)}>
                Close the {focus.kind}
              </button>
            </div>
            <EmbeddedEditor
              key={`${focus.kind}:${focus.id}`}
              collection={focus.kind === 'book' ? 'books' : 'parts'}
              id={focus.id}
            />
          </div>
        ) : (
          <p className="example-note">
            Pick a chapter row to see its beats and who is present, and to edit its strands. Pick an
            arc under Arcs to see its beats.
          </p>
        )}
        <UndoPanel />
      </aside>
    </div>
  );
}

/**
 * KB-3: a book or part heading. The title renames in place; the count says
 * what is inside; New part or New chapter adds one here; Actions holds
 * Edit details, the moves, and Move to trash (ED-5).
 */
function Heading(props: {
  row: BookRow | PartRow;
  writes: OutlineWrites;
  canMove: boolean;
  onMove: (by: -1 | 1) => void;
  onAdd: () => void;
  onDetails: () => void;
}) {
  const { row, writes } = props;
  const menu = useRef<HTMLDetailsElement | null>(null);
  const collection = row.kind === 'book' ? 'books' : 'parts';
  const noun = row.kind === 'book' ? 'book' : 'part';
  if (row.missing) {
    return (
      <div className="ol-heading row tight">
        <span className="ol-name missing">{row.label}</span>
        {row.kind === 'part' && (
          <span className="ol-count">{plural(row.chapterCount, 'chapter', 'chapters')}</span>
        )}
      </div>
    );
  }
  const close = () => {
    if (menu.current) menu.current.open = false;
  };
  return (
    <div className="ol-heading row tight">
      <span data-focus-key={`${row.kind}:${row.id}`} className="ol-name-slot">
        <InlineName
          value={row.title}
          label={`${row.kind === 'book' ? 'Book' : 'Part'} title`}
          disabled={writes.ro.off}
          testId={`${row.kind}-name`}
          onSave={(t) => writes.edit(collection, row.id, { title: t }, `Renamed ${row.label}`)}
          onMove={props.canMove ? props.onMove : undefined}
        >
          {row.label}
        </InlineName>
      </span>
      <span className="ol-count" data-testid={`${row.kind}-count`}>
        {row.kind === 'book'
          ? plural(row.partCount, 'part', 'parts')
          : plural(row.chapterCount, 'chapter', 'chapters')}
      </span>
      <button
        type="button"
        className="btn small"
        disabled={writes.ro.off}
        {...writes.ro.tip}
        onClick={props.onAdd}
      >
        {row.kind === 'book' ? 'New part' : 'New chapter'}
      </button>
      <details className="ol-menu" ref={menu}>
        <summary aria-label={`Actions for ${row.label}`}>Actions</summary>
        <div className="ol-menu-body row tight">
          <button
            type="button"
            className="btn small"
            onClick={() => {
              close();
              props.onDetails();
            }}
          >
            Edit details
          </button>
          {props.canMove && (
            <>
              <button
                type="button"
                className="btn small"
                disabled={writes.ro.off}
                onClick={() => props.onMove(-1)}
              >
                Move {noun} earlier
              </button>
              <button
                type="button"
                className="btn small"
                disabled={writes.ro.off}
                onClick={() => props.onMove(1)}
              >
                Move {noun} later
              </button>
            </>
          )}
          <TrashControls
            collection={collection}
            id={row.id}
            title={row.title}
            inTrash={false}
            beforeDelete={async () => undefined}
            onChanged={close}
          />
        </div>
      </details>
    </div>
  );
}
