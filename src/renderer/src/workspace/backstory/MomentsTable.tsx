import { useEffect, useId, useRef, useState } from 'react';
import { ageText } from '../../../../shared/domain/backstoryGrid';
import type { BackstoryMoment, BackstoryPerson } from '../../../../shared/domain/backstoryGrid';
import { lifeYears } from '../../../../shared/domain/ages';
import { useWriteGuard } from '../../connection';
import { span } from '../timeline/common';
import type { EditableOption } from '../editable';

export type MomentField = 'year' | 'endYear' | 'title' | 'body' | 'worldContext' | 'characterId';

/**
 * SM-9, IP-13, A49: moments in year order, one line each (the years, whose
 * moment it is, their age and what happens), and a line opens the moment
 * across the screen in `MomentDialog`, where every field is edited. With a
 * person picked the list is theirs; with none it lists every moment, by year
 * and then person, and New moment asks whose it is. Age is computed (TL-3).
 * While a snapshot is open read-only (ARCH-6) the controls that write are
 * off with the reason; opening a moment still works.
 */
export function MomentsTable(props: {
  /** The picked person, or null for every moment (IP-13). */
  person: BackstoryPerson | null;
  /** Everyone, in the grid's order: the "Whose moment" choices and each line's age. */
  people: readonly BackstoryPerson[];
  moments: BackstoryMoment[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Open a moment across the screen (A49). */
  onOpen: (id: string) => void;
  /** A new moment for the person at the story year. */
  onAdd: (characterId: string) => Promise<void>;
  /** Back to every moment (IP-13). */
  onShowAll: () => void;
}) {
  const { person, moments } = props;
  const ro = useWriteGuard();
  const table = useRef<HTMLTableElement>(null);
  const headingId = useId();
  const whoId = useId();
  const [asking, setAsking] = useState(false);
  const whoBox = useRef<HTMLSelectElement>(null);
  useEffect(() => {
    if (asking) whoBox.current?.focus({ preventScroll: true });
  }, [asking]);
  const byId = new Map(props.people.map((p) => [p.id, p]));
  const options: EditableOption[] = props.people.map((p) => ({
    value: p.id,
    label: p.chinese ? `${p.name} ${p.chinese}` : p.name,
  }));

  useEffect(() => {
    if (!props.selectedId) return;
    table.current
      ?.querySelector(`tr[data-id="${CSS.escape(props.selectedId)}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [props.selectedId]);

  return (
    <section
      className="panel stack tight bs-table-panel"
      aria-labelledby={headingId}
      data-testid={person ? 'moments-panel' : 'all-moments'}
    >
      <div className="list-head">
        {person ? (
          <h3 id={headingId} data-testid="moments-heading">
            {person.name}
            {person.chinese && (
              <span className="bs-zh" lang="zh">
                {' '}
                {person.chinese}
              </span>
            )}
            <span className="bs-years">, {lifeYears(person)}</span>
          </h3>
        ) : (
          <h3 id={headingId} data-testid="moments-heading">
            Every moment
            <span className="bs-years">
              , {moments.length === 1 ? '1 moment' : `${moments.length} moments`}
            </span>
          </h3>
        )}
        {person ? (
          <span className="row tight">
            <button
              type="button"
              className="btn small primary"
              disabled={ro.off}
              {...ro.tip}
              onClick={() => void props.onAdd(person.id)}
            >
              Add a moment
            </button>
            <button type="button" className="btn small" onClick={props.onShowAll}>
              Show every moment
            </button>
          </span>
        ) : asking ? (
          <span className="row tight bs-ask">
            <label htmlFor={whoId}>Whose moment</label>
            <select
              id={whoId}
              ref={whoBox}
              defaultValue=""
              disabled={ro.off}
              onChange={(e) => {
                const id = e.target.value;
                if (!id) return;
                setAsking(false);
                void props.onAdd(id);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault();
                  setAsking(false);
                }
              }}
            >
              <option value="" disabled>
                Pick the person
              </option>
              {options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <button type="button" className="btn small" onClick={() => setAsking(false)}>
              Cancel
            </button>
          </span>
        ) : (
          <button
            type="button"
            className="btn small primary"
            disabled={ro.off}
            {...ro.tip}
            onClick={() => setAsking(true)}
          >
            New moment
          </button>
        )}
      </div>
      {!person && <p className="bs-empty">Pick a person in the grid to list only their moments.</p>}
      {moments.length === 0 ? (
        <p className="bs-empty">
          {person
            ? 'No moments yet. Add one here, or click their row in the grid at a year.'
            : 'No moments yet. Make one with New moment, or click a row in the grid at a year.'}
        </p>
      ) : (
        <div className="bs-table-wrap">
          <table className="bs-table" ref={table} data-testid="moments-table">
            <thead>
              <tr>
                <th scope="col" className="bs-col-year">
                  Year
                </th>
                <th scope="col" className="bs-col-who">
                  Whose moment
                </th>
                <th scope="col" className="bs-col-age">
                  Age
                </th>
                <th scope="col">What happens</th>
              </tr>
            </thead>
            <tbody>
              {moments.map((m) => (
                <MomentLine
                  key={m.id}
                  m={m}
                  person={byId.get(m.characterId) ?? null}
                  selected={props.selectedId === m.id}
                  onSelect={() => props.onSelect(m.id)}
                  onOpen={() => props.onOpen(m.id)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** One line of the list: a click anywhere on it, or Enter on its title, opens the moment. */
function MomentLine(props: {
  m: BackstoryMoment;
  person: BackstoryPerson | null;
  selected: boolean;
  onSelect: () => void;
  onOpen: () => void;
}) {
  const { m, person } = props;
  const title = m.title.trim();
  return (
    <tr
      data-id={m.id}
      data-year={m.year}
      data-person={m.characterId}
      className={props.selected ? 'selected' : undefined}
      aria-current={props.selected ? 'true' : undefined}
      onFocusCapture={props.onSelect}
      onClick={props.onOpen}
    >
      <td data-field="year" className="bs-col-year num">
        {span(m.year, m.endYear ?? m.year)}
      </td>
      <td data-field="characterId" className="bs-col-who">
        {person ? (
          <>
            {person.name}
            {person.chinese && (
              <span className="bs-zh" lang="zh">
                {' '}
                {person.chinese}
              </span>
            )}
          </>
        ) : (
          'Unknown'
        )}
      </td>
      <td data-field="age" className="bs-col-age num" data-testid="moment-age">
        {person ? ageText(person, m.year) : 'Unknown'}
      </td>
      <td data-field="title">
        <button type="button" className="bs-open">
          {title || <span className="is-placeholder">Add what happens</span>}
        </button>
      </td>
    </tr>
  );
}
