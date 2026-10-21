import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useEntries } from './data';
import { useUndo } from './undo';
import { useStoryTime } from './storyTime';
import { useYearView } from './timeline/common';
import { useStrandOptions } from './timeline/StoryTimeDialog';

/**
 * The bar above every screen of an open bible: the story year slider, the
 * era as a button that opens the year view (KB-2, as Cmd+T does), the
 * chapter being written, Undo and Redo with this session's changes (ED-3,
 * A43), Relevant to Session, and Start session. The first two
 * read and write the one story time (TM-3), so the tree, the timeline,
 * character ages, and the session selection follow them. Start session opens
 * the DB-2 flow on the Sessions screen (SM-11) with the chapter being written
 * as its section.
 */
export function TopBar(props: {
  onRelevant: () => void;
  onStartSession: () => void;
  /** SM-10: Relevant to Session is the screen showing. */
  relevantActive?: boolean;
}) {
  const story = useStoryTime();
  const characters = useEntries('characters');
  const strands = useStrandOptions();
  const time = story.time ?? { year: story.year };
  const view = useYearView(time);
  const [yearDraft, setYearDraft] = useState<string | null>(null);
  const ids = { year: useId(), slider: useId(), writing: useId() };

  const bounds = useMemo(() => {
    const ys = [story.year, ...strands.map((s) => s.year).filter((y): y is number => y !== null)];
    for (const c of characters) {
      for (const d of [c.birth, c.death] as unknown[]) {
        if (d && typeof d === 'object' && 'year' in d)
          ys.push(Number((d as { year: number }).year));
      }
    }
    return { min: Math.min(...ys), max: Math.max(...ys) };
  }, [characters, strands, story.year]);

  const writing = strands.find(
    (s) => s.chapterId === time.chapterId && s.strandId === time.strandId,
  );

  // The typed year commits on Enter or blur, never per keystroke (2045 must not set 2, 20, 204).
  const commitYear = () => {
    const t = yearDraft;
    setYearDraft(null);
    if (t !== null && /^-?\d{1,5}$/.test(t.trim())) story.setYear(Number(t));
  };

  const pickChapter = (key: string) => {
    const s = strands.find((o) => o.key === key);
    if (!s) story.set({ year: time.year });
    else story.set({ year: s.year ?? time.year, chapterId: s.chapterId, strandId: s.strandId });
  };

  return (
    <section className="ws-topbar" aria-label="Story time and session" data-testid="top-bar">
      <div className="topbar-year">
        <label htmlFor={ids.slider}>Story year</label>
        <input
          id={ids.slider}
          type="range"
          min={bounds.min}
          max={bounds.max}
          value={time.year}
          onChange={(e) => {
            setYearDraft(null);
            story.setYear(Number(e.target.value));
          }}
          data-testid="top-year-slider"
        />
        <input
          id={ids.year}
          type="number"
          className="num"
          aria-label="Type a story year"
          value={yearDraft ?? String(time.year)}
          onChange={(e) => setYearDraft(e.target.value)}
          onBlur={commitYear}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitYear();
            else if (e.key === 'Escape') setYearDraft(null);
          }}
          data-testid="top-year"
        />
        <button
          type="button"
          className="btn small topbar-era"
          onClick={story.openDialog}
          aria-label={view?.era ? `Open the year, ${view.era.name}` : 'Open the year'}
          title="Everyone and the world in this year (Cmd T)"
          data-testid="top-open-year"
        >
          {view?.era?.name ?? 'Open the year'}
        </button>
      </div>
      <div className="topbar-writing">
        <label htmlFor={ids.writing}>Writing</label>
        <select
          id={ids.writing}
          value={writing?.key ?? ''}
          onChange={(e) => pickChapter(e.target.value)}
          data-testid="top-writing"
        >
          <option value="">No chapter picked</option>
          {strands.map((s) => (
            <option key={s.key} value={s.key}>
              {s.label}
            </option>
          ))}
        </select>
      </div>
      <UndoControls />
      <div className="topbar-session">
        <button
          type="button"
          className="btn small"
          onClick={props.onRelevant}
          aria-current={props.relevantActive ? 'page' : undefined}
          data-testid="top-relevant"
          title="The entries that matter for the chapter being written"
        >
          Relevant to Session
        </button>
        <button
          type="button"
          className="btn primary small"
          onClick={props.onStartSession}
          data-testid="top-start-session"
        >
          Start session
        </button>
      </div>
    </section>
  );
}

/**
 * ED-3, A43: Undo and Redo for the whole app, on every screen, with a Changes
 * popover listing this session's steps newest first. Steps that were undone
 * sit on top, marked Undone, until Redo takes them again or a new change drops
 * them. Cmd+Z and Shift+Cmd+Z do the same as the buttons.
 */
function UndoControls() {
  const undo = useUndo();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const popId = useId();
  const items = [
    ...undo.history.redo.map((c) => ({ label: c.label, redo: true })).reverse(),
    ...undo.history.undo.map((c) => ({ label: c.label, redo: false })),
  ];
  const close = () => {
    setOpen(false);
    button.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!pop.current?.contains(t) && !button.current?.contains(t)) setOpen(false);
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);

  const nextUndo = undo.history.undo[0]?.label;
  const nextRedo = undo.history.redo[0]?.label;
  return (
    <div
      className="topbar-undo"
      role="group"
      aria-label="Undo and redo"
      // Escape on the Changes button or inside the popover closes it.
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || !open) return;
        e.preventDefault();
        e.stopPropagation();
        close();
      }}
    >
      <button
        type="button"
        className="btn small"
        disabled={!undo.canUndo}
        onClick={() => void undo.undo()}
        title={nextUndo ? `Undo ${nextUndo} (Cmd Z)` : 'Cmd Z'}
        data-testid="top-undo"
      >
        Undo
      </button>
      <button
        type="button"
        className="btn small"
        disabled={!undo.canRedo}
        onClick={() => void undo.redo()}
        title={nextRedo ? `Redo ${nextRedo} (Shift Cmd Z)` : 'Shift Cmd Z'}
        data-testid="top-redo"
      >
        Redo
      </button>
      <button
        ref={button}
        type="button"
        className="btn small"
        aria-expanded={open}
        aria-controls={open ? popId : undefined}
        onClick={() => setOpen((o) => !o)}
        data-testid="top-changes"
      >
        Changes
      </button>
      {open && (
        <div
          ref={pop}
          id={popId}
          className="changes-pop stack tight"
          role="dialog"
          aria-label="Changes this session"
          data-testid="changes-popover"
        >
          <span className="eyebrow">Changes this session, newest first</span>
          <ul className="stack-list" data-testid="undo-history">
            {items.length === 0 ? (
              <li className="empty">No changes yet. The last 100 are kept.</li>
            ) : (
              items.map((it, i) => (
                <li key={i} className={it.redo ? 'redo' : undefined}>
                  {it.redo ? `Undone: ${it.label}` : it.label}
                </li>
              ))
            )}
          </ul>
          <button type="button" className="btn small" onClick={close}>
            Close
          </button>
        </div>
      )}
    </div>
  );
}
