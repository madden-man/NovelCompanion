import { useEffect, useRef } from 'react';
import type { EntryCollection } from '../../../shared/schema';
import { EmbeddedEditor } from './editor';

export interface Picked {
  collection: EntryCollection;
  id: string;
}

/**
 * A43: an entry picked on a wide screen (an open question, a
 * place, a glossary term, a world event) opens in place, under its row, with
 * the full editor. One opens at a time; Close puts it away and gives the focus
 * back to whatever opened it, usually the row.
 */
export function RowEditor(props: { open: Picked; onClose: () => void; testId: string }) {
  const { open } = props;
  const opener = useRef<HTMLElement | null>(null);
  const box = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    box.current?.scrollIntoView({ block: 'nearest' });
  }, []);
  const close = () => {
    props.onClose();
    if (opener.current?.isConnected) opener.current.focus();
  };
  return (
    <div ref={box} className="row-editor" data-testid={props.testId}>
      <EmbeddedEditor key={`${open.collection}:${open.id}`} {...open} onClose={close} />
    </div>
  );
}
