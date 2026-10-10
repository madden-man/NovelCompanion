import { useEffect, useId, useState } from 'react';
import type { Response } from '../../../../shared/ipc';
import { call } from '../../api';
import { useEntries, useStore } from '../data';
import { formatMoment, useStoryTime } from '../storyTime';
import { Zh } from '../Zh';
import { FamilyChips, StateText, span, useFamilies, useYearView } from './common';

type Lived = Response<'timeline.livedThrough'>;

/**
 * The year view (TL-2 to TL-5): every character's state at the current story
 * time, and the world events one character has lived through by then. All of
 * it is computed in code from the read model (TL-1).
 */
export function YearView() {
  const story = useStoryTime();
  const time = story.time ?? { year: story.year };
  const view = useYearView(time);
  const families = useFamilies();
  return (
    <section className="ws-wide stack" aria-labelledby="year-title" data-testid="year-view">
      <div className="list-head">
        <h2 id="year-title">
          Who is alive in <span className="num">{formatMoment(time)}</span>
        </h2>
        <button type="button" className="btn small" onClick={story.openDialog}>
          Change the story time
        </button>
      </div>
      <p className="example-note">
        With a birth year only, age is the year minus the birth year. With full dates, age is exact
        for the date. In the year of their death a character is alive and flagged. An unknown birth
        is never estimated.
      </p>
      <div className="table-wrap">
        <table className="compact state-table" data-testid="year-table">
          <thead>
            <tr>
              <th scope="col">Character</th>
              <th scope="col">Family</th>
              <th scope="col">State</th>
              <th scope="col">Age</th>
            </tr>
          </thead>
          <tbody>
            {(view?.rows ?? []).map((r) => (
              <tr key={r.id} data-person={r.id}>
                <td>
                  <Zh text={r.name} /> {r.chinese && <Zh text={r.chinese} />}
                </td>
                <td>
                  <FamilyChips ids={r.familyIds} families={families} />
                </td>
                <td>
                  <StateText state={r.state} />
                </td>
                <td className="num" data-testid="year-age">
                  {r.state.state === 'alive'
                    ? r.state.age
                    : r.state.state === 'dead'
                      ? `died ${r.state.deathYear}`
                      : r.state.state === 'unborn'
                        ? `born ${r.state.birthYear}`
                        : 'unknown'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <LivedThrough year={time.year} />
    </section>
  );
}

function LivedThrough({ year }: { year: number }) {
  const { version } = useStore();
  const characters = useEntries('characters');
  const [who, setWho] = useState('');
  const [lived, setLived] = useState<Lived | null>(null);
  const id = useId();
  const chosen = who || characters[0]?._id || '';

  useEffect(() => {
    if (!chosen) return;
    let live = true;
    void call('timeline.livedThrough', { characterId: chosen, year }).then((r) => {
      if (live) setLived(r);
    });
    return () => {
      live = false;
    };
  }, [chosen, year, version]);

  const name = (cid: string) => {
    const c = characters.find((x) => x._id === cid);
    return String((c?.names as { full?: string } | undefined)?.full ?? c?.title ?? cid);
  };

  return (
    <section className="stack" aria-labelledby={`${id}-title`} data-testid="lived-through">
      <h3 id={`${id}-title`}>Events a character has lived through by {year}</h3>
      <p className="example-note">
        World events inside the character&rsquo;s lifetime up to the story year, with their age at
        each. Formative events reach every brief for that character.
      </p>
      <div className="field">
        <label htmlFor={id}>Character</label>
        <select id={id} value={chosen} onChange={(e) => setWho(e.target.value)}>
          {characters.map((c) => (
            <option key={c._id} value={c._id}>
              {name(c._id)}
            </option>
          ))}
        </select>
      </div>
      <div className="table-wrap">
        <table className="compact" data-testid="lived-table">
          <thead>
            <tr>
              <th scope="col">Year</th>
              <th scope="col">Age</th>
              <th scope="col">Event</th>
              <th scope="col">Category</th>
              <th scope="col">Formative</th>
            </tr>
          </thead>
          <tbody>
            {lived && lived.characterId === chosen && !lived.birthKnown && (
              <tr>
                <td colSpan={5}>
                  {name(chosen)} has no known birth year, so the events they lived through cannot be
                  worked out.
                </td>
              </tr>
            )}
            {lived && lived.characterId === chosen && lived.birthKnown && !lived.events.length && (
              <tr>
                <td colSpan={5}>
                  No world event in {name(chosen)}&rsquo;s lifetime up to {year}.
                </td>
              </tr>
            )}
            {lived?.characterId === chosen &&
              lived.events.map((e) => (
                <tr key={e.id} data-event={e.id}>
                  <td className="num">{span(e.startYear, e.endYear)}</td>
                  <td className="num">{e.age}</td>
                  <td>{e.title}</td>
                  <td>{e.categoryPath}</td>
                  <td>{e.formative && <span className="chip canon">formative</span>}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
