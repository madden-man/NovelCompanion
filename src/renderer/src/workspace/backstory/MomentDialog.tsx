import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { ageText, eventsNear } from '../../../../shared/domain/backstoryGrid';
import type { BackstoryMoment, BackstoryPerson } from '../../../../shared/domain/backstoryGrid';
import type { EventSpan } from '../../../../shared/domain/timeline';
import { useWriteGuard } from '../../connection';
import { TrashControls } from '../editor';
import { span } from '../timeline/common';
import { Editable } from '../editable';
import type { EditableOption } from '../editable';
import { useBibleSettings } from '../bibleSettings';
import { useLookup } from '../pickers';
import { useFocusTrap } from '../focusTrap';

export type MomentField = 'year' | 'endYear' | 'title' | 'body' | 'worldContext' | 'characterId';

type SaveField = (
  field: MomentField,
  value: string | number | null,
  mentioned?: readonly string[],
) => Promise<void>;

/** How soon after the dialog opens a second press still counts as the marker's double-click. */
const DOUBLE_CLICK_MS = 800;

/** "Name 中文", the way the "Whose moment" choices and the dialog's head name a person. */
export function personLabel(p: BackstoryPerson): string {
  return p.chinese ? `${p.name} ${p.chinese}` : p.name;
}

/** TL-3: "age 39", or the state in words when there is no age that year. */
function ageWords(p: BackstoryPerson, year: number): string {
  const age = ageText(p, year);
  return /^\d+$/.test(age) ? `age ${age}` : age.charAt(0).toLowerCase() + age.slice(1);
}

/**
 * SM-9, IP-1, A49: one moment in a modal over the grid. Every stored value is
 * an `Editable`: a field opens on a click, Enter or Space, saves on Enter or
 * blur as one write and one undo step (ED-3), and Escape puts the stored value
 * back. An Escape that no open field takes closes the dialog, and the focus
 * goes back to where it was (the marker). Previous and Next walk the person's
 * moments in year order without closing. "Whose moment" moves the moment to
 * another person; the age is computed (TL-3). Delete lists what links to the
 * moment first (ED-5). While a snapshot is open read-only (ARCH-6) the fields
 * and Delete are off with the reason; Previous, Next and Close still work.
 */
