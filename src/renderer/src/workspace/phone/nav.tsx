import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import { isEntryCollection } from '../../../../shared/schema';
import type { EntryCollection } from '../../../../shared/schema';

/**
 * A58 U1 (PH-30, PH-31): the phone's places. Four tabs on the bottom bar, each
 * with its own stack of pages; the top page of the active tab is what shows.
 * Every page opened is a history entry, so the back control, the browser's
 * back and the iOS edge swipe all step back the same way, and the hash names
 * the page, so a reload or an app update comes back to it.
 *
 *   #/people                         the People list
 *   #/people/e:characters:H1         Margaret Hale's page over it
 *   #/search/e:places:P2             a place opened from Search
 *   #/people/s:tree:H1               a screen from the bible menu, with its argument
 *
 * A bottom sheet is a history entry too, so back closes it.
 */
export type Tab = 'people' | 'outline' | 'world' | 'search';
export const TABS: readonly Tab[] = ['people', 'outline', 'world', 'search'];

/** Screens reached from the bible menu (the old rail and App menu), reworked by U2 to U6. */
export type Screen =
  | 'tree'
  | 'backstory'
  | 'questions'
  | 'culture'
  | 'words'
  | 'relevant'
  | 'places'
  | 'romanization'
  | 'glossary'
  | 'lists'
  | 'trash'
  | 'settings'
  | 'notebook';
const SCREENS: readonly Screen[] = [
  'tree',
  'backstory',
  'questions',
  'culture',
  'words',
  'relevant',
  'places',
  'romanization',
  'glossary',
  'lists',
  'trash',
  'settings',
  'notebook',
];

export type Page =
  /** An entry as a full page (PH-31). */
  | { kind: 'entry'; collection: EntryCollection; id: string }
  /** A new entry's form; `preset` holds a typed name and is not kept in the hash. */
  | { kind: 'new'; collection: EntryCollection; preset?: Record<string, unknown> }
  /** One section's list, from All sections. */
  | { kind: 'section'; collection: EntryCollection }
  /** A screen with up to two arguments (a person, a moment, a tab, a page ID). */
  | { kind: 'screen'; screen: Screen; arg?: string; arg2?: string; at?: number };

export type Sheet = 'year' | 'bibles' | 'changes';

export interface NavState {
  tab: Tab;
  stacks: Record<Tab, Page[]>;
}

export function rootState(tab: Tab = 'people'): NavState {
  return { tab, stacks: { people: [], outline: [], world: [], search: [] } };
}

const enc = encodeURIComponent;

function pagePart(p: Page): string {
  switch (p.kind) {
    case 'entry':
      return `e:${enc(p.collection)}:${enc(p.id)}`;
    case 'new':
      return `n:${enc(p.collection)}`;
    case 'section':
      return `l:${enc(p.collection)}`;
    case 'screen':
      return ['s', p.screen, p.arg ?? '', p.arg2 ?? ''].map(enc).join(':').replace(/:+$/, '');
  }
}

function parsePart(part: string): Page | null {
  const [kind, a = '', b = '', c = ''] = part.split(':').map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return '';
    }
  });
  if ((kind === 'e' || kind === 'n' || kind === 'l') && isEntryCollection(a)) {
    if (kind === 'e') return b ? { kind: 'entry', collection: a, id: b } : null;
    if (kind === 'n') return { kind: 'new', collection: a };
    return { kind: 'section', collection: a };
  }
  if (kind === 's' && (SCREENS as readonly string[]).includes(a)) {
    return {
      kind: 'screen',
      screen: a as Screen,
      ...(b ? { arg: b } : {}),
      ...(c ? { arg2: c } : {}),
    };
  }
  return null;
}

/** The hash for a state: the active tab and its stack. */
export function toHash(s: NavState): string {
  return `#/${[s.tab, ...s.stacks[s.tab].map(pagePart)].join('/')}`;
}

/** A state from a hash; anything it cannot read falls back to People. */
export function fromHash(hash: string): NavState {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (!(TABS as readonly string[]).includes(parts[0] ?? '')) return rootState('people');
  const tab = parts[0] as Tab;
  const s = rootState(tab);
  s.stacks[tab] = parts
    .slice(1)
    .map(parsePart)
    .filter((p): p is Page => p !== null);
  return s;
}

/** Two states are the same place when their tabs and every stack read the same. */
function stateKey(s: NavState): string {
  return JSON.stringify([s.tab, TABS.map((t) => s.stacks[t].map(pagePart))]);
}

