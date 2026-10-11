import { useEffect, useId, useMemo, useState } from 'react';
import type { DragEvent } from 'react';
import { describeState } from '../../../shared/domain/ages';
import { beatsOfArc } from '../../../shared/domain/outline';
import { reorderCommand } from '../../../shared/domain/undoRunner';
import type { Response } from '../../../shared/ipc';
import { entryTitle } from '../../../shared/schema';
import { call, plainError } from '../api';
import { useEntries, useStore } from './data';
import { EmbeddedEditor, UndoPanel } from './editor';
import { useStoryTime } from './storyTime';
import { useUndo } from './undo';
import { Zh } from './Zh';

type Outline = Response<'outline.get'>;
type ChapterRow = Extract<Outline['rows'][number], { kind: 'chapter' }>;
type Page = Response<'chapter.page'>['page'];

/** Width of one year column, in pixels. */
const COL = 26;

/** Move a chapter or a beat and record one undo step for the whole reorder (PL-3). */
function useReorder() {
  const undo = useUndo();
  const [error, setError] = useState<string | null>(null);
  const run = async (
    kind: 'chapters' | 'beats',
    groupId: string,
    movedId: string,
    toIndex: number,
    label: string,
  ) => {
    setError(null);
    try {
      const r = await call('plot.reorder', { kind, groupId, movedId, toIndex });
      if (r.changes.length) {
        undo.record(reorderCommand(label, r.collection, r.changes));
      }
    } catch (e) {
      setError(plainError(e));
    }
  };
  return { run, error };
}

/**
 * The outline (PL-2, PL-3): one row per chapter, one column per story year.
 * Strands are marks (primary filled, backstory hollow), arcs are spans in the
 * owner's family color, and a line marks the story time. Rows can be dragged
 * within their part in reading order; the story-year order is read only.
 */
