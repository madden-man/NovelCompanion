import { useEffect, useState } from 'react';
import type { Response } from '../../../../shared/ipc';
import { call } from '../../api';
import { useStore } from '../data';
import { formatMoment, useStoryTime } from '../storyTime';
import { useYearView } from '../timeline/common';

type Dashboard = Response<'dashboard.get'>;

/**
 * DB-1: the screen the app opens on. Where you stopped (SL-1), the story
 * time, the current position, open questions, rewrite tasks, and the two
 * primary controls, Start session and Check alignment.
 */
export function DashboardView(props: {
  onStartSession: () => void;
  onCheckAlignment: () => void;
  onOpenQuestions: () => void;
  onOpenBrief: (id: string) => void;
  onOpenChapter: (id: string) => void;
  /** Leave the dashboard and start working. */
  onDone: () => void;
}) {
  const { version } = useStore();
  const story = useStoryTime();
  const time = story.time ?? { year: story.year };
  const view = useYearView(time);
  const [d, setD] = useState<Dashboard | null>(null);
  const last = d?.lastLog ?? null;
  const position = d?.position ?? null;
  useEffect(() => {
    let live = true;
    void call('dashboard.get', {}).then((r) => {
      if (live) setD(r);
    });
    return () => {
      live = false;
    };
  }, [version]);

  return (
    <div className="ws-wide stack dash" data-testid="dashboard">
      <h2>Dashboard</h2>
      {last && (
        <section
          className="panel stack tight launch-panel"
          aria-label="Where you stopped"
          data-testid="launch-panel"
        >
          <span className="eyebrow">Where you stopped, {last.date}</span>
          <p data-testid="launch-note">{last.stoppedAt || last.notes}</p>
          {last.chapter && <p className="example-note">Chapter: {last.chapter}</p>}
          <div className="row">
            {last.briefId && (
              <button
                type="button"
                className="btn small"
                onClick={() => last.briefId && props.onOpenBrief(last.briefId)}
              >
                Open its brief
              </button>
            )}
            <button type="button" className="btn small" onClick={props.onDone}>
              Start working
            </button>
          </div>
        </section>
      )}
      <div className="dash-tiles">
        <section className="panel tile" aria-label="Story time" data-testid="dash-time">
          <span className="eyebrow">Story time</span>
          <div className="tile-num">{formatMoment(time)}</div>
          <span>{view?.era ? view.era.name : 'No era covers this year'}</span>
          <button type="button" className="btn small" onClick={story.openDialog}>
            Change
          </button>
        </section>
        <section className="panel tile" aria-label="Current position" data-testid="dash-position">
          <span className="eyebrow">Current position</span>
          {position ? (
            <>
              <div className="tile-num">Chapter {position.readingOrder}</div>
              <button
                type="button"
                className="link-btn"
                onClick={() => props.onOpenChapter(position.chapterId)}
              >
                {position.title}
              </button>
              {position.year !== null && <span>Story year {position.year}</span>}
            </>
          ) : (
            <>
              <div className="tile-num">None</div>
              <span>No chapter is marked written yet.</span>
            </>
          )}
        </section>
        <section className="panel tile" aria-label="Open questions" data-testid="dash-questions">
          <span className="eyebrow">Open questions</span>
          <div className="tile-num">{d?.openQuestions ?? 0}</div>
          <button type="button" className="btn small" onClick={props.onOpenQuestions}>
            Review
          </button>
        </section>
      </div>
      <div className="row dash-cta">
        <button type="button" className="btn primary" onClick={props.onStartSession}>
          Start session
        </button>
        <button type="button" className="btn primary" onClick={props.onCheckAlignment}>
          Check alignment
        </button>
        <span className="example-note">
          Start a session for a brief. Check alignment to compare the manuscript with the bible.
        </span>
      </div>
      <section className="panel stack tight" aria-label="Rewrite tasks" data-testid="dash-tasks">
        <span className="eyebrow">Rewrite tasks</span>
        {d && d.rewriteTasks.length ? (
          <ul className="plain-list stack tight">
            {d.rewriteTasks.map((t) => (
              <li key={t.id}>
                <strong>
                  {t.chapter ?? 'No chapter'}
                  {t.lines ? `, ${t.lines}` : ''}:
                </strong>{' '}
                {t.quote && <q>{t.quote}</q>} {t.text}
              </li>
            ))}
          </ul>
        ) : (
          <p className="example-note">No open rewrite tasks.</p>
        )}
      </section>
      {d && d.recentLogs.length > 0 && (
        <section className="panel stack tight" aria-label="Session log">
          <span className="eyebrow">Session log</span>
          <ul className="plain-list stack tight" data-testid="dash-log">
            {d.recentLogs.map((l) => (
              <li key={l.id}>
                <span className="num">{l.date}</span> {l.chapter ? `${l.chapter}: ` : ''}
                {l.text}{' '}
                {l.briefId && (
                  <button
                    type="button"
                    className="link-btn"
                    onClick={() => l.briefId && props.onOpenBrief(l.briefId)}
                  >
                    brief
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
