import { useEffect, useId, useRef, useState } from 'react';
import type { BackstoryPerson } from '../../../../shared/domain/backstoryGrid';
import { lifeYears } from '../../../../shared/domain/ages';
import { useWriteGuard } from '../../connection';
import { personLabel } from './MomentDialog';

/**
 * SM-9, IP-13, A49: the head bar's creation controls, where the moments table
 * had them. With a person picked: their name and life, and Add a moment, at
 * the story year. With nobody picked: New moment, which asks whose it is
 * first. Either opens the new moment in the dialog. Off with the reason while
 * a snapshot is open read-only (ARCH-6).
 */
export function MomentCreate(props: {
  /** The picked person, or null. */
  person: BackstoryPerson | null;
  /** Everyone, in the grid's order: the "Whose moment" choices. */
  people: readonly BackstoryPerson[];
  /** A new moment for the person at the story year. */
  onAdd: (characterId: string) => Promise<void>;
  /** Back to nobody picked. */
  onClear: () => void;
}) {
  const { person } = props;
  const ro = useWriteGuard();
  const whoId = useId();
  const [asking, setAsking] = useState(false);
  const whoBox = useRef<HTMLSelectElement>(null);
  useEffect(() => {
    if (asking) whoBox.current?.focus({ preventScroll: true });
  }, [asking]);

  if (person) {
    return (
      <span className="row tight bs-create">
        <span className="bs-picked" data-testid="picked-person">
          {person.name}
          {person.chinese && (
            <span className="bs-zh" lang="zh">
              {' '}
              {person.chinese}
            </span>
          )}
          <span className="bs-years">, {lifeYears(person)}</span>
        </span>
        <button
          type="button"
          className="btn small primary"
          disabled={ro.off}
          {...ro.tip}
          onClick={() => void props.onAdd(person.id)}
        >
          Add a moment
        </button>
        <button type="button" className="btn small" onClick={props.onClear}>
          Clear pick
        </button>
      </span>
    );
  }
  if (!asking) {
    return (
      <span className="row tight bs-create">
        <button
          type="button"
          className="btn small primary"
          disabled={ro.off}
          {...ro.tip}
          onClick={() => setAsking(true)}
        >
          New moment
        </button>
      </span>
    );
  }
  return (
    <span className="row tight bs-create bs-ask">
      <label htmlFor={whoId}>Whose moment</label>
      <select
        id={whoId}
        ref={whoBox}
        defaultValue=""
        disabled={ro.off}
        onChange={(e) => {
          const id = e.target.value;
          if (!id) return;
          setAsking(false);
          void props.onAdd(id);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            setAsking(false);
          }
        }}
      >
        <option value="" disabled>
          Pick the person
        </option>
        {props.people.map((p) => (
          <option key={p.id} value={p.id}>
            {personLabel(p)}
          </option>
        ))}
      </select>
      <button type="button" className="btn small" onClick={() => setAsking(false)}>
        Cancel
      </button>
    </span>
  );
}
