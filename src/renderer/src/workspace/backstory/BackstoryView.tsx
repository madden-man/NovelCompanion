import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { entryTitle, manifests } from '../../../../shared/schema';
import type { EntryCollection } from '../../../../shared/schema';
import { blankEntry } from '../../../../shared/domain/blank';
import {
  backstoryGrid,
  insertMention,
  lifeProblem,
  lifespanOf,
  momentsOf,
  moveLifeEnd,
  withMentionLink,
  withYear,
} from '../../../../shared/domain/backstoryGrid';
import type { BackstoryMoment } from '../../../../shared/domain/backstoryGrid';
import {
  eraSpans,
  eventSpans,
  fromCollections,
  strandSpans,
} from '../../../../shared/domain/timeline';
import { shiftEnd, shiftSpan, writingBand } from '../../../../shared/domain/worldGrid';
import type { EdgeSide, Zoom } from '../../../../shared/domain/worldGrid';
import type { StoryDate } from '../../../../shared/schema';
import type { StoredPositions } from '../../../../shared/domain/tree';
import { createCommand, editCommand, restoreCommand } from '../../../../shared/domain/undoRunner';
import { useWriteGuard } from '../../connection';
import { call, plainError } from '../../api';
import { useEntries } from '../data';
import { useStoryTime } from '../storyTime';
import { useUndo } from '../undo';
import { BackstoryGrid } from './BackstoryGrid';
import { MomentDialog } from './MomentDialog';
import type { MomentField } from './MomentDialog';
import { MomentCreate } from './MomentCreate';
import { useEraEdits, useTitleRename } from '../timeline/gridShared';
import type { MovePart } from '../timeline/gridShared';
import './backstory.css';
import { useBibleSettings, useDefaultStatus } from '../bibleSettings';

const ZOOMS: { zoom: Zoom; label: string }[] = [
  { zoom: 'fit', label: 'Whole span' },
  { zoom: 'default', label: 'Medium' },
  { zoom: 'close', label: 'Close' },
];

const FIELD_WORDS: Record<MomentField, string> = {
  year: 'the year',
  endYear: 'the last year',
  title: 'what happens',
  body: 'how they experience it',
  worldContext: 'the relevant world events',
  characterId: 'whose moment it is',
};

/**
 * The Backstory screen (SM-9): the character grid on the World events axis,
 * which is the list of moments; a moment opens in a dialog to edit (A49), and
 * the head bar makes new ones. A click on a name opens that person's timeline
 * across the section (A50); Show everyone, Escape or the name again go back. Every write goes through the write path with
 * one undo step (ED-3); nothing here is computed by a model.
 */
