import { useEffect, useId, useRef, useState } from 'react';
import { WriteFieldset } from '../connection';
import { manifests } from '../../../shared/schema';
import type { EntryCollection, FieldSpec } from '../../../shared/schema';
import { fieldByName } from '../../../shared/schema/manifest';
import type { Response } from '../../../shared/ipc';
import type { Doc } from '../../../shared/domain/paths';
import { dateText, parseDateText } from '../../../shared/domain/dates';
import type { DateBox } from '../../../shared/domain/dates';
import type { StoryDate } from '../../../shared/schema';
import { deepEqual } from '../../../shared/domain/paths';
import { call } from '../api';
import { useList, useStore } from './data';
import { Field } from './fields';
import type { Messages } from './fields';
import { formatMoment, useStoryTime } from './storyTime';
import { Zh } from './Zh';

type Page = Response<'character.page'>['page'];
type Relatives = Page['relatives'];

const str = (v: unknown) => (typeof v === 'string' ? v : '');

function useLabel(listId: string) {
  const list = useList(listId);
  return (id: string) => list?.items.find((i) => i.id === id)?.label ?? id;
}

/** "married 1982 to 2030", "partnered from 2056", "married". */
function unionWords(type: string, start: number | null, end: number | null): string {
  if (start === null && end === null) return type;
  if (end === null) return `${type} from ${start}`;
  if (start === null) return `${type} until ${end}`;
  return `${type} ${start} to ${end}`;
}

/**
 * SM-1: the relatives in one read-only sentence, "Parents: Peter Hale,
 * Margaret Hale. Partner: Zhou Lan (married from 2029). Children: Iris
 * Hale-Zhou." Siblings follow from the parents and are left to the tree.
 */
export function relativesLine(rel: Relatives, unionLabel: (id: string) => string): string {
  const parts: string[] = [];
  const names = (list: { name: string }[]) => list.map((p) => p.name).join(', ');
  if (rel.parents.length) {
    parts.push(`${rel.parents.length === 1 ? 'Parent' : 'Parents'}: ${names(rel.parents)}.`);
  }
  if (rel.partners.length) {
    const list = rel.partners
      .map(
        (p) =>
          `${p.name} (${unionWords(unionLabel(p.type).toLowerCase(), p.startYear, p.endYear)})`,
      )
      .join(', ');
    parts.push(`${rel.partners.length === 1 ? 'Partner' : 'Partners'}: ${list}.`);
  }
  if (rel.children.length) {
    parts.push(`${rel.children.length === 1 ? 'Child' : 'Children'}: ${names(rel.children)}.`);
  }
  return parts.join(' ') || 'No parents, partners or children in the family tree yet.';
}

/**
 * SM-1: Birth or Death as one text box: a year, a year and month, or a full
 * date. It commits on blur or Enter, as one change; a value it cannot read
 * shows why under the box and writes nothing. The date warnings show here too.
 */
function DateBoxField(props: {
  name: DateBox;
  label: string;
  value: unknown;
  messages: Messages;
  onChange: (value: StoryDate | null) => void;
}) {
  const id = useId();
  const errorId = useId();
  const stored = (props.value ?? null) as StoryDate | null;
  const [text, setText] = useState(() => dateText(stored));
  const [error, setError] = useState<string | null>(null);
  const editing = useRef(false);
  const shown = dateText(stored);
  useEffect(() => {
    if (!editing.current) setText(shown);
  }, [shown]);
  const commit = () => {
    editing.current = false;
    const parsed = parseDateText(text, props.name);
    if (!parsed.ok) {
      setError(parsed.message);
      return;
    }
    setError(null);
    setText(dateText(parsed.value));
    const before = props.name === 'death' ? stored : (stored ?? { unknown: true });
    if (!deepEqual(parsed.value, before)) props.onChange(parsed.value);
  };
  const warnings = props.messages.warnings.filter((w) => w.path === props.name);
  const issues = props.messages.issues.filter((i) => i.path === props.name);
  return (
    <div
      className={`ed-field date-box${warnings.length ? ' has-warning' : ''}${error || issues.length ? ' has-error' : ''}`}
      data-field={props.name}
      data-kind="dateText"
    >
      <label className="ed-label" htmlFor={id}>
        {props.label}
      </label>
      <input
        id={id}
        className="num date-box-input"
        value={text}
        inputMode="numeric"
        autoComplete="off"
        placeholder={props.name === 'birth' ? 'Unknown' : 'Not recorded'}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        onChange={(e) => {
          editing.current = true;
          setText(e.target.value);
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          }
        }}
      />
      {error && (
        <p id={errorId} className="ed-error" role="alert">
          Not saved: {error}
        </p>
      )}
      {issues.map((issue, i) => (
        <p key={`e${i}`} className="ed-error" role="alert">
          Not saved: {issue.message}
        </p>
      ))}
      {warnings.map((w, i) => (
        <p key={`w${i}`} className="ed-warning" role="note" data-code={w.code}>
          {w.message}
        </p>
      ))}
    </div>
  );
}

/** An age for the page line: the number, or the state in plain words. */
function ageWords(s: NonNullable<Page['current']['state']>, year: number): string {
  switch (s.state) {
    case 'alive':
      return s.dyingThisYear
        ? `Age ${s.age} in ${year}, dies that year`
        : `Age ${s.age} in ${year}`;
    case 'dead':
      return `Dead since ${s.deathYear}`;
    case 'unborn':
      return `Not born until ${s.birthYear}`;
    case 'unknown':
      return 'Age unknown';
  }
}

