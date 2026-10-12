import type { Collection, Db, Document, MongoClient } from 'mongodb';
import { MongoServerError } from 'mongodb';
import { LATEST_SCHEMA_VERSION, migrations } from './migrations';
import type { Migration } from './migrations';
import type { Store } from './connection';
import { BIBLE_SLUG_RULE, BibleSlug } from '../../shared/bible';

/** The registry of bibles inside `novel_companion` (ARCH-8, A22). */
export const REGISTRY = 'bibles';

export class BibleError extends Error {
  override name = 'BibleError';
}

export function assertBibleSlug(slug: string): void {
  if (!BibleSlug.safeParse(slug).success || slug === REGISTRY) {
    throw new BibleError(`"${slug}" cannot be a bible ID. ${BIBLE_SLUG_RULE}`);
  }
}

export interface BibleRecord {
  _id: string;
  name: string;
  createdAt: string;
  schemaVersion: number;
}

/**
 * A handle on one bible. Its data lives in collections named
 * `<bibleId>.<collection>`; the accessor adds the prefix, so code using a
 * handle cannot reach another bible's collections.
 */
export interface BibleHandle {
  readonly id: string;
  readonly client: MongoClient;
  /** The shared `novel_companion` database. Prefer `collection()`. */
  readonly db: Db;
  qualified(collection: string): string;
  collection<T extends Document = Document>(collection: string): Collection<T>;
  /** This bible's collection names, without the prefix. */
  collectionNames(): Promise<string[]>;
  /**
   * ARCH-6: set only on a local snapshot opened read-only, which has no
   * registry and no sessions: the bible record the snapshot carries.
   */
  readonly snapshotOf?: { name: string; createdAt: string; schemaVersion: number };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function handleFor(store: Store, id: string): BibleHandle {
  const prefix = `${id}.`;
  return {
    id,
    client: store.client,
    db: store.db,
    qualified: (c) => `${prefix}${c}`,
    collection: <T extends Document>(c: string) => store.db.collection<T>(`${prefix}${c}`),
    async collectionNames() {
      const found = await store.db
        .listCollections({ name: { $regex: `^${escapeRegex(prefix)}` } }, { nameOnly: true })
        .toArray();
      return found.map((c) => c.name.slice(prefix.length)).sort();
    },
  };
}

const registry = (store: Store) => store.db.collection<BibleRecord>(REGISTRY);

/** Open a registered bible. Unregistered IDs are refused. */
export async function openBible(store: Store, id: string): Promise<BibleHandle> {
  assertBibleSlug(id);
  const record = await registry(store).findOne({ _id: id });
  if (!record) throw new BibleError(`There is no bible with the ID "${id}".`);
  return handleFor(store, id);
}

/** Every registered bible, read from the registry. */
export async function listBibles(store: Store): Promise<BibleRecord[]> {
  return registry(store).find({}).sort({ _id: 1 }).toArray();
}

export async function schemaVersion(bible: BibleHandle): Promise<number> {
  const record = await bible.db.collection<BibleRecord>(REGISTRY).findOne({ _id: bible.id });
  if (!record) throw new BibleError(`There is no bible with the ID "${bible.id}".`);
  return record.schemaVersion;
}

/**
 * Run every migration newer than the bible's recorded version, in order,
 * recording the version on the registry document after each one so a failure
 * part way leaves an accurate record.
 */
export async function migrate(
  bible: BibleHandle,
  list: readonly Migration[] = migrations,
): Promise<{ from: number; to: number }> {
  list.forEach((m, i) => {
    if (m.version !== i + 1) throw new BibleError(`Migration ${m.name} is out of order`);
  });
  const from = await schemaVersion(bible);
  if (from > list.length) {
    throw new BibleError(
      `This bible uses schema version ${from}, which is newer than this app knows (${list.length}). Update the app before opening it.`,
    );
  }
  const reg = bible.db.collection<BibleRecord>(REGISTRY);
  for (const m of list.slice(from)) {
    await m.up(bible);
    await reg.updateOne({ _id: bible.id }, { $set: { schemaVersion: m.version } });
  }
  return { from, to: list.length };
}

/** Register a new, empty bible, create its collections, and seed the default lists. */
export async function createBible(store: Store, id: string, name: string): Promise<BibleHandle> {
  assertBibleSlug(id);
  if (!name.trim()) throw new BibleError('A bible needs a name.');
  try {
    await registry(store).insertOne({
      _id: id,
      name: name.trim(),
      createdAt: new Date().toISOString(),
      schemaVersion: 0,
    });
  } catch (e) {
    if (e instanceof MongoServerError && e.code === 11000) {
      throw new BibleError(`A bible with the ID "${id}" already exists.`);
    }
    throw e;
  }
  const bible = handleFor(store, id);
  await migrate(bible);
  if ((await schemaVersion(bible)) !== LATEST_SCHEMA_VERSION) {
    throw new BibleError('The new bible did not migrate.');
  }
  return bible;
}

/** Drop one bible: its prefixed collections and its registry document, nothing else. */
export async function dropBible(store: Store, id: string): Promise<void> {
  const bible = await openBible(store, id);
  for (const name of await bible.collectionNames()) {
    await store.db.dropCollection(bible.qualified(name));
  }
  await registry(store).deleteOne({ _id: id });
}
