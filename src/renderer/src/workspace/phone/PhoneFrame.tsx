import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { ENTRY_COLLECTIONS, collectionInfo } from '../../../../shared/schema';
import type { EntryCollection } from '../../../../shared/schema';
import { call } from '../../api';
import { EntryPane } from '../editor';
import { NotebookPageView } from '../notebook';
import { RelevantView } from '../sessions/relevant';
import { QuestionsView } from '../sessions/SessionsView';
import { SearchView } from '../search';
import { UndoNotice, useUndo } from '../undo';
import { useStoryTime } from '../storyTime';
import { TimelineView } from '../timeline/TimelineView';
import { BackstoryView } from '../backstory/BackstoryView';
import { useOpenBackstory } from '../backstory/nav';
import { TreeView } from '../tree/TreeView';
import { OutlineView } from '../plot';
import { useOpenOutline } from '../outline/nav';
import { ZhNavProvider } from '../Zh';
import { EntryList, ListsView, NewEntryForm, TrashView } from '../views';
import { CulturalDataView, GlossaryTable, PlacesView, RomanizationView } from '../culture';
import type { CultureTab } from '../culture';
import { WritingToolsScreen } from '../words';
import { CaptureBox, captureNav } from '../capture';
import { SettingsView } from '../settings';
import { Icon } from './icons';
import type { IconName } from './icons';
import { useKeyboardHold } from './keyboard';
import { PhoneNavProvider, TABS, usePhoneNav } from './nav';
import type { Page, Screen, Tab } from './nav';
import { PhoneSheet } from './Sheet';
import { YearDial } from './YearDial';
import { YearPage } from './YearPage';
import './phone.css';

interface BibleRef {
  id: string;
  name: string;
}

/** What the phone's bible chooser needs from the app shell (PH-37). */
export interface PhoneChooser {
  current: BibleRef;
  bibles: readonly BibleRef[];
  busy: boolean;
  onOpen: (id: string) => Promise<void>;
}

type Open = (collection: EntryCollection, id: string) => void;

const TAB_ITEMS: { tab: Tab; label: string; icon: IconName }[] = [
  { tab: 'people', label: 'People', icon: 'people' },
  { tab: 'outline', label: 'Outline', icon: 'outline' },
  { tab: 'world', label: 'World', icon: 'world' },
  { tab: 'search', label: 'Search', icon: 'search' },
];

/** The bible menu's More: every screen of the old rail and App menu not on the bottom bar. */
const MORE: { label: string; screen: Screen }[] = [
  { label: 'Family tree', screen: 'tree' },
  { label: 'Backstory', screen: 'backstory' },
  { label: 'Questions', screen: 'questions' },
  { label: 'Cultural data', screen: 'culture' },
  { label: 'Writing tools', screen: 'words' },
  { label: 'Relevant to Session', screen: 'relevant' },
  { label: 'Place tree', screen: 'places' },
  { label: 'Romanization', screen: 'romanization' },
  { label: 'Glossary table', screen: 'glossary' },
  { label: 'Lists', screen: 'lists' },
  { label: 'Trash', screen: 'trash' },
  { label: 'Settings', screen: 'settings' },
];

/**
 * A58 U1 (PH-29, PH-30, PH-31, PH-35): the phone's frame for an open bible.
 * A fixed top bar (the bible, the story year, Undo and Redo), one screen at a
 * time, and a fixed bottom bar (People, Outline, World, Search, +). Entries
 * open as full pages over their tab; the bible's name opens the chooser, with
 * every other screen under More. `Workspace` renders it in place of the desk
 * frame when `usePhone()` is true.
 */
export function PhoneFrame(props: { bible: string; chooser?: PhoneChooser }) {
  return (
    <PhoneNavProvider bible={props.bible}>
      <Frame chooser={props.chooser} bible={props.bible} />
    </PhoneNavProvider>
  );
}