export function OutlineView() {
  const { version } = useStore();
  const story = useStoryTime();
  const reorder = useReorder();
  const [order, setOrder] = useState<'reading' | 'story'>('reading');
  const [outline, setOutline] = useState<Outline | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
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

  const first = outline?.years[0] ?? 0;
  const x = (year: number) => (year - first) * COL;
  const chapters = useMemo(
    () => (outline?.rows ?? []).filter((r): r is ChapterRow => r.kind === 'chapter'),
    [outline],
  );
  const inPart = (partId: string) => chapters.filter((c) => c.partId === partId);

  const drop = (e: DragEvent, target: ChapterRow) => {
    e.preventDefault();
    setOver(null);
    const moved = chapters.find((c) => c.id === dragging);
    setDragging(null);
    if (!moved || moved.id === target.id) return;
    // Into another part the chapter takes the target's place and the target's part (PL-3).
    const siblings = inPart(target.partId).filter((c) => c.id !== moved.id);
    const toIndex = siblings.findIndex((c) => c.id === target.id);
    void reorder.run('chapters', target.partId, moved.id, toIndex, `Moved ${moved.title}`);
  };

  /** Drop on a part heading: the chapter goes to the start of that part. */
  const dropOnPart = (e: DragEvent, partId: string) => {
    e.preventDefault();
    setOver(null);
    const moved = chapters.find((c) => c.id === dragging);
    setDragging(null);
    if (!moved || moved.partId === partId) return;
    void reorder.run('chapters', partId, moved.id, 0, `Moved ${moved.title}`);
  };

  const toPart = (c: ChapterRow, partId: string) => {
    if (!partId || partId === c.partId) return;
    const end = inPart(partId).length;
    void reorder.run('chapters', partId, c.id, end, `Moved ${c.title} to another part`);
  };

  const move = (c: ChapterRow, by: -1 | 1) => {
    const siblings = inPart(c.partId);
    const at = siblings.findIndex((s) => s.id === c.id);
    const to = at + by;
    if (to < 0 || to >= siblings.length) return;
    void reorder.run(
      'chapters',
      c.partId,
      c.id,
      to,
      `Moved ${c.title} ${by < 0 ? 'earlier' : 'later'}`,
    );
  };

  const sel = chapters.find((c) => c.id === selected) ?? null;
  const siblings = sel ? inPart(sel.partId) : [];
  const selIndex = sel ? siblings.findIndex((c) => c.id === sel.id) : -1;

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
          </span>
        </div>
        <p className="example-note">
          {order === 'reading'
            ? 'Chapters in reading order, grouped by book and part. Drag a row to a new place in its part or into another part, or open a chapter and use the move buttons.'
            : 'Chapters sorted by story year. Switch to reading order to move them.'}
        </p>
        {reorder.error && (
          <p className="callout crit" role="alert">
            {reorder.error}
          </p>
        )}
        {!outline ? (
          <p aria-live="polite">Loading the outline.</p>
        ) : chapters.length === 0 ? (
          <p className="example-note">No chapters yet. Add one in the Chapters section.</p>
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
              {outline.rows.map((row) =>
                row.kind !== 'chapter' ? (
                  <div
                    key={`${row.kind}:${row.id}`}
                    className={`ol-group ${row.kind}${over === `part:${row.id}` ? ' over' : ''}`}
                    data-part={row.kind === 'part' ? row.id : undefined}
                    onDragOver={
                      row.kind === 'part'
                        ? (e) => {
                            if (dragging) {
                              e.preventDefault();
                              setOver(`part:${row.id}`);
                            }
                          }
                        : undefined
                    }
                    onDragLeave={row.kind === 'part' ? () => setOver(null) : undefined}
                    onDrop={row.kind === 'part' ? (e) => dropOnPart(e, row.id) : undefined}
                  >
                    {row.kind === 'book' ? 'Book' : 'Part'}: {row.title}
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
                      draggable={outline.order === 'reading'}
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
                        data-testid="outline-label"
                        onClick={() => setSelected(row.id)}
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
                          className={`ol-arc ${a.color}`}
                          style={{
                            left: x(a.from),
                            width: (a.to - a.from + 1) * COL,
                            top: 3 + i * 6,
                          }}
                          title={`${a.name}, ${a.from} to ${a.to}`}
                          data-arc={a.arcId}
                        />
                      ))}
                      {row.strands.map((s) => (
                        <span
                          key={s.id}
                          role="img"
                          className={`ol-mark ${s.primary ? 'primary' : 'backstory'}`}
                          style={{
                            left: x(s.startYear) + 3,
                            width: (s.endYear - s.startYear + 1) * COL - 6,
                          }}
                          title={`${s.label}, ${s.startYear}${s.endYear > s.startYear ? ` to ${s.endYear}` : ''}`}
                          aria-label={`${s.primary ? 'Primary' : 'Backstory'} strand ${s.label}, ${s.startYear}`}
                          data-strand={s.id}
                        />
                      ))}
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
        <ArcBeats reorder={reorder} />
      </section>
      <aside
        className="inspector tree-inspector"
        aria-label="Outline inspector"
        data-testid="outline-inspector"
      >
        <span className="eyebrow">Inspector</span>
        {sel ? (
          <>
            <div className="row tight">
              <button type="button" className="btn small" onClick={() => setSelected(null)}>
                Close the chapter
              </button>
              <button
                type="button"
                className="btn small"
                disabled={selIndex <= 0 || outline?.order !== 'reading'}
                onClick={() => move(sel, -1)}
              >
                Move earlier in its part
              </button>
              <button
                type="button"
                className="btn small"
                disabled={
                  selIndex < 0 || selIndex >= siblings.length - 1 || outline?.order !== 'reading'
                }
                onClick={() => move(sel, 1)}
              >
                Move later in its part
              </button>
            </div>
            {outline?.order === 'reading' && (
              <div className="field">
                <label htmlFor={`${orderId}-part`}>Move to the end of a part</label>
                <select
                  id={`${orderId}-part`}
                  value=""
                  onChange={(e) => toPart(sel, e.target.value)}
                >
                  <option value="">Pick a part</option>
                  {outline.rows
                    .filter((r) => r.kind === 'part' && r.id !== sel.partId)
                    .map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.title}
                      </option>
                    ))}
                </select>
              </div>
            )}
            <ChapterPageView key={`p:${sel.id}`} id={sel.id} />
            <EmbeddedEditor key={`e:${sel.id}`} collection="chapters" id={sel.id} />
          </>
        ) : (
          <p className="example-note">
            Pick a chapter row to see its beats, who is present, and to edit its strand years.
          </p>
        )}
        <UndoPanel />
      </aside>
    </div>
  );
}