/** The age at the story year (TM-3), else at the current position, else why there is none. */
function ageLine(page: Page): string {
  if (page.storyTime) {
    const t = page.storyTime;
    const at = t.month !== undefined ? formatMoment(t) : String(t.year);
    const words = ageWords(t.state, t.year);
    return t.month !== undefined ? `${words} (${at})` : words;
  }
  if (page.current.year !== null && page.current.state) {
    return `${ageWords(page.current.state, page.current.year)} (current position)`;
  }
  return 'No story year set';
}

/**
 * The character page (SM-1, A39): the name and the Chinese name as the
 * heading; one line with birth, death, status, families and the age at the
 * story year; the relatives as one read-only line that opens the family tree;
 * then three text boxes that grow with their text: In the story, Description,
 * and Backstory. Nothing else. Every box saves on its own (ED-2).
 */
export function CharacterPage(props: {
  id: string;
  draft: Doc;
  messages: Messages;
  onChange: (name: string, value: unknown) => void;
  onMention: (targetId: string) => void;
  onOpen: (collection: EntryCollection, id: string) => void;
  /** Opens the family tree on this person. */
  onOpenTree?: (id: string) => void;
}) {
  const { draft } = props;
  const { version } = useStore();
  const story = useStoryTime();
  const [page, setPage] = useState<Page | null>(null);
  const [error, setError] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const unionLabel = useLabel('unionTypes');
  const fullId = useId();
  const chineseId = useId();
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
  const field = (name: string, opts: { label?: string; grow?: boolean } = {}) => {
    const base = fieldByName(manifest, name);
    if (!base) return null;
    const spec: FieldSpec = opts.label ? { ...base, label: opts.label } : base;
    return (
      <Field
        key={name}
        spec={spec}
        value={draft[name]}
        path={name}
        messages={props.messages}
        root={draft}
        grow={opts.grow}
        onMention={props.onMention}
        onChange={(v) => props.onChange(name, v)}
      />
    );
  };

  if (error) return null;
  if (!page) return <p aria-live="polite">Loading the character page.</p>;
  const names = (draft.names ?? {}) as Record<string, unknown>;
  const full = str(names.full);
  const chinese = str(names.chinese);
  const setNames = (next: { full?: string; chinese?: string }) => {
    const merged = { ...names, ...next };
    props.onChange('names', merged);
    // The title is the name the app shows everywhere; it follows the full name.
    if (next.full !== undefined) props.onChange('title', next.full);
  };
  const relatives = relativesLine(page.relatives, unionLabel);
  const issuesAt = (path: string) => props.messages.issues.filter((i) => i.path === path);
  const nameIssue = (path: string) =>
    issuesAt(path).map((issue, i) => (
      <p key={i} className="ed-error" role="alert">
        Not saved: {issue.message}
      </p>
    ));

  return (
    <section className="char-page stack" aria-label="Character page" data-testid="character-page">
      <header className="char-head" data-testid="char-heading">
        {renaming ? (
          <form className="char-rename row" onSubmit={(e) => e.preventDefault()}>
            <WriteFieldset>
              <div className="ed-field" data-field="names.full">
                <label className="ed-label" htmlFor={fullId}>
                  Full name
                </label>
                <input
                  id={fullId}
                  value={full}
                  autoComplete="off"
                  aria-invalid={issuesAt('names.full').length > 0 || undefined}
                  onChange={(e) => setNames({ full: e.target.value })}
                />
                {nameIssue('names.full')}
              </div>
              <div className="ed-field" data-field="names.chinese">
                <label className="ed-label" htmlFor={chineseId}>
                  Name in Chinese characters
                </label>
                <input
                  id={chineseId}
                  value={chinese}
                  autoComplete="off"
                  onChange={(e) => setNames({ chinese: e.target.value })}
                />
                {nameIssue('names.chinese')}
              </div>
              <button type="button" className="btn small" onClick={() => setRenaming(false)}>
                Done
              </button>
            </WriteFieldset>
          </form>
        ) : (
          <div className="row char-name-row">
            <h3 className="char-name">
              <Zh text={full || page.name} />
              {chinese && (
                <>
                  {' '}
                  <span className="char-name-zh" data-testid="char-chinese">
                    <Zh text={chinese} />
                  </span>
                </>
              )}
            </h3>
            <button type="button" className="btn small" onClick={() => setRenaming(true)}>
              Edit name
            </button>
          </div>
        )}
      </header>

      <form
        className="editor-fields char-line"
        data-testid="char-line"
        onSubmit={(e) => e.preventDefault()}
      >
        <WriteFieldset>
          <DateBoxField
            name="birth"
            label="Birth"
            value={draft.birth}
            messages={props.messages}
            onChange={(v) => props.onChange('birth', v)}
          />
          <DateBoxField
            name="death"
            label="Death"
            value={draft.death}
            messages={props.messages}
            onChange={(v) => props.onChange('death', v)}
          />
          {field('status')}
          {field('familyIds')}
          <p className="char-age" data-testid="char-age">
            {ageLine(page)}
          </p>
        </WriteFieldset>
      </form>

      <p className="char-relatives">
        <button
          type="button"
          className="link-btn"
          data-testid="char-relatives"
          aria-label={`${relatives} Open in the family tree.`}
          onClick={() => props.onOpenTree?.(props.id)}
        >
          {relatives}
        </button>
      </p>

      <form className="editor-fields char-texts" onSubmit={(e) => e.preventDefault()}>
        <WriteFieldset>
          {field('role', { grow: true })}
          {field('body', { label: 'Description', grow: true })}
          {field('backstory', { grow: true })}
        </WriteFieldset>
      </form>
    </section>
  );
}
