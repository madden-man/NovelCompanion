import type { ReactNode } from 'react';
import { isEntryCollection } from '../../../../shared/schema';
import type { EntryCollection } from '../../../../shared/schema';
import type { Response } from '../../../../shared/ipc';
import { GROUP_TITLES, WINDOW_AHEAD } from '../../../../shared/domain/brief/selection';
import { span } from '../timeline/common';
import { WorldEventsStrip } from '../timeline/WorldEventsStrip';
import type { StripEvent } from '../timeline/WorldEventsStrip';
import { patchBetween } from '../../../../shared/domain/diff';
import { editCommand } from '../../../../shared/domain/undoRunner';
import { entryTitle } from '../../../../shared/schema';
import { call } from '../../api';
import type { Entry } from '../data';
import type { useUndo } from '../undo';

export type SelectionView = Response<'session.relevant'>['selection'];
type Group = SelectionView['shared'][number];
type Item = Group['items'][number];

export type OpenEntry = (collection: EntryCollection, id: string) => void;

/** Change an entry through the write path and record one undo step for it (ED-3). */
export async function updateWithUndo(
  undo: ReturnType<typeof useUndo>,
  collection: EntryCollection,
  id: string,
  patch: Record<string, unknown>,
  label: string,
): Promise<Entry> {
  const before = (await call('entry.get', { collection, id })).entry as Entry;
  const after = (await call('entry.update', { collection, id, patch })).entry as Entry;
  if (Object.keys(patchBetween(before, after).forward).length) {
    undo.record(editCommand(`${label} on ${entryTitle(after)}`, collection, id, before, after));
  }
  return after;
}

/** A status chip: canon, planned, or idea (SB-5 keeps them visibly apart). */
export function StatusChip({ status }: { status: string }) {
  if (!status) return null;
  return <span className={`chip ${status}`}>{status}</span>;
}

function ItemRow(props: { item: Item; onOpen: OpenEntry; action?: (item: Item) => ReactNode }) {
  const { item, onOpen } = props;
  const collection = item.collection;
  return (
    <li className="sel-item" data-testid="sel-item" data-id={item.id}>
      <div className="row tight">
        {isEntryCollection(collection) ? (
          <button
            type="button"
            className="link-btn"
            onClick={() => onOpen(collection, item.id)}
            title={`Open ${item.title}`}
          >
            {item.title}
          </button>
        ) : (
          <strong>{item.title}</strong>
        )}
        <StatusChip status={item.status} />
        {item.note && <span data-testid="sel-note">{item.note}</span>}
        {props.action?.(item)}
      </div>
      {item.detail && <p className="sel-detail">{item.detail}</p>}
    </li>
  );
}

export function GroupBlock(props: {
  group: Group;
  onOpen: OpenEntry;
  action?: (item: Item) => ReactNode;
  showEmpty?: boolean;
}) {
  const { group } = props;
  if (!group.items.length && !props.showEmpty) return null;
  return (
    <section className="sel-group" data-testid="sel-group" data-kind={group.kind}>
      <h4>
        {group.title} <span className="num">({group.items.length})</span>
      </h4>
      {group.items.length ? (
        <ul className="plain-list stack tight">
          {group.items.map((it) => (
            <ItemRow key={it.id} item={it} onOpen={props.onOpen} action={props.action} />
          ))}
        </ul>
      ) : (
        <p className="example-note">Nothing selected.</p>
      )}
    </section>
  );
}

/**
 * True when a selected item is a world event the strip of years shows (A33):
 * a world event up to the year after the story year. Everything else under
 * Planned ahead, moments included (SB-5), stays in the Planned ahead list.
 */
export function onEventStrip(it: Item, strandYear: number, ahead = WINDOW_AHEAD): boolean {
  return (
    it.collection === 'worldEvents' && typeof it.year === 'number' && it.year <= strandYear + ahead
  );
}

/** The world events of a strand's window as strip events: titles only, placed by year (A33). */
function stripEvents(groups: Group[], from: number, to: number): StripEvent[] {
  const out: StripEvent[] = [];
  for (const g of groups) {
    if (g.kind !== 'eventsWindow' && g.kind !== 'plannedAhead') continue;
    for (const it of g.items) {
      if (it.collection !== 'worldEvents') continue;
      if (typeof it.year !== 'number' || it.year > to) continue;
      const endYear = it.endYear ?? it.year;
      if (endYear < from) continue;
      out.push({ id: it.id, title: it.title, status: it.status, startYear: it.year, endYear });
    }
  }
  return out;
}

/**
 * A33: the world events of the window as a strip of years, in place of the
 * list. Planned-ahead world events inside the window sit on the strip too, so
 * the list under "Planned ahead" keeps the rest: later events and moments (SB-5).
 */
