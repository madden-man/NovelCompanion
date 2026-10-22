import { useMemo } from 'react';
import { entryTitle } from '../../../../shared/schema';
import { fillTemplate } from '../../../../shared/schema/settings';
import { useBibleSettings, useDefaultStatus } from '../bibleSettings';
import { useEntries } from '../data';
import type { Entry } from '../data';
import { EntryEditable } from '../editable';
import type { OutlineWrites } from './actions';

const live = (e: Entry) => e.deletedAt === undefined;
const numberOf = (e: Entry) => (typeof e.number === 'number' ? e.number : 0);
/** "Part 3", unless the title already starts with it, as the default "Part {n}" does. */
const kindTag = (kind: string, e: Entry) => {
  const tag = `${kind} ${numberOf(e) || ''}`.trim();
  return entryTitle(e).toLowerCase().startsWith(tag.toLowerCase()) ? null : tag;
};
const byNumber = (a: Entry, b: Entry) =>
  numberOf(a) - numberOf(b) || entryTitle(a).localeCompare(entryTitle(b));

/**
 * IP-13: Books and parts, a disclosure under the Outline's track. Every book
 * and part with its title in place, the part's summary as the A44 box, and
 * New part and New book, each one undo step. The parts are the dividers'
 * source, so a title changed here changes the divider and the other way round.
 */
export function BooksParts(props: { writes: OutlineWrites }) {
  const { writes } = props;
  const { templates } = useBibleSettings();
  const statusOf = useDefaultStatus();
  const allBooks = useEntries('books');
  const allParts = useEntries('parts');
  const books = useMemo(() => allBooks.filter(live).sort(byNumber), [allBooks]);
  const parts = useMemo(() => allParts.filter(live).sort(byNumber), [allParts]);
  const off = writes.ro.off;

  const newBook = () => {
    const n = Math.max(0, ...books.map(numberOf)) + 1;
    void writes.create('books', {
      title: fillTemplate(templates.bookTitle, n),
      number: n,
      status: statusOf('idea'),
    });
  };
  const newPart = (book: Entry) => {
    const n = Math.max(0, ...parts.filter((p) => p.bookId === book._id).map(numberOf)) + 1;
    void writes.create('parts', {
      title: fillTemplate(templates.partTitle, n),
      bookId: book._id,
      number: n,
      status: statusOf('idea'),
    });
  };

  return (
    <details className="books-parts" data-testid="books-parts">
      <summary>Books and parts</summary>
      <p className="example-note">
        A part is a section of chapters; its title is the divider above its first chapter.
      </p>
      {books.length === 0 && <p>No books yet. New book makes the first.</p>}
      <ul className="bp-books">
        {books.map((book) => {
          const mine = parts.filter((p) => p.bookId === book._id);
          return (
            <li key={book._id} className="bp-book" data-testid="bp-book" data-book={book._id}>
              <div className="bp-head">
                {kindTag('Book', book) && <span className="bp-kind">{kindTag('Book', book)}</span>}
                <EntryEditable
                  collection="books"
                  id={book._id}
                  entry={book}
                  path="title"
                  kind="text"
                  label={`Title of book ${numberOf(book)}`}
                  allowEmpty={false}
                  testId="bp-book-title"
                  className="bp-title"
                />
              </div>
              <ul className="bp-parts">
                {mine.map((part) => (
                  <li key={part._id} className="bp-part" data-testid="bp-part" data-part={part._id}>
                    <div className="bp-head">
                      {kindTag('Part', part) && (
                        <span className="bp-kind">{kindTag('Part', part)}</span>
                      )}
                      <EntryEditable
                        collection="parts"
                        id={part._id}
                        entry={part}
                        path="title"
                        kind="text"
                        label={`Title of part ${numberOf(part)}`}
                        allowEmpty={false}
                        testId="bp-part-title"
                        className="bp-title"
                      />
                    </div>
                    <EntryEditable
                      collection="parts"
                      id={part._id}
                      entry={part}
                      path="summary"
                      kind="rich"
                      label={`Summary of ${entryTitle(part)}`}
                      placeholder="Add a summary"
                      testId="bp-part-summary"
                    />
                  </li>
                ))}
              </ul>
              <button
                type="button"
                className="btn small"
                disabled={off}
                {...writes.ro.tip}
                data-testid="bp-new-part"
                onClick={newPart.bind(null, book)}
              >
                New part in {entryTitle(book)}
              </button>
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        className="btn small"
        disabled={off}
        {...writes.ro.tip}
        data-testid="bp-new-book"
        onClick={newBook}
      >
        New book
      </button>
    </details>
  );
}
