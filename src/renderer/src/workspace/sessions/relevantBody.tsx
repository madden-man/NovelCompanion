import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { placePath, unitOf, unitSpan } from '../../../../shared/domain/culture';
import {
  charactersChangeLabel,
  setStrandCharacters,
  setStrandPov,
  setStrandYear,
  strandById,
  strandCharacters,
  strandsOf,
} from '../../../../shared/domain/strands';
import type { StrandDoc } from '../../../../shared/domain/strands';
import { createCommand, editCommand } from '../../../../shared/domain/undoRunner';
import type { Response } from '../../../../shared/ipc';
import { entryTitle } from '../../../../shared/schema';
import { useWriteGuard } from '../../connection';
import { call, plainError } from '../../api';
import { useBibleSettings } from '../bibleSettings';
import { captureNav } from '../capture';
import { relativesLine } from '../character';
import { useEntries, useList, useStore } from '../data';
import type { Entry } from '../data';
import {
  Editable,
  EditableError,
  EntryEditable,
  entryOptions,
  mergeCommands,
  useEntryAddNew,
} from '../editable';
import type { SaveInfo } from '../editable';
import { SaveState, useAutosave } from '../editor';
import { useStoryTime } from '../storyTime';
import { useUndo } from '../undo';
import { Zh } from '../Zh';
import { RichText } from '../richText/RichText';
import type { StripEvent } from '../timeline/WorldEventsStrip';
import {
  EventsWindow,
  GroupBlock,
  OmittedList,
  onEventStrip,
  removeAction,
  updateWithUndo,
} from './common';
import type { OpenEntry, SelectionView } from './common';
import { Reimport } from './Reimport';
import './relevant.css';

type Strand = SelectionView['strands'][number];
type Group = Strand['groups'][number];
type Item = Group['items'][number];
type BackstoryPerson = Strand['backstory']['people'][number];
type BackstoryRow = BackstoryPerson['rows'][number];
type Relatives = Response<'character.page'>['page']['relatives'];

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

/** SM-10: the parents and partner from the tree, in one line; children are left to the page. */
function familyLine(rel: Relatives | null, unionLabel: (id: string) => string): string {
  if (!rel) return 'Loading the family.';
  if (!rel.parents.length && !rel.partners.length) {
    return 'No parents or partner in the family tree yet.';
  }
  return relativesLine({ ...rel, children: [] }, unionLabel);
}

/** An end year after the start, as " to 2044", or nothing. */
function endText(m: Record<string, unknown>): string {
  return typeof m.endYear === 'number' && m.endYear !== m.year ? ` to ${m.endYear}` : '';
}

/**
 * IP-2: store the strands of a chapter as one undo step with the desk's own
 * label ("Story year of The Letter"), joined with the step of anything Add
 * new made on the way. The patch comes from `strands.ts`.
 */
function useStrandWriter(chapterId: string | null) {
  const undo = useUndo();
  return useCallback(
    async (
      edit: (strands: StrandDoc[]) => StrandDoc[] | null,
      label: (before: Entry) => string,
      info: SaveInfo = {},
    ): Promise<Entry> => {
      if (!chapterId) throw new EditableError('Pick a chapter in Writing to change its strand.');
      await undo.flush();
      const before = (await call('entry.get', { collection: 'chapters', id: chapterId }))
        .entry as Entry;
      const next = edit(strandsOf(before));
      if (!next) {
        throw new EditableError(
          'This strand is no longer in the chapter. Pick it again in Writing.',
        );
      }
      const after = (
        await call('entry.update', {
          collection: 'chapters',
          id: chapterId,
          patch: { strands: next },
        })
      ).entry as Entry;
      const step = editCommand(label(before), 'chapters', chapterId, before, after);
      const changed = step.redo.some(
        (op) => op.kind === 'update' && Object.keys(op.patch).length > 0,
      );
      const added = info.added?.command;
      if (added && changed) undo.record(mergeCommands(step.label, added, step));
      else if (added) undo.record(added);
      else if (changed) undo.record(step);
      undo.markSaved(after);
      return after;
    },
    [chapterId, undo],
  );
}

