import { useId } from 'react';
import { characterName } from '../../../../shared/domain/timeline';
import { entryTitle } from '../../../../shared/schema';
import { useEntries } from '../data';

/**
 * SB-1: for a story year and point of view, the optional places and the other
 * characters present. Both are multi-selects, so the keyboard picks with the
 * arrow keys and Space or Ctrl-click; nothing picked means the defaults.
 */
export function PovExtras(props: {
  pov: string;
  placeIds: string[];
  characterIds: string[];
  onPlaces: (ids: string[]) => void;
  onCharacters: (ids: string[]) => void;
}) {
  const places = useEntries('places');
  const characters = useEntries('characters');
  const placeId = useId();
  const charId = useId();
  const picked = (e: React.ChangeEvent<HTMLSelectElement>) =>
    Array.from(e.target.selectedOptions, (o) => o.value);
  const others = [...characters]
    .filter((c) => c._id !== props.pov)
    .sort((a, b) => characterName(a).localeCompare(characterName(b)));
  return (
    <>
      <div className="field">
        <label htmlFor={placeId}>Places (optional)</label>
        <select
          id={placeId}
          multiple
          size={4}
          value={props.placeIds}
          onChange={(e) => props.onPlaces(picked(e))}
          data-testid="session-places"
        >
          {places.map((p) => (
            <option key={p._id} value={p._id}>
              {entryTitle(p)}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor={charId}>Other characters present (optional)</label>
        <select
          id={charId}
          multiple
          size={4}
          value={props.characterIds}
          onChange={(e) => props.onCharacters(picked(e))}
          data-testid="session-characters"
        >
          {others.map((c) => (
            <option key={c._id} value={c._id}>
              {characterName(c)}
            </option>
          ))}
        </select>
      </div>
    </>
  );
}
