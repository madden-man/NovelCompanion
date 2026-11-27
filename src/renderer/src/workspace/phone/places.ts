import { isEntryCollection } from '../../../../shared/schema';
import type { EntryCollection } from '../../../../shared/schema';

/**
 * A58 U1 (PH-31): the phone's places and their hash, pure, so unit tests and
 * other packages can read them without React. `nav.tsx` keeps them in history.
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
  | 'notebook'
  // A58 U5: capture, opened by the + (PH-27).
  | 'capture';
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
  'capture',
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

export type Sheet =
  | 'year'
  | 'bibles'
  | 'changes'
  | 'capturePick'
  // A58 U4: the family tree's person and warnings sheet.
  | 'tree';

export interface NavState {
  tab: Tab;
  stacks: Record<Tab, Page[]>;
}

export function rootState(tab: Tab = 'people'): NavState {
  return { tab, stacks: { people: [], outline: [], world: [], search: [] } };
}

const enc = encodeURIComponent;

export function pagePart(p: Page): string {
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
