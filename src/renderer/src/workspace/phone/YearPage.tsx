import { useState } from 'react';
import type { LifeState } from '../../../../shared/domain/ages';
import { createCommand } from '../../../../shared/domain/undoRunner';
import { entryTitle } from '../../../../shared/schema';
import type { EntryCollection } from '../../../../shared/schema';
import { call, plainError } from '../../api';
import { useWriteGuard } from '../../connection';
import { useBibleSettings } from '../bibleSettings';
import { openOutline } from '../outline/nav';
import { formatMoment, useStoryTime } from '../storyTime';
import { StateText, span, useYearView } from '../timeline/common';
import { useUndo } from '../undo';
import { Zh } from '../Zh';
import './year.css';

/**
 * A58 U3 (TM-2, KB-2): the year view as a phone page, one column. The year
 * with a step back and forward, the era, everyone with their age or state,
 * the world events of the year and the chapter strands in it. Every item
 * opens its own page; back returns here.
 */
export function YearPage(props: { onOpen: (collection: EntryCollection, id: string) => void }) {
  const story = useStoryTime();
  const undo = useUndo();
  const ro = useWriteGuard();
  const { templates } = useBibleSettings();
  const time = story.time ?? { year: story.year };
  const view = useYearView(time);
  const [error, setError] = useState<string | null>(null);
  const step = (by: number) => story.setYear(time.year + by);

  /** IP-14: a new era from this year, named from the bible's template; one undo step. */
  const addEra = async () => {
    setError(null);
    try {
      const { entry } = await call('entry.create', {
        collection: 'eraStates',
        data: {
          title: templates.eraName,
          name: templates.eraName,
          startYear: time.year,
          endYear: time.year + 9,
        },
      });
      undo.record(createCommand('eraStates', entry._id, entryTitle(entry)));
      props.onOpen('eraStates', entry._id);
    } catch (e) {
      setError(plainError(e));
    }
  };

  return (
    <div className="ph-yearpage" data-testid="year-page">
      <header className="ph-yp-head">
        <button
          type="button"
          className="ph-step"
          aria-label="Back 1 year"
          onClick={() => step(-1)}
          data-testid="year-page-prev"
        >
          -1
        </button>
        <h2 className="ph-yp-year num" data-testid="year-page-year" aria-live="polite">
          {formatMoment(time)}
        </h2>
        <button
          type="button"
          className="ph-step"
          aria-label="Forward 1 year"
          onClick={() => step(1)}
          data-testid="year-page-next"
        >
          +1
        </button>
      </header>
      {error && (
        <p className="callout crit" role="alert">
          {error}
        </p>
      )}

      <section aria-label="Era" data-testid="year-page-era">
        {view?.era ? (
          <button
            type="button"
            className="ph-yp-row ph-yp-era"
            onClick={() => view.era && props.onOpen('eraStates', view.era.id)}
          >
            <span className="ph-yp-name">{view.era.name}</span>
            <span className="ph-yp-side num">{span(view.era.startYear, view.era.endYear)}</span>
          </button>
        ) : view ? (
          <div className="ph-yp-none">
            <span>No era covers {time.year}</span>
            <button
              type="button"
              className="btn"
              disabled={ro.off}
              onClick={() => void addEra()}
              data-testid="year-page-add-era"
            >
              Add an era
            </button>
          </div>
        ) : null}
        {view && view.eras.length > 1 && (
          <p className="callout warn" data-testid="year-page-overlap">
            {view.eras.length} eras cover {view.year}
          </p>
        )}
      </section>

      <section aria-labelledby="yp-people">
        <h3 id="yp-people" className="ph-group">
          Everyone
        </h3>
        <ul className="ph-list" data-testid="year-people">
          {(view?.rows ?? []).map((r) => (
            <li key={r.id}>
              <button
                type="button"
                className="ph-yp-row"
                data-person={r.id}
                data-testid="year-person"
                onClick={() => props.onOpen('characters', r.id)}
              >
                <span className="ph-yp-name">
                  <Zh text={r.name} actions={false} />
                </span>
                <span className="ph-yp-side" data-testid="year-age">
                  {r.state.state === 'alive' ? (
                    <span className="num">{r.state.age}</span>
                  ) : (
                    <StateText state={r.state} />
                  )}
                  {r.state.state === 'alive' && r.state.dyingThisYear && (
                    <span className="ph-yp-sub"> {deathNote(r.state)}</span>
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="yp-events">
        <h3 id="yp-events" className="ph-group">
          World events
        </h3>
        {view && view.events.length === 0 ? (
          <p className="ph-yp-empty">None in {time.year}</p>
        ) : (
          <ul className="ph-list" data-testid="year-events">
            {(view?.events ?? []).map((e) => (
              <li key={e.id}>
                <button
                  type="button"
                  className={`ph-yp-row${e.formative ? ' formative' : ''}`}
                  data-testid="year-event"
                  onClick={() => props.onOpen('worldEvents', e.id)}
                >
                  <span className="ph-yp-name">{e.title}</span>
                  <span className="ph-yp-side num">{span(e.startYear, e.endYear)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="yp-strands">
        <h3 id="yp-strands" className="ph-group">
          Chapter strands
        </h3>
        {view && view.strands.length === 0 ? (
          <p className="ph-yp-empty">None in {time.year}</p>
        ) : (
          <ul className="ph-list" data-testid="year-strands">
            {(view?.strands ?? []).map((s) => (
              <li key={`${s.chapterId}|${s.strandId}`}>
                <button
                  type="button"
                  className="ph-yp-row"
                  data-testid="year-strand"
                  onClick={() => openOutline(s.chapterId)}
                >
                  <span className="ph-yp-name">
                    {s.number ?? '?'}. {s.chapterTitle}
                  </span>
                  <span className="ph-yp-side">
                    {s.label}
                    {s.primary ? ', primary' : ''}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function deathNote(s: LifeState): string {
  return s.state === 'alive' && s.dyingThisYear ? 'dies this year' : '';
}
