import type { Document } from 'mongodb';
import { Moment } from '../../../shared/schema/moment';
import { GlossaryTerm } from '../../../shared/schema/world';
import {
  beatToMoment,
  characterMoments,
  foldedBody,
  nameGlossaryTerms,
  nameLanguage,
} from '../../../shared/domain/moments';
import type { MomentDoc, Skip } from '../../../shared/domain/moments';
import type { BibleHandle } from '../bibles';
import type { Migration } from './types';

/** SM-2: the collections A39 drops. Every one is in the snapshot taken before this runs. */
export const DROPPED_COLLECTIONS = [
  'facts',
  'knowledgeRecords',
  'themes',
  'customSections',
  'customEntries',
  'arcs',
  'relationships',
  'plotBeats',
] as const;

/** SM-1, SM-4: the fields A39 drops, per collection, as `$unset` paths. */
export const DROPPED_FIELDS: Record<string, string[]> = {
  characters: [
    'names.romanization',
    'names.order',
    'names.birthName',
    'names.marriedName',
    'names.nicknames',
    'names.calledBy',
    'birthplace',
    'voiceNotes',
    'placesLived',
    'backstoryMarks',
  ],
  worldEvents: ['reality', 'placeIds'],
  eraStates: ['technology', 'climate', 'economy', 'politics', 'dailyLife'],
  culturalEntries: ['generationNotes'],
  chapters: ['arcIds', 'factsInPlay'],
};

/** SM-4: prose folded into the body before its field goes, with the label it keeps. */
const FOLDED: Record<string, [string, string][]> = {
  eraStates: [
    ['technology', 'Technology'],
    ['climate', 'Climate'],
    ['economy', 'Economy'],
    ['politics', 'Politics'],
    ['dailyLife', 'Daily life'],
  ],
  culturalEntries: [['generationNotes', 'Generation notes']],
};

export const MIGRATION9_META_ID = 'migration9';

