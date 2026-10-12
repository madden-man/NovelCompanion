import { useId, useMemo } from 'react';
import { describeState } from '../../../../shared/domain/ages';
import { newNestedId } from '../../../../shared/domain/blank';
import { placePath } from '../../../../shared/domain/culture';
import { isPlainObject } from '../../../../shared/domain/paths';
import type { Doc } from '../../../../shared/domain/paths';
import { warningsAt } from '../../../../shared/domain/warnings';
import { entryTitle, manifests } from '../../../../shared/schema';
import type { FieldSpec } from '../../../../shared/schema';
import type { Response } from '../../../../shared/ipc';
import { useEntries } from '../data';
import { Field } from '../fields';
import type { Messages } from '../fields';
import { Zh } from '../Zh';

type PageStrand = Response<'chapter.page'>['page']['strands'][number];

const strandSpecs: FieldSpec[] = manifests.chapters.find((s) => s.name === 'strands')?.fields ?? [];
/** A strand field by name; a renamed field fails here at once, not quietly. */
function spec(name: string): FieldSpec {
  const found = strandSpecs.find((s) => s.name === name);
  if (!found) throw new Error(`The chapter strands have no field named ${name}.`);
  return found;
}

const ids = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

/**
 * KB-3, PL-4: the strands of a chapter, edited in place. Each strand has its
 * label, years, the primary choice (one per chapter, so a radio), point of
 * view, the characters present in order with their age in that year, and its
 * places with the places they sit in.
 */
