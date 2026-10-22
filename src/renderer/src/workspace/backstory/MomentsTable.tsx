import { useEffect, useId, useRef, useState } from 'react';
import { ageText, eventsNear } from '../../../../shared/domain/backstoryGrid';
import type { BackstoryMoment, BackstoryPerson } from '../../../../shared/domain/backstoryGrid';
import { lifeYears } from '../../../../shared/domain/ages';
import type { EventSpan } from '../../../../shared/domain/timeline';
import { useWriteGuard } from '../../connection';
import { TrashControls } from '../editor';
import { span } from '../timeline/common';
import { Editable } from '../editable';
import type { EditableOption } from '../editable';
import { useBibleSettings } from '../bibleSettings';
import { useLookup } from '../pickers';

export type MomentField = 'year' | 'endYear' | 'title' | 'body' | 'worldContext' | 'characterId';

/**
 * SM-9, IP-1, IP-13: moments in year order, every stored value an `Editable`
 * in place: a cell opens on a click, Enter or Space, saves on Enter or blur as
 * one write and one undo step, and Escape puts the stored value back. With a
 * person picked the table lists theirs; with none it lists every moment, by
 * year and then person, and New moment asks whose it is. "Whose moment" moves
 * a moment to another person. Age is computed (TL-3). Delete lists what links
 * to the moment first (ED-5). While a snapshot is open read-only (ARCH-6)
 * every control is off with the reason.
 */
