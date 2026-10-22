import { useEffect, useId, useMemo, useRef } from 'react';
import type { RefObject } from 'react';
import { newNestedId } from '../../../../shared/domain/blank';
import { placePath } from '../../../../shared/domain/culture';
import {
  backstoryStrand,
  barStrands,
  newBackstoryStrand,
  patchStrand,
  writingStrand,
} from '../../../../shared/domain/sceneOutline';
import type { BarStrand } from '../../../../shared/domain/sceneOutline';
import { shiftStrand } from '../../../../shared/domain/strands';
import type { Doc } from '../../../../shared/domain/paths';
import { entryTitle } from '../../../../shared/schema';
import { useBibleSettings } from '../bibleSettings';
import { useEntries } from '../data';
import type { Entry } from '../data';
import { EditableError, EntryEditable, entryOptions, useEntryAddNew } from '../editable';
import type { OutlineWrites } from './actions';

const newCharacter = (label: string) => ({ title: label, names: { full: label } });
const newPlace = (label: string) => ({ title: label });

/** The strand chip's words: the writing strand's label and year. */
export function strandChipText(strands: unknown): string {
  const w = writingStrand(strands);
  if (!w) return 'No strand';
  return `${w.label || 'Strand'}, ${w.startYear}`;
}

/** Said when the strand a field was opened on is gone from the stored chapter. */
const STRAND_GONE = 'This strand is no longer on the chapter. Close this and open it again.';

/**
 * One strand field's stored strands, patched by the strand's ID so a reordered
 * list never hits the wrong one. A strand gone since the popover opened is
 * refused, so the index in the field's path never writes another strand.
 */
const byId =
  (strandId: string, patch: (next: unknown, s: BarStrand) => Partial<BarStrand>) =>
  (next: unknown, entry: Doc): Doc => {
    const stored = Array.isArray(entry.strands) ? (entry.strands as unknown[]) : [];
    const s = barStrands(stored).find((x) => x.id === strandId);
    if (!s) throw new EditableError(STRAND_GONE);
    return { strands: patchStrand(stored, strandId, patch(next, s)) };
  };

/**
 * IP-3: the strand popover of a chapter bar. It sits beside the bar, over
 * the outline, and moves nothing: the writing strand's label, point of view,
 * characters present and places, and the backstory strand's year, each an
 * `Editable` that saves as one undo step. It is not modal: the outline stays
 * readable and scrollable, and it closes on Escape (the focus goes back to
 * the chip), on a click outside, and when Tab leaves it.
 */
