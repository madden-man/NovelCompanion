import type { z } from 'zod';
import { Character, characterFields } from './character';
import { Moment, momentFields } from './moment';
import { Family, ParentLink, Union, familyFields, parentLinkFields, unionFields } from './family';
import {
  CulturalEntry,
  EraState,
  GlossaryTerm,
  Place,
  WorldEvent,
  culturalEntryFields,
  eraStateFields,
  glossaryTermFields,
  placeFields,
  worldEventFields,
} from './world';
import {
  Book,
  Brief,
  Chapter,
  Finding,
  OpenQuestion,
  Part,
  SessionLog,
  bookFields,
  briefFields,
  chapterFields,
  findingFields,
  openQuestionFields,
  partFields,
  sessionLogFields,
} from './story';
import { ListDoc } from './lists';
import { Proposal } from './proposal';
import type { FieldSpec } from './manifest';

export * from './common';
export * from './character';
export * from './moment';
export * from './family';
export * from './world';
export * from './story';
export * from './lists';
export * from './manifest';
export * from './proposal';

/**
 * Every collection written through the one write path, and its schema. These
 * are every entity in SPEC section 4 as cut by A39 (SM-1 to SM-4), plus briefs
 * and findings (generated content, ED-6).
 */
export const entrySchemas = {
  characters: Character,
  moments: Moment,
  families: Family,
  unions: Union,
  parentLinks: ParentLink,
  books: Book,
  parts: Part,
  chapters: Chapter,
  worldEvents: WorldEvent,
  eraStates: EraState,
  culturalEntries: CulturalEntry,
  places: Place,
  glossaryTerms: GlossaryTerm,
  openQuestions: OpenQuestion,
  sessionLogs: SessionLog,
  briefs: Brief,
  findings: Finding,
} as const;

export type EntryCollection = keyof typeof entrySchemas;
export type EntryOf<C extends EntryCollection> = z.infer<(typeof entrySchemas)[C]>;
export type EntryInput<C extends EntryCollection> = z.input<(typeof entrySchemas)[C]>;

export const ENTRY_COLLECTIONS = Object.keys(entrySchemas) as EntryCollection[];

/** The field manifest of every collection (ED-1, T-5). */
export const manifests: Record<EntryCollection, FieldSpec[]> = {
  characters: characterFields,
  moments: momentFields,
  families: familyFields,
  unions: unionFields,
  parentLinks: parentLinkFields,
  books: bookFields,
  parts: partFields,
  chapters: chapterFields,
  worldEvents: worldEventFields,
  eraStates: eraStateFields,
  culturalEntries: culturalEntryFields,
  places: placeFields,
  glossaryTerms: glossaryTermFields,
  openQuestions: openQuestionFields,
  sessionLogs: sessionLogFields,
  briefs: briefFields,
  findings: findingFields,
};

/** A document without its derived fields (they are read from other entries, never stored on this one). */
export function withoutDerived<T extends Record<string, unknown>>(
  collection: EntryCollection,
  doc: T,
): T {
  const derived = manifests[collection].filter((s) => s.derived).map((s) => s.name);
  if (derived.length === 0) return doc;
  return Object.fromEntries(Object.entries(doc).filter(([k]) => !derived.includes(k))) as T;
}

export interface CollectionInfo {
  singular: string;
  plural: string;
  group: string;
}

/** Names the interface uses for each collection, grouped as in the rail. */
export const collectionInfo: Record<EntryCollection, CollectionInfo> = {
  characters: { singular: 'Character', plural: 'Characters', group: 'People' },
  moments: { singular: 'Moment', plural: 'Moments', group: 'People' },
  families: { singular: 'Family', plural: 'Families', group: 'People' },
  unions: { singular: 'Union', plural: 'Unions', group: 'People' },
  parentLinks: { singular: 'Parent link', plural: 'Parent links', group: 'People' },
  books: { singular: 'Book', plural: 'Books', group: 'Story' },
  parts: { singular: 'Part', plural: 'Parts', group: 'Story' },
  chapters: { singular: 'Chapter', plural: 'Chapters', group: 'Story' },
  worldEvents: { singular: 'World event', plural: 'World events', group: 'World' },
  eraStates: { singular: 'Era state', plural: 'Era states', group: 'World' },
  culturalEntries: { singular: 'Cultural entry', plural: 'Cultural entries', group: 'World' },
  places: { singular: 'Place', plural: 'Places', group: 'World' },
  glossaryTerms: { singular: 'Glossary term', plural: 'Glossary', group: 'World' },
  openQuestions: { singular: 'Open question', plural: 'Open questions', group: 'Knowledge' },
  sessionLogs: { singular: 'Session log', plural: 'Session log', group: 'Sessions' },
  briefs: { singular: 'Brief', plural: 'Briefs', group: 'Sessions' },
  findings: { singular: 'Finding', plural: 'Continuity findings', group: 'Sessions' },
};

/** Collections that are not entries but hold bible configuration. */
export const configSchemas = {
  lists: ListDoc,
  proposals: Proposal,
} as const;

export function isEntryCollection(name: string): name is EntryCollection {
  return Object.hasOwn(entrySchemas, name);
}

/** The name shown for an entry: its title, or its name for definitions. */
export function entryTitle(doc: Record<string, unknown> | undefined): string {
  if (!doc) return 'Missing entry';
  const t = typeof doc.title === 'string' && doc.title.trim() ? doc.title : doc.name;
  return typeof t === 'string' && t.trim() ? t : 'Untitled';
}
