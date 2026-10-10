import type { BibleHandle } from '../db/bibles';

export interface StoredDoc {
  _id: string;
  [key: string]: unknown;
}

export interface Backlink {
  collection: string;
  id: string;
  kind: string;
}

/**
 * Collections that are not loaded into memory. Revisions are history, read
 * on demand for one entry at a time; holding every prior document in memory
 * would grow without bound and no deterministic query needs them.
 */
const NOT_LOADED = new Set(['revisions']);

/**
 * The in-memory read model of the open bible (ARCH-2). Every collection is
 * held in a map keyed by ID. The repository updates it after every write, so
 * deterministic queries never round-trip to the database.
 */
export class ReadModel {
  private readonly maps = new Map<string, Map<string, StoredDoc>>();

  /** Load every collection of one bible (its prefixed collections only). */
  async load(bible: BibleHandle): Promise<void> {
    this.maps.clear();
    const names = (await bible.collectionNames()).filter((n) => !NOT_LOADED.has(n));
    await Promise.all(
      names.map(async (name) => {
        const docs = await bible.collection<StoredDoc>(name).find({}).toArray();
        this.maps.set(
          name,
          new Map(docs.map((d) => [String(d._id), { ...d, _id: String(d._id) }])),
        );
      }),
    );
  }

  collections(): string[] {
    return [...this.maps.keys()].sort();
  }

  private map(collection: string): Map<string, StoredDoc> {
    let m = this.maps.get(collection);
    if (!m) {
      m = new Map();
      this.maps.set(collection, m);
    }
    return m;
  }

  put(collection: string, doc: StoredDoc): void {
    this.map(collection).set(doc._id, doc);
  }

  remove(collection: string, id: string): void {
    this.maps.get(collection)?.delete(id);
  }

  get(collection: string, id: string): StoredDoc | undefined {
    return this.maps.get(collection)?.get(id);
  }

  all(collection: string): StoredDoc[] {
    return [...(this.maps.get(collection)?.values() ?? [])];
  }

  size(collection: string): number {
    return this.maps.get(collection)?.size ?? 0;
  }

  /** Entries whose `links` point at `targetId` (ARCHITECTURE rule 4). */
  backlinks(targetId: string): Backlink[] {
    const out: Backlink[] = [];
    for (const [collection, docs] of this.maps) {
      for (const doc of docs.values()) {
        const links = Array.isArray(doc.links)
          ? (doc.links as { targetId: string; kind: string }[])
          : [];
        for (const l of links) {
          if (l.targetId === targetId) out.push({ collection, id: doc._id, kind: l.kind });
        }
      }
    }
    return out;
  }
}