/** What a history entry of ours holds. */
interface Held {
  nc: NavState;
  bible: string;
  /** The place this entry was pushed from: back steps the history when it is the place wanted. */
  prev?: string;
  sheet?: Sheet;
}

function held(v: unknown, bible: string): Held | null {
  if (!v || typeof v !== 'object' || !('nc' in v)) return null;
  const h = v as Held;
  return h.bible === bible ? h : null;
}

/** The page the iOS edge swipe starts from: this close to the left edge. */
const EDGE_PX = 24;
const SWIPE_PX = 70;

function standalone(): boolean {
  const nav = navigator as Navigator & { standalone?: boolean };
  return nav.standalone === true || window.matchMedia?.('(display-mode: standalone)').matches;
}

export interface PhoneNav {
  tab: Tab;
  /** The active tab's pages, oldest first. */
  stack: readonly Page[];
  stacks: NavState['stacks'];
  /** The top page of the active tab, or null on its root. */
  top: Page | null;
  sheet: Sheet | null;
  /** Open a page over the active tab (a history entry). From a sheet, the page takes its place. */
  push(page: Page): void;
  /** Swap the top page (a new entry's form for the entry it made). */
  replaceTop(page: Page): void;
  /** The back control: the page before, through the history when that is where it leads. */
  back(): void;
  /** A bottom bar tab; the active one again goes back to its root. */
  switchTab(tab: Tab): void;
  openSheet(sheet: Sheet): void;
  closeSheet(): void;
  /** Forget every page, for another bible. */
  reset(): void;
}

const Ctx = createContext<PhoneNav | null>(null);

