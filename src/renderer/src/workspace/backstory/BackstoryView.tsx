import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { entryTitle, manifests } from '../../../../shared/schema';
import type { EntryCollection } from '../../../../shared/schema';
import { blankEntry } from '../../../../shared/domain/blank';
import { backstoryGrid, momentsOf, writingBand } from '../../../../shared/domain/backstoryGrid';
import type { BackstoryMoment } from '../../../../shared/domain/backstoryGrid';
import {
  eraSpans,
  eventSpans,
  fromCollections,
  strandSpans,
} from '../../../../shared/domain/timeline';
import { shiftEnd, shiftSpan } from '../../../../shared/domain/worldGrid';
import type { Zoom } from '../../../../shared/domain/worldGrid';
import type { StoredPositions } from '../../../../shared/domain/tree';
import { createCommand, editCommand, restoreCommand } from '../../../../shared/domain/undoRunner';
import { useWriteGuard } from '../../connection';
import { call, plainError } from '../../api';
import { useEntries } from '../data';
import { useStoryTime } from '../storyTime';
import { useUndo } from '../undo';
import { BackstoryGrid } from './BackstoryGrid';
import { MomentsTable } from './MomentsTable';
import type { MomentField } from './MomentsTable';
import type { MovePart } from '../timeline/gridShared';
import './backstory.css';

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
};

/**
 * The Backstory screen (SM-9): the character grid on the World events axis,
 * then the picked person's moments as an editable table. Every write goes
 * through the write path with one undo step (ED-3); nothing here is computed
 * by a model.
 */
export function BackstoryView(props: {
  characterId?: string;
  /** Opens an entry in its section: an era picked in the era band. */
  onOpen?: (collection: EntryCollection, id: string) => void;
}) {
  const story = useStoryTime();
  const year = story.year;
  const undo = useUndo();
  const ro = useWriteGuard();
  const characters = useEntries('characters');
  const families = useEntries('families');
  const unions = useEntries('unions');
  const parentLinks = useEntries('parentLinks');
  const momentEntries = useEntries('moments');
  const worldEvents = useEntries('worldEvents');
  const eraEntries = useEntries('eraStates');
  const chapters = useEntries('chapters');
  const [positions, setPositions] = useState<StoredPositions | null>(null);
  const [picked, setPicked] = useState<string | null>(props.characterId ?? null);
  const [selected, setSelected] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
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

  // Their backstory button (SM-10) opens on a person, also when the screen is already open.
  const [openedFor, setOpenedFor] = useState(props.characterId);
  if (props.characterId !== openedFor) {
    setOpenedFor(props.characterId);
    if (props.characterId) {
      setPicked(props.characterId);
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
      }),
    [characters, families, unions, parentLinks, momentEntries, positions],
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
  const person = picked ? grid.people.get(picked) : undefined;
  const rows = useMemo(
    () => (picked ? momentsOf(grid.moments, picked) : []),
    [grid.moments, picked],
  );

  const clearFocus = useCallback(() => setFocusId(null), []);

  const pick = (id: string) => {
    setPicked(id);
    setSelected(null);
  };

  const create = async (characterId: string, at: number) => {
    setError(null);
    if (ro.off) return;
    const data: Record<string, unknown> = {
      ...blankEntry(manifests.moments),
      title: '',
      status: 'idea',
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

  /** Cell saves run one after another, so a blur and a pick right after it land in order. */
  const saving = useRef<Promise<unknown>>(Promise.resolve());

  const save = (id: string, field: MomentField, value: string | number | null) => {
    setError(null);
    if (ro.off) return Promise.resolve();
    const run = saving.current.then(async () => {
      try {
        // The stored entry as it is now, so each step undoes exactly its own change.
        const before = (await call('entry.get', { collection: 'moments', id })).entry as Record<
          string,
          unknown
        >;
        const patch: Record<string, unknown> = { [field]: value };
        // A moment over several years keeps its length when its year changes.
        if (field === 'year' && typeof value === 'number' && typeof before.endYear === 'number') {
          patch.endYear = before.endYear + (value - Number(before.year));
        }
        const { entry } = await call('entry.update', { collection: 'moments', id, patch });
        const title = entryTitle(entry) || 'a moment';
        undo.record(
          editCommand(`Changed ${FIELD_WORDS[field]} of ${title}`, 'moments', id, before, entry),
        );
        // Only a cell of this row counts the stored value as saved (ED-3).
        const row = (document.activeElement as HTMLElement | null)?.closest('tr');
        if (row?.getAttribute('data-id') === id) undo.markSaved(entry);
      } catch (e) {
        setError(plainError(e));
        throw e;
      }
    });
    saving.current = run.catch(() => undefined);
    return run;
  };

  const move = async (id: string, delta: number, part: MovePart) => {
    setError(null);
    if (ro.off) return;
    const before = momentEntries.find((e) => e._id === id);
    const m = grid.moments.find((x) => x.id === id);
    if (!before || !m) return;
    let patch: Record<string, unknown>;
    let label: string;
    if (part === 'span') {
      const moved = shiftSpan(m.year, m.endYear ?? m.year, delta, span);
      if (moved.delta === 0) return;
      patch = {
        year: moved.startYear,
        endYear: m.endYear === null ? null : m.endYear + moved.delta,
      };
      label = `Moved ${m.title.trim() || 'a moment'} to ${moved.startYear}`;
    } else {
      const end = m.endYear ?? m.year;
      const to = shiftEnd(m.year, end, delta, span);
      if (to === end) return;
      patch = { endYear: to === m.year ? null : to };
      label = `Set the end of ${m.title.trim() || 'a moment'} to ${to}`;
    }
    try {
      const { entry } = await call('entry.update', { collection: 'moments', id, patch });
      undo.record(editCommand(label, 'moments', id, before, entry));
    } catch (e) {
      setError(plainError(e));
    }
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
        </span>
      </div>
      <div className="tree-toolbar wg-toolbar bs-toolbar">
        <div className="row tight" role="group" aria-label="Zoom">
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
        </div>
      </div>
      {error && (
        <p className="callout crit" role="alert">
          {error}
        </p>
      )}
      <p className="bs-help">
        Pick a name to list their moments below. Click an empty spot in a row to add a moment at
        that year. Drag a marker to change its year. From the keyboard, Tab to the markers, Up and
        Down move between them, Enter picks one, and Left and Right change its year.
      </p>
      <BackstoryGrid
        grid={grid}
        eras={eras}
        span={span}
        zoom={zoom}
        storyYear={year}
        writing={writing}
        pickedId={picked}
        selectedMomentId={selected}
        readOnly={ro.off}
        onPick={pick}
        onPickMoment={(id, characterId) => {
          setPicked(characterId);
          setSelected(id);
        }}
        onOpenEra={(id) => props.onOpen?.('eraStates', id)}
        onMove={move}
        onCreate={create}
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
      {person ? (
        <MomentsTable
          person={person}
          moments={rows}
          events={events}
          selectedId={selected}
          focusId={focusId}
          onFocused={clearFocus}
          onSelect={setSelected}
          onSave={save}
          onAdd={() => create(person.id, year)}
          onTrashed={trashedOne}
        />
      ) : (
        <p className="bs-empty" data-testid="backstory-none">
          Pick a person in the grid to see and edit their moments.
        </p>
      )}
    </div>
  );
}
