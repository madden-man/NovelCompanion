import { useState } from 'react';
import type { ReactNode } from 'react';
import { ENTRY_COLLECTIONS, collectionInfo } from '../../../shared/schema';
import type { EntryCollection } from '../../../shared/schema';
import { DataProvider } from './data';
import { EntryPane, UndoPanel } from './editor';
import { ReviewQueue } from './review';
import { UndoProvider } from './undo';
import { StoryTimeProvider } from './storyTime';
import { TreeView } from './tree/TreeView';
import { EntryList, ListsView, NewEntryForm, TrashView } from './views';

type View =
  | { kind: 'section'; collection: EntryCollection; selected: string | null; creating: boolean }
  | { kind: 'tree' }
  | { kind: 'trash' }
  | { kind: 'lists' }
  | { kind: 'review' }
  | { kind: 'bibles' };

const GROUPS = ['People', 'Story', 'World', 'Knowledge', 'Sessions', 'Custom'];

/** The app frame for an open bible: sections in the rail, a list, the editor, an inspector. */
export function Workspace(props: { bibleId: string; bibles: ReactNode }) {
  return (
    <DataProvider key={props.bibleId}>
      <UndoProvider key={props.bibleId}>
        <StoryTimeProvider key={props.bibleId}>
          <Frame bibles={props.bibles} />
        </StoryTimeProvider>
      </UndoProvider>
    </DataProvider>
  );
}

function Frame({ bibles }: { bibles: ReactNode }) {
  const [view, setView] = useState<View>({
    kind: 'section',
    collection: 'characters',
    selected: null,
    creating: false,
  });

  const open = (collection: EntryCollection, id: string) =>
    setView({ kind: 'section', collection, selected: id, creating: false });

  const railButton = (label: string, active: boolean, onClick: () => void) => (
    <button key={label} type="button" aria-current={active ? 'page' : undefined} onClick={onClick}>
      {label}
    </button>
  );

  return (
    <div className="ws-frame" data-testid="workspace">
      <nav className="rail ws-rail" aria-label="Sections">
        {GROUPS.map((g) => (
          <div key={g} className="rail-group">
            <span className="eyebrow">{g}</span>
            {g === 'People' &&
              railButton('Family tree', view.kind === 'tree', () => setView({ kind: 'tree' }))}
            {ENTRY_COLLECTIONS.filter((c) => collectionInfo[c].group === g).map((c) =>
              railButton(
                collectionInfo[c].plural,
                view.kind === 'section' && view.collection === c,
                () => setView({ kind: 'section', collection: c, selected: null, creating: false }),
              ),
            )}
          </div>
        ))}
        <div className="rail-group">
          <span className="eyebrow">Manage</span>
          {railButton('Review queue', view.kind === 'review', () => setView({ kind: 'review' }))}
          {railButton('Lists', view.kind === 'lists', () => setView({ kind: 'lists' }))}
          {railButton('Trash', view.kind === 'trash', () => setView({ kind: 'trash' }))}
          {railButton('Bibles', view.kind === 'bibles', () => setView({ kind: 'bibles' }))}
        </div>
      </nav>
      {view.kind === 'section' ? (
        <>
          <EntryList
            collection={view.collection}
            selected={view.selected}
            onSelect={(id) => open(view.collection, id)}
            onNew={() => setView({ ...view, selected: null, creating: true })}
          />
          {view.creating ? (
            <>
              <NewEntryForm
                key={view.collection}
                collection={view.collection}
                onCreated={(id) => open(view.collection, id)}
                onCancel={() => setView({ ...view, creating: false })}
              />
              <SideInspector />
            </>
          ) : view.selected ? (
            <EntryPane
              key={`${view.collection}:${view.selected}`}
              collection={view.collection}
              id={view.selected}
              onOpen={open}
              onClosed={() => setView({ ...view, selected: null })}
            />
          ) : (
            <>
              <div className="ws-editor empty-editor">
                <p className="lede">
                  Pick an entry to edit it, or make a new{' '}
                  {collectionInfo[view.collection].singular.toLowerCase()}.
                </p>
              </div>
              <SideInspector />
            </>
          )}
        </>
      ) : view.kind === 'tree' ? (
        <TreeView onOpen={open} />
      ) : (
        <>
          <div className="ws-wide-area">
            {view.kind === 'trash' && <TrashView onOpen={open} />}
            {view.kind === 'lists' && <ListsView />}
            {view.kind === 'review' && <ReviewQueue />}
            {view.kind === 'bibles' && <div className="ws-wide stack">{bibles}</div>}
          </div>
          <SideInspector />
        </>
      )}
    </div>
  );
}

function SideInspector() {
  return (
    <aside className="inspector ws-inspector" aria-label="Inspector" data-testid="inspector">
      <span className="eyebrow">Inspector</span>
      <UndoPanel />
    </aside>
  );
}
