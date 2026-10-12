import { useState } from 'react';
import type { ReactNode } from 'react';
import { ENTRY_COLLECTIONS, collectionInfo } from '../../../shared/schema';
import type { EntryCollection } from '../../../shared/schema';
import { DataProvider, useEntries } from './data';
import { EntryPane, UndoPanel } from './editor';
import { StopPrompt } from './session';
import { DashboardView } from './sessions/dashboard';
import { RelevantView } from './sessions/relevant';
import { StartSessionView } from './sessions/start';
import { BriefView } from './sessions/brief';
import { ManuscriptView } from './sessions/manuscript';
import { AlignmentView } from './sessions/alignment';
import { TopBar } from './TopBar';
import { SearchView } from './search';
import { ReviewQueue } from './review';
import { UndoProvider } from './undo';
import { StoryTimeProvider, formatMoment, useStoryTime } from './storyTime';
import { StoryTimeDialog, useStrandOptions } from './timeline/StoryTimeDialog';
import { TimelineView } from './timeline/TimelineView';
import { YearView } from './timeline/YearView';
import { CompareView } from './timeline/CompareView';
import { useYearView } from './timeline/common';
import { TreeView } from './tree/TreeView';
import { CultureView, GlossaryTable, PlacesView, RomanizationView } from './culture';
import { OutlineView } from './plot';
import { ZhNavProvider } from './Zh';
import { EntryList, ListsView, NewEntryForm, TrashView } from './views';
import { ImportView } from './importer';
import { BackupsView } from './backups';
import { DriveLaunchNotice, DriveView } from './drive';
import { AskClaudeButton, ClaudePanelGate, useClaudeNavigation } from './claude';
import { SettingsView } from './settings';

