/**
 * KB-5: the Entries screen lists facts, cultural entries, places, glossary
 * terms, themes, open questions, and custom entries together. Pure helpers
 * for its kinds, rows, filters, and order.
 */
import type { EntryCollection } from '../schema';
import { collectionInfo } from '../schema';
import { plain } from './brief/selection';
import type { Doc } from './paths';

/** The built-in collections the Entries screen lists, in the order of their chips. */
export const ENTRY_KIND_COLLECTIONS = [
  'facts',
  'culturalEntries',
  'places',
  'glossaryTerms',
  'themes',
  'openQuestions',
] as const satisfies readonly EntryCollection[];

export type EntriesCollection = (typeof ENTRY_KIND_COLLECTIONS)[number] | 'customEntries';

/** Every collection the screen reads, custom entries included. */
export const ENTRIES_COLLECTIONS: readonly EntriesCollection[] = [
  ...ENTRY_KIND_COLLECTIONS,
  'customEntries',
];

/** One kind: a built-in collection, or one custom section (`custom:<sectionId>`). */
export interface EntryKind {
  key: string;
  collection: EntriesCollection;
  /** Singular, for the row and the New entry picker. */
  label: string;
  /** Plural, for the chip. */
  plural: string;
  sectionId?: string;
}

/** The kinds in chip order: the built-in ones, then each live custom section by name. */
export function entryKinds(customSections: readonly Doc[]): EntryKind[] {
  const builtIn: EntryKind[] = ENTRY_KIND_COLLECTIONS.map((c) => ({
    key: c,
    collection: c,
    label: collectionInfo[c].singular,
    plural: collectionInfo[c].plural,
  }));
  const custom = customSections
    .filter((s) => !s.deletedAt)
    .map((s) => {
      const name = sectionName(s);
      return {
        key: customKindKey(String(s._id)),
        collection: 'customEntries' as const,
        label: name,
        plural: name,
        sectionId: String(s._id),
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
  return [...builtIn, ...custom];
}

export const customKindKey = (sectionId: string) => `custom:${sectionId}`;

function sectionName(s: Doc): string {
  const n = typeof s.name === 'string' && s.name.trim() ? s.name : s.title;
  return typeof n === 'string' && n.trim() ? n.trim() : 'Custom section';
}

/** The kind key of one entry. */
export function kindKeyOf(collection: EntriesCollection, entry: Doc): string {
  return collection === 'customEntries' ? customKindKey(String(entry.sectionId ?? '')) : collection;
}

/** The fields that hold an entry's text, in the order the first line is read from. */
const TEXT_FIELDS = ['body', 'description', 'meaning', 'generationNotes', 'usageNote', 'decision'];

/** All of an entry's text, plain, for matching. Place descriptions and custom values count. */
export function entryText(entry: Doc): string {
  const parts: string[] = TEXT_FIELDS.map((f) => plain(entry[f]));
  if (Array.isArray(entry.descriptions)) {
    for (const d of entry.descriptions) {
      if (d && typeof d === 'object') parts.push(plain((d as Doc).text));
    }
  }
  if (entry.values && typeof entry.values === 'object') {
    for (const v of Object.values(entry.values as Doc)) {
      if (typeof v === 'string') parts.push(plain(v));
    }
  }
  return parts.filter(Boolean).join('\n');
}

/** The first line of an entry's text, cut to a length that fits a row. */
export function firstLine(entry: Doc, max = 120): string {
  const line =
    entryText(entry)
      .split('\n')
      .map((l) => l.trim())
      .find(Boolean) ?? '';
  return line.length > max ? `${line.slice(0, max - 3).trimEnd()}...` : line;
}

export type EntryStatus = 'canon' | 'planned' | 'idea';

export interface EntriesFilter {
  /** Kind keys shown. */
  kinds: ReadonlySet<string>;
  /** Null shows every status. */
  status: EntryStatus | null;
  /** The search box, as typed. */
  query: string;
  /** IDs the search channel returned for the query (SR-1); they match too. */
  hits?: ReadonlySet<string>;
}

export interface EntriesRow {
  collection: EntriesCollection;
  entry: Doc;
}

/** True when the title or the text holds every word of the query, ignoring case. */
export function textMatches(entry: Doc, query: string): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const title = typeof entry.title === 'string' ? entry.title : String(entry.name ?? '');
  const hay = `${title}\n${entryText(entry)}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}

const stamp = (e: Doc) => (typeof e.modifiedAt === 'string' ? Date.parse(e.modifiedAt) || 0 : 0);

/** The rows that pass the kind chips, the status, and the search, newest change first. */
export function filterEntries(rows: readonly EntriesRow[], filter: EntriesFilter): EntriesRow[] {
  const q = filter.query.trim();
  return rows
    .filter((r) => !r.entry.deletedAt)
    .filter((r) => filter.kinds.has(kindKeyOf(r.collection, r.entry)))
    .filter((r) => filter.status === null || r.entry.status === filter.status)
    .filter(
      (r) => !q || textMatches(r.entry, q) || (filter.hits?.has(String(r.entry._id)) ?? false),
    )
    .sort(newestFirst);
}

/** Newest `modifiedAt` first; ties by title, so the order never jumps. */
export function newestFirst(a: EntriesRow, b: EntriesRow): number {
  const d = stamp(b.entry) - stamp(a.entry);
  if (d !== 0) return d;
  return String(a.entry.title ?? '').localeCompare(String(b.entry.title ?? ''));
}

/** KB-5 tabs of the Entries screen. */
export const ENTRIES_TABS = ['entries', 'culture', 'places', 'romanization', 'glossary'] as const;
export type EntriesTab = (typeof ENTRIES_TABS)[number];

export function isEntriesTab(v: unknown): v is EntriesTab {
  return typeof v === 'string' && (ENTRIES_TABS as readonly string[]).includes(v);
}

/** KB-4: world events and eras in the list under the chart, newest change first or by year. */
export type WorldOrder = 'newest' | 'year';

export interface WorldRow {
  id: string;
  startYear: number;
  endYear: number;
  modifiedAt: string;
  title: string;
}

export function orderWorldRows<T extends WorldRow>(rows: readonly T[], order: WorldOrder): T[] {
  return [...rows].sort((a, b) => {
    if (order === 'year') {
      return a.startYear - b.startYear || a.endYear - b.endYear || a.title.localeCompare(b.title);
    }
    const d = (Date.parse(b.modifiedAt) || 0) - (Date.parse(a.modifiedAt) || 0);
    return d || a.startYear - b.startYear || a.title.localeCompare(b.title);
  });
}
