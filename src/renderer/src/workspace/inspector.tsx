import type { ReactNode } from 'react';
import type { EntryCollection } from '../../../shared/schema';
import { EmbeddedEditor, UndoPanel } from './editor';

export interface Inspected {
  collection: EntryCollection;
  id: string;
}

/**
 * The inspector column of a wide screen (Sessions, Cultural data, the App
 * menu's reference views): an entry picked on the screen opens here for
 * editing, with the undo history under it. `children` replaces the editor,
 * for a form such as New question.
 */
export function InspectorAside(props: {
  open: Inspected | null;
  onClose: () => void;
  children?: ReactNode;
  hint?: string;
}) {
  const { open } = props;
  return (
    <aside className="inspector ws-inspector" aria-label="Inspector" data-testid="inspector">
      <span className="eyebrow">Inspector</span>
      {props.children ??
        (open ? (
          <>
            <button type="button" className="btn small" onClick={props.onClose}>
              Close the editor
            </button>
            <EmbeddedEditor key={`${open.collection}:${open.id}`} {...open} />
          </>
        ) : (
          <p className="example-note">{props.hint ?? 'Pick an entry here to edit it.'}</p>
        ))}
      <UndoPanel />
    </aside>
  );
}
