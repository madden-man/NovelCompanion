import { useId, useMemo, useState } from 'react';
import { createCommand } from '../../../shared/domain/undoRunner';
import { localDateString } from '../../../shared/domain/sessionLog';
import { entryTitle } from '../../../shared/schema';
import { call, plainError } from '../api';
import { useEntries } from './data';
import { useStoryTime } from './storyTime';
import { useYearView } from './timeline/common';
import { useStrandOptions } from './timeline/StoryTimeDialog';
import { useUndo } from './undo';

/**
 * The bar above every screen of an open bible: the story year slider, the
 * chapter being written, and Start session. All three read and write the one
 * story time (TM-3), so the tree, the timeline, and character ages follow them.
 */
export function TopBar() {
  const story = useStoryTime();
  const undo = useUndo();
  const characters = useEntries('characters');
  const strands = useStrandOptions();
  const time = story.time ?? { year: story.year };
  const view = useYearView(time);
  const [yearDraft, setYearDraft] = useState<string | null>(null);
  const [session, setSession] = useState<{ startedAt: string; chapter: string } | null>(null);
  const [note, setNote] = useState<{ text: string; bad: boolean } | null>(null);
  const ids = { year: useId(), slider: useId(), writing: useId() };

  const bounds = useMemo(() => {
    const ys = [story.year, ...strands.map((s) => s.year)];
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

  const pickChapter = (key: string) => {
    const s = strands.find((o) => o.key === key);
    if (!s) story.set({ year: time.year });
    else story.set({ year: s.year, chapterId: s.chapterId, strandId: s.strandId });
  };

  const startSession = async () => {
    setNote(null);
    try {
      await story.flush();
      const now = new Date();
      const startedAt = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      const date = localDateString(now);
      const data = {
        title: `Session ${date}`,
        status: 'canon',
        date,
        chapterId: writing?.chapterId ?? null,
        stoppedAt: '',
        notes: `Started at ${startedAt}, story time ${time.year}.`,
      };
      const { entry } = await call('entry.create', { collection: 'sessionLogs', data });
      undo.record(createCommand('sessionLogs', entry._id, entryTitle(entry)));
      setSession({ startedAt, chapter: writing?.label ?? 'no chapter picked' });
    } catch (e) {
      setNote({ text: plainError(e), bad: true });
    }
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
          aria-label="Story year"
          value={yearDraft ?? String(time.year)}
          onBlur={() => setYearDraft(null)}
          onChange={(e) => {
            const t = e.target.value;
            if (/^-?\d{1,5}$/.test(t.trim())) {
              setYearDraft(null);
              story.setYear(Number(t));
            } else setYearDraft(t);
          }}
          data-testid="top-year"
        />
        {view?.era && <span className="example-note">{view.era.name}</span>}
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
        {session ? (
          <span role="status" data-testid="session-status">
            Session started {session.startedAt} ({session.chapter})
          </span>
        ) : (
          <button type="button" className="btn primary" onClick={() => void startSession()}>
            Start session
          </button>
        )}
        {note && (
          <span className={note.bad ? 'callout crit' : 'callout'} role="status">
            {note.text}
          </span>
        )}
      </div>
    </section>
  );
}
