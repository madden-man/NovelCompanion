import { characterName } from '../../../../shared/domain/timeline';
import { useEntries } from '../data';

/**
 * SM-6: the Backstory screen's place in the rail until the SM-9 grid is wired
 * in. It names the person Relevant to Session picked (SM-10, Their backstory).
 */
export function BackstoryPlaceholder(props: { characterId?: string }) {
  const characters = useEntries('characters');
  const person = characters.find((c) => c._id === props.characterId);
  return (
    <section
      className="ws-wide stack"
      aria-labelledby="backstory-title"
      data-testid="backstory-view"
      data-character={props.characterId ?? ''}
    >
      <h2 id="backstory-title">Backstory</h2>
      <p className="lede">Backstory grid: coming in this wave</p>
      {person && <p data-testid="backstory-person-picked">Picked: {characterName(person)}</p>}
    </section>
  );
}
