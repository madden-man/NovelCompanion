import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { WriteFieldset } from '../connection';
import { manifests } from '../../../shared/schema';
import type { EntryCollection } from '../../../shared/schema';
import { fieldByName } from '../../../shared/schema/manifest';
import type { Response } from '../../../shared/ipc';
import type { Doc } from '../../../shared/domain/paths';
import { call } from '../api';
import { useList, useStore } from './data';
import { Field } from './fields';
import type { Messages } from './fields';
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

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const wordsOf = (text: string) =>
  text.trim() ? count(text.trim().split(/\s+/).length, 'word') : '';

/** The sections of the page, in page order; `open` is how each starts the first time (A38). */
const SECTIONS = {
  description: { title: 'Description', open: true },
  family: { title: 'Family', open: true },
  life: { title: 'Life', open: true },
  names: { title: 'Names', open: false },
  knowledge: { title: 'What they know', open: false },
  timeline: { title: 'Personal timeline', open: false },
  backstory: { title: 'Backstory', open: false },
  voice: { title: 'Voice notes', open: false },
  source: { title: 'Source, tags and links', open: false },
} as const;
type SectionKey = keyof typeof SECTIONS;
const SECTIONS_KEY = 'novel-companion.character-sections';

/** Which sections are open, remembered on this computer; the page works the same without it. */
function useOpenSections(): [Record<SectionKey, boolean>, (k: SectionKey, open: boolean) => void] {
  const [open, setOpen] = useState<Record<SectionKey, boolean>>(() => {
    const base = Object.fromEntries(
      Object.entries(SECTIONS).map(([k, s]) => [k, s.open]),
    ) as Record<SectionKey, boolean>;
    try {
      const saved = JSON.parse(localStorage.getItem(SECTIONS_KEY) ?? '{}') as Record<
        string,
        unknown
      >;
      for (const k of Object.keys(base) as SectionKey[]) {
        if (typeof saved[k] === 'boolean') base[k] = saved[k];
      }
    } catch {
      // Browser storage may be unavailable; the defaults stand.
    }
    return base;
  });
  const set = (k: SectionKey, v: boolean) => {
    setOpen((o) => {
      const next = { ...o, [k]: v };
      try {
        localStorage.setItem(SECTIONS_KEY, JSON.stringify(next));
      } catch {
        // Nothing to remember it in; the page still works.
      }
      return next;
    });
  };
  return [open, set];
}

/** One section of the page: a caret, its title, a one-line hint, and the body when open. */
function Section(props: {
  id: SectionKey;
  hint: string;
  open: boolean;
  onToggle: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <details
      className="char-section"
      open={props.open}
      data-testid={`section-${props.id}`}
      onToggle={(e) => props.onToggle(e.currentTarget.open)}
    >
      <summary>
        <span className="char-section-title">{SECTIONS[props.id].title}</span>
        {props.hint && <span className="char-section-hint">{props.hint}</span>}
      </summary>
      <div className="stack tight char-section-body">{props.children}</div>
    </details>
  );
}

/**
 * The character page (CH-1 to CH-4, A38): who they are to the story first,
 * then the description, family, life dates and places, and below those the
 * names, what they know, the personal timeline, the backstory and the voice
 * notes, each behind a caret. The computed parts come from `character.page`;
 * the fields edit the entry in place with autosave.
 */