/** What migration 9 did, kept in `meta` so the numbers can be checked against the audit. */
export interface Migration9Summary {
  _id: typeof MIGRATION9_META_ID;
  made: { fromBeats: number; fromVoiceNotes: number; fromPlacesLived: number; total: number };
  /** Moments of trashed beats or of trashed characters, made in the trash too. */
  madeInTrash: number;
  skipped: Skip[];
  /** Live and trashed documents in each dropped collection when it was dropped. */
  dropped: Record<string, number>;
  /** Revisions of entries in the dropped collections, removed with them. */
  revisionsDropped: number;
  /** Links from other entries to entries that no longer exist (beats became moments and keep theirs). */
  linksRemoved: number;
  /** Pending proposals for a dropped collection, now rejected. */
  proposalsRejected: number;
  /** Saved import mappings that wrote to a dropped collection, now removed. */
  mappingsRemoved: number;
  /** SM-1: glossary terms made for character names from their romanization. */
  glossaryMade: number;
  /** SM-1: glossary terms for a name that had no romanization, filled from the character. */
  glossaryFilled: number;
  takenAt: string;
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** The source of a moment, read from its ID (see `src/shared/domain/moments.ts`). */
function sourceOf(m: MomentDoc, beatIds: Set<string>): Skip['source'] {
  if (beatIds.has(m._id)) return 'plotBeat';
  return /-voice-\d+$/.test(m._id) ? 'voiceNote' : 'placeLived';
}

/**
 * A39, SM-1 to SM-4 (schema version 9), per bible in one pass: a moment from
 * every plot beat, voice note, and place lived (trash carried over); the
 * dropped fields unset, with era prose and generation notes folded into the
 * body first; the eight dropped collections and their revisions dropped; and
 * one summary document in `meta`. `openBibleSession` takes a snapshot first
 * (SM-2). Running it again makes the same moments and changes nothing more.
 */
export const simplifiedModel: Migration = {
  version: 9,
  name: 'the simplified model: moments, dropped collections and fields',
  async up(bible: BibleHandle) {
    const existing = new Set(await bible.collectionNames());
    const all = async (name: string): Promise<Document[]> =>
      existing.has(name) ? bible.collection<Document>(name).find({}).toArray() : [];

    // 1. Moments from beats, voice notes, and places lived.
    const beats = await all('plotBeats');
    const characters = await all('characters');
    const beatIds = new Set(beats.map((b) => str(b._id)));
    const made: MomentDoc[] = [];
    const skipped: Skip[] = [];
    for (const b of beats) {
      const r = beatToMoment(b as never);
      if ('moment' in r) made.push(r.moment);
      else skipped.push(r.skip);
    }
    for (const c of characters) {
      const r = characterMoments(c as never);
      made.push(...r.moments);
      skipped.push(...r.skipped);
    }
    if (!existing.has('moments')) await bible.db.createCollection(bible.qualified('moments'));
    const moments = bible.collection<Document>('moments');
    const kept: MomentDoc[] = [];
    for (const m of made) {
      const parsed = Moment.safeParse(m);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        skipped.push({
          source: sourceOf(m, beatIds),
          id: m._id,
          reason: `it would not be a valid moment (${issue?.path.join('.') || 'entry'}: ${issue?.message ?? 'invalid'})`,
        });
        continue;
      }
      kept.push(m);
      await moments.updateOne(
        { _id: m._id } as Document,
        { $setOnInsert: parsed.data } as Document,
        { upsert: true },
      );
    }
    await moments.createIndex({ characterId: 1, year: 1 });
    await moments.createIndex({ deletedAt: 1 });
    await moments.createIndex({ 'links.targetId': 1 });

    // 1b. SM-1: a name's romanization moves to the glossary term for the name, before it is unset.
    const languages = existing.has('lists')
      ? await bible.collection<Document>('lists').findOne({ _id: 'languages' } as Document)
      : null;
    const terms = nameGlossaryTerms(
      characters,
      await all('glossaryTerms'),
      nameLanguage(languages),
    );
    if (terms.made.length && !existing.has('glossaryTerms')) {
      await bible.db.createCollection(bible.qualified('glossaryTerms'));
    }
    const glossary = bible.collection<Document>('glossaryTerms');
    let glossaryMade = 0;
    for (const t of terms.made) {
      const parsed = GlossaryTerm.safeParse(t);
      if (!parsed.success) continue;
      const res = await glossary.updateOne(
        { _id: t._id } as Document,
        { $setOnInsert: parsed.data } as Document,
        { upsert: true },
      );
      glossaryMade += res.upsertedCount;
    }
    let glossaryFilled = 0;
    for (const f of terms.filled) {
      const res = await glossary.updateOne(
        {
          _id: f._id,
          $or: [{ romanization: '' }, { romanization: { $exists: false } }],
        } as Document,
        { $set: { romanization: f.romanization } },
      );
      glossaryFilled += res.modifiedCount;
    }

    // 2. Prose folded into the body, then the dropped fields unset (and in the history too).
    for (const [collection, fields] of Object.entries(FOLDED)) {
      for (const d of await all(collection)) {
        const body = foldedBody(
          d.body,
          fields.map(([f, label]) => [label, d[f]] as const),
        );
        if (body !== null) {
          await bible
            .collection<Document>(collection)
            .updateOne({ _id: d._id }, { $set: { body } });
        }
      }
    }
    for (const [collection, fields] of Object.entries(DROPPED_FIELDS)) {
      if (!existing.has(collection)) continue;
      const unset = Object.fromEntries(fields.map((f) => [f, '']));
      await bible.collection(collection).updateMany({}, { $unset: unset });
      const prior = Object.fromEntries(fields.map((f) => [`prior.${f}`, '']));
      await bible
        .collection('revisions')
        .updateMany({ collection, prior: { $ne: null } } as Document, { $unset: prior });
    }

    // 3. Links to entries that are gone. A beat's moment keeps the beat's ID, so links to beats stay.
    const gone = new Set<string>();
    for (const name of DROPPED_COLLECTIONS) {
      if (name === 'plotBeats') continue;
      for (const d of await all(name)) gone.add(str(d._id));
    }
    for (const id of kept.map((m) => m._id)) gone.delete(id);
    let linksRemoved = 0;
    if (gone.size) {
      const ids = [...gone];
      for (const name of await bible.collectionNames()) {
        if ((DROPPED_COLLECTIONS as readonly string[]).includes(name)) continue;
        if (
          ['revisions', 'meta', 'lists', 'proposals', 'conversations', 'importSources'].includes(
            name,
          )
        ) {
          continue;
        }
        const docs = await bible
          .collection<Document>(name)
          .find({ 'links.targetId': { $in: ids } } as Document)
          .toArray();
        for (const d of docs) {
          const links = (Array.isArray(d.links) ? d.links : []) as { targetId: string }[];
          const next = links.filter((l) => !gone.has(l.targetId));
          linksRemoved += links.length - next.length;
          await bible
            .collection<Document>(name)
            .updateOne({ _id: d._id }, { $set: { links: next } });
        }
      }
    }

    // 4. Pending proposals for a dropped collection can never apply; saved mappings to one can never run.
    const dropped = DROPPED_COLLECTIONS as readonly string[];
    const takenAt = new Date().toISOString();
    let proposalsRejected = 0;
    if (existing.has('proposals')) {
      const r = await bible
        .collection('proposals')
        .updateMany({ state: 'pending', collection: { $in: [...dropped] } } as Document, {
          $set: { state: 'rejected', decidedAt: takenAt },
        });
      proposalsRejected = r.modifiedCount;
    }
    let mappingsRemoved = 0;
    const meta = bible.collection<Document>('meta');
    const mappings = existing.has('meta')
      ? await meta.findOne({ _id: 'importMappings' } as Document)
      : null;
    if (mappings && Array.isArray(mappings.mappings)) {
      const writes = (m: unknown): boolean => {
        const x = m as { target?: { collection?: string }; headings?: { collection?: string }[] };
        return (
          dropped.includes(str(x?.target?.collection)) ||
          (Array.isArray(x?.headings) &&
            x.headings.some((h) => dropped.includes(str(h?.collection))))
        );
      };
      const list = mappings.mappings as { key: string; mapping: unknown }[];
      const keep = list.filter((m) => !writes(m.mapping));
      mappingsRemoved = list.length - keep.length;
      if (mappingsRemoved) {
        await meta.updateOne({ _id: 'importMappings' } as Document, { $set: { mappings: keep } });
      }
    }

    // 5. The dropped collections and their history.
    const counts: Record<string, number> = {};
    for (const name of DROPPED_COLLECTIONS) {
      counts[name] = existing.has(name) ? await bible.collection(name).countDocuments({}) : 0;
      if (existing.has(name)) await bible.db.dropCollection(bible.qualified(name));
    }
    const revs = await bible
      .collection('revisions')
      .deleteMany({ collection: { $in: [...dropped] } } as Document);

    // 6. The summary, written once; a second run keeps the first.
    const count = (kind: Skip['source']) =>
      kept.filter((m) => sourceOf(m, beatIds) === kind).length;
    const summary: Migration9Summary = {
      _id: MIGRATION9_META_ID,
      made: {
        fromBeats: count('plotBeat'),
        fromVoiceNotes: count('voiceNote'),
        fromPlacesLived: count('placeLived'),
        total: kept.length,
      },
      madeInTrash: kept.filter((m) => m.deletedAt).length,
      skipped,
      dropped: counts,
      revisionsDropped: revs.deletedCount,
      linksRemoved,
      proposalsRejected,
      mappingsRemoved,
      glossaryMade,
      glossaryFilled,
      takenAt,
    };
    await meta.updateOne(
      { _id: MIGRATION9_META_ID } as Document,
      { $setOnInsert: summary } as Document,
      { upsert: true },
    );
  },
};
