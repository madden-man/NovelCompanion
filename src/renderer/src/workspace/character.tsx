import { useEffect, useState } from 'react';
import type { EntryCollection } from '../../../shared/schema';
import type { Response } from '../../../shared/ipc';
import { call } from '../api';
import { useList, useStore } from './data';
import { formatMoment, useStoryTime } from './storyTime';
import { Zh } from './Zh';

type Page = Response<'character.page'>['page'];

function useLabel(listId: string) {
  const list = useList(listId);
  return (id: string) => list?.items.find((i) => i.id === id)?.label ?? id;
}

function years(start: number | null, end: number | null): string {
  if (start === null && end === null) return 'years unknown';
  if (end === null) return `from ${start}`;
  if (start === null) return `until ${end}`;
  return `${start} to ${end}`;
}

/**
 * The character page (CH-1 to CH-4): the age at the current position, every
 * name, families, relatives, a personal timeline, and what they know. All of
 * it comes from `character.page`, computed in code from the read model.
 */
export function CharacterSummary(props: {
  id: string;
  onOpen: (collection: EntryCollection, id: string) => void;
}) {
  const { version } = useStore();
  const story = useStoryTime();
  const [page, setPage] = useState<Page | null>(null);
  const [error, setError] = useState(false);
  const unionLabel = useLabel('unionTypes');
  const linkLabel = useLabel('parentLinkTypes');
  const st = story.stored?.time;
  const storyKey = st ? formatMoment(st) : null;

  useEffect(() => {
    let live = true;
    call('character.page', { id: props.id })
      .then((r) => {
        if (live) setPage(r.page);
      })
      .catch(() => {
        if (live) setError(true);
      });
    return () => {
      live = false;
    };
  }, [props.id, version, storyKey]);

  if (error) return null;
  if (!page) return <p aria-live="polite">Loading the character page.</p>;
  const cur = page.current;
  const knows = page.knowledge.filter((k) => k.knownAtPosition === true);
  const open = (id: string) => props.onOpen('characters', id);
  const person = (id: string, name: string) => (
    <button type="button" className="link-btn" onClick={() => open(id)}>
      <Zh text={name} actions={false} />
    </button>
  );

  return (
    <section className="char-page stack" aria-label="Character page" data-testid="character-page">
      <div className="char-head">
        <div className="stack tight">
          <span className="char-name">
            <Zh text={page.names.full || page.name} />
            {page.names.chinese && (
              <>
                {' '}
                <Zh text={page.names.chinese} />
              </>
            )}
          </span>
          <span className="char-years num" data-testid="char-years">
            {page.years === 'unknown' ? 'Born: unknown' : page.years}
          </span>
        </div>
        <div className="stack tight">
          <p className="char-age" data-testid="char-age">
            {cur.year === null || !cur.state
              ? 'Age at current position: no chapter is marked written yet.'
              : `Age at current position (Chapter ${cur.readingOrder ?? '?'}, year ${cur.year}): ${ageWords(cur.state)}`}
          </p>
          {page.storyTime && (
            <p className="char-age" data-testid="char-age-story">
              {`Age at story time (${page.storyTime.month !== undefined ? formatMoment(page.storyTime) : `year ${page.storyTime.year}`}): ${ageWords(page.storyTime.state)}`}
            </p>
          )}
        </div>
      </div>

      <div className="char-grid">
        <div className="stack tight">
          <h4>Names</h4>
          <dl className="kv" data-testid="char-names">
            <dt>Full name</dt>
            <dd>{page.names.full}</dd>
            <dt>In Chinese characters</dt>
            <dd>{page.names.chinese ? <Zh text={page.names.chinese} /> : 'None'}</dd>
            <dt>Romanization</dt>
            <dd>{page.names.romanization || 'None'}</dd>
            <dt>Name order</dt>
            <dd>
              {page.names.order === 'family-first' ? 'Family name first' : 'Family name last'}
            </dd>
            <dt>Birth name</dt>
            <dd>{page.names.birthName || 'None'}</dd>
            <dt>Married name</dt>
            <dd>{page.names.marriedName || 'None'}</dd>
            <dt>Nicknames</dt>
            <dd>{page.names.nicknames.length ? page.names.nicknames.join(', ') : 'None'}</dd>
          </dl>
          <h4>What others call them</h4>
          {page.names.calledBy.length === 0 ? (
            <p className="example-note">No one has a name for them yet.</p>
          ) : (
            <ul className="plain-list" data-testid="called-by">
              {page.names.calledBy.map((c, i) => (
                <li key={i}>
                  {person(c.characterId, c.characterName)} calls them <strong>{c.name}</strong>
                </li>
              ))}
            </ul>
          )}
          <h4>Families</h4>
          {page.families.length === 0 ? (
            <p data-testid="char-families">No family</p>
          ) : (
            <p className="row tight" data-testid="char-families">
              {page.families.map((f) => (
                <span key={f.id} className={`chip fam fam-${f.color}`}>
                  {f.name}
                </span>
              ))}
            </p>
          )}
        </div>

        <div className="stack tight" data-testid="relatives">
          <h4>Relatives</h4>
          <dl className="kv">
            <dt>Parents</dt>
            <dd>
              {page.relatives.parents.length === 0
                ? 'None known'
                : page.relatives.parents.map((p, i) => (
                    <span key={p.id}>
                      {i > 0 && ', '}
                      {person(p.id, p.name)} ({linkLabel(p.type).toLowerCase()}
                      {p.type !== 'biological' && p.startYear !== null
                        ? ` from ${p.startYear}`
                        : ''}
                      )
                    </span>
                  ))}
            </dd>
            <dt>Children</dt>
            <dd>
              {page.relatives.children.length === 0
                ? 'None'
                : page.relatives.children.map((c, i) => (
                    <span key={c.id}>
                      {i > 0 && ', '}
                      {person(c.id, c.name)} ({linkLabel(c.type).toLowerCase()})
                    </span>
                  ))}
            </dd>
            <dt>Siblings</dt>
            <dd>
              {page.relatives.siblings.length === 0
                ? 'None'
                : page.relatives.siblings.map((s, i) => (
                    <span key={s.id}>
                      {i > 0 && ', '}
                      {person(s.id, s.name)}
                      {s.kind === 'half'
                        ? ' (half-sibling)'
                        : s.kind === 'full'
                          ? ''
                          : ' (one parent known)'}
                    </span>
                  ))}
            </dd>
            <dt>Partners</dt>
            <dd>
              {page.relatives.partners.length === 0
                ? 'None'
                : page.relatives.partners.map((p, i) => (
                    <span key={p.unionId}>
                      {i > 0 && ', '}
                      {person(p.id, p.name)} ({unionLabel(p.type).toLowerCase()},{' '}
                      {years(p.startYear, p.endYear)}
                      {p.endReason ? `, ${p.endReason}` : ''})
                    </span>
                  ))}
            </dd>
          </dl>

          <h4>What they know</h4>
          {page.knowledgeYear === null ? (
            <p className="example-note" data-testid="knowledge-no-year">
              Set a story time to see what they know and do not know.
            </p>
          ) : (
            <>
              <p className="example-note" data-testid="knowledge-year">
                As of {page.knowledgeYear}.
              </p>
              {knows.length === 0 ? (
                <p className="example-note" data-testid="knowledge-empty">
                  They know no facts yet in {page.knowledgeYear}.
                </p>
              ) : (
                <ul className="plain-list" data-testid="knowledge">
                  {knows.map((k) => (
                    <li key={k.recordId} data-fact={k.factId}>
                      <button
                        type="button"
                        className="link-btn"
                        onClick={() => props.onOpen('facts', k.factId)}
                      >
                        <Zh text={k.fact} actions={false} />
                      </button>
                      : learned {k.yearLearned}
                      {k.chapter ? ` in ${k.chapter}` : ''}
                      {k.how ? `. ${k.how}` : ''}
                    </li>
                  ))}
                </ul>
              )}
              <h4>What they do not know</h4>
              {page.doesNotKnow.length === 0 ? (
                <p className="example-note" data-testid="does-not-know-empty">
                  There is no fact they do not know in {page.knowledgeYear}.
                </p>
              ) : (
                <ul className="plain-list" data-testid="does-not-know">
                  {page.doesNotKnow.map((f) => (
                    <li key={f.factId} data-fact={f.factId}>
                      <button
                        type="button"
                        className="link-btn"
                        onClick={() => props.onOpen('facts', f.factId)}
                      >
                        <Zh text={f.fact} actions={false} />
                      </button>{' '}
                      <span className="chip idea">{f.label}</span>
                      {f.yearLearned !== null && (
                        <span className="example-note"> They learn it in {f.yearLearned}.</span>
                      )}
                      {page.knowledge.some(
                        (k) => k.factId === f.factId && k.yearLearned === null,
                      ) && <span className="example-note"> A record has no year.</span>}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      </div>

      <div className="stack tight">
        <h4>Personal timeline</h4>
        {!page.birthKnown && (
          <p className="example-note">
            The birth year is unknown, so ages are unknown and the world events of their lifetime
            cannot be listed.
          </p>
        )}
        <div className="table-wrap">
          <table className="compact" data-testid="char-timeline">
            <thead>
              <tr>
                <th scope="col">Year</th>
                <th scope="col">Age</th>
                <th scope="col">What</th>
                <th scope="col">Kind</th>
              </tr>
            </thead>
            <tbody>
              {page.timeline.map((t, i) => (
                <tr key={i} data-kind={t.kind}>
                  <td className="num">{t.year ?? 'unknown'}</td>
                  <td className="num">{timelineAge(t)}</td>
                  <td>
                    <button
                      type="button"
                      className="link-btn"
                      onClick={() => props.onOpen(t.collection as EntryCollection, t.id)}
                    >
                      {t.title}
                    </button>
                    {t.detail && <span className="example-note"> {t.detail}</span>}
                  </td>
                  <td>{KIND_LABELS[t.kind]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

/** The age column: an age, or why there is none. "age unknown" is only for an unknown birth (CH-4). */
function timelineAge(t: Page['timeline'][number]): string {
  if (t.year === null) return 'year unknown';
  switch (t.state) {
    case 'alive':
      return String(t.age);
    case 'dead':
      return 'dead';
    case 'unborn':
      return 'not yet born';
    default:
      return 'age unknown';
  }
}

/** An age for the page lines: the number, or the state in plain words. */
function ageWords(s: NonNullable<Page['current']['state']>): string {
  switch (s.state) {
    case 'alive':
      return s.dyingThisYear ? `${s.age}, dies this year` : String(s.age);
    case 'dead':
      return `dead since ${s.deathYear}`;
    case 'unborn':
      return 'not yet born';
    case 'unknown':
      return 'age unknown';
  }
}

const KIND_LABELS: Record<Page['timeline'][number]['kind'], string> = {
  birth: 'Own',
  death: 'Own',
  union: 'Own',
  'union-end': 'Own',
  child: 'Own',
  beat: 'Plot beat',
  event: 'World event',
  chapter: 'Chapter',
};