export function BackstoryView(props: {
  characterId?: string;
  /** When the request to open on that person was made: every new request picks them again. */
  openedAt?: number;
  /** Opens an entry in its section: an era picked in the era band. */
  onOpen?: (collection: EntryCollection, id: string) => void;
}) {
  const story = useStoryTime();
  const year = story.year;
  const undo = useUndo();
  const ro = useWriteGuard();
  const characters = useEntries('characters');
  const families = useEntries('families');
  const { numbers } = useBibleSettings();
  const statusOf = useDefaultStatus();
  const unions = useEntries('unions');
  const parentLinks = useEntries('parentLinks');
  const momentEntries = useEntries('moments');
  const worldEvents = useEntries('worldEvents');
  const eraEntries = useEntries('eraStates');
  const chapters = useEntries('chapters');
  const [positions, setPositions] = useState<StoredPositions | null>(null);
  const [picked, setPicked] = useState<string | null>(props.characterId ?? null);
  // A50: the person whose timeline fills the section, or null for everyone.
  const [person, setPerson] = useState<string | null>(props.characterId ?? null);
  const [selected, setSelected] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [freshKey, setFreshKey] = useState(0);
  const [zoom, setZoom] = useState<Zoom>('fit');
  const [error, setError] = useState<string | null>(null);
  const [trashed, setTrashed] = useState<{ title: string; id: string } | null>(null);

  // The tree's stored places set the order of the rows (FT-10, FT-11).
  useEffect(() => {
    let live = true;
    void call('tree.get', {})
      .then((r) => {
        if (live) setPositions(r.positions ?? null);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [characters, unions, parentLinks]);

  // Their backstory button (SM-10) opens on a person, also when the screen is already open
  // and when it is the same person again after another was picked.
  const [openedFor, setOpenedFor] = useState(props.openedAt);
  if (props.openedAt !== openedFor) {
    setOpenedFor(props.openedAt);
    if (props.characterId) {
      setPicked(props.characterId);
      setPerson(props.characterId);
      setSelected(null);
    }
  }

  const grid = useMemo(
    () =>
      backstoryGrid({
        characters,
        families,
        unions,
        parentLinks,
        moments: momentEntries,
        positions,
        base: { from: numbers.timelineStart, to: numbers.timelineEnd },
      }),
    [characters, families, unions, parentLinks, momentEntries, positions, numbers],
  );
  const span = useMemo(() => {
    const s = grid.span;
    return { from: Math.min(s.from, year), to: Math.max(s.to, year) };
  }, [grid.span, year]);
  const eras = useMemo(() => eraSpans(fromCollections({ eraStates: eraEntries })), [eraEntries]);
  const events = useMemo(() => eventSpans(fromCollections({ worldEvents })), [worldEvents]);
  const writing = useMemo(
    () =>
      writingBand(
        strandSpans(fromCollections({ chapters })),
        story.time?.chapterId,
        story.time?.strandId,
      ),
    [chapters, story.time?.chapterId, story.time?.strandId],
  );
  const pickedPerson = picked ? grid.people.get(picked) : undefined;
  // A person no longer in the grid (trashed meanwhile) leaves the view for everyone.
  const viewing = person !== null && grid.people.has(person) ? person : null;
  const everyone = useMemo(() => grid.families.flatMap((f) => f.people), [grid.families]);
  const eraEdits = useEraEdits({ eras, span, readOnly: ro.off, onError: setError });
  const renameMoment = useTitleRename('moments');

  // A49: the dialog shows the selected moment while it is live; Previous and Next walk its
  // person's moments in year order (SM-9).
  const open = selected ? (grid.moments.find((m) => m.id === selected) ?? null) : null;
  const theirs = useMemo(
    () => (open ? momentsOf(grid.moments, open.characterId) : []),
    [grid.moments, open],
  );
  const place = open ? theirs.findIndex((m) => m.id === open.id) : -1;
  const prev = place > 0 ? theirs[place - 1] : undefined;
  const next = place >= 0 && place < theirs.length - 1 ? theirs[place + 1] : undefined;
  // What happens opens on the dialog's first render only; a step or a close forgets it.
  const fresh = open !== null && focusId === open.id;
  const show = useCallback((id: string | null) => {
    setFocusId(null);
    setSelected(id);
  }, []);
  // The grid keeps the open moment's marker in view, as the table kept its row.
  const openId = open?.id ?? null;
  useEffect(() => {
    if (!openId) return;
    document
      .querySelector(`[data-testid="backstory-grid"] .wg-marker[data-id="${CSS.escape(openId)}"]`)
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [openId]);
  const closeDialog = useCallback(() => show(null), [show]);
  /** A49: a double-click on a marker opens its moment with What happens open, as a new one does. */
  const openTitle = (id: string, characterId: string) => {
    setPicked(characterId);
    setSelected(id);
    setFocusId(id);
    setFreshKey((k) => k + 1);
  };

  /** A50: the name cell opens the person's timeline, and in it goes back to everyone. */
  const pick = (id: string) => {
    if (viewing === id) {
      setPerson(null);
      return;
    }
    setPicked(id);
    setPerson(id);
    setSelected(null);
  };
  /** A50: back to everyone; the pick stays. */
  const showEveryone = useCallback(() => setPerson(null), []);

  // A50: on the way back to everyone the person's row scrolls into view and their name cell
  // takes the focus; on the way in, the name cell keeps it when nothing else has it.
  const shownFor = useRef(viewing);
  useEffect(() => {
    const was = shownFor.current;
    shownFor.current = viewing;
    if (was === viewing) return;
    const id = viewing ?? was;
    if (!id) return;
    const row = document.querySelector<HTMLElement>(
      `[data-testid="backstory-grid"] .bs-row[data-person="${CSS.escape(id)}"]`,
    );
    if (!row) return;
    const now = document.activeElement;
    if (viewing === null) row.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    if (viewing === null || !now || now === document.body) {
      row.querySelector<HTMLElement>('.bs-row-label')?.focus({ preventScroll: true });
    }
  }, [viewing]);

  /** A new moment picks its person and opens in the dialog with What happens open. */
  const create = async (characterId: string, at: number) => {
    setError(null);
    if (ro.off) return;
    const data: Record<string, unknown> = {
      ...blankEntry(manifests.moments),
      title: '',
      status: statusOf('idea'),
      characterId,
      year: at,
      endYear: null,
    };
    try {
      const { entry } = await call('entry.create', { collection: 'moments', data });
      const who = grid.people.get(characterId)?.name ?? 'someone';
      undo.record(createCommand('moments', entry._id, `a moment for ${who} in ${at}`));
      setPicked(characterId);
      setSelected(entry._id);
      setFocusId(entry._id);
    } catch (e) {
      setError(plainError(e));
    }
  };

  /** Cell saves and marker moves run one after another, so each starts from the last one's result. */
  const saving = useRef<Promise<unknown>>(Promise.resolve());
  const queue = (job: () => Promise<void>): Promise<void> => {
    const run = saving.current.then(async () => {
      try {
        await job();
      } catch (e) {
        setError(plainError(e));
        throw e;
      }
    });
    saving.current = run.catch(() => undefined);
    return run;
  };

  /** `mentioned`: entries picked with `@` in the text, linked in the same step (ED-9). */
  const save = (
    id: string,
    field: MomentField,
    value: string | number | null,
    mentioned: readonly string[] = [],
  ) => {
    setError(null);
    if (ro.off) return Promise.resolve();
    return queue(async () => {
      // The stored entry as it is now, so each step undoes exactly its own change.
      const before = (await call('entry.get', { collection: 'moments', id })).entry as Record<
        string,
        unknown
      >;
      const patch: Record<string, unknown> = { [field]: value };
      if (mentioned.length) {
        let links = Array.isArray(before.links)
          ? (before.links as { targetId: string; kind: string }[])
          : [];
        for (const t of mentioned) links = withMentionLink(links, t);
        patch.links = links;
      }
      // A moment over several years keeps its length when its year changes.
      if (field === 'year' && typeof value === 'number' && typeof before.endYear === 'number') {
        patch.endYear = before.endYear + (value - Number(before.year));
      }
      const { entry } = await call('entry.update', { collection: 'moments', id, patch });
      const title = entryTitle(entry) || 'a moment';
      undo.record(
        editCommand(`Changed ${FIELD_WORDS[field]} of ${title}`, 'moments', id, before, entry),
      );
      // Only a field of this moment's dialog counts the stored value as saved (ED-3).
      const dialog = (document.activeElement as HTMLElement | null)?.closest(
        '[data-testid="moment-dialog"]',
      );
      if (dialog?.getAttribute('data-id') === id) undo.markSaved(entry);
    });
  };

  /**
   * A marker moved by a drag or an arrow key. It joins the cell saves' queue
   * and reads the stored moment first, so quick presses add up and never
   * write over a save still on its way.
   */
  const move = (id: string, delta: number, part: MovePart) => {
    setError(null);
    if (ro.off) return Promise.resolve();
    return queue(async () => {
      const before = (await call('entry.get', { collection: 'moments', id })).entry as Record<
        string,
        unknown
      >;
      const year = Number(before.year);
      const endYear = typeof before.endYear === 'number' ? before.endYear : null;
      const title = (typeof before.title === 'string' && before.title.trim()) || 'a moment';
      let patch: Record<string, unknown>;
      let label: string;
      if (part === 'span') {
        const moved = shiftSpan(year, endYear ?? year, delta, span);
        if (moved.delta === 0) return;
        patch = {
          year: moved.startYear,
          endYear: endYear === null ? null : endYear + moved.delta,
        };
        label = `Moved ${title} to ${moved.startYear}`;
      } else {
        const end = endYear ?? year;
        const to = shiftEnd(year, end, delta, span);
        if (to === end) return;
        patch = { endYear: to === year ? null : to };
        label = `Set the end of ${title} to ${to}`;
      }
      const { entry } = await call('entry.update', { collection: 'moments', id, patch });
      undo.record(editCommand(label, 'moments', id, before, entry));
    }).catch(() => undefined);
  };

  /**
   * IP-4, ED-9: mention a world event in a moment's Relevant world events: the
   * `@Title` on a line of its own and the link to the event, one step. It joins
   * the queue, so a cell saved on its way out (the blur before the click) lands first.
   */
  const mention = (id: string, event: { id: string; title: string }) => {
    setError(null);
    if (ro.off) return Promise.resolve();
    return queue(async () => {
      const before = (await call('entry.get', { collection: 'moments', id })).entry as Record<
        string,
        unknown
      >;
      const text = typeof before.worldContext === 'string' ? before.worldContext : '';
      const links = Array.isArray(before.links)
        ? (before.links as { targetId: string; kind: string }[])
        : [];
      const worldContext = insertMention(text, event.title);
      const nextLinks = withMentionLink(links, event.id);
      if (worldContext === text && nextLinks.length === links.length) return;
      const { entry } = await call('entry.update', {
        collection: 'moments',
        id,
        patch: { worldContext, links: nextLinks },
      });
      const title = entryTitle(entry) || 'a moment';
      undo.record(
        editCommand(`Mentioned ${event.title} in ${title}`, 'moments', id, before, entry),
      );
    });
  };

  /**
   * IP-4: a lifespan end dragged or keyed: the birth or the death moves by
   * whole years through the write path, one step. A death before the birth is
   * refused with the reason (ED-10) and the bar stays where it was.
   */
  const lifeEnd = (characterId: string, side: EdgeSide, delta: number) => {
    setError(null);
    if (ro.off) return Promise.resolve();
    return queue(async () => {
      const before = (await call('entry.get', { collection: 'characters', id: characterId }))
        .entry as Record<string, unknown>;
      const birth = (before.birth ?? null) as StoryDate | null;
      const death = (before.death ?? null) as StoryDate | null;
      const moved = moveLifeEnd(lifespanOf({ birth, death }), side, delta, span);
      if (!moved) return;
      const problem = lifeProblem(moved.from, moved.to, side);
      if (problem) {
        setError(problem);
        return;
      }
      const name = grid.people.get(characterId)?.name ?? entryTitle(before as never);
      let patch: Record<string, unknown>;
      let label: string;
      if (side === 'start') {
        if (moved.from === lifespanOf({ birth, death }).from) return;
        patch = { birth: withYear(birth, moved.from) };
        label = `Moved the birth of ${name} to ${moved.from}`;
      } else {
        if (moved.to === null || moved.to === lifespanOf({ birth, death }).to) return;
        patch = { death: withYear(death, moved.to) };
        label = `Moved the death of ${name} to ${moved.to}`;
      }
      const { entry } = await call('entry.update', {
        collection: 'characters',
        id: characterId,
        patch,
      });
      undo.record(editCommand(label, 'characters', characterId, before, entry));
    }).catch(() => undefined);
  };

  /** ED-5: the confirm moved it to the trash as one undo step; offer Undo here too. */
  const trashedOne = (m: BackstoryMoment) => {
    setTrashed({ title: m.title.trim() || `the moment of ${m.year}`, id: m.id });
    if (selected === m.id) setSelected(null);
  };

  const undoTrash = async () => {
    if (!trashed || ro.off) return;
    const t = trashed;
    setTrashed(null);
    const top = undo.history.undo[undo.history.undo.length - 1];
    const op = top?.undo.length === 1 ? top.undo[0] : undefined;
    if (op?.kind === 'restore' && op.collection === 'moments' && op.id === t.id) {
      await undo.undo();
    } else {
      // Something else was done since: bring this one back as a step of its own.
      try {
        await call('entry.restore', { collection: 'moments', id: t.id });
        undo.record(restoreCommand('moments', t.id, t.title));
      } catch (e) {
        setError(plainError(e));
      }
    }
    setSelected(t.id);
  };

  return (
    <div className="bs-area stack" data-testid="backstory-view">
      <div className="list-head">
        <h2 id="backstory-title">Backstory</h2>
        <span className="row tight">
          <span className="chip time" data-testid="backstory-time">
            Story time {year}
          </span>
          <button type="button" className="btn small" onClick={story.openDialog}>
            Change
          </button>
          <span className="row tight wg-toolbar bs-zoom" role="group" aria-label="Zoom">
            <span className="wg-toolbar-label">Zoom</span>
            {ZOOMS.map((z) => (
              <button
                key={z.zoom}
                type="button"
                className="btn small"
                aria-pressed={zoom === z.zoom}
                onClick={() => setZoom(z.zoom)}
              >
                {z.label}
              </button>
            ))}
          </span>
        </span>
        <MomentCreate
          person={(viewing !== null ? grid.people.get(viewing) : pickedPerson) ?? null}
          people={everyone}
          viewing={viewing !== null}
          onAdd={(id) => create(id, year)}
          onShowEveryone={showEveryone}
          onClear={() => {
            setPicked(null);
            setSelected(null);
          }}
        />
      </div>
      {error && (
        <p className="callout crit" role="alert">
          {error}
        </p>
      )}
      <BackstoryGrid
        grid={grid}
        eras={eras}
        span={span}
        zoom={zoom}
        storyYear={year}
        writing={writing}
        pickedId={picked}
        personId={viewing}
        selectedMomentId={selected}
        readOnly={ro.off}
        onPick={pick}
        onLeavePerson={showEveryone}
        onPickMoment={(id, characterId) => {
          setPicked(characterId);
          setSelected(id);
        }}
        onOpenMoment={openTitle}
        onOpenEra={(id) => props.onOpen?.('eraStates', id)}
        onMove={move}
        onCreate={create}
        onLifeEnd={lifeEnd}
        onOpenPerson={props.onOpen ? (id) => props.onOpen?.('characters', id) : undefined}
        onRename={renameMoment}
        eraEdits={eraEdits}
      />
      <div className="legend" aria-label="Grid legend">
        <span>
          <span className="bs-key life" aria-hidden="true" />
          Lifespan, in the family colour
        </span>
        <span>
          <span className="bs-key life dash" aria-hidden="true" />
          Alive past the story year
        </span>
        <span>
          <span className="wg-key dot" aria-hidden="true" />
          Moment
        </span>
        <span>
          <span className="wg-key bar" aria-hidden="true" />
          Moment over several years
        </span>
        <span>
          <span className="wg-key story" aria-hidden="true" />
          Story year
        </span>
        <span>
          <span className="wg-key writing" aria-hidden="true" />
          Chapter being written
        </span>
      </div>
      {trashed && !momentEntries.some((e) => e._id === trashed.id) && (
        <p className="callout bs-trashed" role="status" data-testid="moment-trashed">
          Moved {trashed.title} to the trash.{' '}
          <button
            type="button"
            className="btn small"
            disabled={ro.off}
            {...ro.tip}
            onClick={() => void undoTrash()}
          >
            Undo
          </button>
        </p>
      )}
      {open && (
        <MomentDialog
          moment={open}
          person={grid.people.get(open.characterId) ?? null}
          people={everyone}
          events={events}
          fresh={fresh}
          freshKey={freshKey}
          onOpenTitle={() => openTitle(open.id, open.characterId)}
          onSave={(field, value, mentioned) => save(open.id, field, value, mentioned)}
          onMention={(e) => mention(open.id, e)}
          onTrashed={() => trashedOne(open)}
          onClose={closeDialog}
          onPrev={prev ? () => show(prev.id) : null}
          onNext={next ? () => show(next.id) : null}
        />
      )}
    </div>
  );
}
