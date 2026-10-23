import { useMemo } from 'react';
import type { ReactNode } from 'react';
import { span } from './common';

/** One event on the strip: what the selection and the chart both carry. */
export interface StripEvent {
  id: string;
  title: string;
  status: string;
  startYear: number;
  endYear: number;
  formative?: boolean;
}

/**
 * A33: world events on a timeline of year columns, titles only, each a link
 * that opens the event. The "Relevant to Session" view shows the five year
 * window around a strand's year; the World events section shows every year
 * with an event. A range sits in its first year inside the strip and carries
 * its span in the tooltip, so a long event is never listed more than once.
 */
export function WorldEventsStrip(props: {
  events: StripEvent[];
  /** The first and last year drawn. */
  from: number;
  to: number;
  /** The story year, marked on its column. */
  year?: number | null;
  /** Columns for the years with no event, else only the years that have one. */
  everyYear: boolean;
  onOpen: (id: string) => void;
  /** Something to show after an event's title, such as a Remove button on the desk. */
  action?: (id: string) => ReactNode;
  /** a47-desk (IP-2): draws an event's title, such as a field, in place of the link. */
  renderTitle?: (e: StripEvent) => ReactNode;
  label: string;
  testid?: string;
}) {
  const { from, to, year } = props;
  const columns = useMemo(() => {
    const byYear = new Map<number, StripEvent[]>();
    for (const e of props.events) {
      if (e.endYear < from || e.startYear > to) continue;
      const at = Math.max(e.startYear, from);
      const list = byYear.get(at) ?? [];
      list.push(e);
      byYear.set(at, list);
    }
    const years: number[] = [];
    for (let y = from; y <= to; y++) {
      if (props.everyYear || byYear.has(y) || y === year) years.push(y);
    }
    return years.map((y) => ({ year: y, events: byYear.get(y) ?? [] }));
  }, [props.events, from, to, year, props.everyYear]);

  return (
    <div
      className={`we-strip-wrap${props.everyYear ? '' : ' sparse'}`}
      role="group"
      aria-label={props.label}
      data-testid={props.testid ?? 'we-strip'}
    >
      <ol className="we-strip">
        {columns.map((c, i) => {
          const prev = columns[i - 1];
          const gap = prev ? c.year - prev.year - 1 : 0;
          return (
            <li
              key={c.year}
              className={`we-col${c.year === year ? ' current' : ''}${c.events.length ? '' : ' empty'}`}
              data-year={c.year}
              aria-current={c.year === year ? 'date' : undefined}
            >
              <span className="we-year num">
                {gap > 0 && (
                  <span className="we-gap" aria-label={`${gap} years with no event`}>
                    ⋯
                  </span>
                )}
                {c.year}
              </span>
              <ul className="we-events">
                {c.events.map((e) => (
                  <li key={e.id} data-testid="sel-item" data-id={e.id}>
                    {props.renderTitle?.(e) ?? (
                      <button
                        type="button"
                        className={`link-btn we-event ${e.status}${e.formative ? ' formative' : ''}`}
                        onClick={() => props.onOpen(e.id)}
                        title={`${span(e.startYear, e.endYear)}${e.status ? `, ${e.status}` : ''}${e.formative ? ', formative' : ''}`}
                      >
                        {e.title}
                      </button>
                    )}
                    {props.action?.(e.id)}
                  </li>
                ))}
              </ul>
            </li>
          );
        })}
      </ol>
      {columns.every((c) => !c.events.length) && (
        <p className="example-note">No world event from {span(from, to)}.</p>
      )}
    </div>
  );
}
