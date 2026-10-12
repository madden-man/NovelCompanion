import { useMemo, useState } from 'react';
import { beatOrderIn, beatsOfArc } from '../../../../shared/domain/outline';
import type { Doc } from '../../../../shared/domain/paths';
import { entryTitle } from '../../../../shared/schema';
import { useEntries } from '../data';
import type { Entry } from '../data';
import { EmbeddedEditor } from '../editor';
import { Zh } from '../Zh';
import type { OutlineWrites } from './actions';
import { InlineName, NameForm } from './InlineName';

const SCOPES: Record<string, string> = {
  book: 'Whole book',
  family: 'A family',
  character: 'A character',
  custom: 'Custom',
};

/** The position after the last beat of an arc, for a new beat placed at its end. */
export function lastBeatOrder(beats: readonly Doc[], arcId: string): number {
  return Math.max(0, ...beatsOfArc(beats, arcId).map((b) => beatOrderIn(b, arcId)));
}

const arcName = (a: Entry) =>
  typeof a.name === 'string' && a.name.trim() ? a.name.trim() : entryTitle(a);

function years(a: Entry): string {
  const from = typeof a.startYear === 'number' ? a.startYear : null;
  const to = typeof a.endYear === 'number' ? a.endYear : null;
  if (from === null && to === null) return 'years from its chapters';
  if (from !== null && to !== null && from !== to) return `${from} to ${to}`;
  return String(from ?? to);
}

/**
 * KB-3, PL-1: the arcs of the story, in a disclosure on the outline. Each
 * shows its owner and scope; picking one highlights its spans on the grid and
 * opens it in the inspector with its beats. New arc adds one here.
 */
