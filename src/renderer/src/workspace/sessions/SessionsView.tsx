import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { Response } from '../../../../shared/ipc';
import { entryTitle } from '../../../../shared/schema';
import { filterQuestions, questionCounts } from '../../../../shared/domain/questions';
import type { QuestionFilter } from '../../../../shared/domain/questions';
import { logsNewestFirst } from '../../../../shared/domain/sessionLog';
import { useWriteGuard } from '../../connection';
import { call } from '../../api';
import { useEntries, useStore } from '../data';
import { RowEditor } from '../rowEditor';
import type { Picked } from '../rowEditor';
import { formatMoment, useStoryTime } from '../storyTime';
import { useYearView } from '../timeline/common';
import { NewEntryForm } from '../views';
import { Zh } from '../Zh';
import { RewriteTasks, useFindings } from './alignment';
import { BriefView } from './brief';
import type { OpenEntry } from './common';
import { StartSessionView } from './start';
import './sessions.css';

type Dashboard = Response<'dashboard.get'>;

/** Where the Sessions screen is: the whole screen, opened at Start session, or one brief in place. */
export type SessionsSub = 'home' | 'start' | 'brief';

/**
 * SM-11: Sessions, the screen the app opens on (DB-1). At the top what the
 * dashboard held: where you stopped (SL-1), the story time, the reading
 * position, the open questions and rewrite tasks, Start session and Check
 * alignment. Then Start session (DB-2 to DB-4), the session log (SL-1), the
 * saved briefs, each opening here in place (SB-8), and the open questions
 * (OQ-1). A43: a log or a question opens in place under its row, one at a
 * time, and New question opens at the top of the questions.
 */
export function SessionsView(props: {
  sub: SessionsSub;
  briefId?: string;
  note: string | null;
  noteSettings: boolean;
  onOpen: OpenEntry;
  onSub: (sub: SessionsSub, briefId?: string, note?: string | null, noteSettings?: boolean) => void;
  onCheckAlignment: () => void;
  /** Leave the launch panel and start working: the characters. */
  onDone: () => void;
}) {
  const [picked, setPicked] = useState<Picked | null>(null);
  const [newQuestion, setNewQuestion] = useState(false);
  const startRef = useRef<HTMLElement>(null);
  const questionsRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (props.sub === 'start') startRef.current?.scrollIntoView({ block: 'start' });
  }, [props.sub]);

  /** A43: a second pick of the open row closes it. */
  const pick = (collection: Picked['collection'], id: string) => {
    setNewQuestion(false);
    setPicked((p) => (p?.collection === collection && p.id === id ? null : { collection, id }));
  };
  const close = () => setPicked(null);

  if (props.sub === 'brief' && props.briefId) {
    return (
      <div className="ws-wide-area" data-testid="sessions-view" data-sub="brief">
        <div className="ws-wide stack">
          <div className="row">
            <button type="button" className="btn small" onClick={() => props.onSub('home')}>
              Back to Sessions
            </button>
          </div>
          <BriefView
            id={props.briefId}
            note={props.note}
            noteSettings={props.noteSettings}
            onOpen={props.onOpen}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="ws-wide-area" data-testid="sessions-view" data-sub={props.sub}>
      <div className="ws-wide stack sessions">
        <h2>Sessions</h2>
        <Overview
          onStart={() => {
            props.onSub('start');
            startRef.current?.scrollIntoView({ block: 'start' });
          }}
          onCheckAlignment={props.onCheckAlignment}
          onQuestions={() => questionsRef.current?.scrollIntoView({ block: 'start' })}
          onOpenBrief={(id) => props.onSub('brief', id)}
          onOpenChapter={(id) => props.onOpen('chapters', id)}
          onDone={props.onDone}
        />
        <section
          ref={startRef}
          className="sessions-part stack"
          aria-label="Start session"
          data-testid="sessions-start"
        >
          <StartSessionView
            onOpen={props.onOpen}
            showSelection={props.sub === 'start'}
            onStarted={(id, note, noteSettings) => props.onSub('brief', id, note, noteSettings)}
          />
        </section>
        <SessionLog
          open={picked?.collection === 'sessionLogs' ? picked : null}
          onPick={(id) => pick('sessionLogs', id)}
          onClose={close}
        />
        <Briefs onOpenBrief={(id) => props.onSub('brief', id)} />
        <section
          ref={questionsRef}
          className="sessions-part stack tight"
          aria-labelledby="sessions-questions"
        >
          <Questions
            open={picked?.collection === 'openQuestions' ? picked : null}
            onPick={(id) => pick('openQuestions', id)}
            onClose={close}
            newQuestion={newQuestion}
            onNew={() => {
              setPicked(null);
              setNewQuestion(true);
            }}
            onCreated={(id) => {
              setNewQuestion(false);
              setPicked({ collection: 'openQuestions', id });
            }}
            onCancelNew={() => setNewQuestion(false)}
          />
        </section>
      </div>
    </div>
  );
}

