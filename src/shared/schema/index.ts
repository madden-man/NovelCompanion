import type { z } from 'zod';
import { Character } from './character';
import { Family, ParentLink, Union } from './family';
import { CulturalEntry, EraState, GlossaryTerm, WorldEvent } from './world';
import { Book, Chapter, Fact, KnowledgeRecord, Part } from './story';
import { CustomEntry, CustomSection } from './custom';
import { ListDoc } from './lists';

export * from './common';
export * from './character';
export * from './family';
export * from './world';
export * from './story';
export * from './custom';
export * from './lists';

/**
 * Every entry collection and its schema. The repository writes only to these.
 * M1 adds the rest of section 4 (relationships, arcs, plot beats, places,
 * themes, open questions, session logs) here following the same pattern.
 */
export const entrySchemas = {
  characters: Character,
  families: Family,
  unions: Union,
  parentLinks: ParentLink,
  worldEvents: WorldEvent,
  eraStates: EraState,
  culturalEntries: CulturalEntry,
  glossaryTerms: GlossaryTerm,
  books: Book,
  parts: Part,
  chapters: Chapter,
  facts: Fact,
  knowledgeRecords: KnowledgeRecord,
  customEntries: CustomEntry,
} as const;

export type EntryCollection = keyof typeof entrySchemas;
export type EntryOf<C extends EntryCollection> = z.infer<(typeof entrySchemas)[C]>;
export type EntryInput<C extends EntryCollection> = z.input<(typeof entrySchemas)[C]>;

export const ENTRY_COLLECTIONS = Object.keys(entrySchemas) as EntryCollection[];

/** Collections that are not entries but hold bible configuration. */
export const configSchemas = {
  lists: ListDoc,
  customSections: CustomSection,
} as const;

export function isEntryCollection(name: string): name is EntryCollection {
  return Object.hasOwn(entrySchemas, name);
}
