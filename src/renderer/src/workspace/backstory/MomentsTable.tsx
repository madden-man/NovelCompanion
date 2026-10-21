import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { ageText, eventsNear, insertEventTitle } from '../../../../shared/domain/backstoryGrid';
import type { BackstoryMoment, BackstoryPerson } from '../../../../shared/domain/backstoryGrid';
import { lifeYears } from '../../../../shared/domain/ages';
import type { EventSpan } from '../../../../shared/domain/timeline';
import { span } from '../timeline/common';

export type MomentField = 'year' | 'title' | 'body' | 'worldContext';

const FIELD_LABEL: Record<MomentField, string> = {
  year: 'Year',
  title: 'What happens',
  body: 'How they experience it',
  worldContext: 'Relevant world events',
};

/**
 * SM-9: the picked person's moments in year order, every cell editable in
 * place. A cell saves on blur or Enter (Shift+Enter starts a new line in the
 * longer cells), one write and one undo step per cell. Age is computed (TL-3).
 */
export function MomentsTable(props: {
  person: BackstoryPerson;
  moments: BackstoryMoment[];
  events: EventSpan[];
  selectedId: string | null;
  /** A row to focus on What happens once it shows, after it was made. */
  focusId: string | null;
  readOnly: boolean;
  onFocused: () => void;
  onSelect: (id: string) => void;
  onSave: (id: string, field: MomentField, value: string | number) => Promise<void>;
  onAdd: () => Promise<void>;
  onDelete: (m: BackstoryMoment) => Promise<void>;
}) {
  const { person, moments } = props;
  const table = useRef<HTMLTableElement>(null);
  const headingId = useId();

  useEffect(() => {
    if (!props.focusId) return;
    const cell = table.current?.querySelector<HTMLElement>(
      `tr[data-id="${CSS.escape(props.focusId)}"] [data-field="title"] textarea`,
    );
    if (!cell) return;
    cell.focus();
    props.onFocused();
  }, [props.focusId, moments, props]);

  useEffect(() => {
    if (!props.selectedId) return;
    table.current
      ?.querySelector(`tr[data-id="${CSS.escape(props.selectedId)}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [props.selectedId]);

  return (
    <section className="panel stack tight bs-table-panel" aria-labelledby={headingId}>
      <div className="list-head">
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
        <button
          type="button"
          className="btn small primary"
          disabled={props.readOnly}
          onClick={() => void props.onAdd()}
        >
          Add a moment
        </button>
      </div>
      {moments.length === 0 ? (
        <p className="bs-empty">
          No moments yet. Add one here, or click their row in the grid at a year.
        </p>
      ) : (
        <div className="bs-table-wrap">
          <table className="bs-table" ref={table} data-testid="moments-table">
            <thead>
              <tr>
                <th scope="col" className="bs-col-year">
                  Year
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
                  person={person}
                  events={props.events}
                  selected={props.selectedId === m.id}
                  readOnly={props.readOnly}
                  onSelect={() => props.onSelect(m.id)}
                  onSave={(field, value) => props.onSave(m.id, field, value)}
                  onDelete={() => props.onDelete(m)}
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
  person: BackstoryPerson;
  events: EventSpan[];
  selected: boolean;
  readOnly: boolean;
  onSelect: () => void;
  onSave: (field: MomentField, value: string | number) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const { m } = props;
  const what = m.title.trim() || 'this moment';
  return (
    <tr
      data-id={m.id}
      data-year={m.year}
      className={props.selected ? 'selected' : undefined}
      aria-current={props.selected ? 'true' : undefined}
      onFocusCapture={props.onSelect}
    >
      <td data-field="year" className="bs-col-year">
        <Cell
          kind="year"
          label={`Year of ${what}`}
          value={String(m.year)}
          readOnly={props.readOnly}
          onSave={(v) => props.onSave('year', Number(v))}
        />
        {m.endYear !== null && m.endYear !== m.year && (
          <span className="bs-to num">to {m.endYear}</span>
        )}
      </td>
      <td data-field="age" className="bs-col-age num" data-testid="moment-age">
        {ageText(props.person, m.year)}
      </td>
      <td data-field="title">
        <Cell
          kind="text"
          label={`${FIELD_LABEL.title}, ${span(m.year, m.endYear ?? m.year)}`}
          value={m.title}
          readOnly={props.readOnly}
          onSave={(v) => props.onSave('title', v)}
        />
      </td>
      <td data-field="body">
        <Cell
          kind="text"
          label={`${FIELD_LABEL.body}, ${what}`}
          value={m.body}
          readOnly={props.readOnly}
          onSave={(v) => props.onSave('body', v)}
        />
      </td>
      <td data-field="worldContext">
        <div className="bs-world">
          <Cell
            kind="text"
            label={`${FIELD_LABEL.worldContext}, ${what}`}
            value={m.worldContext}
            readOnly={props.readOnly}
            onSave={(v) => props.onSave('worldContext', v)}
          />
          <EventPicker
            year={m.year}
            events={props.events}
            readOnly={props.readOnly}
            what={what}
            onPick={(title) =>
              props.onSave('worldContext', insertEventTitle(m.worldContext, title))
            }
          />
        </div>
      </td>
      <td className="bs-col-act">
        <button
          type="button"
          className="btn small danger"
          disabled={props.readOnly}
          aria-label={`Delete ${what}, ${span(m.year, m.endYear ?? m.year)}`}
          onClick={() => void props.onDelete()}
        >
          Delete
        </button>
      </td>
    </tr>
  );
}

/** One editable cell: saves on blur or Enter, Escape puts the stored value back. */
function Cell(props: {
  kind: 'year' | 'text';
  label: string;
  value: string;
  readOnly: boolean;
  onSave: (v: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState(props.value);
  const [error, setError] = useState<string | null>(null);
  const focused = useRef(false);
  const errorId = useId();

  // A stored change (a save, an undo, another screen) shows unless the cell is being edited.
  useEffect(() => {
    if (!focused.current) setDraft(props.value);
  }, [props.value]);

  const commit = async () => {
    if (draft === props.value) return;
    if (props.kind === 'year') {
      const t = draft.trim();
      if (!/^-?\d+$/.test(t)) {
        setError('The year is a whole number, such as 2042.');
        return;
      }
    }
    setError(null);
    try {
      await props.onSave(props.kind === 'year' ? draft.trim() : draft);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const onKey = (e: ReactKeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void commit();
    } else if (e.key === 'Escape') {
      setDraft(props.value);
      setError(null);
    }
  };

  const common = {
    'aria-label': props.label,
    'aria-invalid': error ? true : undefined,
    'aria-describedby': error ? errorId : undefined,
    disabled: props.readOnly,
    onFocus: () => {
      focused.current = true;
    },
    onBlur: () => {
      focused.current = false;
      void commit();
    },
    onKeyDown: onKey,
  };

  return (
    <>
      {props.kind === 'year' ? (
        <input
          {...common}
          className="bs-cell bs-cell-year num"
          inputMode="numeric"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
      ) : (
        <textarea
          {...common}
          className="bs-cell"
          rows={Math.min(6, Math.max(2, draft.split('\n').length))}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
      )}
      {error && (
        <span className="bs-cell-error" id={errorId} role="alert">
          {error}
        </span>
      )}
    </>
  );
}

/** A33: the world events of the moment's year plus or minus one; a click inserts a title. */
function EventPicker(props: {
  year: number;
  events: EventSpan[];
  readOnly: boolean;
  what: string;
  onPick: (title: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const near = open ? eventsNear(props.events, props.year) : [];
  const listId = useId();

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
        aria-label={`Pick events from ${props.year - 1} to ${props.year + 1} for ${props.what}`}
        disabled={props.readOnly}
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
          aria-label={`World events from ${props.year - 1} to ${props.year + 1}`}
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
          <span className="bs-picker-head">
            World events, {props.year - 1} to {props.year + 1}
          </span>
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
                  void props.onPick(e.title);
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
