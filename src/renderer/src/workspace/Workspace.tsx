import { useState } from 'react';
import type { ReactNode } from 'react';
import { collectionInfo } from '../../../shared/schema';
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
import { useYearView } from './timeline/common';
import { TreeView } from './tree/TreeView';
import { OutlineView } from './plot';
import { ZhNavProvider } from './Zh';
import { EntryList, ListsView, NewEntryForm, TrashView } from './views';
import { EntriesView } from './entries/EntriesView';
import { ImportView } from './importer';
import { BackupsView } from './backups';
import { DriveLaunchNotice, DriveView } from './drive';
import { AskClaudeButton, ClaudePanelGate, useClaudeNavigation } from './claude';
import { SettingsView } from './settings';
import './shell.css';

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
  /** KB-5: the Entries screen. */
  | { kind: 'entries' }
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
  | { kind: 'brief'; id: string; note?: string | null; noteSettings?: boolean }
  /** MS-1 to MS-4. */
  | { kind: 'manuscript'; chapterId?: string; openFlow?: boolean };

/**
 * KB-1: the raw section lists under More, by group. Characters is one of the
 * five screens; places, cultural entries, glossary terms and custom entries
 * belong to the Entries screen (KB-5).
 */
const MORE_SECTIONS = {
  Sessions: ['sessionLogs', 'briefs', 'findings'],
  People: ['families', 'unions', 'parentLinks', 'relationships'],
  Story: ['books', 'parts', 'arcs', 'chapters', 'plotBeats'],
  World: ['worldEvents', 'eraStates'],
  Knowledge: ['facts', 'knowledgeRecords', 'themes', 'openQuestions'],
} as const satisfies Record<string, readonly EntryCollection[]>;

/** Lists reached only through the Entries screen (KB-5), so its rail item lights for them. */
const ENTRY_ONLY: readonly EntryCollection[] = [
  'culturalEntries',
  'places',
  'glossaryTerms',
  'customEntries',
];

/** More's open state, kept per bible (KB-1). Storage can be missing; the rail works without it. */
function moreKey(bibleId: string): string {
  return `nc.rail.more.${bibleId}`;
}
function readMore(bibleId: string): boolean {
  try {
    return window.localStorage.getItem(moreKey(bibleId)) === 'open';
  } catch {
    return false;
  }
}
function writeMore(bibleId: string, open: boolean): void {
  try {
    window.localStorage.setItem(moreKey(bibleId), open ? 'open' : 'closed');
  } catch {
    // Not remembered; nothing else depends on it.
  }
}

/** The app frame for an open bible: sections in the rail, a list, the editor, an inspector. */
export function Workspace(props: { bibleId: string; bibles: ReactNode }) {
  return (
    <DataProvider key={props.bibleId}>
      <UndoProvider key={props.bibleId}>
        <StoryTimeProvider key={props.bibleId}>
          <Frame bibleId={props.bibleId} bibles={props.bibles} />
        </StoryTimeProvider>
      </UndoProvider>
    </DataProvider>
  );
}

function Frame({ bibleId, bibles }: { bibleId: string; bibles: ReactNode }) {
  const [view, setView] = useState<View>({ kind: 'dashboard' });
  const [moreOpen, setMoreState] = useState(() => readMore(bibleId));
  const setMoreOpen = (open: boolean) => {
    setMoreState(open);
    writeMore(bibleId, open);
  };

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
  const sectionButton = (c: EntryCollection) =>
    railButton(
      collectionInfo[c].plural,
      view.kind === 'section' && view.collection === c && !view.sectionId,
      () => setView({ kind: 'section', collection: c, selected: null, creating: false }),
    );
  const entriesActive =
    view.kind === 'entries' ||
    (view.kind === 'section' && ENTRY_ONLY.includes(view.collection) && !view.sectionId);

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
          <div className="rail-group rail-main" data-testid="rail-main">
            {sectionButton('characters')}
            {railButton('Family tree', view.kind === 'tree', () => setView({ kind: 'tree' }))}
            {railButton('Outline', view.kind === 'outline', () => setView({ kind: 'outline' }))}
            {railButton('Timeline', view.kind === 'timeline', () => setView({ kind: 'timeline' }))}
            {railButton('Entries', entriesActive, () => setView({ kind: 'entries' }))}
          </div>
          <details className="rail-more" open={moreOpen} data-testid="rail-more">
            {/* The state is set here, not from the toggle event, so it is saved at once. */}
            <summary
              onClick={(e) => {
                e.preventDefault();
                setMoreOpen(!moreOpen);
              }}
            >
              More
            </summary>
            <div className="rail-group">
              <span className="eyebrow">Sessions</span>
              {railButton('Dashboard', view.kind === 'dashboard', () =>
                setView({ kind: 'dashboard' }),
              )}
              {railButton('Manuscript', view.kind === 'manuscript', () =>
                setView({ kind: 'manuscript' }),
              )}
              {railButton('Relevant to Session', view.kind === 'relevant', () =>
                setView({ kind: 'relevant' }),
              )}
              {railButton('Start session', view.kind === 'start', () => setView({ kind: 'start' }))}
              {MORE_SECTIONS.Sessions.map(sectionButton)}
            </div>
            {(['People', 'Story', 'World', 'Knowledge'] as const).map((g) => (
              <div key={g} className="rail-group">
                <span className="eyebrow">{g}</span>
                {MORE_SECTIONS[g].map(sectionButton)}
              </div>
            ))}
            <div className="rail-group">
              <span className="eyebrow">Custom</span>
              {sectionButton('customSections')}
              {customSections
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
            <div className="rail-group">
              <span className="eyebrow">Manage</span>
              {railButton('Search and filters', view.kind === 'search', () =>
                setView({ kind: 'search' }),
              )}
              {railButton('Review queue', view.kind === 'review', () =>
                setView({ kind: 'review' }),
              )}
              {railButton('Import', view.kind === 'import', () => setView({ kind: 'import' }))}
              {railButton('Backups', view.kind === 'backups', () => setView({ kind: 'backups' }))}
              {railButton('Google Drive', view.kind === 'drive', () => setView({ kind: 'drive' }))}
              {railButton('Lists', view.kind === 'lists', () => setView({ kind: 'lists' }))}
              {railButton('Trash', view.kind === 'trash', () => setView({ kind: 'trash' }))}
              {railButton('Bibles', view.kind === 'bibles', () => setView({ kind: 'bibles' }))}
              {railButton('Settings', view.kind === 'settings', () =>
                setView({ kind: 'settings' }),
              )}
            </div>
          </details>
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
                onWritten={(chapterId) =>
                  setView({ kind: 'manuscript', chapterId, openFlow: true })
                }
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
              <SearchView query={query} onQuery={setQuery} onOpen={open} />
            </div>
            <SideInspector />
          </>
        ) : view.kind === 'tree' ? (
          <TreeView onOpen={open} />
        ) : view.kind === 'timeline' ? (
          <TimelineView />
        ) : view.kind === 'entries' ? (
          <EntriesView onOpen={open} />
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
                  onStarted={(id, note, noteSettings) =>
                    setView({ kind: 'brief', id, note, noteSettings })
                  }
                />
              )}
              {view.kind === 'brief' && (
                <BriefView
                  key={view.id}
                  id={view.id}
                  note={view.note ?? null}
                  noteSettings={view.noteSettings === true}
                  onOpen={open}
                />
              )}
              {view.kind === 'manuscript' && (
                <ManuscriptView
                  key={view.chapterId ?? ''}
                  onOpen={open}
                  chapterId={view.chapterId}
                  openFlow={view.openFlow}
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
