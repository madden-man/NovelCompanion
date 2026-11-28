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
import { TABS, fromHash, pagePart, rootState, toHash } from './places';
import type { NavState, Page, Sheet, Tab } from './places';

export { TABS, fromHash, rootState, toHash };
export type { NavState, Page, Screen, Sheet, Tab } from './places';

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
  // A reload comes back with the sheet closed: what it was opened on does not survive one.
  const [sheet, setSheet] = useState<Sheet | null>(null);
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
    write('replace', navRef.current, h ? { prev: h.prev } : {});
  }, [bible, write]);

  useEffect(() => {
    const onPop = (e: PopStateEvent) => {
      const h = held(e.state, bible);
      if (!h && e.state && typeof e.state === 'object' && 'nc' in e.state) {
        // An entry left from another bible: stay in this one, where we are.
        window.history.replaceState({ nc: navRef.current, bible }, '', toHash(navRef.current));
        setSheet(null);
        return;
      }
      let next = h ? h.nc : fromHash(window.location.hash);
      const cur = navRef.current;
      const stack = cur.stacks[cur.tab];
      // An entry from before a tab switch names the other tab: step back within this one.
      if (next.tab !== cur.tab && stack.length > 0) {
        next = { ...cur, stacks: { ...cur.stacks, [cur.tab]: stack.slice(0, -1) } };
        window.history.replaceState({ nc: next, bible }, '', toHash(next));
      }
      if (stateKey(next) !== stateKey(navRef.current)) {
        scrolls.current.set(stateKey(navRef.current), window.scrollY);
        pendingScroll.current = scrolls.current.get(stateKey(next)) ?? 0;
        setNav(next);
      }
      // Back closes a sheet; forward does not reopen one, whose subject is gone.
      setSheet(null);
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

/** A58 U3: the phone's places, or null on the desk, for screens both share. */
export function useOptionalPhoneNav(): PhoneNav | null {
  return useContext(Ctx);
}

export function usePhoneNav(): PhoneNav {
  const v = useContext(Ctx);
  if (!v) throw new Error('usePhoneNav needs a PhoneNavProvider.');
  return v;
}

/** A58 U4: the phone's places, or null outside the phone frame (a desk screen). */
export function usePhoneNavIfAny(): PhoneNav | null {
  return useContext(Ctx);
}