export function EventsWindow(props: {
  strand: SelectionView['strands'][number];
  group: Group;
  window: number;
  /** IP-11: years the window looks past the story year. */
  ahead?: number;
  onOpen: OpenEntry;
  action?: (item: Item) => ReactNode;
  /** IP-2: draws an event's title, such as a field, in place of the link. */
  renderTitle?: (e: StripEvent) => ReactNode;
  /** IP-2: what follows the strip, such as Add an event. */
  footer?: ReactNode;
}) {
  const { strand, group } = props;
  const from = strand.year - props.window;
  const to = strand.year + (props.ahead ?? WINDOW_AHEAD);
  const events = stripEvents(strand.groups, from, to);
  const items = new Map<string, Item>();
  for (const g of strand.groups) for (const it of g.items) items.set(it.id, it);
  const action = props.action;
  return (
    <section className="sel-group" data-testid="sel-group" data-kind={group.kind}>
      <h4>
        World events <span className="num">{span(from, to)}</span>{' '}
        <span className="num">({events.length})</span>
      </h4>
      <WorldEventsStrip
        events={events}
        from={from}
        to={to}
        year={strand.year}
        everyYear
        onOpen={(id) => props.onOpen('worldEvents', id)}
        action={
          action &&
          ((id) => {
            const it = items.get(id);
            return it ? action(it) : null;
          })
        }
        renderTitle={props.renderTitle}
        label={`World events ${span(from, to)}`}
      />
      {props.footer}
    </section>
  );
}

/**
 * A selection as the "Relevant to Session" view and the brief show it: one
 * section per strand, primary first, then what the section shares. Every item
 * opens its entry.
 */
export function SelectionBody(props: {
  selection: SelectionView;
  onOpen: OpenEntry;
  /** The strand being written, marked in the list. */
  writing?: { chapterId?: string; strandId?: string } | null;
  action?: (item: Item) => ReactNode;
  /** SB-9: put back an entry removed from the selection, shown on its Left out row. */
  onKeep?: (id: string) => void;
}) {
  const { selection: sel, onOpen } = props;
  return (
    <div className="stack" data-testid="selection">
      {sel.strands.map((s) => {
        const isWriting =
          !!props.writing?.strandId &&
          s.chapterId === props.writing.chapterId &&
          s.strandId === props.writing.strandId;
        return (
          <section
            key={`${s.chapterId ?? ''}|${s.strandId ?? s.label}`}
            className="panel stack tight"
            data-testid="relevant-strand"
            data-strand={s.strandId ?? ''}
            aria-label={s.label}
          >
            <div className="row">
              <h3>{s.label}</h3>
              <span className="chip time">{s.year}</span>
              {s.primary && <span className="chip">primary</span>}
              {isWriting && <span className="chip canon">writing now</span>}
              {s.povName && <span>Point of view: {s.povName}</span>}
              {s.communities.length > 0 && (
                <span>Community: {s.communities.map((c) => c.label).join(', ')}</span>
              )}
            </div>
            {s.groups.map((g) => {
              if (g.kind === 'eventsWindow') {
                return (
                  <EventsWindow
                    key={g.kind}
                    strand={s}
                    group={g}
                    window={sel.window}
                    ahead={sel.ahead}
                    onOpen={onOpen}
                    action={props.action}
                  />
                );
              }
              const group =
                g.kind === 'plannedAhead'
                  ? {
                      ...g,
                      items: g.items.filter((it) => !onEventStrip(it, s.year, sel.ahead)),
                    }
                  : g;
              return (
                <GroupBlock
                  key={g.kind}
                  group={group}
                  onOpen={onOpen}
                  action={props.action}
                  showEmpty={g.kind === 'characters' || g.kind === 'culture' || g.kind === 'era'}
                />
              );
            })}
          </section>
        );
      })}
      <section className="panel stack tight" aria-label="For the whole section">
        <h3>For the whole section</h3>
        {sel.shared.map((g) => (
          <GroupBlock
            key={g.kind}
            group={g}
            onOpen={onOpen}
            action={props.action}
            showEmpty={g.kind === 'previousChapters'}
          />
        ))}
      </section>
      {sel.omitted.length > 0 && (
        <section className="panel stack tight" data-testid="sel-omitted" aria-label="Left out">
          <h3>Left out</h3>
          <OmittedList selection={sel} onKeep={props.onKeep} />
        </section>
      )}
    </div>
  );
}

/**
 * SB-9, IP-2: what the selection left out, by title; an entry removed by the
 * writer has Keep, which puts it back before the brief is written.
 */
export function OmittedList(props: { selection: SelectionView; onKeep?: (id: string) => void }) {
  const sel = props.selection;
  return (
    <ul className="plain-list stack tight">
      {sel.omitted.map((o) => (
        <li key={`${o.kind}|${o.id}`} data-testid="omitted-item" data-id={o.id}>
          {o.title} ({GROUP_TITLES[o.kind].toLowerCase()}):{' '}
          {o.reason === 'removed'
            ? 'removed by you'
            : `over the size budget of ${sel.budget} characters`}
          {o.reason === 'removed' && props.onKeep && (
            <>
              {' '}
              <button
                type="button"
                className="btn small"
                aria-label={`Keep ${o.title}`}
                onClick={() => props.onKeep?.(o.id)}
              >
                Keep
              </button>
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

/** SB-9, IP-2: Remove on an item of a selection no brief has been written from yet. */
export function removeAction(onRemove: (id: string) => void) {
  function RemoveAction(item: Item) {
    return (
      <button
        type="button"
        className="btn small"
        aria-label={`Remove ${item.title}`}
        onClick={() => onRemove(item.id)}
      >
        Remove
      </button>
    );
  }
  return RemoveAction;
}