export function StrandPopover(props: {
  chapter: Entry;
  chapterNo: number;
  anchor: RefObject<HTMLElement | null>;
  writes: OutlineWrites;
  onClose: (refocus: boolean) => void;
}) {
  const { chapter, onClose } = props;
  const root = useRef<HTMLDivElement | null>(null);
  const titleId = useId();
  const { templates } = useBibleSettings();
  const characters = useEntries('characters');
  const places = useEntries('places');
  const addCharacter = useEntryAddNew('characters', newCharacter);
  const addPlace = useEntryAddNew('places', newPlace);
  const all = barStrands(chapter.strands);
  const w = writingStrand(chapter.strands);
  const b = backstoryStrand(chapter.strands);
  const wi = w ? all.findIndex((s) => s.id === w.id) : -1;
  const bi = b ? all.findIndex((s) => s.id === b.id) : -1;
  const title = entryTitle(chapter);
  const off = props.writes.ro.off;

  const people = useMemo(() => entryOptions(characters), [characters]);
  const placeOptions = useMemo(
    () =>
      places
        .filter((p) => p.deletedAt === undefined)
        .map((p) => ({ value: p._id, label: placePath(places, p._id) || entryTitle(p) }))
        .sort((x, y) => x.label.localeCompare(y.label)),
    [places],
  );
  const povOptions = people.filter(
    (o) => w && (w.characterIds.includes(o.value) || w.povCharacterId === o.value),
  );

  // Opening moves the focus in without scrolling anything (IP-1).
  useEffect(() => {
    const first = root.current?.querySelector<HTMLElement>('[tabindex="0"], button, input, select');
    (first ?? root.current)?.focus({ preventScroll: true });
  }, []);

  // A click outside closes it; the focus stays where the writer clicked.
  useEffect(() => {
    const down = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (!t || root.current?.contains(t) || props.anchor.current?.contains(t)) return;
      onClose(false);
    };
    document.addEventListener('pointerdown', down, true);
    return () => document.removeEventListener('pointerdown', down, true);
  }, [onClose, props.anchor]);

  const common = { collection: 'chapters' as const, id: chapter._id, entry: chapter };
  const addBackstory = () => {
    const stored = Array.isArray(chapter.strands) ? (chapter.strands as unknown[]) : [];
    const year = w?.startYear ?? new Date().getFullYear();
    void props.writes.edit(
      'chapters',
      chapter._id,
      {
        strands: [...stored, newBackstoryStrand(newNestedId(), templates.strandBackstory, year)],
      },
      `Added a ${templates.strandBackstory} strand to ${title}`,
    );
  };

  return (
    <div
      ref={root}
      className="strand-pop"
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      tabIndex={-1}
      data-testid="strand-popover"
      data-chapter={chapter._id}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          onClose(true);
        }
      }}
      onBlur={(e) => {
        const next = e.relatedTarget as Node | null;
        // Tab out of the popover closes it; a field closing inside it does not.
        if (next && !root.current?.contains(next)) onClose(false);
      }}
    >
      <p id={titleId} className="strand-pop-title">
        Strands of chapter {props.chapterNo}
      </p>
      {w && wi >= 0 ? (
        <dl className="strand-pop-fields">
          <dt>Writing strand</dt>
          <dd>
            <EntryEditable
              {...common}
              kind="text"
              path={`strands.${wi}.label`}
              label="Writing strand label"
              allowEmpty={false}
              testId="strand-label"
              extraPatch={byId(w.id, (next) => ({ label: String(next) }))}
            />
          </dd>
          <dt>Point of view</dt>
          <dd>
            <EntryEditable
              {...common}
              kind="select"
              path={`strands.${wi}.povCharacterId`}
              label="Point of view"
              options={povOptions}
              allowEmpty
              emptyLabel="No point of view"
              placeholder="No point of view"
              testId="strand-pov"
              extraPatch={byId(w.id, (next) => ({
                povCharacterId: typeof next === 'string' && next ? next : null,
              }))}
            />
          </dd>
          <dt>Characters present</dt>
          <dd>
            <EntryEditable
              {...common}
              kind="chips"
              path={`strands.${wi}.characterIds`}
              label="Characters present"
              layout="inline"
              options={people}
              onAddNew={addCharacter}
              addLabel="Add a character"
              pickerLabel="Character to add"
              placeholder="Nobody listed"
              testId="strand-characters"
              extraPatch={byId(w.id, (next) => ({
                characterIds: Array.isArray(next) ? next.map(String) : [],
              }))}
            />
          </dd>
          <dt>Places</dt>
          <dd>
            <EntryEditable
              {...common}
              kind="chips"
              path={`strands.${wi}.placeIds`}
              label="Places"
              layout="inline"
              options={placeOptions}
              onAddNew={addPlace}
              addLabel="Add a place"
              pickerLabel="Place to add"
              placeholder="No places"
              testId="strand-places"
              extraPatch={byId(w.id, (next) => ({
                placeIds: Array.isArray(next) ? next.map(String) : [],
              }))}
            />
          </dd>
          <dt>Backstory year</dt>
          <dd>
            {b && bi >= 0 ? (
              <EntryEditable
                {...common}
                kind="year"
                path={`strands.${bi}.startYear`}
                label={`Year of the ${b.label || 'backstory'} strand`}
                testId="strand-backstory-year"
                extraPatch={(next, entry) => {
                  const stored = Array.isArray(entry.strands) ? (entry.strands as object[]) : [];
                  if (typeof next !== 'number') return {};
                  const shift = shiftStrand(stored, b.id, next);
                  if (!shift) throw new EditableError(STRAND_GONE);
                  return { strands: shift.next };
                }}
              />
            ) : (
              <span className="strand-pop-none" data-testid="strand-no-backstory">
                No backstory strand.{' '}
                <button
                  type="button"
                  className="btn small"
                  disabled={off}
                  {...props.writes.ro.tip}
                  data-testid="strand-add-backstory"
                  onClick={addBackstory}
                >
                  Add one
                </button>
              </span>
            )}
          </dd>
        </dl>
      ) : (
        <p>This chapter has no strand yet. Open the chapter to add one.</p>
      )}
    </div>
  );
}
