import type { Document } from 'mongodb';
import { REGISTRY, migrate } from '../db/bibles';
import type { BibleHandle, BibleRecord } from '../db/bibles';

export type CollectionDocs = Record<string, Document[]>;

export interface BibleDump {
  bible: { id: string; name: string; createdAt: string; schemaVersion: number };
  collections: CollectionDocs;
}

/**
 * Every collection of one bible, read in a single snapshot-isolated
 * transaction so the dump is consistent even while a write lands (BK-1).
 */
export async function dumpBible(handle: BibleHandle): Promise<BibleDump> {
  // ARCH-6: a snapshot open read-only is already consistent and has no sessions to open.
  if (handle.snapshotOf) {
    const collections: CollectionDocs = {};
    for (const name of await handle.collectionNames()) {
      collections[name] = await handle.collection(name).find({}).toArray();
    }
    return { bible: { id: handle.id, ...handle.snapshotOf }, collections };
  }
  const session = handle.client.startSession();
  try {
    let collections: CollectionDocs = {};
    await session.withTransaction(
      async () => {
        collections = {};
        for (const name of await handle.collectionNames()) {
          collections[name] = await handle.collection(name).find({}, { session }).toArray();
        }
      },
      { readConcern: { level: 'snapshot' } },
    );
    const record = await handle.db
      .collection<BibleRecord>(REGISTRY)
      .findOne({ _id: handle.id }, { session });
    if (!record) throw new Error(`There is no bible with the ID "${handle.id}".`);
    return {
      bible: {
        id: record._id,
        name: record.name,
        createdAt: record.createdAt,
        schemaVersion: record.schemaVersion,
      },
      collections,
    };
  } finally {
    await session.endSession();
  }
}

const CHUNK = 1000;

/**
 * Replace every collection of a bible with the given documents in one
 * transaction: all of it or none (BK-2, BK-3). Collections the bible has that
 * the data lacks are emptied. The recorded schema version is set to the
 * data's, then the bible is migrated up to the current version.
 */
export async function replaceBible(
  handle: BibleHandle,
  collections: CollectionDocs,
  schemaVersion: number,
): Promise<void> {
  const existing = await handle.collectionNames();
  const names = [...new Set([...existing, ...Object.keys(collections)])];
  const session = handle.client.startSession();
  try {
    await session.withTransaction(async () => {
      for (const name of names) {
        const target = handle.collection(name);
        await target.deleteMany({}, { session });
        const docs = collections[name] ?? [];
        for (let i = 0; i < docs.length; i += CHUNK) {
          await target.insertMany(docs.slice(i, i + CHUNK), { session, ordered: true });
        }
      }
      await handle.db
        .collection<BibleRecord>(REGISTRY)
        .updateOne({ _id: handle.id }, { $set: { schemaVersion } }, { session });
    });
  } finally {
    await session.endSession();
  }
  await migrate(handle);
}