function Frame({ chooser, bible }: { chooser?: PhoneChooser; bible: string }) {
  const nav = usePhoneNav();
  const { push } = nav;
  useKeyboardHold();
  const [query, setQuery] = useState('');

  // A50: a moment's door is Backstory, on its person with the moment open.
  const open = useCallback<Open>(
    (collection, id) =>
      push(
        collection === 'moments'
          ? { kind: 'screen', screen: 'backstory', arg2: id, at: Date.now() }
          : { kind: 'entry', collection, id },
      ),
    [push],
  );
  useOpenBackstory((characterId, at, momentId) =>
    push({ kind: 'screen', screen: 'backstory', arg: characterId, arg2: momentId, at }),
  );
  useOpenOutline(() => nav.switchTab('outline'));

  return (
    <ZhNavProvider value={open}>
      <CloseFlush />
      <CaptureBox />
      <div className="ph-frame" data-testid="workspace" data-tab={nav.tab}>
        <PhoneTopBar name={chooser?.current.name ?? bible} />
        {TABS.filter((t) => t === nav.tab).map((t) => (
          <TabView key={t} tab={t} open={open} query={query} onQuery={setQuery} />
        ))}
        <PhoneToast />
        <BottomBar />
        <YearSheet />
        <BibleSheet chooser={chooser} />
        <ChangesSheet />
        <StoryTimeGate />
      </div>
    </ZhNavProvider>
  );
}

/** When the app is closed or hidden, pending edits are saved first (`app.closeRequested`). */
function CloseFlush() {
  const { flush } = useUndo();
  useEffect(
    () =>
      window.api.on('app.closeRequested', () => {
        void flush()
          .catch(() => undefined)
          .finally(() => void call('app.flushed', {}));
      }),
    [flush],
  );
  return null;
}

/** A58 U3: whatever opens the Story Time dialog (TM-1) opens the year view page on the phone. */
function StoryTimeGate() {
  const story = useStoryTime();
  const nav = usePhoneNav();
  const { dialogOpen, closeDialog } = story;
  const { push, top } = nav;
  const onYear = top?.kind === 'screen' && top.screen === 'year';
  useEffect(() => {
    if (!dialogOpen) return;
    closeDialog();
    if (!onYear) push({ kind: 'screen', screen: 'year' });
  }, [dialogOpen, closeDialog, push, onYear]);
  return null;
}

/** PH-29: the bible's name (the chooser), the story year (its sheet), Undo and Redo. */
function PhoneTopBar({ name }: { name: string }) {
  const nav = usePhoneNav();
  const story = useStoryTime();
  const undo = useUndo();
  const year = String((story.time ?? { year: story.year }).year);
  const nextUndo = undo.history.undo[0]?.label;
  const nextRedo = undo.history.redo[0]?.label;
  return (
    <header className="ph-top" data-testid="phone-top-bar">
      {nav.stack.length > 0 && (
        <button
          type="button"
          className="ph-icon-btn ph-back"
          aria-label="Back"
          onClick={nav.back}
          data-testid="phone-back"
        >
          <Icon name="back" />
        </button>
      )}
      <button
        type="button"
        className="ph-bible"
        aria-haspopup="dialog"
        aria-expanded={nav.sheet === 'bibles'}
        aria-label={`Bible: ${name}`}
        onClick={() => nav.openSheet('bibles')}
        data-testid="bible-menu-button"
      >
        <span className="ph-bible-name" data-testid="current-bible">
          {name}
        </span>
        <Icon name="down" className="ph-chevron" />
      </button>
      <button
        type="button"
        className="ph-year"
        aria-haspopup="dialog"
        aria-expanded={nav.sheet === 'year'}
        aria-label={`Story year ${year}`}
        onClick={() => nav.openSheet('year')}
        data-testid="phone-year"
      >
        {year}
      </button>
      <button
        type="button"
        className="ph-icon-btn"
        aria-label={nextUndo ? `Undo ${nextUndo}` : 'Undo'}
        disabled={!undo.canUndo}
        onClick={() => void undo.undo()}
        data-testid="phone-undo"
      >
        <Icon name="undo" />
      </button>
      <button
        type="button"
        className="ph-icon-btn"
        aria-label={nextRedo ? `Redo ${nextRedo}` : 'Redo'}
        disabled={!undo.canRedo}
        onClick={() => void undo.redo()}
        data-testid="phone-redo"
      >
        <Icon name="redo" />
      </button>
    </header>
  );
}

