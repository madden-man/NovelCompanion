import { useEffect, useId, useRef, useState } from 'react';
import { ageText, eventsNear } from '../../../../shared/domain/backstoryGrid';
import type { BackstoryMoment, BackstoryPerson } from '../../../../shared/domain/backstoryGrid';
import type { EventSpan } from '../../../../shared/domain/timeline';
import { useWriteGuard } from '../../connection';
import { TrashControls } from '../editor';
import { Editable } from '../editable';
import type { EditableOption } from '../editable';
import { useBibleSettings } from '../bibleSettings';
import { useFocusTrap } from '../focusTrap';
import { useLookup } from '../pickers';
import { span } from '../timeline/common';
import type { MomentField } from './MomentsTable';

/**
 * A49: one moment across the whole screen. The list under the grid names each
 * moment on a line; opening one shows every field of it here with room to
 * read and write: the years, whose moment it is and their age on one line,
 * then What happens, How they experience it and Relevant world events as
 * full boxes, Pick events beside the last, and Delete at the foot. Every
 * field is an `Editable` (IP-1): one write and one undo step per save.
 * Escape or Close puts focus back on the line it opened from. A field that
 * is open takes Escape first (it reverts the field), so one Escape never
 * both reverts and closes.
 */
export function MomentDialog(props: {
  m: BackstoryMoment;
  person: BackstoryPerson | null;
  /** Everyone, in the grid's order: the "Whose moment" choices. */
  options: readonly EditableOption[];
  events: EventSpan[];
  /** Just made: What happens opens as a field. */
  fresh: boolean;
  onSave: (
    field: MomentField,
    value: string | number | null,
    mentioned?: readonly string[],
  ) => Promise<void>;
  onMention: (e: { id: string; title: string }) => Promise<void>;
  onTrashed: () => void;
  onClose: () => void;
}) {
  const { m, person, fresh, onClose } = props;
  const root = useRef<HTMLDivElement>(null);
  // Read as the dialog first renders, before a fresh moment's title field takes focus.
  const [opener] = useState(() => document.activeElement);
  const titleId = useId();
  useFocusTrap(root);

  // ED-9: the linked entries' titles show as chips; an `@` pick links in the save that follows.
  const found = useLookup(m.linkIds);
  const titles = m.linkIds.flatMap((id) => found.get(id)?.title ?? []);
  const picked = useRef<string[]>([]);
  const what = m.title.trim() || 'this moment';
  const when = span(m.year, m.endYear ?? m.year);

  // Focus lands on the first field, or in What happens for a moment just made (autoOpen);
  // on close it goes back to the line the moment opened from.
  useEffect(() => {
    if (!fresh) {
      root.current
        ?.querySelector<HTMLElement>('[data-field="year"] .editable-text')
        ?.focus({ preventScroll: true });
    }
    // Escape closes from anywhere, the body included; an open field, the picker and the
    // trash confirm stop the key first, so Escape there reverts or closes only that.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (opener instanceof HTMLElement && opener.isConnected)
        opener.focus({ preventScroll: true });
    };
    // Once per moment shown (`onClose` is stable); `fresh` only matters when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [m.id, onClose]);

  return (
    <div
      className="overlay bs-moment-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={root}
        className="dialog stack bs-moment-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid="moment-dialog"
        data-id={m.id}
      >
        <header className="dialog-head">
          <h2 id={titleId} data-testid="moment-dialog-heading">
            {person ? person.name : 'A moment'}
            {person?.chinese && (
              <span className="bs-zh" lang="zh">
                {' '}
                {person.chinese}
              </span>
            )}
            <span className="bs-years">, {when}</span>
          </h2>
          <button type="button" className="btn small" onClick={onClose}>
            Close
          </button>
        </header>
        <div className="bs-moment-when">
          <Editable
            kind="year"
            showLabel
            className="num"
            data-field="year"
            label="Year"
            value={m.year}
            onSave={(v) => props.onSave('year', v)}
          />
          <Editable
            kind="year"
            showLabel
            className="num"
            data-field="endYear"
            allowEmpty
            placeholder="Same year"
            label="To"
            value={m.endYear}
            onSave={(v) => props.onSave('endYear', v)}
          />
          <Editable
            kind="select"
            showLabel
            data-field="characterId"
            label="Whose moment"
            options={props.options}
            value={m.characterId}
            onSave={(v) => (v ? props.onSave('characterId', v) : Promise.resolve())}
          />
          <span className="editable-labelled bs-moment-age">
            <span className="editable-label">Age</span>
            <span className="num" data-testid="moment-age">
              {person ? ageText(person, m.year) : 'Unknown'}
            </span>
          </span>
        </div>
        <section className="stack tight bs-moment-field">
          <h3>What happens</h3>
          <Editable
            kind="text"
            layout="block"
            className="bs-moment-title"
            data-field="title"
            label={`What happens, ${when}`}
            placeholder="Add what happens"
            value={m.title}
            autoOpen={fresh}
            onSave={(v) => props.onSave('title', v)}
          />
        </section>
        <section className="stack tight bs-moment-field">
          <h3>How they experience it</h3>
          <Editable
            kind="rich"
            data-field="body"
            mode="full"
            size="prose"
            label={`How they experience it, ${what}`}
            placeholder="Add how they experience it"
            value={m.body}
            onSave={(v) => props.onSave('body', v)}
          />
        </section>
        <section className="stack tight bs-moment-field">
          <h3>Relevant world events</h3>
          <div className="bs-world">
            <Editable
              kind="rich"
              data-field="worldContext"
              mode="full"
              size="prose"
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
        </section>
        <footer className="bs-moment-foot">
          <TrashControls
            collection="moments"
            id={m.id}
            title={m.title.trim() || `the moment of ${m.year}`}
            inTrash={false}
            label="Delete"
            beforeDelete={async () => undefined}
            onChanged={props.onTrashed}
          />
        </footer>
      </div>
    </div>
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
