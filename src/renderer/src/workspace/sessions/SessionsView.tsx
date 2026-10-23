import { useId, useMemo, useState } from 'react';
import { entryTitle } from '../../../../shared/schema';
import { filterQuestions, questionCounts } from '../../../../shared/domain/questions';
import type { QuestionFilter } from '../../../../shared/domain/questions';
import { useWriteGuard } from '../../connection';
import { useEntries } from '../data';
import { RowEditor } from '../rowEditor';
import type { Picked } from '../rowEditor';
import { NewEntryForm } from '../views';
import { Zh } from '../Zh';
import './sessions.css';

/**
 * SM-11: the Questions screen, the open questions (OQ-1). A43: a question
 * opens in place under its row, one at a time, and New question opens at the
 * top of the questions.
 */
export function QuestionsView() {
  const [picked, setPicked] = useState<Picked | null>(null);
  const [newQuestion, setNewQuestion] = useState(false);

  /** A43: a second pick of the open row closes it. */
  const pick = (collection: Picked['collection'], id: string) => {
    setNewQuestion(false);
    setPicked((p) => (p?.collection === collection && p.id === id ? null : { collection, id }));
  };
  const close = () => setPicked(null);

  return (
    <div className="ws-wide-area" data-testid="questions-view">
      <div className="ws-wide stack sessions">
        <h2>Questions</h2>
        <section className="sessions-part stack tight" aria-labelledby="sessions-questions">
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
