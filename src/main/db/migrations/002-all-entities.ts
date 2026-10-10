import type { BibleHandle } from '../bibles';
import { defaultLists } from '../defaultLists';
import type { Migration } from './types';

/** Collections section 4 needs that the first migration did not create (M1). */
const NEW_COLLECTIONS = [
  'relationships',
  'arcs',
  'plotBeats',
  'places',
  'themes',
  'openQuestions',
  'sessionLogs',
  'briefs',
  'findings',
  'proposals',
];

/** Every entry collection at the time of this migration. */
const ENTRY_COLLECTIONS_V2 = [
  'characters',
  'families',
  'unions',
  'parentLinks',
  'relationships',
  'books',
  'parts',
  'arcs',
  'chapters',
  'plotBeats',
  'worldEvents',
  'eraStates',
  'culturalEntries',
  'places',
  'glossaryTerms',
  'facts',
  'knowledgeRecords',
  'themes',
  'openQuestions',
  'sessionLogs',
  'briefs',
  'findings',
  'customSections',
  'customEntries',
];

/** Indexes for the lookups the app and its tests make, beyond `_id`. */
const INDEXES: Record<string, Record<string, 1 | -1>[]> = {
  characters: [{ familyIds: 1 }],
  unions: [{ partnerIds: 1 }],
  parentLinks: [{ parentId: 1 }, { childId: 1 }],
  relationships: [{ characterIds: 1 }],
  parts: [{ bookId: 1, number: 1 }],
  arcs: [{ ownerCharacterId: 1 }],
  chapters: [{ partId: 1, readingOrder: 1 }, { 'strands.characterIds': 1 }],
  plotBeats: [{ arcIds: 1, order: 1 }, { chapterId: 1 }],
  worldEvents: [{ 'start.year': 1 }, { categoryId: 1 }],
  eraStates: [{ startYear: 1 }],
  culturalEntries: [{ communityId: 1, startYear: 1 }],
  places: [{ parentId: 1 }],
  glossaryTerms: [{ characters: 1 }],
  knowledgeRecords: [{ factId: 1 }, { characterId: 1 }],
  themes: [{ 'appearances.chapterId': 1 }],
  openQuestions: [{ state: 1 }],
  sessionLogs: [{ date: -1 }],
  briefs: [{ chapterId: 1 }],
  findings: [{ chapterId: 1, state: 1 }],
  customEntries: [{ sectionId: 1 }],
};

export const allEntities: Migration = {
  version: 2,
  name: 'every section 4 collection, proposals, indexes, languages and tags lists',
  async up(bible: BibleHandle) {
    const existing = new Set(await bible.collectionNames());
    for (const name of NEW_COLLECTIONS) {
      if (!existing.has(name)) await bible.db.createCollection(bible.qualified(name));
    }
    for (const name of ENTRY_COLLECTIONS_V2) {
      const c = bible.collection(name);
      // Every entry can be in the trash (ED-5) and linked (ED-9).
      await c.createIndex({ deletedAt: 1 });
      await c.createIndex({ 'links.targetId': 1 });
      for (const key of INDEXES[name] ?? []) await c.createIndex(key);
    }
    await bible.collection('revisions').createIndex({ collection: 1, entryId: 1, _id: 1 });
    await bible.collection('proposals').createIndex({ state: 1, _id: 1 });
    const lists = bible.collection<{ _id: string }>('lists');
    for (const list of defaultLists().filter((l) => ['languages', 'tags'].includes(l._id))) {
      await lists.updateOne({ _id: list._id }, { $setOnInsert: list }, { upsert: true });
    }
  },
};
