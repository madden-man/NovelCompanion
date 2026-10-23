import { useEffect, useId, useState } from 'react';
import type { Response } from '../../../../shared/ipc';
import { call } from '../../api';
import { useEntries, useStore } from '../data';
import { span } from './common';

type Lived = Response<'timeline.livedThrough'>;

/**
 * TL-5: the world events one character has lived through by a year, with
 * their age at each. Shown in the year dialog's "Lived through" disclosure.
 */
export function LivedThrough({
  year,
  onOpenPerson,
}: {
  year: number;
  /** IP-5: the name opens the person's page. */
  onOpenPerson?: (id: string) => void;
}) {
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
    <div className="stack tight" data-testid="lived-through">
      <p className="example-note">
        World events inside the character&rsquo;s lifetime up to {year}, with their age at each.
        Formative events reach every session selection for that character.
      </p>
      <div className="row tight year-person-pick">
        <div className="field">
          <label htmlFor={id}>Lived through by</label>
          <select id={id} value={chosen} onChange={(e) => setWho(e.target.value)}>
            {characters.map((c) => (
              <option key={c._id} value={c._id}>
                {name(c._id)}
              </option>
            ))}
          </select>
        </div>
        {chosen && onOpenPerson && (
          <button
            type="button"
            className="link-btn"
            data-testid="lived-person"
            onClick={() => onOpenPerson(chosen)}
          >
            Open {name(chosen)}
          </button>
        )}
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
                  <td>{e.formative && <span className="chip now">formative</span>}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