export function CharacterPage(props: {
  id: string;
  draft: Doc;
  messages: Messages;
  onChange: (name: string, value: unknown) => void;
  onMention: (targetId: string) => void;
  onOpen: (collection: EntryCollection, id: string) => void;
}) {
  const { draft } = props;
  const { version } = useStore();
  const story = useStoryTime();
  const [page, setPage] = useState<Page | null>(null);
  const [error, setError] = useState(false);
  const unionLabel = useLabel('unionTypes');
  const linkLabel = useLabel('parentLinkTypes');
  const [open, setOpen] = useOpenSections();
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

  const manifest = manifests.characters;
  const field = (name: string) => {
    const spec = fieldByName(manifest, name);
    if (!spec) return null;
    return (
      <Field
        key={name}
        spec={spec}
        value={draft[name]}
        path={name}
        messages={props.messages}
        root={draft}
        onMention={props.onMention}
        onChange={(v) => props.onChange(name, v)}
      />
    );
  };
  const section = (id: SectionKey, hint: string, body: ReactNode) => (
    <Section id={id} hint={hint} open={open[id]} onToggle={(v) => setOpen(id, v)}>
      {body}
    </Section>
  );

  if (error) return null;
  if (!page) return <p aria-live="polite">Loading the character page.</p>;
  const cur = page.current;
  const knows = page.knowledge.filter((k) => k.knownAtPosition === true);
  const openChar = (id: string) => props.onOpen('characters', id);
  const person = (id: string, name: string) => (
    <button type="button" className="link-btn" onClick={() => openChar(id)}>
      <Zh text={name} actions={false} />
    </button>
  );
  const names = (draft.names ?? {}) as Record<string, unknown>;
  const rel = page.relatives;
  const relCount =
    rel.parents.length + rel.children.length + rel.siblings.length + rel.partners.length;
  const voiceNotes = Array.isArray(draft.voiceNotes) ? draft.voiceNotes.length : 0;
  const places = Array.isArray(draft.placesLived) ? draft.placesLived.length : 0;
  const tags = Array.isArray(draft.tags) ? draft.tags.length : 0;

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

      <form className="editor-fields char-story" onSubmit={(e) => e.preventDefault()}>
        <WriteFieldset>
          <div className="char-story-row">
            {field('role')}
            {field('status')}
          </div>
        </WriteFieldset>
      </form>

      {section(
        'description',
        wordsOf(str(draft.body)) || 'Nothing yet',
        <form className="editor-fields" onSubmit={(e) => e.preventDefault()}>
          <WriteFieldset>{field('body')}</WriteFieldset>
        </form>,
      )}

      {section(
        'family',
        [
          page.families.length ? page.families.map((f) => f.name).join(', ') : 'No family',
          count(relCount, 'relative'),
        ].join(', '),
        <>
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
          <div data-testid="relatives">
            <dl className="kv">
              <dt>Parents</dt>
              <dd>
                {rel.parents.length === 0
                  ? 'None known'
                  : rel.parents.map((p, i) => (
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
                {rel.children.length === 0
                  ? 'None'
                  : rel.children.map((c, i) => (
                      <span key={c.id}>
                        {i > 0 && ', '}
                        {person(c.id, c.name)} ({linkLabel(c.type).toLowerCase()})
                      </span>
                    ))}
              </dd>
              <dt>Siblings</dt>
              <dd>
                {rel.siblings.length === 0
                  ? 'None'
                  : rel.siblings.map((s, i) => (
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
                {rel.partners.length === 0
                  ? 'None'
                  : rel.partners.map((p, i) => (
                      <span key={p.unionId}>
                        {i > 0 && ', '}
                        {person(p.id, p.name)} ({unionLabel(p.type).toLowerCase()},{' '}
                        {years(p.startYear, p.endYear)}
                        {p.endReason ? `, ${p.endReason}` : ''})
                      </span>
                    ))}
              </dd>
            </dl>
          </div>
          <form className="editor-fields" onSubmit={(e) => e.preventDefault()}>
            <WriteFieldset>{field('familyIds')}</WriteFieldset>
          </form>
          <p className="example-note">
            Parents, children and partners are linked in the family tree.
          </p>
        </>,
      )}

      {section(
        'life',
        [page.years === 'unknown' ? 'born unknown' : page.years, str(draft.birthplace)]
          .filter(Boolean)
          .join(', ') + (places ? `, ${count(places, 'place')} lived` : ''),
        <form className="editor-fields" onSubmit={(e) => e.preventDefault()}>
          <WriteFieldset>
            <div className="char-dates">
              {field('birth')}
              {field('death')}
            </div>
            {field('birthplace')}
            {field('placesLived')}
          </WriteFieldset>
        </form>,
      )}

      {section(
        'names',
        [str(names.chinese), str(names.romanization)].filter(Boolean).join(' ') ||
          str(names.full) ||
          'Full name only',
        <>
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
          <form className="editor-fields" onSubmit={(e) => e.preventDefault()}>
            <WriteFieldset>
              {field('title')}
              {field('names')}
            </WriteFieldset>
          </form>
        </>,
      )}

      {section(
        'knowledge',
        page.knowledgeYear === null
          ? 'no story time set'
          : `${count(knows.length, 'fact')} as of ${page.knowledgeYear}`,
        page.knowledgeYear === null ? (
          <p className="example-note" data-testid="knowledge-no-year">
            Set a story time to see what they know.
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
          </>
        ),
      )}

      {section(
        'timeline',
        count(page.timeline.length, 'row'),
        <>
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
        </>,
      )}

      {section(
        'backstory',
        wordsOf(str(draft.backstory)) || 'Nothing yet',
        <form className="editor-fields" onSubmit={(e) => e.preventDefault()}>
          <WriteFieldset>
            {field('backstory')}
            {field('backstoryMarks')}
          </WriteFieldset>
        </form>,
      )}

      {section(
        'voice',
        voiceNotes ? count(voiceNotes, 'note') : 'None yet',
        <form className="editor-fields" onSubmit={(e) => e.preventDefault()}>
          <WriteFieldset>{field('voiceNotes')}</WriteFieldset>
        </form>,
      )}

      {section(
        'source',
        [str(draft.provenance), tags ? count(tags, 'tag') : ''].filter(Boolean).join(', ') ||
          'Nothing recorded',
        <form className="editor-fields" onSubmit={(e) => e.preventDefault()}>
          <WriteFieldset>
            {field('provenance')}
            {field('sourceNote')}
            {field('sourceRef')}
            {field('tags')}
            {field('links')}
          </WriteFieldset>
        </form>,
      )}
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