/** DB-1: what the dashboard held. */
function Overview(props: {
  onStart: () => void;
  onCheckAlignment: () => void;
  onQuestions: () => void;
  onOpenBrief: (id: string) => void;
  onOpenChapter: (id: string) => void;
  onDone: () => void;
}) {
  const { version } = useStore();
  const story = useStoryTime();
  const time = story.time ?? { year: story.year };
  const view = useYearView(time);
  const [d, setD] = useState<Dashboard | null>(null);
  const tasks = useFindings(null, ['rewrite']);
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
  const taskCount = tasks?.findings.length ?? 0;

  return (
    <section className="stack dash" aria-label="Overview" data-testid="dashboard">
      {last && (
        <section
          className="panel stack tight launch-panel"
          aria-label="Where you stopped"
          data-testid="launch-panel"
        >
          <span className="eyebrow">Where you stopped, {last.date}</span>
          <p data-testid="launch-note">{last.stoppedAt || last.notes}</p>
          {last.chapter && <p>Chapter: {last.chapter}</p>}
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
          <button type="button" className="btn small" onClick={props.onQuestions}>
            Go to the questions
          </button>
        </section>
        <section
          className="panel tile"
          aria-label="Open rewrite tasks"
          data-testid="dash-task-count"
        >
          <span className="eyebrow">Rewrite tasks</span>
          <div className="tile-num">{taskCount}</div>
          <span>{taskCount === 1 ? 'open task' : 'open tasks'}</span>
        </section>
      </div>
      <div className="row dash-cta">
        <button type="button" className="btn primary" onClick={props.onStart}>
          Start session
        </button>
        <button type="button" className="btn primary" onClick={props.onCheckAlignment}>
          Check alignment
        </button>
        <span>
          Start a session for a brief. Check alignment to compare the manuscript with the bible.
        </span>
      </div>
      <section className="panel stack tight" aria-label="Rewrite tasks" data-testid="dash-tasks">
        <span className="eyebrow">Rewrite tasks</span>
        <RewriteTasks chapterId={null} onOpenChapter={props.onOpenChapter} />
      </section>
    </section>
  );
}

/** SL-1: every session log, newest first. A row opens the log under it (A43). */
function SessionLog(props: {
  open: Picked | null;
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const logs = useEntries('sessionLogs');
  const chapters = useEntries('chapters');
  const rows = useMemo(() => logsNewestFirst(logs), [logs]);
  const chapterTitle = (id: unknown) =>
    typeof id === 'string' && id ? entryTitle(chapters.find((c) => c._id === id)) : '';
  return (
    <section className="sessions-part stack tight" aria-labelledby="sessions-log">
      <h3 id="sessions-log">Session log</h3>
      {rows.length === 0 ? (
        <p className="example-note">No sessions logged yet.</p>
      ) : (
        <ul className="entry-list sessions-list" data-testid="session-log">
          {rows.map((l) => {
            const chapter = chapterTitle(l.chapterId);
            const stopped = typeof l.stoppedAt === 'string' ? l.stoppedAt : '';
            return (
              <li key={l._id}>
                <button
                  type="button"
                  className="entry-row"
                  data-id={l._id}
                  aria-expanded={props.open?.id === l._id}
                  onClick={() => props.onPick(l._id)}
                >
                  <span className="row tight">
                    <span className="num">{String(l.date ?? '')}</span>
                    <span className="entry-title">{entryTitle(l)}</span>
                    {chapter && <span className="chip">{chapter}</span>}
                  </span>
                  {stopped && <span>Stopped at: {stopped}</span>}
                </button>
                {props.open?.id === l._id && (
                  <RowEditor
                    open={props.open}
                    onClose={props.onClose}
                    testId="session-row-editor"
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** SB-8: the saved briefs, newest first; one opens here in place. */
function Briefs(props: { onOpenBrief: (id: string) => void }) {
  const briefs = useEntries('briefs');
  const rows = useMemo(
    () => [...briefs].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))),
    [briefs],
  );
  return (
    <section className="sessions-part stack tight" aria-labelledby="sessions-briefs">
      <h3 id="sessions-briefs">Briefs</h3>
      {rows.length === 0 ? (
        <p className="example-note">No briefs yet. Start a session to write one.</p>
      ) : (
        <ul className="entry-list sessions-list" data-testid="session-briefs">
          {rows.map((b) => (
            <li key={b._id}>
              <button
                type="button"
                className="entry-row"
                data-id={b._id}
                onClick={() => props.onOpenBrief(b._id)}
              >
                <span className="row tight">
                  <span className="entry-title">{entryTitle(b)}</span>
                  {typeof b.storyYear === 'number' && (
                    <span className="chip time">{b.storyYear}</span>
                  )}
                  <span className="chip">
                    {b.synthesized === true ? `Written by ${String(b.model)}` : 'Structured'}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * OQ-1: the open questions, filtered by state; a row opens under it (A43);
 * New question opens its form at the top of the list.
 */
function Questions(props: {
  open: Picked | null;
  onPick: (id: string) => void;
  onClose: () => void;
  newQuestion: boolean;
  onNew: () => void;
  onCreated: (id: string) => void;
  onCancelNew: () => void;
}) {
  const questions = useEntries('openQuestions');
  const [state, setState] = useState<QuestionFilter>('all');
  const stateId = useId();
  const ro = useWriteGuard();
  const counts = useMemo(() => questionCounts(questions), [questions]);
  const rows = useMemo(
    () =>
      [...filterQuestions(questions, state)].sort((a, b) =>
        entryTitle(a).localeCompare(entryTitle(b)),
      ),
    [questions, state],
  );
  return (
    <>
      <div className="list-head">
        <h3 id="sessions-questions">Open questions</h3>
        <button
          type="button"
          className="btn primary small"
          onClick={props.onNew}
          disabled={ro.off}
          aria-expanded={props.newQuestion}
          {...ro.tip}
        >
          New question
        </button>
      </div>
      {props.newQuestion && (
        <div className="row-editor" data-testid="question-new">
          <NewEntryForm
            collection="openQuestions"
            onCreated={props.onCreated}
            onCancel={props.onCancelNew}
          />
        </div>
      )}
      <div className="field narrow">
        <label htmlFor={stateId}>Show questions</label>
        <select
          id={stateId}
          value={state}
          onChange={(e) => setState(e.target.value as QuestionFilter)}
        >
          <option value="all">All ({counts.open + counts.decided})</option>
          <option value="open">Open ({counts.open})</option>
          <option value="decided">Decided ({counts.decided})</option>
        </select>
      </div>
      {rows.length === 0 ? (
        <p className="example-note" data-testid="questions-empty">
          {questions.length === 0 ? 'No questions yet.' : 'No question is in this state.'}
        </p>
      ) : (
        <ul className="entry-list sessions-list" data-testid="questions-list">
          {rows.map((q) => (
            <li key={q._id}>
              <button
                type="button"
                className="entry-row"
                data-id={q._id}
                aria-expanded={props.open?.id === q._id}
                onClick={() => props.onPick(q._id)}
              >
                <span className="entry-title">
                  <Zh text={entryTitle(q)} actions={false} />
                </span>
                <span className="row tight">
                  <span className="chip" data-state={String(q.state ?? 'open')}>
                    {q.state === 'decided' ? 'decided' : 'open'}
                  </span>
                  {typeof q.status === 'string' && (
                    <span className={`chip ${q.status}`}>{q.status}</span>
                  )}
                </span>
              </button>
              {props.open?.id === q._id && (
                <RowEditor open={props.open} onClose={props.onClose} testId="session-row-editor" />
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