/** PH-30: People, Outline, World, Search and +, above the home indicator. */
function BottomBar() {
  const nav = usePhoneNav();
  const pick = (tab: Tab) => {
    if (tab !== 'search' || nav.tab === 'search') {
      nav.switchTab(tab);
      return;
    }
    // Focused inside the tap itself, so iOS raises the keyboard.
    flushSync(() => nav.switchTab('search'));
    if (nav.stacks.search.length === 0) focusSearch();
  };
  return (
    <nav className="ph-bottom" aria-label="Screens" data-testid="phone-bottom-bar">
      {TAB_ITEMS.map((it) => (
        <button
          key={it.tab}
          type="button"
          className="ph-tab"
          aria-current={nav.tab === it.tab ? 'page' : undefined}
          onClick={() => pick(it.tab)}
          data-testid={`tab-${it.tab}`}
        >
          <Icon name={it.icon} />
          <span className="ph-tab-label">{it.label}</span>
        </button>
      ))}
      <button
        type="button"
        className="ph-tab ph-add"
        aria-label="Add"
        aria-haspopup="dialog"
        onClick={() => captureNav.open()}
        data-testid="tab-add"
      >
        <Icon name="plus" />
        <span className="ph-tab-label" aria-hidden="true">
          +
        </span>
      </button>
    </nav>
  );
}

function focusSearch(): void {
  document
    .querySelector<HTMLInputElement>('[data-testid="phone-search"] input[type="search"]')
    ?.focus({ preventScroll: true });
}

/** One tab: its root, with each page of its stack over it; only the top one shows. */
function TabView(props: { tab: Tab; open: Open; query: string; onQuery: (q: string) => void }) {
  const { tab, open } = props;
  const nav = usePhoneNav();
  const stack = nav.stacks[tab];
  const root: ReactNode =
    tab === 'people' ? (
      <EntryList
        collection="characters"
        selected={null}
        onSelect={(id) => open('characters', id)}
        onNew={(preset) => nav.push({ kind: 'new', collection: 'characters', preset })}
      />
    ) : tab === 'outline' ? (
      <OutlineView onOpen={open} />
    ) : tab === 'world' ? (
      <TimelineView />
    ) : (
      <SearchScreen query={props.query} onQuery={props.onQuery} open={open} />
    );
  return (
    <>
      <div className="ph-screen" hidden={stack.length > 0} data-testid={`phone-${tab}`}>
        {root}
      </div>
      {stack.map((page, i) => (
        <div
          key={`${i}:${pageKey(page)}`}
          className="ph-screen ph-page"
          hidden={i !== stack.length - 1}
          data-testid="phone-page"
        >
          <PageView page={page} open={open} />
        </div>
      ))}
    </>
  );
}

function pageKey(p: Page): string {
  switch (p.kind) {
    case 'entry':
      return `e:${p.collection}:${p.id}`;
    case 'new':
      return `n:${p.collection}`;
    case 'section':
      return `l:${p.collection}`;
    case 'screen':
      return `s:${p.screen}:${p.arg ?? ''}:${p.arg2 ?? ''}:${p.at ?? ''}`;
  }
}

