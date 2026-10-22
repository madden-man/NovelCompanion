/**
 * IP-1: every kind of `Editable` on one panel, over the open bible's own
 * entries: the first world event (title, date, category, characters,
 * description), the first era's start year, a number kept in this window,
 * and a read-only value. It is the reference the next screens are built
 * against and what the end-to-end tests drive for the kinds the Characters
 * page does not use. It opens only when the window's address ends in
 * `#editable-gallery`, which nothing in the app links to.
 */
import { useEffect, useRef, useState } from 'react';
import { entryTitle } from '../../../../shared/schema';
import { useEntries, useList } from '../data';
import { Editable } from './Editable';
import {
  EntryEditable,
  entryOptions,
  listOptions,
  useEditableSave,
  useEntryAddNew,
  useListAddNew,
  valueCommand,
} from './helpers';

export const GALLERY_HASH = '#editable-gallery';

function useHash(): string {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const on = () => setHash(window.location.hash);
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return hash;
}

const newCharacter = (label: string) => ({ title: label, names: { full: label } });

export function EditableGallery() {
  const hash = useHash();
  if (hash !== GALLERY_HASH) return null;
  return <Gallery />;
}

function Gallery() {
  const events = useEntries('worldEvents');
  const eras = useEntries('eraStates');
  const characters = useEntries('characters');
  const categories = useList('eventCategories');
  const addCategory = useListAddNew('eventCategories');
  const addCharacter = useEntryAddNew('characters', newCharacter);
  const event = [...events].sort((a, b) => entryTitle(a).localeCompare(entryTitle(b)))[0];
  const era = [...eras].sort((a, b) => Number(a.startYear) - Number(b.startYear))[0];

  // A number outside the entries, kept in this window: its steps are `run` ops.
  const [words, setWords] = useState<number | null>(1200);
  const box = useRef(words);
  const saveWords = useEditableSave<number | null>({
    value: words,
    write: async (next) => {
      box.current = next;
      setWords(next);
    },
    command: (before, after) =>
      valueCommand({
        label: 'Changed Words written today',
        read: async () => box.current,
        write: async (to) => {
          box.current = to;
          setWords(to);
        },
        before,
        after,
      }),
  });

  const close = () => {
    window.location.hash = '';
  };

  return (
    <section
      className="editable-gallery stack"
      aria-label="Editable fields"
      data-testid="editable-gallery"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && e.target === e.currentTarget) close();
      }}
    >
      <header className="row">
        <h2>Editable fields</h2>
        <button type="button" className="btn small" onClick={close}>
          Close the gallery
        </button>
      </header>
      {!event || !era ? (
        <p>This bible needs a world event and an era for the examples.</p>
      ) : (
        <dl className="editable-gallery-list">
          <dt>Text</dt>
          <dd>
            <EntryEditable
              collection="worldEvents"
              id={event._id}
              path="title"
              kind="text"
              label="Event title"
              allowEmpty={false}
              testId="g-text"
            />
          </dd>
          <dt>Year</dt>
          <dd>
            <EntryEditable
              collection="eraStates"
              id={era._id}
              path="startYear"
              kind="year"
              label="Era start year"
              testId="g-year"
            />{' '}
            <span data-testid="g-year-after">is when {String(era.name)} begins.</span>
          </dd>
          <dt>Number</dt>
          <dd>
            <Editable
              kind="number"
              label="Words written today"
              integer
              min={0}
              value={words}
              onSave={saveWords}
              testId="g-number"
            />{' '}
            words today (an example kept only in this window)
          </dd>
          <dt>Rich text</dt>
          <dd>
            <EntryEditable
              collection="worldEvents"
              id={event._id}
              path="body"
              kind="rich"
              label="Event description"
              placeholder="Add a description"
              testId="g-rich"
            />
          </dd>
          <dt>Select</dt>
          <dd>
            <EntryEditable
              collection="worldEvents"
              id={event._id}
              path="categoryId"
              kind="select"
              label="Event category"
              options={listOptions(categories)}
              onAddNew={addCategory}
              testId="g-select"
            />
          </dd>
          <dt>Chips</dt>
          <dd>
            <EntryEditable
              collection="worldEvents"
              id={event._id}
              path="characterIds"
              kind="chips"
              label="Characters affected"
              addLabel="Add a character"
              options={entryOptions(characters)}
              onAddNew={addCharacter}
              testId="g-chips"
            />
          </dd>
          <dt>Date</dt>
          <dd>
            <EntryEditable
              collection="worldEvents"
              id={event._id}
              path="start"
              kind="date"
              dateBox="birth"
              label="Event date"
              placeholder="Unknown"
              testId="g-date"
            />
          </dd>
          <dt>Read only</dt>
          <dd>
            <Editable
              kind="text"
              label="Created"
              value={String(event.createdAt)}
              onSave={async () => undefined}
              disabled
              reason="The app sets this when the entry is made."
              testId="g-locked"
            />
          </dd>
        </dl>
      )}
    </section>
  );
}