type View =
  | {
      kind: 'section';
      collection: EntryCollection;
      selected: string | null;
      creating: boolean;
      /** CS-2: a custom section whose entries are listed and created here. */
      sectionId?: string;
    }
  | { kind: 'search' }
  | { kind: 'tree' }
  | { kind: 'timeline' }
  | { kind: 'outline' }
  | { kind: 'culture' }
  | { kind: 'places' }
  | { kind: 'romanization' }
  | { kind: 'glossary' }
  | { kind: 'year' }
  | { kind: 'compare' }
  | { kind: 'trash' }
  | { kind: 'lists' }
  | { kind: 'review' }
  | { kind: 'import' }
  | { kind: 'backups' }
  | { kind: 'drive' }
  | { kind: 'settings' }
  | { kind: 'bibles' }
  /** DB-1: the screen the app opens on. */
  | { kind: 'dashboard' }
  /** Relevant to Session: the SB-2 selection for the chapter being written. */
  | { kind: 'relevant' }
  /** CC-1: the alignment check, from Check alignment on the dashboard. */
  | { kind: 'alignment' }
  /** DB-2: start a session for a section of plot. */
  | { kind: 'start' }
  /** SB-8: one saved brief. */
  | { kind: 'brief'; id: string; note?: string | null }
  /** MS-1 to MS-4. */
  | { kind: 'manuscript' };

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
  const [view, setView] = useState<View>({ kind: 'dashboard' });

  const [query, setQuery] = useState('');
  const customSections = useEntries('customSections');

  const open = (collection: EntryCollection, id: string) =>
    setView({ kind: 'section', collection, selected: id, creating: false });
  useClaudeNavigation({
    settings: () => setView({ kind: 'settings' }),
    review: () => setView({ kind: 'review' }),
    entry: open,
  });

  const railButton = (label: string, active: boolean, onClick: () => void) => (
    <button key={label} type="button" aria-current={active ? 'page' : undefined} onClick={onClick}>
      {label}
    </button>
  );

  return (
    <ZhNavProvider value={open}>
      <DriveLaunchNotice onReview={() => setView({ kind: 'drive' })} />
      <StopPrompt />
      <div className="ws-frame" data-testid="workspace">
        <TopBar
          onRelevant={() => setView({ kind: 'relevant' })}
          onStartSession={() => setView({ kind: 'start' })}
        />
        <nav className="rail ws-rail" aria-label="Sections">
          <div className="field rail-search">
            <label className="sr-only" htmlFor="rail-search">
              Search the bible
            </label>
            <input
              id="rail-search"
              type="search"
              placeholder="Search the bible"
              autoComplete="off"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setView({ kind: 'search' });
              }}
            />
          </div>
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
              {g === 'Story' && (
                <>
                  {railButton('Outline', view.kind === 'outline', () =>
                    setView({ kind: 'outline' }),
                  )}
                  {railButton('Manuscript', view.kind === 'manuscript', () =>
                    setView({ kind: 'manuscript' }),
                  )}
                </>
              )}
              {g === 'Sessions' && (
                <>
                  {railButton('Dashboard', view.kind === 'dashboard', () =>
                    setView({ kind: 'dashboard' }),
                  )}
                  {railButton('Relevant to Session', view.kind === 'relevant', () =>
                    setView({ kind: 'relevant' }),
                  )}
                  {railButton('Start session', view.kind === 'start', () =>
                    setView({ kind: 'start' }),
                  )}
                </>
              )}
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
                  {railButton('Glossary table', view.kind === 'glossary', () =>
                    setView({ kind: 'glossary' }),
                  )}
                </>
              )}
              {ENTRY_COLLECTIONS.filter((c) => collectionInfo[c].group === g).map((c) =>
                railButton(
                  collectionInfo[c].plural,
                  view.kind === 'section' && view.collection === c && !view.sectionId,
                  () =>
                    setView({ kind: 'section', collection: c, selected: null, creating: false }),
                ),
              )}
              {g === 'Custom' &&
                customSections
                  .filter((sec) => sec.deletedAt === undefined)
                  .sort((a, b) => String(a.name).localeCompare(String(b.name)))
                  .map((sec) =>
                    railButton(
                      String(sec.name),
                      view.kind === 'section' && view.sectionId === sec._id,
                      () =>
                        setView({
                          kind: 'section',
                          collection: 'customEntries',
                          selected: null,
                          creating: false,
                          sectionId: sec._id,
                        }),
                    ),
                  )}
            </div>
          ))}
          <div className="rail-group">
            <span className="eyebrow">Manage</span>
            {railButton('Search and filters', view.kind === 'search', () =>
              setView({ kind: 'search' }),
            )}
            {railButton('Review queue', view.kind === 'review', () => setView({ kind: 'review' }))}
            {railButton('Import', view.kind === 'import', () => setView({ kind: 'import' }))}
            {railButton('Backups', view.kind === 'backups', () => setView({ kind: 'backups' }))}
            {railButton('Google Drive', view.kind === 'drive', () => setView({ kind: 'drive' }))}
            {railButton('Lists', view.kind === 'lists', () => setView({ kind: 'lists' }))}
            {railButton('Trash', view.kind === 'trash', () => setView({ kind: 'trash' }))}
            {railButton('Bibles', view.kind === 'bibles', () => setView({ kind: 'bibles' }))}
            {railButton('Settings', view.kind === 'settings', () => setView({ kind: 'settings' }))}
          </div>
        </nav>
        {view.kind === 'section' ? (
          <>
            <EntryList
              collection={view.collection}
              sectionId={view.sectionId}
              selected={view.selected}
              onSelect={(id) => setView({ ...view, selected: id, creating: false })}
              onNew={() => setView({ ...view, selected: null, creating: true })}
            />
            {view.creating ? (
              <>
                <NewEntryForm
                  key={`${view.collection}:${view.sectionId ?? ''}`}
                  collection={view.collection}
                  preset={view.sectionId ? { sectionId: view.sectionId } : undefined}
                  onCreated={(id) => setView({ ...view, selected: id, creating: false })}
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
        ) : view.kind === 'search' ? (
          <>
            <div className="ws-wide-area">
              <SearchView query={query} onQuery={setQuery} onOpen={open} />
            </div>
            <SideInspector />
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
              {view.kind === 'import' && <ImportView />}
              {view.kind === 'backups' && <BackupsView />}
              {view.kind === 'drive' && <DriveView />}
              {view.kind === 'settings' && <SettingsView />}
              {view.kind === 'bibles' && <div className="ws-wide stack">{bibles}</div>}
              {view.kind === 'year' && <YearView />}
              {view.kind === 'compare' && <CompareView />}
              {view.kind === 'culture' && <CultureView onOpen={open} />}
              {view.kind === 'places' && <PlacesView onOpen={open} />}
              {view.kind === 'romanization' && <RomanizationView onOpen={open} />}
              {view.kind === 'glossary' && <GlossaryTable onOpen={open} />}
              {view.kind === 'dashboard' && (
                <DashboardView
                  onStartSession={() => setView({ kind: 'start' })}
                  onCheckAlignment={() => setView({ kind: 'alignment' })}
                  onOpenQuestions={() =>
                    setView({
                      kind: 'section',
                      collection: 'openQuestions',
                      selected: null,
                      creating: false,
                    })
                  }
                  onOpenBrief={(id) => setView({ kind: 'brief', id })}
                  onOpenChapter={(id) => open('chapters', id)}
                  onDone={() =>
                    setView({
                      kind: 'section',
                      collection: 'characters',
                      selected: null,
                      creating: false,
                    })
                  }
                />
              )}
              {view.kind === 'relevant' && <RelevantView onOpen={open} />}
              {view.kind === 'alignment' && <AlignmentView onOpen={open} />}
              {view.kind === 'start' && (
                <StartSessionView
                  onOpen={open}
                  onStarted={(id, note) => setView({ kind: 'brief', id, note })}
                />
              )}
              {view.kind === 'brief' && (
                <BriefView key={view.id} id={view.id} note={view.note ?? null} onOpen={open} />
              )}
              {view.kind === 'manuscript' && <ManuscriptView onOpen={open} />}
            </div>
            <SideInspector />
          </>
        )}
        <StatusBar />
        <StoryTimeGate />
        <ClaudePanelGate />
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
      <AskClaudeButton />
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
