import { useId, useRef, useState } from 'react';
import { GROUP_TITLES, WINDOW_AHEAD } from '../../../../shared/domain/brief/selection';
import { placePath } from '../../../../shared/domain/culture';
import { call, plainError } from '../../api';
import { useWriteGuard } from '../../connection';
import { captureNav } from '../capture';
import { useEntries } from '../data';
import type { Entry } from '../data';
import { useUndo } from '../undo';
import { EventsWindow, GroupBlock, updateWithUndo } from './common';
import type { OpenEntry, SelectionView } from './common';
import './relevant.css';

type Strand = SelectionView['strands'][number];
type Group = Strand['groups'][number];
type Item = Group['items'][number];
type BackstoryPerson = Strand['backstory']['people'][number];
type BackstoryRow = BackstoryPerson['rows'][number];
type Mark = { key: string; year?: number | null; pinned?: boolean };

/** The groups shown open, in this order; everything else folds under "More" (A35). */
const LEAD = new Set(['eventsWindow', 'characters', 'culture']);

/** A character's age in the strand's year, and nothing else (A35). */
function ageText(item: Item): string {
  const s = item.state;
  if (!s) return '';
  switch (s.state) {
    case 'alive':
      return s.dyingThisYear ? `${s.age}, dies this year` : String(s.age);
    case 'dead':
      return `died ${s.deathYear}`;
    case 'unborn':
      return `born ${s.birthYear}`;
    case 'unknown':
      return 'age unknown';
  }
}

function Characters({
  group,
  pov,
  onOpen,
}: {
  group: Group;
  pov: string | null;
  onOpen: OpenEntry;
}) {
  return (
    <section className="sel-group rel-sec" data-testid="sel-group" data-kind="characters">
      <h4>
        Characters <span className="num">({group.items.length})</span>
      </h4>
      {group.items.length ? (
        <ul className="rel-people">
          {group.items.map((it) => (
            <li
              key={it.id}
              className={`rel-person${it.id === pov ? ' pov' : ''}`}
              data-testid="sel-item"
              data-id={it.id}
            >
              <button
                type="button"
                className="link-btn"
                onClick={() => onOpen('characters', it.id)}
              >
                {it.title}
              </button>
              <span className={`rel-age${it.state?.state === 'unknown' ? ' unknown' : ''}`}>
                {ageText(it)}
              </span>
              {it.id === pov && <span className="rel-pov">POV</span>}
            </li>
          ))}
        </ul>
      ) : (
        <p className="example-note">Nothing selected.</p>
      )}
    </section>
  );
}

/** One dated passage: the year chip corrects the year, the pin keeps it in every session. */
function PassageRow(props: {
  row: BackstoryRow;
  onYear: (year: number | null) => void;
  onPin: (pinned: boolean) => void;
  off: boolean;
}) {
  const { row } = props;
  const [editing, setEditing] = useState(false);
  const [open, setOpen] = useState(false);
  const tag = row.kind === 'pinned' ? 'Pinned' : row.kind === 'lead' ? 'Leading up' : row.tag;
  const commit = (v: string) => {
    setEditing(false);
    const n = v.trim() === '' ? null : Number(v);
    if (n === null || (Number.isInteger(n) && n !== row.year)) props.onYear(n);
  };
  return (
    <li className={`rel-bs-row ${row.kind}`} data-testid="backstory-row" data-key={row.key}>
      {editing ? (
        <input
          className="rel-year-input num"
          type="number"
          aria-label="Year of this passage (empty to date it from the text)"
          defaultValue={row.year ?? ''}
          autoFocus
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit(e.currentTarget.value);
            if (e.key === 'Escape') setEditing(false);
          }}
        />
      ) : (
        <button
          type="button"
          className={`chip time rel-year${row.source === 'set' ? ' set' : ''}`}
          title={
            row.source === 'set'
              ? 'Year set by hand. Click to change.'
              : row.source === 'carried'
                ? 'Dated from the passage before. Click to correct.'
                : 'Dated from the text. Click to correct.'
          }
          disabled={props.off}
          onClick={() => setEditing(true)}
        >
          {row.year ?? '?'}
        </button>
      )}
      <span className="rel-bs-tag">{tag}</span>
      <span className="rel-bs-text">
        {open ? row.text : row.excerpt}
        {row.text !== row.excerpt && (
          <>
            {' '}
            <button
              type="button"
              className="link-btn rel-bs-more"
              aria-expanded={open}
              onClick={() => setOpen((v) => !v)}
            >
              {open ? 'Less' : 'More'}
            </button>
          </>
        )}
      </span>
      <button
        type="button"
        className="btn small rel-pin"
        aria-pressed={row.pinned}
        disabled={props.off}
        onClick={() => props.onPin(!row.pinned)}
        title={row.pinned ? 'Unpin: show only when its years are relevant' : 'Pin to every session'}
      >
        {row.pinned ? 'Pinned' : 'Pin'}
      </button>
    </li>
  );
}

