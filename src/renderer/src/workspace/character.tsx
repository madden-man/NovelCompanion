import { useEffect, useState } from 'react';
import { WriteFieldset } from '../connection';
import { manifests } from '../../../shared/schema';
import type { EntryCollection, FieldSpec } from '../../../shared/schema';
import { fieldByName } from '../../../shared/schema/manifest';
import type { Response } from '../../../shared/ipc';
import type { Doc } from '../../../shared/domain/paths';
import { call } from '../api';
import { useEntries, useList, useStore } from './data';
import type { Entry } from './data';
import { Field } from './fields';
import type { Messages } from './fields';
import { formatMoment, useStoryTime } from './storyTime';
import { Zh } from './Zh';
import { EntryEditable, entryOptions, useEntryAddNew } from './editable';

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

/** The age for the page line (TL-2, TL-4): short, since the story year is in the top bar. */
function ageWords(s: NonNullable<Page['current']['state']>): string {
  switch (s.state) {
    case 'alive':
      return s.dyingThisYear ? `Dies this year, age ${s.age}` : `Age ${s.age}`;
    case 'dead':
      return `Dead since ${s.deathYear}`;
    case 'unborn':
      return `Not yet born (${s.birthYear})`;
    case 'unknown':
      return 'Unknown age';
  }
}

/** The age at the story year (TM-3), else at the current position, else why there is none. */
function ageLine(page: Page): string {
  if (page.storyTime) return ageWords(page.storyTime.state);
  if (page.current.year !== null && page.current.state) return ageWords(page.current.state);
  return 'No story year set';
}

/** SM-1: a quick family made from a chip row's "Add new...": the name is the title. */
const newFamily = (label: string) => ({ name: label, title: label });

/**
 * The character page (SM-1, A39, IP-1): the name and the Chinese name as the
 * heading, each a field in place; one line with birth, death,
 * families and the age at the story year; the relatives as one read-only line
 * that opens the family tree; then three text boxes that grow with their
 * text: In the story, Description, and Backstory. Nothing else. Every field
 * saves on its own as one undo step (ED-2, ED-3).
 */
export function CharacterPage(props: {
  id: string;
  draft: Doc;
  messages: Messages;
  onChange: (name: string, value: unknown) => void;
  /** IP-1: a field saved in place hands the stored entry to the page's autosave. */
  onSaved?: (entry: Entry) => void;
  onOpen: (collection: EntryCollection, id: string) => void;
  /** Opens the family tree on this person. */
  onOpenTree?: (id: string) => void;
}) {
  const { draft } = props;
  const { version } = useStore();
  const story = useStoryTime();
  const [page, setPage] = useState<Page | null>(null);
  const [error, setError] = useState(false);
  const unionLabel = useLabel('unionTypes');
  const families = useEntries('families');
  const addFamily = useEntryAddNew('families', newFamily);
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
        onChange={(v) => props.onChange(name, v)}
      />
    );
  };

  if (error) return null;
  if (!page) return <p aria-live="polite">Loading the character page.</p>;
  const names = (draft.names ?? {}) as Record<string, unknown>;
  const full = str(names.full);
  const relatives = relativesLine(page.relatives, unionLabel);
  const familyOptions = entryOptions(families).map((o) => {
    const f = families.find((x) => x._id === o.value);
    return { value: o.value, label: str(f?.name) || o.label };
  });
  const common = {
    collection: 'characters' as const,
    id: props.id,
    entry: draft,
    warnings: props.messages.warnings,
    onSaved: props.onSaved,
  };

  return (
    <section className="char-page stack" aria-label="Character page" data-testid="character-page">
      <header className="char-head" data-testid="char-heading">
        <div className="row char-name-row">
          <h3 className="char-name">
            <EntryEditable
              {...common}
              kind="text"
              path="names.full"
              label="Full name"
              allowEmpty={false}
              placeholder={page.name}
              display={(t) => <Zh text={t || page.name} />}
              // The title is the name the app shows everywhere; it follows the full name.
              extraPatch={(next) => ({ title: next })}
            />
            {full && ' '}
            <span className="char-name-zh" data-testid="char-chinese">
              <EntryEditable
                {...common}
                kind="text"
                path="names.chinese"
                label="Name in Chinese characters"
                placeholder="Add a Chinese name"
                display={(t) => <Zh text={t} />}
              />
            </span>
          </h3>
        </div>
      </header>

      <form
        className="editor-fields char-line"
        data-testid="char-line"
        onSubmit={(e) => e.preventDefault()}
      >
        <WriteFieldset>
          <EntryEditable
            {...common}
            kind="date"
            path="birth"
            dateBox="birth"
            showLabel
            placeholder="Unknown"
            className="ed-field"
          />
          <EntryEditable
            {...common}
            kind="date"
            path="death"
            dateBox="death"
            showLabel
            placeholder="Not recorded"
            className="ed-field"
          />
          <EntryEditable
            {...common}
            kind="chips"
            path="familyIds"
            label="Families"
            showLabel
            layout="inline"
            options={familyOptions}
            onAddNew={addFamily}
            addLabel="Add family"
            pickerLabel="Family to add"
            className="ed-field fam-field"
          />
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
