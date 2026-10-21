import { useState } from 'react';
import type { ReactNode } from 'react';
import { collectionInfo } from '../../../shared/schema';
import type { EntryCollection } from '../../../shared/schema';
import { DataProvider } from './data';
import { EntryPane, UndoPanel } from './editor';
import { StopPrompt } from './session';
import { RelevantView } from './sessions/relevant';
import { SessionsView } from './sessions/SessionsView';
import type { SessionsSub } from './sessions/SessionsView';
import { ContinuityView } from './sessions/ContinuityView';
import type { ContinuityTab } from './sessions/ContinuityView';
import { TopBar } from './TopBar';
import { SearchView } from './search';
import { ReviewQueue } from './review';
import { UndoProvider } from './undo';
import { StoryTimeProvider, formatMoment, useStoryTime } from './storyTime';
import { StoryTimeDialog, useStrandOptions } from './timeline/StoryTimeDialog';
import { TimelineView } from './timeline/TimelineView';
import { useYearView } from './timeline/common';
import { TreeView } from './tree/TreeView';
import { OutlineView } from './plot';
import { ZhNavProvider } from './Zh';
import { EntryList, ListsView, NewEntryForm, TrashView } from './views';
import { CulturalDataView, GlossaryTable, PlacesView, RomanizationView } from './culture';
import type { CultureTab } from './culture';
import { BackstoryPlaceholder } from './backstory/Placeholder';
import { ImportView } from './importer';
import { BackupsView } from './backups';
import { DriveLaunchNotice, DriveView } from './drive';
import { AskClaudeButton, ClaudePanelGate, useClaudeNavigation } from './claude';
import { CaptureBox, CaptureButton } from './capture';
import { SettingsView } from './settings';
import { AppMenu } from './AppMenu';
import { InspectorAside } from './inspector';
import type { Inspected } from './inspector';
import './shell.css';

type View =
  | {
      kind: 'section';
      collection: EntryCollection;
      selected: string | null;
      creating: boolean;
    }
  | { kind: 'search' }
  | { kind: 'tree'; focus?: string }
  /** SM-8: the World events grid. */
  | { kind: 'timeline' }
  | { kind: 'outline' }
  /** SM-9: one row per character; SM-10's Their backstory picks the person. */
  | { kind: 'backstory'; characterId?: string }
  /** SM-11: the alignment check (CC-1 to CC-5) with the manuscript (MS-1 to MS-5) as a second tab. */
  | { kind: 'continuity'; tab: ContinuityTab; chapterId?: string; openFlow?: boolean }
  /** SM-11: the screen the app opens on (DB-1), Start session, the log, briefs and questions. */
  | {
      kind: 'sessions';
      sub: SessionsSub;
      briefId?: string;
      note?: string | null;
      noteSettings?: boolean;
    }
  /** SM-11: cultural entries by community, and the era states. */
  | { kind: 'culture'; tab: CultureTab }
  /** SM-10: Relevant to Session, from the top bar. */
  | { kind: 'relevant' }
  | { kind: 'trash' }
  | { kind: 'lists' }
  | { kind: 'review' }
  | { kind: 'import' }
  | { kind: 'backups' }
  | { kind: 'drive' }
  | { kind: 'settings' }
  | { kind: 'bibles' }
  /** PC-1, GL-1, GL-3: the reference views that left the rail, in the App menu. */
  | { kind: 'places' }
  | { kind: 'romanization' }
  | { kind: 'glossary' };

type Simple = Extract<
  View['kind'],
  | 'search'
  | 'review'
  | 'import'
  | 'backups'
  | 'drive'
  | 'lists'
  | 'trash'
  | 'bibles'
  | 'settings'
  | 'places'
  | 'romanization'
  | 'glossary'
>;

/** SM-6: the App menu, so nothing that left the rail is lost. */
const APP_MENU: { label: string; items: { label: string; kind: Simple }[] }[] = [
  {
    label: 'Manage',
    items: [
      { label: 'Search and filters', kind: 'search' },
      { label: 'Review queue', kind: 'review' },
      { label: 'Import', kind: 'import' },
      { label: 'Backups', kind: 'backups' },
      { label: 'Google Drive', kind: 'drive' },
      { label: 'Lists', kind: 'lists' },
      { label: 'Trash', kind: 'trash' },
      { label: 'Bibles', kind: 'bibles' },
      { label: 'Settings', kind: 'settings' },
    ],
  },
  {
    label: 'Reference',
    items: [
      { label: 'Place tree', kind: 'places' },
      { label: 'Romanization', kind: 'romanization' },
      { label: 'Glossary table', kind: 'glossary' },
    ],
  },
];

