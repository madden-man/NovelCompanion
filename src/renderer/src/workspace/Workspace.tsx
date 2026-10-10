import { useState } from 'react';
import type { ReactNode } from 'react';
import { ENTRY_COLLECTIONS, collectionInfo } from '../../../shared/schema';
import type { EntryCollection } from '../../../shared/schema';
import { DataProvider } from './data';
import { EntryPane, UndoPanel } from './editor';
import { ReviewQueue } from './review';
import { UndoProvider } from './undo';
import { StoryTimeProvider, formatMoment, useStoryTime } from './storyTime';
import { StoryTimeDialog, useStrandOptions } from './timeline/StoryTimeDialog';
import { TimelineView } from './timeline/TimelineView';
import { YearView } from './timeline/YearView';
import { CompareView } from './timeline/CompareView';
import { useYearView } from './timeline/common';
import { TreeView } from './tree/TreeView';
import { CultureView, PlacesView, RomanizationView } from './culture';
import { OutlineView } from './plot';
import { ZhNavProvider } from './Zh';
import { EntryList, ListsView, NewEntryForm, TrashView } from './views';

type View =
  | { kind: 'section'; collection: EntryCollection; selected: string | null; creating: boolean }
  | { kind: 'tree' }
  | { kind: 'timeline' }
  | { kind: 'outline' }
  | { kind: 'culture' }
  | { kind: 'places' }
  | { kind: 'romanization' }
  | { kind: 'year' }
  | { kind: 'compare' }
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
    <ZhNavProvider value={open}>
      <div className="ws-frame" data-testid="workspace">
        <nav className="rail ws-rail" aria-label="Sections">
          {GROUPS.map((g) => (
            <div key={g} className="rail-group">
              <span className="eyebrow">{g}</span>
              {g === 'People' && (
                <>
                  {railButton('Family tree', view.kind === 'tree', () => setView({ kind: 'tree' }))}
                  {railButton('Year view', view.kind === 'year', () => setView({ kind: 'year' }))}
                  {railButton('Compare', view.kind === 'compare', () =>
                    setView({ kind: 'compare' }),
                  )}
                </>
              )}
              {g === 'Story' &&
                railButton('Outline', view.kind === 'outline', () => setView({ kind: 'outline' }))}
              {g === 'World' && (
                <>
                  {railButton('Timeline', view.kind === 'timeline', () =>
                    setView({ kind: 'timeline' }),
                  )}
                  {railButton('Culture by year', view.kind === 'culture', () =>
                    setView({ kind: 'culture' }),
                  )}
                  {railButton('Place tree', view.kind === 'places', () =>
                    setView({ kind: 'places' }),
                  )}
                  {railButton('Romanization', view.kind === 'romanization', () =>
                    setView({ kind: 'romanization' }),
                  )}
                </>
              )}
              {ENTRY_COLLECTIONS.filter((c) => collectionInfo[c].group === g).map((c) =>
                railButton(
                  collectionInfo[c].plural,
                  view.kind === 'section' && view.collection === c,
                  () =>
                    setView({ kind: 'section', collection: c, selected: null, creating: false }),
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
        ) : view.kind === 'timeline' ? (
          <TimelineView />
        ) : view.kind === 'outline' ? (
          <OutlineView />
        ) : (
          <>
            <div className="ws-wide-area">
              {view.kind === 'trash' && <TrashView onOpen={open} />}
              {view.kind === 'lists' && <ListsView />}
              {view.kind === 'review' && <ReviewQueue />}
              {view.kind === 'bibles' && <div className="ws-wide stack">{bibles}</div>}
              {view.kind === 'year' && <YearView />}
              {view.kind === 'compare' && <CompareView />}
              {view.kind === 'culture' && <CultureView onOpen={open} />}
              {view.kind === 'places' && <PlacesView onOpen={open} />}
              {view.kind === 'romanization' && <RomanizationView onOpen={open} />}
            </div>
            <SideInspector />
          </>
        )}
        <StatusBar />
        <StoryTimeGate />
      </div>
    </ZhNavProvider>
  );
}

function StoryTimeGate() {
  const story = useStoryTime();
  return story.dialogOpen ? <StoryTimeDialog /> : null;
}

/** TM-3: the current story time, its era, and the chapter being written, on every screen. */
function StatusBar() {
  const story = useStoryTime();
  const time = story.time ?? { year: story.year };
  const view = useYearView(time);
  const strands = useStrandOptions();
  const strand = strands.find(
    (s) => s.chapterId === story.time?.chapterId && s.strandId === story.time?.strandId,
  );
  return (
    <footer className="statusbar ws-status" aria-label="Status" data-testid="status-bar">
      <span data-testid="status-time">
        <strong>Story time {formatMoment(time)}</strong>
        {view?.era ? `, ${view.era.name}` : ''}
        {story.time ? '' : ' (from the current position, not set)'}
      </span>
      {strand && <span data-testid="status-strand">Writing: {strand.label}</span>}
      <button type="button" className="btn small" onClick={story.openDialog}>
        Story time <kbd>Cmd T</kbd>
      </button>
    </footer>
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