export function StrandsEditor(props: {
  value: unknown;
  /** The stored chapter page, for ages and place paths. */
  page: readonly PageStrand[];
  storyYear: number;
  messages: Messages;
  root: Doc;
  onChange: (next: Doc[]) => void;
}) {
  const strands = (Array.isArray(props.value) ? props.value : []).filter(isPlainObject);
  const set = (i: number, patch: Doc) =>
    props.onChange(strands.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const primary = (i: number) =>
    props.onChange(strands.map((s, j) => ({ ...s, primary: j === i })));
  const remove = (i: number) => {
    const next = strands.filter((_, j) => j !== i);
    if (strands[i]?.primary === true && next[0] && !next.some((s) => s.primary === true)) {
      next[0] = { ...next[0], primary: true };
    }
    props.onChange(next);
  };
  const add = () =>
    props.onChange([
      ...strands,
      {
        id: newNestedId(),
        label: 'backstory',
        startYear: props.storyYear,
        endYear: null,
        primary: strands.length === 0,
        povCharacterId: null,
        characterIds: [],
        placeIds: [],
      },
    ]);
  const warnings = warningsAt(props.messages.warnings, 'strands');

  return (
    <div className="stack tight ol-strands" data-field="strands">
      <span className="eyebrow">Strands</span>
      {warnings.map((w, i) => (
        <p key={i} className="ed-warning" role="note" data-code={w.code}>
          {w.message}
        </p>
      ))}
      {strands.map((s, i) => (
        <StrandCard
          key={String(s.id ?? i)}
          strand={s}
          index={i}
          count={strands.length}
          page={props.page.find((p) => p.id === s.id)}
          messages={props.messages}
          root={props.root}
          onChange={(patch) => set(i, patch)}
          onPrimary={() => primary(i)}
          onRemove={() => remove(i)}
        />
      ))}
      <button type="button" className="btn small" onClick={add}>
        Add a strand
      </button>
    </div>
  );
}

function StrandCard(props: {
  strand: Doc;
  index: number;
  count: number;
  page: PageStrand | undefined;
  messages: Messages;
  root: Doc;
  onChange: (patch: Doc) => void;
  onPrimary: () => void;
  onRemove: () => void;
}) {
  const { strand: s, index: i, page } = props;
  const label = typeof s.label === 'string' && s.label.trim() ? s.label.trim() : `Strand ${i + 1}`;
  const path = (name: string) => `strands.${i}.${name}`;
  const characters = useEntries('characters');
  const places = useEntries('places');
  const pickId = useId();
  const placeId = useId();
  const nameOf = useMemo(() => {
    const byId = new Map(characters.map((c) => [c._id, entryTitle(c)]));
    return (id: string) => byId.get(id) ?? id;
  }, [characters]);
  const present = ids(s.characterIds);
  const where = ids(s.placeIds);
  const stateOf = (id: string) => page?.characters.find((c) => c.id === id)?.state;
  const placeName = (id: string) =>
    page?.places.find((p) => p.id === id)?.name ?? (placePath(places, id) || id);

  const field = (name: string) => (
    <Field
      spec={spec(name)}
      value={s[name]}
      path={path(name)}
      messages={props.messages}
      root={props.root}
      onMention={() => undefined}
      onChange={(v) => props.onChange({ [name]: v })}
    />
  );
  const movePresent = (at: number, by: -1 | 1) => {
    const next = [...present];
    const [c] = next.splice(at, 1);
    next.splice(at + by, 0, c as string);
    props.onChange({ characterIds: next });
  };

  return (
    <section
      className="ol-strand stack tight"
      data-testid="chapter-strand"
      data-strand={String(s.id ?? '')}
      aria-label={`Strand ${label}`}
    >
      <div className="row tight ol-strand-head">
        <strong>
          {label}
          {s.primary === true ? ' (primary)' : ''}
        </strong>
        <label className="row tight">
          <input
            type="radio"
            name={`primary-${String(props.root._id ?? '')}`}
            checked={s.primary === true}
            onChange={props.onPrimary}
          />
          Primary strand
        </label>
        <button
          type="button"
          className="btn small danger"
          disabled={props.count <= 1}
          aria-label={`Remove the strand ${label}`}
          onClick={props.onRemove}
        >
          Remove
        </button>
      </div>
      <div className="ol-strand-fields">
        {field('label')}
        {field('startYear')}
        {field('endYear')}
        {field('povCharacterId')}
      </div>
      <div className="stack tight" data-field={path('characterIds')}>
        <span className="ed-label">Characters present</span>
        <ul className="stack-list ol-present-list" aria-label={`Characters present, ${label}`}>
          {present.length === 0 ? (
            <li className="empty">No characters listed.</li>
          ) : (
            present.map((id, at) => {
              const state = stateOf(id);
              const name = nameOf(id);
              return (
                <li key={id} data-character={id} className="ol-present">
                  <span>
                    <Zh text={name} />{' '}
                    {state && <span className="example-note">{describeState(state)}</span>}
                  </span>
                  <span className="row tight">
                    <button
                      type="button"
                      className="btn small"
                      disabled={at === 0}
                      aria-label={`Move ${name} up in ${label}`}
                      onClick={() => movePresent(at, -1)}
                    >
                      Up
                    </button>
                    <button
                      type="button"
                      className="btn small"
                      disabled={at === present.length - 1}
                      aria-label={`Move ${name} down in ${label}`}
                      onClick={() => movePresent(at, 1)}
                    >
                      Down
                    </button>
                    <button
                      type="button"
                      className="btn small"
                      aria-label={`Remove ${name} from ${label}`}
                      onClick={() =>
                        props.onChange({ characterIds: present.filter((x) => x !== id) })
                      }
                    >
                      Remove
                    </button>
                  </span>
                </li>
              );
            })
          )}
        </ul>
        <label htmlFor={pickId} className="sr-only">
          Add a character to {label}
        </label>
        <select
          id={pickId}
          value=""
          onChange={(e) => {
            const id = e.target.value;
            if (id && !present.includes(id)) props.onChange({ characterIds: [...present, id] });
          }}
        >
          <option value="">Add a character present</option>
          {characters
            .filter((c) => !present.includes(c._id))
            .map((c) => ({ id: c._id, title: entryTitle(c) }))
            .sort((a, b) => a.title.localeCompare(b.title))
            .map((c) => (
              <option key={c.id} value={c.id}>
                {c.title}
              </option>
            ))}
        </select>
      </div>
      <div className="stack tight" data-field={path('placeIds')}>
        {where.length > 0 && (
          <span data-testid="chapter-places">
            Places:{' '}
            {where.map((id, at) => (
              <span key={id} data-place={id}>
                {at > 0 && '; '}
                <Zh text={placeName(id)} />
              </span>
            ))}
          </span>
        )}
        {where.length > 0 && (
          <span className="row tight">
            {where.map((id) => (
              <button
                key={id}
                type="button"
                className="btn small"
                aria-label={`Remove ${placeName(id)} from ${label}`}
                onClick={() => props.onChange({ placeIds: where.filter((x) => x !== id) })}
              >
                Remove {placeName(id)}
              </button>
            ))}
          </span>
        )}
        <label htmlFor={placeId} className="sr-only">
          Add a place to {label}
        </label>
        <select
          id={placeId}
          value=""
          onChange={(e) => {
            const id = e.target.value;
            if (id && !where.includes(id)) props.onChange({ placeIds: [...where, id] });
          }}
        >
          <option value="">Add a place</option>
          {places
            .filter((p) => !where.includes(p._id))
            .map((p) => ({ id: p._id, title: placePath(places, p._id) || entryTitle(p) }))
            .sort((a, b) => a.title.localeCompare(b.title))
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}
              </option>
            ))}
        </select>
      </div>
    </section>
  );
}