/** The app frame for an open bible: the eight screens in the rail, the screen, an inspector. */
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
  const [view, setView] = useState<View>({ kind: 'sessions', sub: 'home' });
  const [query, setQuery] = useState('');

  const open = (collection: EntryCollection, id: string) =>
    setView({ kind: 'section', collection, selected: id, creating: false });
  const openSection = (collection: EntryCollection) =>
    setView({ kind: 'section', collection, selected: null, creating: false });
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
      <CaptureBox />
      <div className="ws-frame" data-testid="workspace">
        <TopBar
          relevantActive={view.kind === 'relevant'}
          onRelevant={() => setView({ kind: 'relevant' })}
          onStartSession={() => setView({ kind: 'sessions', sub: 'start' })}
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
          <div className="rail-group rail-main" data-testid="rail-main">
            {railButton(
              'Characters',
              view.kind === 'section' && view.collection === 'characters',
              () => openSection('characters'),
            )}
            {railButton('Family tree', view.kind === 'tree', () => setView({ kind: 'tree' }))}
            {railButton('Outline', view.kind === 'outline', () => setView({ kind: 'outline' }))}
            {railButton('World events', view.kind === 'timeline', () =>
              setView({ kind: 'timeline' }),
            )}
            {railButton('Backstory', view.kind === 'backstory', () =>
              setView({ kind: 'backstory' }),
            )}
            {railButton('Continuity checker', view.kind === 'continuity', () =>
              setView({ kind: 'continuity', tab: 'alignment' }),
            )}
            {railButton('Sessions', view.kind === 'sessions', () =>
              setView({ kind: 'sessions', sub: 'home' }),
            )}
            {railButton('Cultural data', view.kind === 'culture', () =>
              setView({ kind: 'culture', tab: 'communities' }),
            )}
          </div>
          <AppMenu
            groups={APP_MENU.map((g) => ({
              label: g.label,
              items: g.items.map((it) => ({
                label: it.label,
                active: view.kind === it.kind,
                onSelect: () => setView({ kind: it.kind }),
              })),
            }))}
          />
        </nav>
        {view.kind === 'section' ? (
          <>
            <EntryList
              collection={view.collection}
              selected={view.selected}
              onSelect={(id) => setView({ ...view, selected: id, creating: false })}
              onNew={() => setView({ ...view, selected: null, creating: true })}
            />
            {view.creating ? (
              <>
                <NewEntryForm
                  key={view.collection}
                  collection={view.collection}
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
                onWritten={(chapterId) =>
                  setView({ kind: 'continuity', tab: 'manuscript', chapterId, openFlow: true })
                }
                onOpenTree={(focus) => setView({ kind: 'tree', focus })}
              />
            ) : (
              <>
                <div className="ws-editor empty-editor stack">
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
              <SearchView
                query={query}
                onQuery={setQuery}
                onOpen={open}
                onOpenSection={openSection}
              />
            </div>
            <SideInspector />
          </>
        ) : view.kind === 'tree' ? (
          <TreeView onOpen={open} focus={view.focus} />
        ) : view.kind === 'timeline' ? (
          <TimelineView />
        ) : view.kind === 'outline' ? (
          <OutlineView onOpen={open} />
        ) : view.kind === 'sessions' ? (
          <SessionsView
            key={view.sub === 'brief' ? `brief:${view.briefId ?? ''}` : 'home'}
            sub={view.sub}
            briefId={view.briefId}
            note={view.note ?? null}
            noteSettings={view.noteSettings === true}
            onOpen={open}
            onSub={(sub, briefId, note, noteSettings) =>
              setView({ kind: 'sessions', sub, briefId, note, noteSettings })
            }
            onCheckAlignment={() => setView({ kind: 'continuity', tab: 'alignment' })}
            onDone={() => openSection('characters')}
          />
        ) : view.kind === 'culture' ? (
          <CulturalDataView tab={view.tab} onTab={(tab) => setView({ kind: 'culture', tab })} />
        ) : view.kind === 'places' || view.kind === 'romanization' || view.kind === 'glossary' ? (
          <ReferenceScreen key={view.kind} kind={view.kind} />
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
              {view.kind === 'backstory' && (
                <BackstoryPlaceholder key={view.characterId} characterId={view.characterId} />
              )}
              {view.kind === 'relevant' && (
                <RelevantView
                  onOpen={open}
                  onBackstory={(characterId) => setView({ kind: 'backstory', characterId })}
                />
              )}
              {view.kind === 'continuity' && (
                <ContinuityView
                  key={view.chapterId ?? ''}
                  tab={view.tab}
                  chapterId={view.chapterId}
                  openFlow={view.openFlow}
                  onTab={(tab) => setView({ kind: 'continuity', tab, chapterId: view.chapterId })}
                  onOpen={open}
                />
              )}
            </div>
            <SideInspector />
          </>
        )}
        <StatusBar />
        <StoryTimeGate onOpen={open} />
        <ClaudePanelGate />
      </div>
    </ZhNavProvider>
  );
}

/** PC-1, GL-1, GL-3: the place tree, romanization and glossary table, each with an inspector. */
function ReferenceScreen({ kind }: { kind: 'places' | 'romanization' | 'glossary' }) {
  const [inspected, setInspected] = useState<Inspected | null>(null);
  const onOpen = (collection: EntryCollection, id: string) => setInspected({ collection, id });
  return (
    <>
      <div className="ws-wide-area">
        {kind === 'places' && <PlacesView onOpen={onOpen} />}
        {kind === 'romanization' && <RomanizationView onOpen={onOpen} />}
        {kind === 'glossary' && <GlossaryTable onOpen={onOpen} />}
      </div>
      <InspectorAside open={inspected} onClose={() => setInspected(null)} />
    </>
  );
}

function StoryTimeGate({ onOpen }: { onOpen: (collection: EntryCollection, id: string) => void }) {
  const story = useStoryTime();
  return story.dialogOpen ? <StoryTimeDialog onOpen={onOpen} /> : null;
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
      <CaptureButton />
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
