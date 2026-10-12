import { useEffect, useId, useState } from 'react';
import { WriteFieldset } from '../connection';
import type { FormEvent } from 'react';
import { createCommand } from '../../../shared/domain/undoRunner';
import { entryTitle } from '../../../shared/schema';
import type { EntryCollection } from '../../../shared/schema';
import type { Response } from '../../../shared/ipc';
import { call, plainError } from '../api';
import { useEntries, useStore } from './data';
import { useUndo } from './undo';
import { Zh } from './Zh';

type Page = Response<'fact.page'>['page'];

const yearText = (y: number | null) => (y === null ? 'year not set' : `learned in ${y}`);

/**
 * KN-1, KN-2, KN-3: a fact with everyone who learns it and when, the chapters
 * that act on it, and a form that records who learned it. A year before the
 * character was born is flagged and still saved.
 */
export function FactSummary(props: {
  id: string;
  onOpen: (collection: EntryCollection, id: string) => void;
}) {
  const { version } = useStore();
  const undo = useUndo();
  const characters = useEntries('characters');
  const [page, setPage] = useState<Page | null>(null);
  const [characterId, setCharacterId] = useState('');
  const [year, setYear] = useState('');
  const [how, setHow] = useState('');
  const [message, setMessage] = useState<{ text: string; bad: boolean; warnings: string[] } | null>(
    null,
  );
  const ids = { who: useId(), year: useId(), how: useId() };

  useEffect(() => {
    let live = true;
    void call('fact.page', { id: props.id })
      .then((r) => {
        if (live) setPage(r.page);
      })
      .catch(() => {
        if (live) setPage(null);
      });
    return () => {
      live = false;
    };
  }, [props.id, version]);

  const record = async (e: FormEvent) => {
    e.preventDefault();
    if (!page) return;
    setMessage(null);
    const who = characters.find((c) => c._id === characterId);
    if (!who) {
      setMessage({ text: 'Pick the character who learns it.', bad: true, warnings: [] });
      return;
    }
    const trimmed = year.trim();
    if (trimmed !== '' && !/^-?\d{1,5}$/.test(trimmed)) {
      setMessage({ text: 'The year must be a whole number.', bad: true, warnings: [] });
      return;
    }
    try {
      const r = await call('entry.create', {
        collection: 'knowledgeRecords',
        data: {
          title: `${entryTitle(who)} learns ${page.title}`,
          status: 'planned',
          factId: props.id,
          characterId,
          yearLearned: trimmed === '' ? null : Number(trimmed),
          how,
        },
      });
      undo.record(createCommand('knowledgeRecords', r.entry._id, entryTitle(r.entry)));
      setCharacterId('');
      setYear('');
      setHow('');
      setMessage({
        text: `Recorded. ${entryTitle(who)} now knows this${trimmed ? ` from ${trimmed}` : ''}.`,
        bad: false,
        warnings: r.warnings.map((w) => w.message),
      });
    } catch (err) {
      setMessage({ text: plainError(err), bad: true, warnings: [] });
    }
  };

  if (!page) return <p aria-live="polite">Loading the fact page.</p>;
  return (
    <section className="stack fact-page" aria-label="Fact page" data-testid="fact-page">
      <div className="stack tight" data-testid="fact-knowers">
        <span className="eyebrow">Who knows it</span>
        {page.knowers.length === 0 ? (
          <p className="example-note">Nobody knows this yet.</p>
        ) : (
          <ul className="stack-list">
            {page.knowers.map((k) => (
              <li key={k.recordId} data-record={k.recordId}>
                <button
                  type="button"
                  className="link-btn"
                  onClick={() => props.onOpen('characters', k.characterId)}
                >
                  <Zh text={k.name} actions={false} />
                </button>{' '}
                <span className="example-note">
                  {yearText(k.yearLearned)}
                  {k.chapter ? `, in ${k.chapter}` : ''}
                </span>
                {k.how && (
                  <>
                    <br />
                    <span>{k.how}</span>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="stack tight" data-testid="fact-in-play">
        <span className="eyebrow">Chapters that act on it</span>
        {page.inPlay.length === 0 ? (
          <p className="example-note">No chapter lists this fact in play.</p>
        ) : (
          <ul className="stack-list">
            {page.inPlay.map((p, i) => (
              <li key={i}>
                <button
                  type="button"
                  className="link-btn"
                  onClick={() => props.onOpen('chapters', p.chapterId)}
                >
                  {p.chapter}
                </button>
                : {p.character} acts on it
                {p.note && <span className="example-note"> {p.note}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
      <form className="stack tight" onSubmit={(e) => void record(e)} data-testid="fact-record-form">
        <WriteFieldset className="stack tight">
          <span className="eyebrow">Record who learned it</span>
          <div className="field">
            <label htmlFor={ids.who}>Character</label>
            <select
              id={ids.who}
              value={characterId}
              onChange={(e) => setCharacterId(e.target.value)}
            >
              <option value="">Pick a character</option>
              {[...characters]
                .sort((a, b) => entryTitle(a).localeCompare(entryTitle(b)))
                .map((c) => (
                  <option key={c._id} value={c._id}>
                    {entryTitle(c)}
                  </option>
                ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor={ids.year}>Year learned</label>
            <input
              id={ids.year}
              className="num year-input"
              inputMode="numeric"
              value={year}
              onChange={(e) => setYear(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor={ids.how}>How they learn it</label>
            <input id={ids.how} value={how} onChange={(e) => setHow(e.target.value)} />
          </div>
          <div className="row">
            <button type="submit" className="btn primary small">
              Record who learned it
            </button>
          </div>
        </WriteFieldset>
        {message && (
          <div role="status" data-testid="fact-record-result" className="stack tight">
            <p className={message.bad ? 'callout crit' : 'callout'}>{message.text}</p>
            {message.warnings.map((w) => (
              <p key={w} className="callout warn" data-testid="fact-record-warning">
                {w} It still saved.
              </p>
            ))}
          </div>
        )}
      </form>
    </section>
  );
}
