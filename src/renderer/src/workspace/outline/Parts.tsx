import { useMemo } from 'react';
import { entryTitle } from '../../../../shared/schema';
import { fillTemplate } from '../../../../shared/schema/settings';
import { useBibleSettings } from '../bibleSettings';
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
 * IP-13, A53: Parts, a disclosure under the Outline's track. Every part with
 * its title in place, its summary as the A44 box, and New part, one undo
 * step. The parts are the dividers' source, so a title changed here changes
 * the divider and the other way round.
 */
export function Parts(props: { writes: OutlineWrites }) {
  const { writes } = props;
  const { templates } = useBibleSettings();
  const allParts = useEntries('parts');
  const parts = useMemo(() => allParts.filter(live).sort(byNumber), [allParts]);
  const off = writes.ro.off;

  const newPart = () => {
    const n = Math.max(0, ...parts.map(numberOf)) + 1;
    void writes.create('parts', {
      title: fillTemplate(templates.partTitle, n),
      number: n,
    });
  };

  return (
    <details className="outline-parts" data-testid="outline-parts">
      <summary>Parts</summary>
      <p className="example-note">
        A part is a section of chapters; its title is the divider above its first chapter.
      </p>
      {parts.length === 0 && <p>No parts yet. New part makes the first.</p>}
      <ul className="bp-parts">
        {parts.map((part) => (
          <li key={part._id} className="bp-part" data-testid="bp-part" data-part={part._id}>
            <div className="bp-head">
              {kindTag('Part', part) && <span className="bp-kind">{kindTag('Part', part)}</span>}
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
        onClick={newPart}
      >
        New part
      </button>
    </details>
  );
}
