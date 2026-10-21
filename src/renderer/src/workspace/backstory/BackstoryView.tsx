import { useEffect, useMemo, useState } from 'react';
import { entryTitle, manifests } from '../../../../shared/schema';
import { blankEntry } from '../../../../shared/domain/blank';
import { backstoryGrid, momentsOf, writingBand } from '../../../../shared/domain/backstoryGrid';
import type { BackstoryMoment } from '../../../../shared/domain/backstoryGrid';
import {
  eraSpans,
  eventSpans,
  fromCollections,
  strandSpans,
} from '../../../../shared/domain/timeline';
import { shiftSpan } from '../../../../shared/domain/worldGrid';
import type { Zoom } from '../../../../shared/domain/worldGrid';
import type { StoredPositions } from '../../../../shared/domain/tree';
import {
  createCommand,
  deleteCommand,
  editCommand,
  restoreCommand,
} from '../../../../shared/domain/undoRunner';
import type { UndoCommand } from '../../../../shared/domain/undoRunner';
import { useWriteGuard } from '../../connection';
import { call, plainError } from '../../api';
import { useEntries } from '../data';
import { useStoryTime } from '../storyTime';
import { useUndo } from '../undo';
import { BackstoryGrid } from './BackstoryGrid';
import { MomentsTable } from './MomentsTable';
import type { MomentField } from './MomentsTable';
import './backstory.css';

const ZOOMS: { zoom: Zoom; label: string }[] = [
  { zoom: 'fit', label: 'Whole span' },
  { zoom: 'default', label: 'Medium' },
  { zoom: 'close', label: 'Close' },
];

const FIELD_WORDS: Record<MomentField, string> = {
  year: 'the year',
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
export function BackstoryView(props: { characterId?: string }) {
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
  const [trashed, setTrashed] = useState<{ cmd: UndoCommand; title: string; id: string } | null>(
    null,
  );

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

  const pick = (id: string) => {
    setPicked(id);
    setSelected(null);
  };

  const create = async (characterId: string, at: number) => {
    setError(null);
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

  const save = async (id: string, field: MomentField, value: string | number) => {
    setError(null);
    const before = momentEntries.find((e) => e._id === id);
    if (!before) return;
    const patch: Record<string, unknown> = { [field]: value };
    // A moment over several years keeps its length when its year changes.
    if (field === 'year' && typeof value === 'number' && typeof before.endYear === 'number') {
      patch.endYear = before.endYear + (value - Number(before.year));
    }
    try {
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
  };

  const move = async (id: string, delta: number) => {
    setError(null);
    const before = momentEntries.find((e) => e._id === id);
    const m = grid.moments.find((x) => x.id === id);
    if (!before || !m) return;
    const moved = shiftSpan(m.year, m.endYear ?? m.year, delta, span);
    if (moved.delta === 0) return;
    const patch: Record<string, unknown> = {
      year: moved.startYear,
      endYear: m.endYear === null ? null : m.endYear + moved.delta,
    };
    try {
      const { entry } = await call('entry.update', { collection: 'moments', id, patch });
      const title = entryTitle(entry) || 'a moment';
      undo.record(
        editCommand(`Moved ${title} to ${moved.startYear}`, 'moments', id, before, entry),
      );
    } catch (e) {
      setError(plainError(e));
    }
  };

  const remove = async (m: BackstoryMoment) => {
    setError(null);
    const title = m.title.trim() || 'a moment';
    try {
      await call('entry.delete', { collection: 'moments', id: m.id });
      const cmd = deleteCommand('moments', m.id, title);
      undo.record(cmd);
      setTrashed({ cmd, title, id: m.id });
      if (selected === m.id) setSelected(null);
    } catch (e) {
      setError(plainError(e));
    }
  };

  const undoTrash = async () => {
    if (!trashed) return;
    const t = trashed;
    setTrashed(null);
    const top = undo.history.undo[undo.history.undo.length - 1];
    if (top === t.cmd) {
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
          <button type="button" className="btn small" onClick={() => void undoTrash()}>
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
          readOnly={ro.off}
          onFocused={() => setFocusId(null)}
          onSelect={setSelected}
          onSave={save}
          onAdd={() => create(person.id, year)}
          onDelete={remove}
        />
      ) : (
        <p className="bs-empty" data-testid="backstory-none">
          Pick a person in the grid to see and edit their moments.
        </p>
      )}
    </div>
  );
}
