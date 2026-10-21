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
        <code className="id">{item.id}</code>
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

/** The world events of a strand's window as strip events: titles only, placed by year (A33). */
function stripEvents(groups: Group[], from: number, to: number): StripEvent[] {
  const out: StripEvent[] = [];
  for (const g of groups) {
    if (g.kind !== 'eventsWindow' && g.kind !== 'plannedAhead') continue;
    for (const it of g.items) {
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
 * list. Planned-ahead events inside the window sit on the strip too, so the
 * list under "Planned ahead" keeps only what lies past it.
 */
export function EventsWindow(props: {
  strand: SelectionView['strands'][number];
  group: Group;
  window: number;
  onOpen: OpenEntry;
  action?: (item: Item) => ReactNode;
}) {
  const { strand, group } = props;
  const from = strand.year - props.window;
  const to = strand.year + WINDOW_AHEAD;
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
        label={`World events ${span(from, to)}`}
      />
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
                    onOpen={onOpen}
                    action={props.action}
                  />
                );
              }
              const group =
                g.kind === 'plannedAhead'
                  ? {
                      ...g,
                      items: g.items.filter(
                        (it) => typeof it.year !== 'number' || it.year > s.year + WINDOW_AHEAD,
                      ),
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
          <ul className="plain-list">
            {sel.omitted.map((o) => (
              <li key={`${o.kind}|${o.id}`}>
                {o.title} ({GROUP_TITLES[o.kind].toLowerCase()}):{' '}
                {o.reason === 'removed'
                  ? 'removed by you'
                  : `over the size budget of ${sel.budget} characters`}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