/** SM-10, IP-2: one character of the chapter as a tile; its values are fields. */
function Tile(props: {
  item: Item;
  year: number;
  pov: boolean;
  onOpen: OpenEntry;
  onBackstory: (characterId: string) => void;
  onOpenTree?: (characterId: string) => void;
}) {
  const { item } = props;
  const characters = useEntries('characters');
  const moments = useEntries('moments');
  const unions = useList('unionTypes');
  const { version } = useStore();
  const undo = useUndo();
  const ro = useWriteGuard();
  const [open, setOpen] = useState(false);
  const [rel, setRel] = useState<Relatives | null>(null);
  const [newMoment, setNewMoment] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const detailId = useId();
  const person = characters.find((c) => c._id === item.id) ?? null;
  const name = person ? entryTitle(person) : item.title;
  const latest = useMemo(() => {
    const mine = moments
      .filter((m) => m.characterId === item.id && Number(m.year) <= props.year)
      .sort(
        (a, b) => Number(a.year) - Number(b.year) || entryTitle(a).localeCompare(entryTitle(b)),
      );
    const last = mine.slice(-3);
    // A moment just added stays in view while its text is written.
    const made = newMoment ? mine.find((m) => m._id === newMoment) : undefined;
    return made && !last.includes(made) ? [...last.slice(1), made] : last;
  }, [moments, item.id, props.year, newMoment]);
  useEffect(() => {
    if (!open) return;
    let live = true;
    call('character.page', { id: item.id })
      .then((r) => {
        if (live) setRel(r.page.relatives);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [open, item.id, version]);
  const unionLabel = (id: string) => unions?.items.find((i) => i.id === id)?.label ?? 'a union';
  const age = ageText(item);
  const common = {
    collection: 'characters' as const,
    id: item.id,
    ...(person ? { entry: person } : {}),
  };

  const addMoment = async () => {
    setError(null);
    try {
      const { entry } = await call('entry.create', {
        collection: 'moments',
        data: { title: '', characterId: item.id, year: props.year },
      });
      undo.record(createCommand('moments', entry._id, `a moment of ${name} in ${props.year}`));
      setNewMoment(entry._id);
      setOpen(true);
    } catch (e) {
      setError(plainError(e));
    }
  };

  return (
    <li
      className={`rel-tile${props.pov ? ' pov' : ''}${open ? ' open' : ''}`}
      data-testid="sel-item"
      data-id={item.id}
    >
      <div className="rel-tile-head">
        <span className="rel-tile-name">
          <EntryEditable
            {...common}
            kind="text"
            path="names.full"
            label="Full name"
            allowEmpty={false}
            testId="tile-name"
            placeholder={item.title}
            display={(t) => <Zh text={t} actions={false} />}
            // The title is the name the app shows everywhere; it follows the full name.
            extraPatch={(next) => ({ title: next })}
          />
        </span>
        <span className="rel-tile-zh" data-testid="tile-chinese">
          <EntryEditable
            {...common}
            kind="text"
            path="names.chinese"
            label="Name in Chinese characters"
            placeholder="Add a Chinese name"
            display={(t) => <Zh text={t} actions={false} />}
          />
        </span>
        <span
          className={`rel-age${item.state?.state === 'unknown' ? ' unknown' : ''}`}
          data-testid="tile-age"
        >
          {age}
        </span>
        {props.pov && <span className="rel-pov">point of view</span>}
        <button
          type="button"
          className="btn small rel-tile-toggle"
          aria-expanded={open}
          aria-controls={detailId}
          aria-label={open ? `Show less about ${name}` : `Show more about ${name}`}
          onClick={() => setOpen((v) => !v)}
          data-testid="tile-toggle"
        >
          {open ? 'Less' : 'More'}
        </button>
      </div>
      <div id={detailId} className="rel-tile-detail stack tight" hidden={!open}>
        {open && (
          <>
            <dl className="kv" data-testid="tile-detail">
              <dt>Born</dt>
              <dd data-testid="tile-birth">
                <EntryEditable
                  {...common}
                  kind="date"
                  path="birth"
                  dateBox="birth"
                  label="Birth"
                  placeholder="Unknown"
                />
              </dd>
              <dt>Died</dt>
              <dd data-testid="tile-death">
                <EntryEditable
                  {...common}
                  kind="date"
                  path="death"
                  dateBox="death"
                  label="Death"
                  placeholder="Not recorded"
                />
              </dd>
              <dt>In the story</dt>
              <dd data-testid="tile-role">
                <EntryEditable
                  {...common}
                  kind="rich"
                  path="role"
                  label="In the story"
                  placeholder="Not written yet."
                />
              </dd>
              <dt>Description</dt>
              <dd data-testid="tile-description">
                <EntryEditable
                  {...common}
                  kind="rich"
                  path="body"
                  label="Description"
                  placeholder="Not written yet."
                />
              </dd>
              <dt>Family</dt>
              <dd data-testid="tile-family">
                {props.onOpenTree ? (
                  <button
                    type="button"
                    className="link-btn"
                    title={`Show ${name} in the family tree`}
                    onClick={() => props.onOpenTree?.(item.id)}
                  >
                    {familyLine(rel, unionLabel)}
                  </button>
                ) : (
                  familyLine(rel, unionLabel)
                )}
              </dd>
            </dl>
            <div className="stack tight">
              <strong>Latest moments up to {props.year}</strong>
              {latest.length ? (
                <ul className="plain-list rel-tile-moments" data-testid="tile-moments">
                  {latest.map((m) => (
                    <li key={m._id} data-id={m._id} className="rel-moment">
                      <span className="chip time num">
                        <EntryEditable
                          collection="moments"
                          id={m._id}
                          entry={m}
                          kind="year"
                          path="year"
                          label="Year"
                        />
                        {endText(m)}
                      </span>{' '}
                      <EntryEditable
                        collection="moments"
                        id={m._id}
                        entry={m}
                        kind="text"
                        path="title"
                        label="What happens"
                        placeholder="What happens"
                        autoOpen={m._id === newMoment}
                        onClose={() => setNewMoment((v) => (v === m._id ? null : v))}
                      />
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="example-note" data-testid="tile-moments-empty">
                  No moments up to {props.year} yet.
                </p>
              )}
            </div>
            {error && (
              <p className="callout crit" role="alert">
                {error}
              </p>
            )}
            <div className="row tight">
              <button
                type="button"
                className="btn small"
                disabled={ro.off}
                {...ro.tip}
                onClick={() => void addMoment()}
              >
                Add a moment in {props.year}
              </button>
              <button
                type="button"
                className="btn small"
                onClick={() => props.onOpen('characters', item.id)}
              >
                Their page
              </button>
              <button
                type="button"
                className="btn small"
                onClick={() => props.onBackstory(item.id)}
              >
                Their backstory
              </button>
            </div>
          </>
        )}
      </div>
    </li>
  );
}

/**
 * SM-10, IP-2: the characters of the chapter as tiles, under the chip row of
 * who is in this scene (the writing strand's characters present).
 */
function Characters(props: {
  group: Group;
  strand: Strand;
  chapter: Entry | null;
  pov: string | null;
  onOpen: OpenEntry;
  onBackstory: (characterId: string) => void;
  onOpenTree?: (characterId: string) => void;
}) {
  const { group, strand, chapter } = props;
  const characters = useEntries('characters');
  const options = useMemo(() => entryOptions(characters), [characters]);
  const write = useStrandWriter(strand.chapterId);
  const newCharacter = useCallback(
    (label: string) => ({ title: label, names: { full: label } }),
    [],
  );
  const addNew = useEntryAddNew('characters', newCharacter);
  const strandId = strand.strandId;
  const stored = chapter && strandId ? strandById(strandsOf(chapter), strandId) : undefined;
  const present = strandCharacters(stored);
  const title = chapter ? entryTitle(chapter) : strand.label;
  const nameOf = (id: string) => {
    const c = characters.find((x) => x._id === id);
    return c ? entryTitle(c) : 'a new character';
  };
  return (
    <section className="sel-group rel-sec" data-testid="sel-group" data-kind="characters">
      <h4>
        Characters <span className="num">({group.items.length})</span>
      </h4>
      {stored && strandId && (
        <div className="rel-present" data-testid="scene-characters">
          <Editable
            kind="chips"
            label="In this scene"
            showLabel
            layout="inline"
            value={present}
            options={options}
            onAddNew={addNew}
            addLabel="Add a character to this scene"
            pickerLabel="Character to add to this scene"
            onSave={async (next, info) => {
              await write(
                (ss) => setStrandCharacters(ss, strandId, next),
                (before) => {
                  const was = strandCharacters(strandById(strandsOf(before), strandId));
                  const name = (id: string) =>
                    id === info.added?.id ? info.added.label : nameOf(id);
                  return charactersChangeLabel(was, next, name, entryTitle(before));
                },
                info,
              );
            }}
            data-field={`strands.${strandId}.characterIds`}
            placeholder={`No one is in ${title} yet`}
          />
        </div>
      )}
      {group.items.length ? (
        <ul className="rel-tiles">
          {group.items.map((it) => (
            <Tile
              key={it.id}
              item={it}
              year={strand.year}
              pov={it.id === props.pov}
              onOpen={props.onOpen}
              onBackstory={props.onBackstory}
              onOpenTree={props.onOpenTree}
            />
          ))}
        </ul>
      ) : (
        <p className="example-note">Nothing selected.</p>
      )}
    </section>
  );
}

/**
 * SM-10: "What happens in this scene", kept on the chapter (`sceneNote`).
 * It saves as you type, one undo step per pause, and says when it is saved.
 */
function SceneNote({ chapterId }: { chapterId: string }) {
  const ed = useAutosave('chapters', chapterId);
  const id = useId();
  const value = typeof ed.draft?.sceneNote === 'string' ? ed.draft.sceneNote : '';
  return (
    <section className="field rel-scene" data-testid="scene-note" aria-label="Scene note">
      <div className="row tight">
        <label id={id}>What happens in this scene</label>
        <SaveState status={ed.status} error={ed.error} />
      </div>
      <RichText
        labelledBy={id}
        size="notes"
        value={value}
        disabled={!ed.draft}
        placeholder="Who wants what, what goes wrong, where it ends."
        onChange={(md) => ed.setField('sceneNote', md)}
        onBlur={() => void ed.flush()}
      />
    </section>
  );
}

/** SM-3, IP-2: one moment of the character's backstory; its year and text are fields. */
function MomentRow(props: { row: BackstoryRow; moment: Entry | undefined; onOpen: OpenEntry }) {
  const { row } = props;
  const common = {
    collection: 'moments' as const,
    id: row.id,
    ...(props.moment ? { entry: props.moment } : {}),
  };
  return (
    <li className="rel-bs-row" data-testid="backstory-row" data-id={row.id}>
      <span className="chip time rel-year num">
        <EntryEditable {...common} kind="year" path="year" label="Year" testId="backstory-year" />
        {row.endYear !== null && row.endYear !== row.year ? ` to ${row.endYear}` : ''}
      </span>
      <span className="rel-bs-text">
        <EntryEditable
          {...common}
          kind="text"
          path="title"
          label="What happens"
          placeholder="What happens"
          testId="backstory-title"
        />
        {row.body && (
          <>
            {' '}
            <EntryEditable
              {...common}
              kind="rich"
              path="body"
              label="How they live it"
              layout="inline"
            />
          </>
        )}{' '}
        <button
          type="button"
          className="link-btn rel-open"
          aria-label={`Open ${row.title || 'the moment'}`}
          onClick={() => props.onOpen('moments', row.id)}
        >
          Open
        </button>
      </span>
    </li>
  );
}

/** A35, SM-3: the moments of the characters here that fall in the chapter's backstory years. */
function Backstory({ strand, onOpen }: { strand: Strand; onOpen: OpenEntry }) {
  const moments = useEntries('moments');
  const byId = useMemo(() => new Map(moments.map((m) => [m._id, m])), [moments]);
  const b = strand.backstory;
  const span = b.from === b.to ? String(b.from) : `${b.from} to ${b.to}`;
  return (
    <section className="sel-group rel-sec" data-testid="sel-backstory" aria-label="Backstory">
      <h4>
        Backstory{' '}
        <span className="num">
          {b.label} · {span}
        </span>
      </h4>
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
                  <MomentRow key={r.id} row={r} moment={byId.get(r.id)} onOpen={onOpen} />
                ))}
              </ul>
            </div>
          ))}
        </div>
      ) : (
        <p className="example-note">No moment of the characters here falls in {span}.</p>
      )}
    </section>
  );
}