function Backstory({ strand, onOpen }: { strand: Strand; onOpen: OpenEntry }) {
  const b = strand.backstory;
  const undo = useUndo();
  const ro = useWriteGuard();
  const [error, setError] = useState<string | null>(null);
  // Writes run one after another, each on the entry as it is now, so a quick
  // pin after a year change never loses the year.
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const save = (
    person: BackstoryPerson,
    row: BackstoryRow,
    patch: { year?: number | null; pinned?: boolean },
  ) => {
    queue.current = queue.current.then(async () => {
      try {
        const doc = (await call('entry.get', { collection: 'characters', id: person.characterId }))
          .entry as Entry;
        const marks = (Array.isArray(doc.backstoryMarks) ? doc.backstoryMarks : []) as Mark[];
        const merged = { ...(marks.find((m) => m.key === row.key) ?? { key: row.key }), ...patch };
        const clean: Mark = {
          key: row.key,
          ...(typeof merged.year === 'number' ? { year: merged.year } : {}),
          ...(merged.pinned ? { pinned: true } : {}),
        };
        const keep = clean.year !== undefined || clean.pinned === true;
        const next = [...marks.filter((m) => m.key !== row.key), ...(keep ? [clean] : [])];
        await updateWithUndo(
          undo,
          'characters',
          person.characterId,
          { backstoryMarks: next },
          'pinned' in patch ? 'Backstory pin' : 'Backstory date',
        );
        setError(null);
      } catch (e) {
        setError(plainError(e));
      }
    });
  };
  const span = b.from === b.to ? String(b.from) : `${b.from} to ${b.to}`;
  return (
    <section className="sel-group rel-sec" data-testid="sel-backstory" aria-label="Backstory">
      <h4>
        Backstory{' '}
        <span className="num">
          {b.label} · {span}
        </span>
      </h4>
      {error && (
        <p className="callout crit" role="alert">
          {error}
        </p>
      )}
      {b.people.length ? (
        <div className="rel-bs">
          {b.people.map((p) => (
            <div
              key={p.characterId}
              className="rel-bs-person"
              data-testid="backstory-person"
              data-id={p.characterId}
            >
              <div className="rel-bs-who">
                <button
                  type="button"
                  className="link-btn"
                  onClick={() => onOpen('characters', p.characterId)}
                >
                  {p.name}
                </button>
                <small>{p.ages}</small>
              </div>
              <ul className="plain-list">
                {p.rows.map((r) => (
                  <PassageRow
                    key={`${r.kind}|${r.key}`}
                    row={r}
                    off={ro.off}
                    onYear={(year) => save(p, r, { year })}
                    onPin={(pinned) => save(p, r, { pinned })}
                  />
                ))}
              </ul>
            </div>
          ))}
        </div>
      ) : (
        <p className="example-note">No backstory passage of the characters here falls in {span}.</p>
      )}
    </section>
  );
}