/** Search as its own screen: the field takes the focus when the screen opens. */
function SearchScreen(props: { query: string; onQuery: (q: string) => void; open: Open }) {
  const nav = usePhoneNav();
  const showing = nav.tab === 'search' && nav.stacks.search.length === 0;
  const first = useRef(true);
  useEffect(() => {
    // The first opening is focused by the tap; this covers a reload or a return.
    if (showing && (first.current || document.activeElement === document.body)) focusSearch();
    first.current = false;
  }, [showing]);
  return (
    <div className="ws-wide-area">
      <SearchView
        query={props.query}
        onQuery={props.onQuery}
        onOpen={props.open}
        onOpenSection={(collection) => nav.push({ kind: 'section', collection })}
        onOpenNotebook={(id) => nav.push({ kind: 'screen', screen: 'notebook', arg: id })}
      />
    </div>
  );
}

function PageView({ page, open }: { page: Page; open: Open }) {
  const nav = usePhoneNav();
  const tree = (focus?: string) =>
    nav.push({ kind: 'screen', screen: 'tree', ...(focus ? { arg: focus } : {}) });
  switch (page.kind) {
    case 'entry':
      return (
        <EntryPane
          collection={page.collection}
          id={page.id}
          onOpen={open}
          onClosed={nav.back}
          onOpenTree={tree}
        />
      );
    case 'new':
      return (
        <NewEntryForm
          collection={page.collection}
          preset={page.preset}
          onCreated={(id) => nav.replaceTop({ kind: 'entry', collection: page.collection, id })}
          onCancel={nav.back}
        />
      );
    case 'section':
      return (
        <EntryList
          collection={page.collection}
          selected={null}
          onSelect={(id) => open(page.collection, id)}
          onNew={(preset) => nav.push({ kind: 'new', collection: page.collection, preset })}
        />
      );
    case 'screen':
      return <ScreenView page={page} open={open} tree={tree} />;
  }
}

function ScreenView(props: {
  page: Extract<Page, { kind: 'screen' }>;
  open: Open;
  tree: (focus?: string) => void;
}) {
  const { page, open, tree } = props;
  const nav = usePhoneNav();
  const wide = (child: ReactNode) => <div className="ws-wide-area">{child}</div>;
  switch (page.screen) {
    case 'tree':
      return <TreeView onOpen={open} focus={page.arg} />;
    case 'backstory':
      return (
        <BackstoryView
          characterId={page.arg}
          momentId={page.arg2}
          openedAt={page.at}
          onOpen={open}
        />
      );
    case 'questions':
      return <QuestionsView />;
    case 'culture':
      return (
        <CulturalDataView
          tab={(page.arg as CultureTab | undefined) ?? 'communities'}
          onTab={(tab) => nav.replaceTop({ ...page, arg: tab })}
        />
      );
    case 'words':
      return <WritingToolsScreen />;
    case 'relevant':
      return wide(
        <RelevantView
          onOpen={open}
          onBackstory={(characterId) =>
            nav.push({ kind: 'screen', screen: 'backstory', arg: characterId, at: Date.now() })
          }
          onOpenTree={tree}
        />,
      );
    case 'places':
      return wide(<PlacesView />);
    case 'romanization':
      return wide(<RomanizationView />);
    case 'glossary':
      return wide(<GlossaryTable />);
    case 'lists':
      return wide(<ListsView />);
    case 'trash':
      return wide(<TrashView onOpen={open} />);
    case 'settings':
      return wide(<SettingsView />);
    case 'year':
      return <YearPage onOpen={open} />;
    case 'notebook':
      return wide(
        <div className="ws-wide">
          <NotebookPageView id={page.arg ?? ''} onOpen={open} onClose={nav.back} />
        </div>,
      );
  }
}

/**
 * The status bar's notices on the phone: what the last undo, redo or change
 * said, as a toast above the bottom bar with its Undo button. It goes after a
 * few seconds; a new notice brings it back.
 */