function Culture(props: { strand: Strand; group: Group; onOpen: OpenEntry }) {
  const { strand, group } = props;
  const places = useEntries('places');
  const chapters = useEntries('chapters');
  const lines = useEntries('culturalEntries');
  const byId = useMemo(() => new Map(lines.map((l) => [l._id, l])), [lines]);
  const undo = useUndo();
  const ro = useWriteGuard();
  const unit = useBibleSettings().cultureUnit;
  const pickId = useId();
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<string[]>(strand.placeIds);
  const [newLine, setNewLine] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
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
  /** IP-2: a line in the community for the story year's unit and everyone, opened as a field. */
  const writeIt = async () => {
    if (!nearest) return;
    setError(null);
    try {
      const { entry } = await call('entry.create', {
        collection: 'culturalEntries',
        data: {
          title: '',
          communityId: nearest.id,
          ...unitSpan(unitOf(strand.year, unit), unit),
          demographic: 'all',
        },
      });
      undo.record(
        createCommand('culturalEntries', entry._id, `a line for ${nearest.label}, ${strand.year}`),
      );
      setNewLine(entry._id);
    } catch (e) {
      setError(plainError(e));
    }
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
              {placePath(places, id) || 'A place no longer in the bible'}
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
          <div className="rel-comm">{labels.get(community) ?? 'A community no longer listed'}</div>
          <ul className="plain-list">
            {items.map((it) => (
              <li key={it.id} className="rel-ce" data-testid="sel-item" data-id={it.id}>
                <EntryEditable
                  collection="culturalEntries"
                  id={it.id}
                  {...(byId.get(it.id) ? { entry: byId.get(it.id) } : {})}
                  kind="text"
                  path="title"
                  label="Cultural line"
                  placeholder="Write the line"
                  testId="culture-line"
                  autoOpen={it.id === newLine}
                  onClose={() => setNewLine((v) => (v === it.id ? null : v))}
                />{' '}
                <button
                  type="button"
                  className="link-btn rel-open"
                  aria-label={`Open ${it.title || 'the line'}`}
                  onClick={() => props.onOpen('culturalEntries', it.id)}
                >
                  Open
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
      {error && (
        <p className="callout crit" role="alert">
          {error}
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
              {...ro.tip}
              onClick={() =>
                captureNav.open(`Cultural context for ${nearest.label}, ${strand.year}: `)
              }
            >
              Add culture for {nearest.label}, {strand.year}
            </button>
            <button
              type="button"
              className="btn small"
              disabled={ro.off}
              {...ro.tip}
              aria-label={`Write a line for ${nearest.label}, ${strand.year} yourself`}
              onClick={() => void writeIt()}
              data-testid="culture-write"
            >
              Write it yourself
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
 * IP-2: the world events strip on the desk. Titles are fields with a small
 * Open beside each, and Add an event makes one at the story year and opens
 * its title on the strip.
 */
function DeskEvents(props: {
  strand: Strand;
  group: Group;
  selection: SelectionView;
  onOpen: OpenEntry;
}) {
  const { strand } = props;
  const events = useEntries('worldEvents');
  const byId = useMemo(() => new Map(events.map((e) => [e._id, e])), [events]);
  const categories = useList('eventCategories');
  const undo = useUndo();
  const ro = useWriteGuard();
  const [made, setMade] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const add = async () => {
    setError(null);
    const categoryId = categories?.items[0]?.id;
    if (!categoryId) {
      setError('Add an event category on the Lists screen first.');
      return;
    }
    try {
      const { entry } = await call('entry.create', {
        collection: 'worldEvents',
        data: { title: '', start: { year: strand.year }, categoryId },
      });
      undo.record(createCommand('worldEvents', entry._id, `an event in ${strand.year}`));
      setMade(entry._id);
    } catch (e) {
      setError(plainError(e));
    }
  };
  const renderTitle = (e: StripEvent) => (
    <span className="rel-event">
      <EntryEditable
        collection="worldEvents"
        id={e.id}
        {...(byId.get(e.id) ? { entry: byId.get(e.id) } : {})}
        kind="text"
        path="title"
        label="Event"
        placeholder="Name the event"
        testId="event-title"
        autoOpen={e.id === made}
        onClose={() => setMade((v) => (v === e.id ? null : v))}
      />{' '}
      <button
        type="button"
        className="link-btn rel-open"
        aria-label={`Open ${e.title || 'the event'}`}
        onClick={() => props.onOpen('worldEvents', e.id)}
      >
        Open
      </button>
    </span>
  );
  return (
    <EventsWindow
      strand={strand}
      group={props.group}
      window={props.selection.window}
      ahead={props.selection.ahead}
      onOpen={props.onOpen}
      renderTitle={renderTitle}
      footer={
        <div className="row tight rel-add-event">
          <button
            type="button"
            className="btn small"
            disabled={ro.off}
            {...ro.tip}
            onClick={() => void add()}
            data-testid="add-event"
          >
            Add an event in {strand.year}
          </button>
          {error && (
            <span className="callout crit" role="alert">
              {error}
            </span>
          )}
        </div>
      }
    />
  );
}

/**
 * IP-2: the heading of the desk. The chapter title, the story year and the
 * point of view of the writing strand are fields; changing the year moves
 * the story time with it while this chapter is the one being written.
 */
function DeskHeading(props: { strand: Strand; chapter: Entry | null; isWriting: boolean }) {
  const { strand, chapter } = props;
  const story = useStoryTime();
  const characters = useEntries('characters');
  const options = useMemo(() => entryOptions(characters), [characters]);
  const write = useStrandWriter(strand.chapterId);
  const strandId = strand.strandId;
  const stored = chapter && strandId ? strandById(strandsOf(chapter), strandId) : undefined;
  const year = typeof stored?.startYear === 'number' ? stored.startYear : strand.year;
  const pov = typeof stored?.povCharacterId === 'string' ? stored.povCharacterId : null;
  const editable = !!stored && !!strandId;
  return (
    <div className="row rel-head">
      {typeof chapter?.readingOrder === 'number' && (
        <span className="chip">Ch. {chapter.readingOrder}</span>
      )}
      <h3 data-testid="relevant-label">
        {chapter ? (
          <EntryEditable
            collection="chapters"
            id={chapter._id}
            entry={chapter}
            kind="text"
            path="title"
            label="Chapter title"
            allowEmpty={false}
            placeholder="Untitled chapter"
            testId="relevant-title"
          />
        ) : (
          strand.label
        )}
      </h3>
      {editable ? (
        <span className="chip time rel-head-year">
          <Editable
            kind="year"
            label="Story year"
            value={year}
            testId="relevant-year"
            data-field={`strands.${strandId}.startYear`}
            onSave={async (next) => {
              if (next === null) return;
              await write(
                (ss) => setStrandYear(ss, strandId, next),
                (before) => `Story year of ${entryTitle(before)}`,
              );
              // TM-4: the story time follows the strand being written, as the Writing picker does.
              if (props.isWriting) story.setYear(next);
            }}
          />
        </span>
      ) : (
        <span className="chip time">{strand.year}</span>
      )}
      {props.isWriting && <span className="chip now">writing now</span>}
      {editable ? (
        <span className="rel-head-pov" data-testid="relevant-pov">
          <Editable
            kind="select"
            label="Point of view"
            showLabel
            value={pov}
            options={options}
            allowEmpty
            emptyLabel="No point of view"
            placeholder="No point of view"
            data-field={`strands.${strandId}.povCharacterId`}
            onSave={async (next) => {
              await write(
                (ss) => setStrandPov(ss, strandId, next),
                (before) => `Point of view of ${entryTitle(before)}`,
              );
            }}
          />
        </span>
      ) : (
        strand.povName && <span>Point of view: {strand.povName}</span>
      )}
    </div>
  );
}

/**
 * SM-10, A35, IP-2: Relevant to Session for the strand being written, the
 * writing desk. The chapter heads it; then the scene note, the characters as
 * tiles, the five-year world events strip, the cultural context of the
 * setting in that year, and the backstory of the chapter's backstory years.
 * Everything else in the SB-2 selection folds under "More", where an entry
 * can be removed (and kept again) (SB-9). Every
 * stored value is a field (IP-1); the manuscript has Re-import (IP-18).
 */
export function RelevantBody(props: {
  selection: SelectionView;
  onOpen: OpenEntry;
  /** SM-10: Their backstory on a character tile. */
  onBackstory: (characterId: string) => void;
  /** IP-2: the family line of a tile opens the tree at that person. */
  onOpenTree?: (characterId: string) => void;
  writing: { chapterId?: string; strandId?: string } | null;
  /** SB-9: take an entry out of the selection, or put it back. */
  onRemove?: (id: string) => void;
  onKeep?: (id: string) => void;
}) {
  const { selection: sel, onOpen } = props;
  const chapters = useEntries('chapters');
  const strand =
    sel.strands.find((s) => !!props.writing?.strandId && s.strandId === props.writing.strandId) ??
    sel.strands[0];
  if (!strand) {
    return <p className="example-note">This chapter has no strand with a story year.</p>;
  }
  const chapter = chapters.find((c) => c._id === strand.chapterId) ?? null;
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
            items: g.items.filter((it) => !onEventStrip(it, strand.year, sel.ahead)),
          }
        : g,
    );
  const heading = chapter ? entryTitle(chapter) || 'Untitled chapter' : strand.label;
  const action = props.onRemove ? removeAction(props.onRemove) : undefined;
  return (
    <section
      className="panel stack rel-strand"
      data-testid="relevant-strand"
      data-strand={strand.strandId ?? ''}
      aria-label={heading}
    >
      <DeskHeading strand={strand} chapter={chapter} isWriting={isWriting} />
      {strand.chapterId && <SceneNote key={strand.chapterId} chapterId={strand.chapterId} />}
      {characters && (
        <Characters
          group={characters}
          strand={strand}
          chapter={chapter}
          pov={strand.povCharacterId}
          onOpen={onOpen}
          onBackstory={props.onBackstory}
          onOpenTree={props.onOpenTree}
        />
      )}
      {events && <DeskEvents strand={strand} group={events} selection={sel} onOpen={onOpen} />}
      {culture && (
        <Culture key={strand.strandId ?? ''} strand={strand} group={culture} onOpen={onOpen} />
      )}
      <Backstory strand={strand} onOpen={onOpen} />
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
            <GroupBlock key={g.kind} group={g} onOpen={onOpen} action={action} />
          ))}
          {sel.shared.map((g) => (
            <GroupBlock key={`shared-${g.kind}`} group={g} onOpen={onOpen} action={action} />
          ))}
          {sel.omitted.length > 0 && (
            <section data-testid="sel-omitted" aria-label="Left out">
              <h4>Left out</h4>
              <OmittedList selection={sel} onKeep={props.onKeep} />
            </section>
          )}
          <p className="example-note">{sel.ids.length} entries.</p>
        </div>
      </details>
      {chapter && <Reimport chapter={chapter} />}
    </section>
  );
}
