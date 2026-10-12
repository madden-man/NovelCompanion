import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Document } from 'mongodb';
import { READ_ONLY_REASON } from '../../shared/ipcApp';
import { SnapshotManifest } from '../../shared/domain/snapshots';
import type { SnapshotInfo } from '../../shared/domain/snapshots';
import { ReadModel } from '../readmodel';
import { SearchIndex } from '../search';
import { SnapshotService } from '../backup/snapshots';
import type { CollectionDocs } from '../backup/dump';
import type { BibleHandle } from './bibles';
import { Repository } from './repository';
import type { OpenBible } from './session';

/**
 * ARCH-6: opening a local snapshot read-only when MongoDB cannot be reached.
 *
 * The snapshot's JSON files become a `BibleHandle` whose collections answer
 * the reads the app makes (`find`, `findOne`, counts) from memory, and whose
 * every write, and every session or transaction, throws `ReadOnlyError`
 * before anything changes. The read model, search index, and repository are
 * the ordinary ones built on that handle, so search and every deterministic
 * view work exactly as they do against MongoDB, and the one write path
 * refuses every change.
 */
export class ReadOnlyError extends Error {
  override name = 'ReadOnlyError';
  constructor() {
    super(READ_ONLY_REASON);
  }
}

const READS = new Set(['find', 'findOne', 'countDocuments', 'estimatedDocumentCount']);

type Filter = Record<string, unknown>;

function matches(doc: Document, filter: Filter): boolean {
  return Object.entries(filter).every(([key, want]) => {
    const have = doc[key];
    if (want !== null && typeof want === 'object' && !Array.isArray(want)) {
      const ops = want as Record<string, unknown>;
      if ('$in' in ops && Array.isArray(ops.$in)) return ops.$in.some((v) => v === have);
      if ('$exists' in ops) return (have !== undefined) === Boolean(ops.$exists);
      if ('$ne' in ops) return have !== ops.$ne;
      // Anything richer is not a query the app makes against a bible; refuse rather than guess.
      throw new ReadOnlyError();
    }
    return have === want;
  });
}

class Cursor {
  private order: [string, 1 | -1][] = [];
  private max = 0;
  constructor(private readonly docs: Document[]) {}
  sort(spec: Record<string, 1 | -1>): this {
    this.order = Object.entries(spec);
    return this;
  }
  limit(n: number): this {
    this.max = n;
    return this;
  }
  project(): this {
    return this;
  }
  async toArray(): Promise<Document[]> {
    const out = this.docs.map((d) => structuredClone(d));
    if (this.order.length) {
      out.sort((a, b) => {
        for (const [k, dir] of this.order) {
          const x = a[k] as string | number;
          const y = b[k] as string | number;
          if (x < y) return -dir;
          if (x > y) return dir;
        }
        return 0;
      });
    }
    return this.max > 0 ? out.slice(0, this.max) : out;
  }
}

function readOnlyCollection(docs: () => Document[]): unknown {
  const reads = {
    find: (filter: Filter = {}) => new Cursor(docs().filter((d) => matches(d, filter))),
    findOne: async (filter: Filter = {}) => {
      const hit = docs().find((d) => matches(d, filter));
      return hit ? structuredClone(hit) : null;
    },
    countDocuments: async (filter: Filter = {}) => docs().filter((d) => matches(d, filter)).length,
    estimatedDocumentCount: async () => docs().length,
  };
  return new Proxy(reads, {
    get(target, prop) {
      if (typeof prop === 'string' && READS.has(prop)) return target[prop as keyof typeof reads];
      // insertOne, replaceOne, updateMany, deleteOne, bulkWrite, and the rest.
      return () => {
        throw new ReadOnlyError();
      };
    },
  });
}

/** A bible handle over a snapshot's documents: reads from memory, every write refused. */
export function snapshotHandle(
  id: string,
  collections: CollectionDocs,
  record?: BibleHandle['snapshotOf'],
): BibleHandle {
  const refuse = () => {
    throw new ReadOnlyError();
  };
  const client = new Proxy({}, { get: () => refuse });
  const db = new Proxy({}, { get: () => refuse });
  return {
    id,
    client: client as BibleHandle['client'],
    db: db as BibleHandle['db'],
    qualified: (c) => `${id}.${c}`,
    collection: ((c: string) =>
      readOnlyCollection(() => collections[c] ?? [])) as BibleHandle['collection'],
    collectionNames: async () => Object.keys(collections).sort(),
    ...(record ? { snapshotOf: record } : {}),
  };
}

/** Every bible folder under the snapshot root, with its newest readable snapshot. */
async function newestPerBible(root: string): Promise<SnapshotInfo[]> {
  let bibles: string[];
  try {
    bibles = await readdir(root);
  } catch {
    return [];
  }
  const out: SnapshotInfo[] = [];
  for (const bible of bibles) {
    let ids: string[];
    try {
      ids = (await readdir(join(root, bible))).filter((n) => !n.endsWith('.partial'));
    } catch {
      continue;
    }
    for (const id of ids.sort().reverse()) {
      try {
        const text = await readFile(join(root, bible, id, 'manifest.json'), 'utf8');
        const parsed = SnapshotManifest.safeParse(JSON.parse(text));
        if (parsed.success && parsed.data.bible === bible) {
          out.push({ ...parsed.data, id });
          break;
        }
      } catch {
        // Not a snapshot; try the next one.
      }
    }
  }
  return out.sort((a, b) => b.takenAt.localeCompare(a.takenAt));
}

/**
 * The most recent local snapshot: of the given bible when one is named and
 * has any, else of any bible. Null when there is none.
 */
export async function latestSnapshot(
  root: string,
  preferBible?: string | null,
): Promise<SnapshotInfo | null> {
  const all = await newestPerBible(root);
  return (preferBible ? all.find((s) => s.bible === preferBible) : undefined) ?? all[0] ?? null;
}

/** An open bible built from a snapshot, plus which snapshot it is. */
export interface ReadOnlyBible {
  session: OpenBible;
  snapshot: SnapshotInfo;
}

/**
 * ARCH-6: open a snapshot read-only. The snapshot is checked exactly as a
 * restore checks it (BK-2) before anything is loaded.
 */
export async function openSnapshotReadOnly(
  root: string,
  info: { bible: string; id: string },
): Promise<ReadOnlyBible> {
  const collections: CollectionDocs = {};
  // Filled in once the manifest is read, so an export of the snapshot names the bible.
  const record = { name: info.bible, createdAt: '', schemaVersion: 0 };
  const handle = snapshotHandle(info.bible, collections, record);
  const service = new SnapshotService(handle, root);
  const data = await service.read(info.id);
  Object.assign(collections, data.collections);
  Object.assign(record, {
    name: data.manifest.name ?? info.bible,
    createdAt: data.manifest.createdAt ?? data.manifest.takenAt,
    schemaVersion: data.manifest.schemaVersion,
  });
  const model = new ReadModel();
  await model.load(handle);
  const search = new SearchIndex();
  search.rebuild(model);
  const repo = new Repository(handle, model, search);
  return {
    session: { handle, model, search, repo },
    snapshot: { ...data.manifest, id: info.id },
  };
}