const TOAST_MS = 6000;
function PhoneToast() {
  const undo = useUndo();
  const notice = undo.notice;
  const [gone, setGone] = useState<string | null>(null);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setGone(notice), TOAST_MS);
    return () => clearTimeout(t);
  }, [notice, undo.noticeUndo]);
  const showing = notice !== null && gone !== notice;
  return (
    <div className="ph-toast-slot" role="status" aria-live="polite">
      {showing && (
        <div className="ph-toast" data-testid="phone-toast">
          <UndoNotice />
        </div>
      )}
    </div>
  );
}

/** PH-29: the story year as a sheet: the dial (U3). */
function YearSheet() {
  const nav = usePhoneNav();
  return (
    <PhoneSheet name="year" label="Story year" testId="year-sheet">
      <YearDial onOpenYear={() => nav.push({ kind: 'screen', screen: 'year' })} />
    </PhoneSheet>
  );
}

/** PH-37: the bible chooser lists every bible; More holds every screen not on the bottom bar. */
function BibleSheet({ chooser }: { chooser?: PhoneChooser }) {
  return (
    <PhoneSheet name="bibles" label="Bibles" testId="bible-sheet">
      <BibleMenuBody chooser={chooser} />
    </PhoneSheet>
  );
}

function BibleMenuBody({ chooser }: { chooser?: PhoneChooser }) {
  const nav = usePhoneNav();
  const pick = async (id: string) => {
    if (!chooser || id === chooser.current.id) {
      nav.closeSheet();
      return;
    }
    nav.reset();
    await chooser.onOpen(id);
  };
  return (
    <>
      {chooser && (
        <ul className="ph-list" aria-label="Bibles" data-testid="phone-bibles">
          {chooser.bibles.map((b) => (
            <li key={b.id}>
              <button
                type="button"
                className="ph-row"
                aria-current={b.id === chooser.current.id ? 'true' : undefined}
                disabled={chooser.busy}
                onClick={() => void pick(b.id)}
              >
                {b.name}
              </button>
            </li>
          ))}
        </ul>
      )}
      <h3 className="ph-group">More</h3>
      <ul className="ph-list" aria-label="More" data-testid="phone-more">
        {MORE.map((m) => (
          <li key={m.screen}>
            <button
              type="button"
              className="ph-row"
              onClick={() =>
                nav.push({
                  kind: 'screen',
                  screen: m.screen,
                  ...(m.screen === 'backstory' ? { at: Date.now() } : {}),
                })
              }
            >
              {m.label}
            </button>
          </li>
        ))}
        <li>
          <button type="button" className="ph-row" onClick={() => nav.openSheet('changes')}>
            Changes
          </button>
        </li>
      </ul>
      <h3 className="ph-group">All sections</h3>
      <ul className="ph-list" aria-label="All sections" data-testid="phone-sections">
        {ENTRY_COLLECTIONS.filter((c) => c !== 'moments').map((c) => (
          <li key={c}>
            <button
              type="button"
              className="ph-row"
              onClick={() => nav.push({ kind: 'section', collection: c })}
            >
              {collectionInfo[c].plural}
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

/** ED-3: this session's steps, newest first, undone ones on top. */
function ChangesSheet() {
  return (
    <PhoneSheet name="changes" label="Changes this session" title testId="changes-sheet">
      <ChangesList />
    </PhoneSheet>
  );
}

function ChangesList() {
  const undo = useUndo();
  const items = [
    ...undo.history.redo.map((c) => ({ label: c.label, redo: true })).reverse(),
    ...undo.history.undo.map((c) => ({ label: c.label, redo: false })),
  ];
  return (
    <ul className="ph-list ph-changes" data-testid="undo-history">
      {items.length === 0 ? (
        <li className="empty">No changes yet</li>
      ) : (
        items.map((it, i) => (
          <li key={i} className={it.redo ? 'redo' : undefined}>
            {it.redo ? `Undone: ${it.label}` : it.label}
          </li>
        ))
      )}
    </ul>
  );
}