/** PL-4: a chapter's beats, characters present with ages, places, themes, and facts in play. */
export function ChapterPageView({ id }: { id: string }) {
  const { version } = useStore();
  const [page, setPage] = useState<Page | null>(null);

  useEffect(() => {
    let live = true;
    void call('chapter.page', { id })
      .then((r) => {
        if (live) setPage(r.page);
      })
      .catch(() => {
        if (live) setPage(null);
      });
    return () => {
      live = false;
    };
  }, [id, version]);

  if (!page) return <p aria-live="polite">Loading the chapter page.</p>;
  const years = (s: Page['strands'][number]) =>
    s.endYear !== null && s.endYear !== s.startYear
      ? `${s.startYear} to ${s.endYear}`
      : `${s.startYear}`;

  return (
    <section className="stack chapter-page" aria-label="Chapter page" data-testid="chapter-page">
      <h3>
        Chapter {page.readingOrder}: <Zh text={page.title} />
      </h3>
      <p className="example-note">
        {page.storyYear === null ? 'No story year yet' : `Story year ${page.storyYear}`}
        {page.written ? ', written' : ', not written yet'}
      </p>
      {page.arcs.length > 0 && (
        <p className="row tight" data-testid="chapter-arcs">
          {page.arcs.map((a) => (
            <span key={a.id} className="chip">
              <Zh text={a.name} />
            </span>
          ))}
        </p>
      )}
      <div className="stack tight" data-testid="chapter-beats">
        <span className="eyebrow">Beats</span>
        {page.beats.length === 0 ? (
          <p className="example-note">No beats yet.</p>
        ) : (
          <ol className="stack-list">
            {page.beats.map((b) => (
              <li key={b.id}>
                <strong>
                  <Zh text={b.title} />
                </strong>
                {b.year !== null && <span className="example-note"> ({b.year})</span>}
                {b.arcs.length > 0 && (
                  <span className="example-note">
                    {' '}
                    <Zh text={b.arcs.join(', ')} />
                  </span>
                )}
                {b.description && (
                  <>
                    <br />
                    <Zh text={b.description} />
                  </>
                )}
              </li>
            ))}
          </ol>
        )}
      </div>
      {page.strands.map((s) => (
        <div key={s.id} className="stack tight" data-testid="chapter-strand" data-strand={s.id}>
          <span className="eyebrow">
            {s.label}
            {s.primary ? ' (primary)' : ''}, {years(s)}
          </span>
          {s.pov && (
            <span>
              Point of view: <Zh text={s.pov.name} />
            </span>
          )}
          <ul className="stack-list" aria-label={`Characters present, ${s.label}`}>
            {s.characters.length === 0 ? (
              <li className="empty">No characters listed.</li>
            ) : (
              s.characters.map((c) => (
                <li key={c.id} data-character={c.id}>
                  <Zh text={c.name} />{' '}
                  <span className="example-note">{describeState(c.state)}</span>
                </li>
              ))
            )}
          </ul>
          {s.places.length > 0 && (
            <span data-testid="chapter-places">
              Places:{' '}
              {s.places.map((p, i) => (
                <span key={p.id} data-place={p.id}>
                  {i > 0 && '; '}
                  <Zh text={p.name} />
                </span>
              ))}
            </span>
          )}
        </div>
      ))}
      <div className="stack tight" data-testid="chapter-themes">
        <span className="eyebrow">Themes</span>
        {page.themes.length === 0 ? (
          <p className="example-note">No themes linked.</p>
        ) : (
          <ul className="stack-list">
            {page.themes.map((t) => (
              <li key={t.id}>
                <Zh text={t.title} />
                {t.note && (
                  <span className="example-note">
                    {' '}
                    <Zh text={t.note} />
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="stack tight" data-testid="chapter-facts">
        <span className="eyebrow">Facts in play</span>
        {page.factsInPlay.length === 0 ? (
          <p className="example-note">No facts in play.</p>
        ) : (
          <ul className="stack-list">
            {page.factsInPlay.map((f, i) => (
              <li key={i}>
                <Zh text={f.character} /> acts on <Zh text={f.fact} />
                {f.note && (
                  <span className="example-note">
                    {' '}
                    <Zh text={f.note} />
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

/** PL-3: the beats of one arc in order, reordered by dragging or with the move buttons. */
function ArcBeats({ reorder }: { reorder: ReturnType<typeof useReorder> }) {
  const arcs = useEntries('arcs');
  const beats = useEntries('plotBeats');
  const [arcId, setArcId] = useState('');
  const [dragging, setDragging] = useState<string | null>(null);
  const selectId = useId();
  const arc = arcs.find((a) => a._id === arcId) ?? null;
  const list = useMemo(() => beatsOfArc(beats, arcId), [beats, arcId]);
  const moveTo = (id: string, to: number) => {
    if (to < 0 || to >= list.length) return;
    void reorder.run('beats', arcId, id, to, `Moved a beat in ${arc ? entryTitle(arc) : 'an arc'}`);
  };

  return (
    <section className="stack tight" aria-labelledby={`${selectId}-h`} data-testid="arc-beats">
      <h3 id={`${selectId}-h`}>Beats in an arc</h3>
      <div className="field">
        <label htmlFor={selectId}>Arc</label>
        <select id={selectId} value={arcId} onChange={(e) => setArcId(e.target.value)}>
          <option value="">Pick an arc</option>
          {arcs.map((a) => (
            <option key={a._id} value={a._id}>
              {entryTitle(a)}
            </option>
          ))}
        </select>
      </div>
      {arc &&
        (list.length === 0 ? (
          <p className="example-note">This arc has no beats yet.</p>
        ) : (
          <ol className="beat-list">
            {list.map((b, i) => (
              <li
                key={b._id}
                draggable
                data-beat={b._id}
                onDragStart={(e) => {
                  setDragging(b._id);
                  e.dataTransfer.setData('text/plain', b._id);
                }}
                onDragOver={(e) => dragging && e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragging && dragging !== b._id) moveTo(dragging, i);
                  setDragging(null);
                }}
              >
                <span className="beat-title">
                  <Zh text={entryTitle(b)} actions={false} />
                </span>
                <span className="row tight">
                  <button
                    type="button"
                    className="btn small"
                    disabled={i === 0}
                    aria-label={`Move ${entryTitle(b)} up`}
                    onClick={() => moveTo(b._id, i - 1)}
                  >
                    Up
                  </button>
                  <button
                    type="button"
                    className="btn small"
                    disabled={i === list.length - 1}
                    aria-label={`Move ${entryTitle(b)} down`}
                    onClick={() => moveTo(b._id, i + 1)}
                  >
                    Down
                  </button>
                </span>
              </li>
            ))}
          </ol>
        ))}
    </section>
  );
}
