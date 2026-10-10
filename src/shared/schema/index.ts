import type { z } from 'zod';
import { Character, characterFields } from './character';
import {
  Family,
  ParentLink,
  Relationship,
  Union,
  familyFields,
  parentLinkFields,
  relationshipFields,
  unionFields,
} from './family';
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
  Arc,
  Book,
  Brief,
  Chapter,
  Fact,
  Finding,
  KnowledgeRecord,
  OpenQuestion,
  Part,
  PlotBeat,
  SessionLog,
  Theme,
  arcFields,
  bookFields,
  briefFields,
  chapterFields,
  factFields,
  findingFields,
  knowledgeRecordFields,
  openQuestionFields,
  partFields,
  plotBeatFields,
  sessionLogFields,
  themeFields,
} from './story';
import { CustomEntry, CustomSection, customEntryFields, customSectionFields } from './custom';
import { ListDoc } from './lists';
import { Proposal } from './proposal';
import type { FieldSpec } from './manifest';

export * from './common';
export * from './character';
export * from './family';
export * from './world';
export * from './story';
export * from './custom';
export * from './lists';
export * from './manifest';
export * from './proposal';

/**
 * Every collection written through the one write path, and its schema. These
 * are every entity in SPEC section 4, plus briefs and findings (generated
 * content, ED-6) and custom section definitions (CS-1).
 */
export const entrySchemas = {
  characters: Character,
  families: Family,
  unions: Union,
  parentLinks: ParentLink,
  relationships: Relationship,
  books: Book,
  parts: Part,
  arcs: Arc,
  chapters: Chapter,
  plotBeats: PlotBeat,
  worldEvents: WorldEvent,
  eraStates: EraState,
  culturalEntries: CulturalEntry,
  places: Place,
  glossaryTerms: GlossaryTerm,
  facts: Fact,
  knowledgeRecords: KnowledgeRecord,
  themes: Theme,
  openQuestions: OpenQuestion,
  sessionLogs: SessionLog,
  briefs: Brief,
  findings: Finding,
  customSections: CustomSection,
  customEntries: CustomEntry,
} as const;

export type EntryCollection = keyof typeof entrySchemas;
export type EntryOf<C extends EntryCollection> = z.infer<(typeof entrySchemas)[C]>;
export type EntryInput<C extends EntryCollection> = z.input<(typeof entrySchemas)[C]>;

export const ENTRY_COLLECTIONS = Object.keys(entrySchemas) as EntryCollection[];

/** The field manifest of every collection (ED-1, T-5). */
export const manifests: Record<EntryCollection, FieldSpec[]> = {
  characters: characterFields,
  families: familyFields,
  unions: unionFields,
  parentLinks: parentLinkFields,
  relationships: relationshipFields,
  books: bookFields,
  parts: partFields,
  arcs: arcFields,
  chapters: chapterFields,
  plotBeats: plotBeatFields,
  worldEvents: worldEventFields,
  eraStates: eraStateFields,
  culturalEntries: culturalEntryFields,
  places: placeFields,
  glossaryTerms: glossaryTermFields,
  facts: factFields,
  knowledgeRecords: knowledgeRecordFields,
  themes: themeFields,
  openQuestions: openQuestionFields,
  sessionLogs: sessionLogFields,
  briefs: briefFields,
  findings: findingFields,
  customSections: customSectionFields,
  customEntries: customEntryFields,
};

export interface CollectionInfo {
  singular: string;
  plural: string;
  group: string;
}

/** Names the interface uses for each collection, grouped as in the rail. */
export const collectionInfo: Record<EntryCollection, CollectionInfo> = {
  characters: { singular: 'Character', plural: 'Characters', group: 'People' },
  families: { singular: 'Family', plural: 'Families', group: 'People' },
  unions: { singular: 'Union', plural: 'Unions', group: 'People' },
  parentLinks: { singular: 'Parent link', plural: 'Parent links', group: 'People' },
  relationships: { singular: 'Relationship', plural: 'Relationships', group: 'People' },
  books: { singular: 'Book', plural: 'Books', group: 'Story' },
  parts: { singular: 'Part', plural: 'Parts', group: 'Story' },
  arcs: { singular: 'Arc', plural: 'Arcs', group: 'Story' },
  chapters: { singular: 'Chapter', plural: 'Chapters', group: 'Story' },
  plotBeats: { singular: 'Plot beat', plural: 'Plot beats', group: 'Story' },
  worldEvents: { singular: 'World event', plural: 'World events', group: 'World' },
  eraStates: { singular: 'Era state', plural: 'Era states', group: 'World' },
  culturalEntries: { singular: 'Cultural entry', plural: 'Cultural entries', group: 'World' },
  places: { singular: 'Place', plural: 'Places', group: 'World' },
  glossaryTerms: { singular: 'Glossary term', plural: 'Glossary', group: 'World' },
  facts: { singular: 'Fact', plural: 'Facts', group: 'Knowledge' },
  knowledgeRecords: {
    singular: 'Knowledge record',
    plural: 'Knowledge records',
    group: 'Knowledge',
  },
  themes: { singular: 'Theme', plural: 'Themes and motifs', group: 'Knowledge' },
  openQuestions: { singular: 'Open question', plural: 'Open questions', group: 'Knowledge' },
  sessionLogs: { singular: 'Session log', plural: 'Session log', group: 'Sessions' },
  briefs: { singular: 'Brief', plural: 'Briefs', group: 'Sessions' },
  findings: { singular: 'Finding', plural: 'Continuity findings', group: 'Sessions' },
  customSections: { singular: 'Custom section', plural: 'Custom sections', group: 'Custom' },
  customEntries: { singular: 'Custom entry', plural: 'Custom entries', group: 'Custom' },
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