function Culture(props: { strand: Strand; group: Group; onOpen: OpenEntry }) {
  const { strand, group } = props;
  const places = useEntries('places');
  const chapters = useEntries('chapters');
  const undo = useUndo();
  const ro = useWriteGuard();
  const pickId = useId();
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<string[]>(strand.placeIds);
  const setting = strand.setting;
  const labels = new Map(strand.communities.map((c) => [c.id, c.label]));
  const byCommunity = new Map<string, Item[]>();
  for (const it of group.items) {
    const k = it.community ?? '';
    byCommunity.set(k, [...(byCommunity.get(k) ?? []), it]);
  }
  const empty = strand.communities.filter((c) => !byCommunity.has(c.id));
  const nearest = strand.communities[0];
  const canPick = !!strand.chapterId && !!strand.strandId;
  const savePlaces = async () => {
    const ch = chapters.find((c) => c._id === strand.chapterId);
    if (!ch || !Array.isArray(ch.strands)) return;
    const strands = (ch.strands as Record<string, unknown>[]).map((s) =>
      s.id === strand.strandId ? { ...s, placeIds: picked } : s,
    );
    await updateWithUndo(undo, 'chapters', String(ch._id), { strands }, 'Setting');
    setPicking(false);
  };
  return (
    <section className="sel-group rel-sec" data-testid="sel-group" data-kind="culture">
      <h4>
        Cultural context <span className="num">({group.items.length})</span>
      </h4>
      <div className="rel-setting" data-testid="relevant-setting">
        <span>Setting</span>
        {setting.placeIds.length ? (
          setting.placeIds.map((id) => (
            <strong key={id} className="rel-crumb">
              {placePath(places, id) || id}
            </strong>
          ))
        ) : (
          <em>none</em>
        )}
        <span className="rel-src">
          {setting.source === 'strand' ? 'set on this strand' : setting.note}
        </span>
        {canPick && (
          <button
            type="button"
            className="btn small"
            aria-expanded={picking}
            disabled={ro.off}
            {...ro.tip}
            onClick={() => {
              setPicked(strand.placeIds);
              setPicking((v) => !v);
            }}
          >
            Change places
          </button>
        )}
      </div>
      {picking && (
        <div className="field rel-pick">
          <label htmlFor={pickId}>
            Places of this strand (empty: where the point of view lived)
          </label>
          <select
            id={pickId}
            multiple
            size={6}
            value={picked}
            data-testid="relevant-places"
            onChange={(e) => setPicked(Array.from(e.target.selectedOptions, (o) => o.value))}
          >
            {[...places]
              .map((p) => ({ id: String(p._id), path: placePath(places, String(p._id)) }))
              .sort((a, b) => a.path.localeCompare(b.path))
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.path}
                </option>
              ))}
          </select>
          <div className="row tight">
            <button type="button" className="btn small primary" onClick={() => void savePlaces()}>
              Save places
            </button>
            <button type="button" className="btn small" onClick={() => setPicking(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {[...byCommunity].map(([community, items]) => (
        <div key={community} className="rel-cg">
          <div className="rel-comm">{labels.get(community) ?? community}</div>
          <ul className="plain-list">
            {items.map((it) => (
              <li key={it.id} className="rel-ce" data-testid="sel-item" data-id={it.id}>
                <button
                  type="button"
                  className="link-btn"
                  onClick={() => props.onOpen('culturalEntries', it.id)}
                >
                  {it.title}
                </button>
                <span className="rel-yrs">{it.note.split(', ').slice(1).join(', ')}</span>
                {it.detail && <p>{it.detail}</p>}
              </li>
            ))}
          </ul>
        </div>
      ))}
      {group.items.length > 0 && empty.length > 0 && (
        <p className="example-note">
          Also checked: {empty.map((c) => c.label).join(', ')}. Nothing covers {strand.year}.
        </p>
      )}
      {group.items.length === 0 &&
        (nearest ? (
          <div className="rel-gap" data-testid="culture-gap">
            <span>
              Nothing covers {strand.communities.map((c) => c.label).join(', ')} in {strand.year}.
            </span>
            <button
              type="button"
              className="btn small"
              disabled={ro.off}
              onClick={() =>
                captureNav.open(`Cultural context for ${nearest.label}, ${strand.year}: `)
              }
            >
              Add culture for {nearest.label}, {strand.year}
            </button>
          </div>
        ) : (
          <p className="example-note" data-testid="culture-gap">
            No setting for {strand.year}: pick places for this strand, or add a place lived
            {strand.povName ? ` for ${strand.povName}` : ''}.
          </p>
        ))}
    </section>
  );
}

/**
 * A35: Relevant to Session for the strand being written. The chapter heads it;
 * world events lead, then the backstory of the chapter's backstory years,
 * the characters by name and age, and the culture of the setting in that
 * year. Everything else in the SB-2 selection folds under "More".
 */
export function RelevantBody(props: {
  selection: SelectionView;
  onOpen: OpenEntry;
  writing: { chapterId?: string; strandId?: string } | null;
}) {
  const { selection: sel, onOpen } = props;
  const chapters = useEntries('chapters');
  const strand =
    sel.strands.find((s) => !!props.writing?.strandId && s.strandId === props.writing.strandId) ??
    sel.strands[0];
  if (!strand) {
    return <p className="example-note">This chapter has no strand with a story year.</p>;
  }
  const chapter = chapters.find((c) => c._id === strand.chapterId);
  const isWriting = !!props.writing?.chapterId && strand.chapterId === props.writing.chapterId;
  const group = (k: string) => strand.groups.find((g) => g.kind === k);
  const events = group('eventsWindow');
  const characters = group('characters');
  const culture = group('culture');
  const rest = strand.groups
    .filter((g) => !LEAD.has(g.kind))
    .map((g) =>
      g.kind === 'plannedAhead'
        ? {
            ...g,
            items: g.items.filter(
              (it) => typeof it.year !== 'number' || it.year > strand.year + WINDOW_AHEAD,
            ),
          }
        : g,
    );
  const heading = chapter ? String(chapter.title ?? '') || 'Untitled chapter' : strand.label;
  return (
    <section
      className="panel stack rel-strand"
      data-testid="relevant-strand"
      data-strand={strand.strandId ?? ''}
      aria-label={heading}
    >
      <div className="row">
        {typeof chapter?.readingOrder === 'number' && (
          <span className="chip">Ch. {chapter.readingOrder}</span>
        )}
        <h3 data-testid="relevant-label">{heading}</h3>
        <span className="chip time">{strand.year}</span>
        {isWriting && <span className="chip canon">writing now</span>}
        {strand.povName && <span>Point of view: {strand.povName}</span>}
      </div>
      {events && (
        <EventsWindow strand={strand} group={events} window={sel.window} onOpen={onOpen} />
      )}
      <Backstory strand={strand} onOpen={onOpen} />
      {characters && <Characters group={characters} pov={strand.povCharacterId} onOpen={onOpen} />}
      {culture && (
        <Culture key={strand.strandId ?? ''} strand={strand} group={culture} onOpen={onOpen} />
      )}
      <details className="rel-more" data-testid="relevant-more">
        <summary>
          More for this chapter{' '}
          <span>
            {[...rest, ...sel.shared]
              .filter((g) => g.items.length)
              .map((g) => g.title)
              .join(' · ') || 'nothing else selected'}
          </span>
        </summary>
        <div className="stack tight">
          {rest.map((g) => (
            <GroupBlock key={g.kind} group={g} onOpen={onOpen} />
          ))}
          {sel.shared.map((g) => (
            <GroupBlock key={`shared-${g.kind}`} group={g} onOpen={onOpen} />
          ))}
          {sel.omitted.length > 0 && (
            <section data-testid="sel-omitted" aria-label="Left out">
              <h4>Left out</h4>
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
          <p className="example-note">
            {sel.ids.length} entries, selected the same way the brief selects them.
          </p>
        </div>
      </details>
    </section>
  );
}
