import type { Document } from 'mongodb';
import type { BibleHandle } from '../bibles';
import { ENTRY_COLLECTIONS } from '../../../shared/schema';
import type { Migration } from './types';

export const MIGRATION13_META_ID = 'migration13';

/*
 * The names below are written out because migrations never change: the
 * fields, collections, lists and meta documents as of A53 (2026-10-23). The
 * six fields are unset on every entry collection the app has.
 */

/** A52 (A53): the six fields every entry loses. */
export const REMOVED_FIELDS = [
  'status',
  'provenance',
  'sourceNote',
  'sourceRef',
  'tags',
  'links',
] as const;

/** A53: the collections this migration drops. */
export const DROPPED_COLLECTIONS_V13 = [
  'revisions',
  'importSources',
  'briefs',
  'sessionLogs',
  'books',
] as const;

/** A52: the lists that existed only for the removed fields. */
export const REMOVED_LISTS = ['statuses', 'provenance', 'tags'] as const;

/** A53: the meta documents of the importer and Google Drive. `briefSettings` stays. */
export const REMOVED_META = ['importMappings', 'drive'] as const;

/** The tag that marks an offline capture question (KB-7); a question tagged only with it stays. */
const CAPTURE_TAG = 'capture';

/** What migration 13 did, kept in `meta`. */
export interface Migration13Summary {
  _id: typeof MIGRATION13_META_ID;
  /** Live open questions moved to the trash because a tag other than `capture` marked them. */
  questionsTrashed: number;
  /** Open questions given `aboutIds` from their links. */
  questionsAbout: number;
  /** Entries per collection that had at least one of the six fields removed. */
  fieldsCleared: Record<string, number>;
  /** Parts that lost their `bookId`. */
  partsUnlinked: number;
  /** Documents in each dropped collection, counted before the drop. */
  dropped: Record<(typeof DROPPED_COLLECTIONS_V13)[number], number>;
  /** Items each removed list held. */
  listsRemoved: Record<(typeof REMOVED_LISTS)[number], number>;
  takenAt: string;
}

/** The unique target IDs of a stored `links` array, in order. */
function linkTargets(links: unknown): string[] {
  if (!Array.isArray(links)) return [];
  const out: string[] = [];
  for (const l of links) {
    const id = (l as { targetId?: unknown } | null)?.targetId;
    if (typeof id === 'string' && id && !out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * A53 (schema version 13): the cuts. In order:
 * 1. Every live open question tagged with anything but `capture` (the audit
 *    and import questions) goes to the trash.
 * 2. Open questions with no `aboutIds` get the targets of their links.
 * 3. Status, provenance, source note, source location, tags and links are
 *    unset on every entry, trashed ones too.
 * 4. Parts lose `bookId`, and the parts index on it goes.
 * 5. `revisions`, `importSources`, `briefs`, `sessionLogs` and `books` are dropped.
 * 6. The `statuses`, `provenance` and `tags` lists and the `importMappings`
 *    and `drive` meta documents are removed.
 * 7. The counts are written once to `meta.migration13`.
 * Modified times are not touched. `openBibleSession` takes a snapshot first.
 * Running it again changes nothing.
 */
export const cuts: Migration = {
  version: 13,
  name: 'cuts: status, provenance, source, tags, links, revisions, briefs, session logs, books, import sources, Drive',
  async up(bible: BibleHandle) {
    const existing = new Set(await bible.collectionNames());
    const now = new Date().toISOString();

    // 1. The tagged questions go to the trash.
    let questionsTrashed = 0;
    let questionsAbout = 0;
    if (existing.has('openQuestions')) {
      const questions = bible.collection<Document>('openQuestions');
      const trashed = await questions.updateMany(
        {
          deletedAt: { $exists: false },
          tags: { $elemMatch: { $ne: CAPTURE_TAG } },
        },
        { $set: { deletedAt: now } },
      );
      questionsTrashed = trashed.modifiedCount;

      // 2. What each question is about, from its links.
      for (const q of await questions.find({ aboutIds: { $exists: false } }).toArray()) {
        await questions.updateOne({ _id: q._id }, { $set: { aboutIds: linkTargets(q.links) } });
        questionsAbout++;
      }
    }

    // 3. The six fields leave every entry.
    const fieldsCleared: Record<string, number> = {};
    const unset = Object.fromEntries(REMOVED_FIELDS.map((f) => [f, '']));
    const anyField = { $or: REMOVED_FIELDS.map((f) => ({ [f]: { $exists: true } })) };
    for (const name of ENTRY_COLLECTIONS) {
      if (!existing.has(name)) continue;
      const res = await bible.collection<Document>(name).updateMany(anyField, { $unset: unset });
      fieldsCleared[name] = res.modifiedCount;
    }

    // 4. Parts lose their book.
    let partsUnlinked = 0;
    if (existing.has('parts')) {
      const parts = bible.collection<Document>('parts');
      const res = await parts.updateMany({ bookId: { $exists: true } }, { $unset: { bookId: '' } });
      partsUnlinked = res.modifiedCount;
      for (const index of await parts.indexes()) {
        const key = index.key as Record<string, unknown>;
        const names = Object.keys(key);
        if (names.length === 2 && key.bookId === 1 && key.number === 1 && index.name) {
          await parts.dropIndex(index.name);
        }
      }
    }

    // 5. The dropped collections, counted first.
    const dropped = Object.fromEntries(DROPPED_COLLECTIONS_V13.map((n) => [n, 0])) as Record<
      (typeof DROPPED_COLLECTIONS_V13)[number],
      number
    >;
    for (const name of DROPPED_COLLECTIONS_V13) {
      if (!existing.has(name)) continue;
      dropped[name] = await bible.collection(name).countDocuments({});
      await bible.db.dropCollection(bible.qualified(name));
    }

    // 6. The lists and meta documents of the removed features.
    const listsRemoved = Object.fromEntries(REMOVED_LISTS.map((n) => [n, 0])) as Record<
      (typeof REMOVED_LISTS)[number],
      number
    >;
    const lists = bible.collection<Document>('lists');
    for (const l of await lists.find({ _id: { $in: [...REMOVED_LISTS] } } as Document).toArray()) {
      listsRemoved[String(l._id) as (typeof REMOVED_LISTS)[number]] = Array.isArray(l.items)
        ? l.items.length
        : 0;
    }
    await lists.deleteMany({ _id: { $in: [...REMOVED_LISTS] } } as Document);
    const meta = bible.collection<Document>('meta');
    await meta.deleteMany({ _id: { $in: [...REMOVED_META] } } as Document);

    // 7. The summary, written once; a second run keeps the first.
    const summary: Migration13Summary = {
      _id: MIGRATION13_META_ID,
      questionsTrashed,
      questionsAbout,
      fieldsCleared,
      partsUnlinked,
      dropped,
      listsRemoved,
      takenAt: now,
    };
    await meta.updateOne(
      { _id: MIGRATION13_META_ID } as Document,
      { $setOnInsert: summary },
      {
        upsert: true,
      },
    );
  },
};