export function MomentsTable(props: {
  /** The picked person, or null for every moment (IP-13). */
  person: BackstoryPerson | null;
  /** Everyone, in the grid's order: the "Whose moment" choices and each row's age. */
  people: readonly BackstoryPerson[];
  moments: BackstoryMoment[];
  events: EventSpan[];
  selectedId: string | null;
  /** A row whose What happens opens as a field once it shows, after it was made. */
  focusId: string | null;
  onFocused: () => void;
  onSelect: (id: string) => void;
  onSave: (
    id: string,
    field: MomentField,
    value: string | number | null,
    mentioned?: readonly string[],
  ) => Promise<void>;
  /** IP-4, ED-9: a world event mentioned in the moment's Relevant world events. */
  onMention: (id: string, event: { id: string; title: string }) => Promise<void>;
  /** A new moment for the person at the story year. */
  onAdd: (characterId: string) => Promise<void>;
  /** A moment went to the trash through the confirm; the view offers Undo. */
  onTrashed: (m: BackstoryMoment) => void;
  /** Back to every moment (IP-13). */
  onShowAll: () => void;
}) {
  const { person, moments, focusId, onFocused } = props;
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
    if (focusId && moments.some((m) => m.id === focusId)) onFocused();
  }, [focusId, moments, onFocused]);

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
                <th scope="col" className="bs-col-year">
                  To
                </th>
                <th scope="col" className="bs-col-who">
                  Whose moment
                </th>
                <th scope="col" className="bs-col-age">
                  Age
                </th>
                <th scope="col">What happens</th>
                <th scope="col">How they experience it</th>
                <th scope="col">Relevant world events</th>
                <th scope="col" className="bs-col-act">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {moments.map((m) => (
                <MomentRow
                  key={m.id}
                  m={m}
                  person={byId.get(m.characterId) ?? null}
                  options={options}
                  events={props.events}
                  selected={props.selectedId === m.id}
                  fresh={focusId === m.id}
                  onSelect={() => props.onSelect(m.id)}
                  onSave={(field, value, mentioned) => props.onSave(m.id, field, value, mentioned)}
                  onMention={(e) => props.onMention(m.id, e)}
                  onTrashed={() => props.onTrashed(m)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function MomentRow(props: {
  m: BackstoryMoment;
  person: BackstoryPerson | null;
  options: EditableOption[];
  events: EventSpan[];
  selected: boolean;
  /** Just made: What happens opens as a field. */
  fresh: boolean;
  onSelect: () => void;
  onSave: (
    field: MomentField,
    value: string | number | null,
    mentioned?: readonly string[],
  ) => Promise<void>;
  onMention: (e: { id: string; title: string }) => Promise<void>;
  onTrashed: () => void;
}) {
  const { m } = props;
  // ED-9: the linked entries' titles show as chips; an `@` pick links in the save that follows.
  const found = useLookup(m.linkIds);
  const titles = m.linkIds.flatMap((id) => found.get(id)?.title ?? []);
  const picked = useRef<string[]>([]);
  const what = m.title.trim() || 'this moment';
  return (
    <tr
      data-id={m.id}
      data-year={m.year}
      data-person={m.characterId}
      className={props.selected ? 'selected' : undefined}
      aria-current={props.selected ? 'true' : undefined}
      onFocusCapture={props.onSelect}
    >
      <td data-field="year" className="bs-col-year">
        <Editable
          kind="year"
          className="bs-ed num"
          data-field="year"
          label={`Year of ${what}`}
          value={m.year}
          onSave={(v) => props.onSave('year', v)}
        />
      </td>
      <td data-field="endYear" className="bs-col-year">
        <Editable
          kind="year"
          className="bs-ed num"
          data-field="endYear"
          allowEmpty
          placeholder="Same year"
          label={`To, the last year of ${what}, blank for a single year`}
          value={m.endYear}
          onSave={(v) => props.onSave('endYear', v)}
        />
      </td>
      <td data-field="characterId" className="bs-col-who">
        <Editable
          kind="select"
          className="bs-ed"
          data-field="characterId"
          label={`Whose moment, ${what}`}
          options={props.options}
          value={m.characterId}
          onSave={(v) => (v ? props.onSave('characterId', v) : Promise.resolve())}
        />
      </td>
      <td data-field="age" className="bs-col-age num" data-testid="moment-age">
        {props.person ? ageText(props.person, m.year) : 'Unknown'}
      </td>
      <td data-field="title">
        <Editable
          kind="text"
          className="bs-ed"
          data-field="title"
          label={`What happens, ${span(m.year, m.endYear ?? m.year)}`}
          placeholder="Add what happens"
          value={m.title}
          autoOpen={props.fresh}
          onSave={(v) => props.onSave('title', v)}
        />
      </td>
      <td data-field="body">
        <Editable
          kind="rich"
          className="bs-ed"
          data-field="body"
          mode="inline"
          size="quick"
          label={`How they experience it, ${what}`}
          placeholder="Add how they experience it"
          value={m.body}
          onSave={(v) => props.onSave('body', v)}
        />
      </td>
      <td data-field="worldContext">
        <div className="bs-world">
          <Editable
            kind="rich"
            className="bs-ed"
            data-field="worldContext"
            mode="inline"
            size="quick"
            label={`Relevant world events, ${what}`}
            placeholder="Add the world events"
            value={m.worldContext}
            mentionTitles={titles}
            onMention={(hit) => {
              if (!picked.current.includes(hit.id)) picked.current.push(hit.id);
            }}
            onSave={async (v) => {
              await props.onSave('worldContext', v, picked.current);
              picked.current = [];
            }}
          />
          <EventPicker year={m.year} events={props.events} what={what} onPick={props.onMention} />
        </div>
      </td>
      <td className="bs-col-act">
        <TrashControls
          collection="moments"
          id={m.id}
          title={m.title.trim() || `the moment of ${m.year}`}
          inTrash={false}
          label="Delete"
          beforeDelete={async () => undefined}
          onChanged={props.onTrashed}
        />
      </td>
    </tr>
  );
}

/**
 * A33, IP-4: the world events within the bible's picker reach of the moment's
 * year; a click mentions the event (`@Title`, ED-9) in Relevant world events.
 */
function EventPicker(props: {
  year: number;
  events: EventSpan[];
  what: string;
  onPick: (e: { id: string; title: string }) => Promise<void>;
}) {
  const ro = useWriteGuard();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const { pickerReach } = useBibleSettings().numbers;
  const near = open ? eventsNear(props.events, props.year, pickerReach) : [];
  const listId = useId();
  const from = props.year - pickerReach;
  const to = props.year + pickerReach;
  const years = span(from, to);

  useEffect(() => {
    if (open) list.current?.querySelector<HTMLElement>('button')?.focus();
  }, [open]);

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };

  return (
    <div className="bs-picker">
      <button
        ref={button}
        type="button"
        className="btn small"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={`Pick events from ${years} for ${props.what}`}
        disabled={ro.off}
        title={ro.tip.title}
        aria-describedby={ro.tip['aria-describedby']}
        onClick={() => setOpen((o) => !o)}
      >
        Pick events
      </button>
      {open && (
        <div
          id={listId}
          ref={list}
          className="bs-picker-list"
          role="group"
          aria-label={`World events from ${years}`}
          data-testid="event-picker"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              close(true);
            }
          }}
          onBlur={(e) => {
            const to = e.relatedTarget as Node | null;
            if (!to || !e.currentTarget.parentElement?.contains(to)) close(false);
          }}
        >
          <span className="bs-picker-head">World events, {years}</span>
          {near.length === 0 ? (
            <p className="bs-empty" tabIndex={-1}>
              No world events in these years.
            </p>
          ) : (
            near.map((e) => (
              <button
                key={e.id}
                type="button"
                className="bs-picker-item"
                data-id={e.id}
                onClick={() => {
                  void props.onPick({ id: e.id, title: e.title }).catch(() => undefined);
                  close(true);
                }}
              >
                <span className="num">{span(e.startYear, e.endYear)}</span> {e.title}
              </button>
            ))
          )}
          <button type="button" className="btn small" onClick={() => close(true)}>
            Close
          </button>
        </div>
      )}
    </div>
  );
}
