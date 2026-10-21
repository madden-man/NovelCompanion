import { useEffect, useId, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { WriteFieldset } from '../../connection';
import type { Response } from '../../../../shared/ipc';
import type { Doc } from '../../../../shared/domain/paths';
import { MAX_YEAR, MIN_YEAR } from '../../../../shared/domain/sceneOutline';
import { shiftStrand } from '../../../../shared/domain/strands';
import { entryTitle } from '../../../../shared/schema';
import { call } from '../../api';
import { useEntries, useStore } from '../data';
import type { Messages } from '../fields';
import type { OutlineWrites } from './actions';
import { NumberField } from './NumberField';
import { StrandsEditor } from './Strands';

type Outline = Response<'outline.get'>;
type ChapterRow = Extract<Outline['rows'][number], { kind: 'chapter' }>;
type Page = Response<'chapter.page'>['page'];

/** The stored chapter page, reloaded after every change in the bible. */
function useChapterPage(id: string): Page | null {
  const { version } = useStore();
  const [page, setPage] = useState<Page | null>(null);
  useEffect(() => {
    let live = true;
    void call('chapter.page', { id })
      .then((r) => {
        if (live) setPage(r.page);
      })
      .catch(() => {
        if (live) setPage(null);
      });
    return () => {
      live = false;
    };
  }, [id, version]);
  return page;
}

/**
 * KB-3: the strands of a chapter in the full chapter editor, with who is
 * present and how old and the places. The chapter page feeds the ages and
 * place paths; the edit itself goes through the editor's autosave.
 */
export function ChapterStrands(props: {
  id: string;
  draft: Doc;
  messages: Messages;
  onChange: (next: Doc[]) => void;
}) {
  const page = useChapterPage(props.id);
  if (!page) return <p aria-live="polite">Loading the strands.</p>;
  return (
    <StrandsEditor
      value={props.draft.strands}
      page={page.strands}
      storyYear={page.storyYear ?? new Date().getFullYear()}
      messages={props.messages}
      root={props.draft}
      onChange={props.onChange}
    />
  );
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * A40: the outline's inspector for one chapter: its title, its story year,
 * and how many scenes its section of the outline holds. The title and the
 * year write through the outline's writes, one undo step each (ED-3). The
 * rest of the chapter (strands, written, the manuscript) is edited on the
 * chapter's own page under More.
 */
export function ChapterPanel(props: {
  id: string;
  outline: Outline;
  writes: OutlineWrites;
  /** The top-level bullets in the chapter's section of the scene outline (PL-5). */
  scenes: number;
  onClose: () => void;
}) {
  const { id, outline, writes } = props;
  const stored = useEntries('chapters');
  const doc = stored.find((c) => c._id === id);
  const row = outline.rows.find((r): r is ChapterRow => r.kind === 'chapter' && r.id === id);
  const ids = { title: useId(), year: useId() };
  const title = doc ? entryTitle(doc) : (row?.title ?? '');
  const [draft, setDraft] = useState(title);
  const [seen, setSeen] = useState(title);
  if (seen !== title) {
    // Adjusted during render: a rename on the bar, an undo, or another writer changed the title.
    setSeen(title);
    setDraft(title);
  }
  const off = writes.ro.off;

  if (!row) {
    return (
      <div className="stack tight" data-testid="chapter-panel">
        <p className="callout warn">This chapter is no longer in the outline.</p>
        <button type="button" className="btn small" onClick={props.onClose}>
          Close the chapter
        </button>
      </div>
    );
  }

  const saveTitle = async () => {
    const next = draft.trim();
    if (!next || next === title) {
      setDraft(title);
      return;
    }
    await writes.edit(
      'chapters',
      id,
      { title: next },
      `Renamed chapter ${row.readingOrder} to ${next}`,
    );
  };
  const onTitleKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void saveTitle();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setDraft(title);
    }
  };

  /** The story year is the primary strand's start year; moving it moves that strand (TM-5). */
  const setYear = async (y: number): Promise<boolean> => {
    const strands = Array.isArray(doc?.strands)
      ? (doc.strands as { id: string; primary?: boolean }[])
      : [];
    const primary = strands.find((s) => s.primary) ?? strands[0];
    if (!primary) return false;
    const shift = shiftStrand(strands, primary.id, y);
    if (!shift || shift.unchanged) return false;
    const ok = await writes.edit(
      'chapters',
      id,
      { strands: shift.next },
      `Moved chapter ${row.readingOrder} to ${y}`,
    );
    return ok === true;
  };

  return (
    <div className="stack chapter-panel" data-testid="chapter-panel" data-entry-id={id}>
      <h3 className="ol-chapter-title">Chapter {row.readingOrder}</h3>
      <WriteFieldset className="stack tight">
        <div className="field">
          <label htmlFor={ids.title}>Chapter title</label>
          <input
            id={ids.title}
            value={draft}
            maxLength={500}
            disabled={off}
            {...writes.ro.tip}
            data-testid="panel-title"
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => void saveTitle()}
            onKeyDown={onTitleKey}
          />
        </div>
        <div className="field year-field">
          <label htmlFor={ids.year}>Story year</label>
          <NumberField
            id={ids.year}
            label="Story year"
            testId="panel-year"
            value={row.storyYear}
            min={MIN_YEAR}
            max={MAX_YEAR}
            width="7em"
            disabled={off}
            tip={writes.ro.tip}
            onCommit={(y) => (y === null ? Promise.resolve(false) : setYear(y))}
          />
        </div>
      </WriteFieldset>
      <p data-testid="panel-scenes">
        {props.scenes === 0
          ? 'No scenes in the outline yet.'
          : `${plural(props.scenes, 'scene', 'scenes')} in the outline.`}
      </p>
      <button type="button" className="btn small" onClick={props.onClose}>
        Close the chapter
      </button>
    </div>
  );
}