export function PhoneNavProvider(props: { bible: string; children: ReactNode }) {
  const { bible } = props;
  const [nav, setNav] = useState<NavState>(() => {
    const h = held(window.history.state, bible);
    return h ? h.nc : fromHash(window.location.hash);
  });
  const [sheet, setSheet] = useState<Sheet | null>(
    () => held(window.history.state, bible)?.sheet ?? null,
  );
  const navRef = useRef(nav);
  const sheetRef = useRef(sheet);
  useLayoutEffect(() => {
    navRef.current = nav;
    sheetRef.current = sheet;
  });
  /** Where the page was scrolled for each place, so back returns to the same spot. */
  const scrolls = useRef(new Map<string, number>());
  const pendingScroll = useRef<number | null>(null);

  const write = useCallback(
    (how: 'push' | 'replace', next: NavState, extra: Partial<Held> = {}) => {
      const state: Held = { nc: next, bible, ...extra };
      if (how === 'push') window.history.pushState(state, '', toHash(next));
      else window.history.replaceState(state, '', toHash(next));
    },
    [bible],
  );

  // The first entry holds the place, so a reload, back or forward can read it.
  useEffect(() => {
    const h = held(window.history.state, bible);
    write('replace', navRef.current, h ? { prev: h.prev, sheet: h.sheet } : {});
  }, [bible, write]);

  useEffect(() => {
    const onPop = (e: PopStateEvent) => {
      const h = held(e.state, bible);
      const next = h ? h.nc : fromHash(window.location.hash);
      if (stateKey(next) !== stateKey(navRef.current)) {
        scrolls.current.set(stateKey(navRef.current), window.scrollY);
        pendingScroll.current = scrolls.current.get(stateKey(next)) ?? 0;
        setNav(next);
      }
      setSheet(h?.sheet ?? null);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [bible]);

  useLayoutEffect(() => {
    if (pendingScroll.current === null) return;
    const y = pendingScroll.current;
    pendingScroll.current = null;
    window.scrollTo({ top: y, left: 0, behavior: 'instant' });
  }, [nav]);

  const go = useCallback(
    (how: 'push' | 'replace', next: NavState, extra: Partial<Held> = {}, scrollTo?: number) => {
      const from = navRef.current;
      scrolls.current.set(stateKey(from), window.scrollY);
      pendingScroll.current = scrollTo ?? scrolls.current.get(stateKey(next)) ?? 0;
      write(how, next, extra);
      navRef.current = next;
      setNav(next);
    },
    [write],
  );

  const push = useCallback(
    (page: Page) => {
      const from = navRef.current;
      const next: NavState = {
        ...from,
        stacks: { ...from.stacks, [from.tab]: [...from.stacks[from.tab], page] },
      };
      const fromSheet = sheetRef.current !== null && held(window.history.state, bible)?.sheet;
      sheetRef.current = null;
      if (fromSheet) {
        // The sheet's entry becomes the page's, so back from the page skips the closed sheet.
        const prev = held(window.history.state, bible)?.prev;
        setSheet(null);
        go('replace', next, { prev }, 0);
      } else {
        setSheet(null);
        go('push', next, { prev: stateKey(from) }, 0);
      }
    },
    [bible, go],
  );

  const replaceTop = useCallback(
    (page: Page) => {
      const from = navRef.current;
      const stack = from.stacks[from.tab];
      const next: NavState = {
        ...from,
        stacks: { ...from.stacks, [from.tab]: [...stack.slice(0, -1), page] },
      };
      go('replace', next, { prev: held(window.history.state, bible)?.prev }, 0);
    },
    [bible, go],
  );

  const back = useCallback(() => {
    const from = navRef.current;
    const stack = from.stacks[from.tab];
    if (stack.length === 0) return;
    const target: NavState = {
      ...from,
      stacks: { ...from.stacks, [from.tab]: stack.slice(0, -1) },
    };
    const h = held(window.history.state, bible);
    if (h?.prev === stateKey(target) && !h.sheet) {
      window.history.back();
      return;
    }
    // Opened from a link or a reload: there is no entry behind this one to go back to.
    go('replace', target);
  }, [bible, go]);

  const switchTab = useCallback(
    (tab: Tab) => {
      const from = navRef.current;
      setSheet(null);
      if (tab === from.tab) {
        if (from.stacks[tab].length === 0) {
          window.scrollTo({ top: 0, behavior: 'instant' });
          return;
        }
        go('replace', { ...from, stacks: { ...from.stacks, [tab]: [] } });
        return;
      }
      go('replace', { ...from, tab });
    },
    [go],
  );

  const openSheet = useCallback(
    (s: Sheet) => {
      if (sheetRef.current === s) return;
      const h = held(window.history.state, bible);
      if (h?.sheet) write('replace', navRef.current, { prev: h.prev, sheet: s });
      else write('push', navRef.current, { prev: stateKey(navRef.current), sheet: s });
      sheetRef.current = s;
      setSheet(s);
    },
    [bible, write],
  );

  const closeSheet = useCallback(() => {
    if (sheetRef.current === null) return;
    if (held(window.history.state, bible)?.sheet) window.history.back();
    sheetRef.current = null;
    setSheet(null);
  }, [bible]);

  const reset = useCallback(() => {
    setSheet(null);
    go('replace', rootState(navRef.current.tab));
  }, [go]);

  const backRef = useRef(back);
  const closeSheetRef = useRef(closeSheet);
  useEffect(() => {
    backRef.current = back;
    closeSheetRef.current = closeSheet;
  });

  // The iOS edge swipe, for the installed app, where Safari's own is not there.
  useEffect(() => {
    if (!standalone()) return;
    let start: { x: number; y: number } | null = null;
    const down = (e: TouchEvent) => {
      const t = e.touches[0];
      start = t && t.clientX <= EDGE_PX ? { x: t.clientX, y: t.clientY } : null;
    };
    const up = (e: TouchEvent) => {
      const t = e.changedTouches[0];
      if (!start || !t) return;
      const dx = t.clientX - start.x;
      const dy = Math.abs(t.clientY - start.y);
      start = null;
      if (dx > SWIPE_PX && dy < dx / 2) {
        if (sheetRef.current) closeSheetRef.current();
        else backRef.current();
      }
    };
    window.addEventListener('touchstart', down, { passive: true });
    window.addEventListener('touchend', up, { passive: true });
    return () => {
      window.removeEventListener('touchstart', down);
      window.removeEventListener('touchend', up);
    };
  }, []);

  const value = useMemo<PhoneNav>(() => {
    const stack = nav.stacks[nav.tab];
    return {
      tab: nav.tab,
      stack,
      stacks: nav.stacks,
      top: stack[stack.length - 1] ?? null,
      sheet,
      push,
      replaceTop,
      back,
      switchTab,
      openSheet,
      closeSheet,
      reset,
    };
  }, [nav, sheet, push, replaceTop, back, switchTab, openSheet, closeSheet, reset]);

  return <Ctx.Provider value={value}>{props.children}</Ctx.Provider>;
}

export function usePhoneNav(): PhoneNav {
  const v = useContext(Ctx);
  if (!v) throw new Error('usePhoneNav needs a PhoneNavProvider.');
  return v;
}