export function MomentDialog(props: {
  moment: BackstoryMoment;
  /** The moment's person, or null when the character is gone. */
  person: BackstoryPerson | null;
  /** Everyone, in the grid's order: the "Whose moment" choices. */
  people: readonly BackstoryPerson[];
  events: EventSpan[];
  onSave: SaveField;
  /** IP-4, ED-9: a world event mentioned in the moment's Relevant world events. */
  onMention: (event: { id: string; title: string }) => Promise<void>;
  /** The moment went to the trash through the confirm; the view offers Undo. */
  onTrashed: () => void;
  onClose: () => void;
  /** The person's moment before and after this one by year, or null at either end. */
  onPrev: (() => void) | null;
  onNext: (() => void) | null;
  /** Just made: What happens opens as a field on the first render. */
  fresh: boolean;
}) {
  const { moment: m, person, onClose } = props;
  const dialogRef = useRef<HTMLDivElement>(null);
  const prevRef = useRef<HTMLButtonElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  useFocusTrap(dialogRef);
  // Read while rendering the first time, before a field that opens at once takes the focus.
  const [opener] = useState(() => document.activeElement);
  // The host may pass a new function each render; the listener and the focus hand-back stay put.
  const shown = useRef(m);
  const closeRef = useRef(onClose);
  useLayoutEffect(() => {
    shown.current = m;
    closeRef.current = onClose;
  });

  const openedAt = useRef(0);
  useEffect(() => {
    openedAt.current = performance.now();
    const root = dialogRef.current;
    // A fresh moment's What happens has the focus already; otherwise start on it, closed.
    if (root && !root.contains(document.activeElement)) {
      root.querySelector<HTMLElement>('.editable[data-field="title"] > .editable-text')?.focus();
    }
    // An open field takes its own Escape and stops it (IP-1), so only one no field took gets here.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      closeRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      // Focus that left with the dialog goes back: to the moment's marker when a marker opened
      // it (Previous and Next may have moved on), else to the opener, else to the person's row.
      const now = document.activeElement;
      if (now && now !== document.body) return;
      const last = shown.current;
      const marker = document.querySelector<HTMLElement>(
        `[data-testid="backstory-grid"] .wg-marker[data-id="${CSS.escape(last.id)}"]`,
      );
      const back =
        (opener instanceof HTMLElement && opener.classList.contains('wg-marker') && marker) ||
        (opener instanceof HTMLElement && opener.isConnected ? opener : null) ||
        marker ||
        document.querySelector<HTMLElement>(
          `.bs-row[data-person="${CSS.escape(last.characterId)}"] .bs-row-label`,
        );
      back?.focus({ preventScroll: true });
    };
  }, [opener]);

  // A step to the first or the last moment turns its own button off; the focus moves to the other.
  const stepped = useRef<'prev' | 'next' | null>(null);
  useEffect(() => {
    if (stepped.current === 'prev' && !props.onPrev) nextRef.current?.focus();
    if (stepped.current === 'next' && !props.onNext) prevRef.current?.focus();
    stepped.current = null;
  }, [m.id, props.onPrev, props.onNext]);

  const years = span(m.year, m.endYear ?? m.year);
  const who = person ? `${personLabel(person)}, ${years}, ${ageWords(person, m.year)}` : years;
  return (
    <div
      className="overlay"
      onMouseDownCapture={(e) => {
        // IP-4: a double-click on a marker renames it. Its first press opened the dialog, so the
        // second lands here, on whatever of the dialog is drawn over the marker; it goes to the
        // marker instead, and the dialog closes.
        if (e.detail < 2 || !(opener instanceof HTMLElement) || !opener.isConnected) return;
        if (!opener.classList.contains('wg-marker')) return;
        if (performance.now() - openedAt.current > DOUBLE_CLICK_MS) return;
        e.preventDefault();
        e.stopPropagation();
        closeRef.current();
        opener.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      }}
      onMouseDown={(e) => {
        if (e.target !== e.currentTarget) return;
        // The press closes the dialog and moves no focus; the hand-back below places it.
        e.preventDefault();
        onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="dialog stack bs-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid="moment-dialog"
        data-id={m.id}
        data-person={m.characterId}
      >
        <header className="dialog-head bs-dialog-head">
          <div className="stack tight bs-dialog-title">
            <h2 id={titleId} data-testid="moment-title">
              {m.title.trim() || 'Untitled moment'}
            </h2>
            <span className="bs-dialog-who" data-testid="moment-who">
              {who}
            </span>
          </div>
          <span className="row tight">
            <button
              ref={prevRef}
              type="button"
              className="btn small"
              disabled={!props.onPrev}
              onClick={() => {
                stepped.current = 'prev';
                props.onPrev?.();
              }}
            >
              Previous
            </button>
            <button
              ref={nextRef}
              type="button"
              className="btn small"
              disabled={!props.onNext}
              onClick={() => {
                stepped.current = 'next';
                props.onNext?.();
              }}
            >
              Next
            </button>
            <button type="button" className="btn small" onClick={onClose}>
              Close
            </button>
          </span>
        </header>
        {/* Keyed by the moment, so Previous and Next start every field closed on the new one. */}
        <MomentFields key={m.id} {...props} />
        <footer className="row bs-dialog-foot">
          <TrashControls
            collection="moments"
            id={m.id}
            title={m.title.trim() || `the moment of ${m.year}`}
            inTrash={false}
            label="Delete"
            beforeDelete={async () => undefined}
            onChanged={props.onTrashed}
          />
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        </footer>
      </div>
    </div>
  );
}

function MomentFields(props: {
  moment: BackstoryMoment;
  person: BackstoryPerson | null;
  people: readonly BackstoryPerson[];
  events: EventSpan[];
  fresh: boolean;
  onSave: SaveField;
  onMention: (event: { id: string; title: string }) => Promise<void>;
}) {
  const { moment: m } = props;
  // ED-9: the linked entries' titles show as chips; an `@` pick links in the save that follows.
  const found = useLookup(m.linkIds);
  const titles = m.linkIds.flatMap((id) => found.get(id)?.title ?? []);
  const picked = useRef<string[]>([]);
  const what = m.title.trim() || 'this moment';
  const options: EditableOption[] = props.people.map((p) => ({
    value: p.id,
    label: personLabel(p),
  }));
  return (
    <>
      <div className="bs-when">
        <div className="bs-field" data-field="year">
          <span className="bs-field-title" aria-hidden="true">
            Year
          </span>
          <span className="row tight bs-year-age">
            <Editable
              kind="year"
              className="bs-ed num"
              data-field="year"
              label={`Year of ${what}`}
              value={m.year}
              onSave={(v) => props.onSave('year', v)}
            />
            <span className="bs-age">
              Age{' '}
              <span className="num" data-testid="moment-age">
                {props.person ? ageText(props.person, m.year) : 'Unknown'}
              </span>
            </span>
          </span>
        </div>
        <div className="bs-field" data-field="endYear">
          <span className="bs-field-title" aria-hidden="true">
            To
          </span>
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
        </div>
        <div className="bs-field" data-field="characterId">
          <span className="bs-field-title" aria-hidden="true">
            Whose moment
          </span>
          <Editable
            kind="select"
            className="bs-ed"
            data-field="characterId"
            label={`Whose moment, ${what}`}
            options={options}
            value={m.characterId}
            onSave={(v) => (v ? props.onSave('characterId', v) : Promise.resolve())}
          />
        </div>
      </div>
      <div className="bs-field" data-field="title">
        <span className="bs-field-title" aria-hidden="true">
          What happens
        </span>
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
      </div>
      <div className="bs-field bs-body" data-field="body">
        <span className="bs-field-title" aria-hidden="true">
          How they experience it
        </span>
        <Editable
          kind="rich"
          className="bs-ed"
          data-field="body"
          mode="inline"
          size="prose"
          label={`How they experience it, ${what}`}
          placeholder="Add how they experience it"
          value={m.body}
          onSave={(v) => props.onSave('body', v)}
        />
      </div>
      <div className="bs-field bs-world" data-field="worldContext">
        <span className="bs-field-title" aria-hidden="true">
          Relevant world events
        </span>
        <Editable
          kind="rich"
          className="bs-ed"
          data-field="worldContext"
          mode="inline"
          size="notes"
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
    </>
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
            // The list takes its Escape, so the dialog stays open.
            if (e.key === 'Escape') {
              e.preventDefault();
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