export function ArcsList(props: {
  selected: string | null;
  writes: OutlineWrites;
  onOpen: (id: string) => void;
}) {
  const arcs = useEntries('arcs');
  const characters = useEntries('characters');
  const families = useEntries('families');
  const beats = useEntries('plotBeats');
  const [adding, setAdding] = useState(false);
  const titleOf = useMemo(() => {
    const byId = new Map([...characters, ...families].map((e) => [e._id, entryTitle(e)]));
    return (id: unknown) => (typeof id === 'string' ? (byId.get(id) ?? null) : null);
  }, [characters, families]);
  const sorted = [...arcs].sort((a, b) => arcName(a).localeCompare(arcName(b)));

  return (
    <details className="ol-arcs" data-testid="outline-arcs">
      <summary>Arcs ({arcs.length})</summary>
      <div className="stack tight">
        {adding ? (
          <NameForm
            label="Arc name"
            submit="Create arc"
            testId="new-arc"
            onCancel={() => setAdding(false)}
            onSubmit={async (name) => {
              const id = await props.writes.create('arcs', {
                title: name,
                name,
                scope: 'custom',
                status: 'idea',
              });
              if (id) {
                setAdding(false);
                props.onOpen(id);
              }
            }}
          />
        ) : (
          <button
            type="button"
            className="btn small"
            disabled={props.writes.ro.off}
            {...props.writes.ro.tip}
            onClick={() => setAdding(true)}
          >
            New arc
          </button>
        )}
        {sorted.length === 0 ? (
          <p className="example-note">No arcs yet.</p>
        ) : (
          <ul className="stack-list ol-arc-list">
            {sorted.map((a) => {
              const owner = titleOf(a.ownerCharacterId) ?? titleOf(a.familyId);
              const count = beatsOfArc(beats, a._id).length;
              return (
                <li key={a._id} data-arc-row={a._id}>
                  <button
                    type="button"
                    className="link-btn"
                    aria-pressed={props.selected === a._id}
                    onClick={() => props.onOpen(a._id)}
                  >
                    <Zh text={arcName(a)} actions={false} />
                  </button>{' '}
                  <span className="example-note">
                    {SCOPES[String(a.scope)] ?? 'Custom'}
                    {owner ? `, ${owner}` : ''}, {years(a)},{' '}
                    {count === 1 ? '1 beat' : `${count} beats`}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </details>
  );
}

/**
 * KB-3, PL-3: one arc in the inspector: rename it in its heading, see and
 * reorder its beats (drag or Up and Down), add a beat, and edit its details.
 */
export function ArcPanel(props: {
  id: string;
  writes: OutlineWrites;
  onClose: () => void;
  onOpenBeat: (id: string) => void;
}) {
  const { id, writes } = props;
  const arcs = useEntries('arcs');
  const beats = useEntries('plotBeats');
  const [dragging, setDragging] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const arc = arcs.find((a) => a._id === id) ?? null;
  const list = useMemo(() => beatsOfArc(beats, id), [beats, id]);
  if (!arc) {
    return (
      <div className="stack tight">
        <p className="example-note">Loading the arc.</p>
        <button type="button" className="btn small" onClick={props.onClose}>
          Close the arc
        </button>
      </div>
    );
  }
  const name = arcName(arc);
  const moveTo = (beatId: string, to: number) => {
    if (to < 0 || to >= list.length) return;
    void writes.reorder(
      { kind: 'beats', groupId: id, movedId: beatId, toIndex: to },
      `Moved a beat in ${name}`,
    );
  };

  return (
    <div className="stack" data-testid="arc-panel" data-arc-id={id}>
      <div className="row tight">
        <button type="button" className="btn small" onClick={props.onClose}>
          Close the arc
        </button>
      </div>
      <h3>
        <InlineName
          value={name}
          label="Arc name"
          disabled={writes.ro.off}
          testId="arc-name"
          onSave={(next) => writes.edit('arcs', id, { name: next }, `Renamed the arc ${name}`)}
        >
          <Zh text={name} actions={false} />
        </InlineName>
      </h3>
      <section className="stack tight" aria-label={`Beats in ${name}`} data-testid="arc-beats">
        <div className="row tight">
          <span className="eyebrow">Beats in this arc</span>
          {!adding && (
            <button
              type="button"
              className="btn small"
              disabled={writes.ro.off}
              {...writes.ro.tip}
              onClick={() => setAdding(true)}
            >
              New beat
            </button>
          )}
        </div>
        {adding && (
          <NameForm
            label="Beat title"
            submit="Create beat"
            testId="new-beat"
            onCancel={() => setAdding(false)}
            onSubmit={async (title) => {
              const made = await writes.create('plotBeats', {
                title,
                status: 'idea',
                arcIds: [id],
                arcOrders: [{ arcId: id, order: lastBeatOrder(beats, id) + 1 }],
              });
              if (made) setAdding(false);
            }}
          />
        )}
        {list.length === 0 ? (
          <p className="example-note">This arc has no beats yet.</p>
        ) : (
          <ol className="beat-list">
            {list.map((b, i) => (
              <li
                key={b._id}
                draggable={!writes.ro.off}
                data-beat={b._id}
                onDragStart={(e) => {
                  setDragging(b._id);
                  e.dataTransfer.setData('text/plain', b._id);
                }}
                onDragOver={(e) => dragging && e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragging && dragging !== b._id) moveTo(dragging, i);
                  setDragging(null);
                }}
              >
                <button
                  type="button"
                  className="link-btn beat-title"
                  onClick={() => props.onOpenBeat(b._id)}
                >
                  <Zh text={entryTitle(b)} actions={false} />
                </button>
                <span className="row tight">
                  <button
                    type="button"
                    className="btn small"
                    disabled={i === 0 || writes.ro.off}
                    {...writes.ro.tip}
                    aria-label={`Move ${entryTitle(b)} up`}
                    onClick={() => moveTo(b._id, i - 1)}
                  >
                    Up
                  </button>
                  <button
                    type="button"
                    className="btn small"
                    disabled={i === list.length - 1 || writes.ro.off}
                    {...writes.ro.tip}
                    aria-label={`Move ${entryTitle(b)} down`}
                    onClick={() => moveTo(b._id, i + 1)}
                  >
                    Down
                  </button>
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>
      <EmbeddedEditor key={`arc:${id}`} collection="arcs" id={id} />
    </div>
  );
}
