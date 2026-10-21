import { useEffect, useState } from 'react';
import type { Response } from '../../../../shared/ipc';
import type { Doc } from '../../../../shared/domain/paths';
import { call } from '../../api';
import { useStore } from '../data';
import type { Messages } from '../fields';
import { StrandsEditor } from './Strands';

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
