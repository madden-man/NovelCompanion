import { useId, useMemo, useState } from 'react';
import { useEntries } from './data';
import { useStoryTime } from './storyTime';
import { useYearView } from './timeline/common';
import { useStrandOptions } from './timeline/StoryTimeDialog';

/**
 * The bar above every screen of an open bible: the story year slider, the
 * era as a button that opens the year view (KB-2, as Cmd+T does), the
 * chapter being written, Relevant to Session, and Start session. The first two
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
