import { isEntryCollection, manifests } from '../../shared/schema';
import { outgoingRefs } from '../../shared/domain/refs';
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
 * The in-memory read model of the open bible (ARCH-2). Every collection is
 * held in a map keyed by ID. The repository updates it after every write, so
 * deterministic queries never round-trip to the database.
 */
export class ReadModel {
  private readonly maps = new Map<string, Map<string, StoredDoc>>();
  /** target ID to the entries that refer to it; rebuilt after a write when next asked. */
  private reverse: Map<string, { collection: string; id: string; kind: string }[]> | null = null;

  /**
   * A58 (PH-8): the puts and removes made while a load reads the database,
   * replayed onto what it read, so a write that lands mid-load is never lost.
   */
  private midLoad: (() => void)[] | null = null;

  /**
   * Load every collection of one bible (its prefixed collections only). A58:
   * the old contents stay readable until the new ones are all read, so a
   * reload while the app runs never shows a half-loaded bible.
   */
  async load(bible: BibleHandle): Promise<void> {
    const replay: (() => void)[] = [];
    this.midLoad = replay;
    try {
      const next = new Map<string, Map<string, StoredDoc>>();
      const names = await bible.collectionNames();
      await Promise.all(
        names.map(async (name) => {
          const docs = await bible.collection<StoredDoc>(name).find({}).toArray();
          next.set(name, new Map(docs.map((d) => [String(d._id), { ...d, _id: String(d._id) }])));
        }),
      );
      this.maps.clear();
      for (const [name, docs] of next) this.maps.set(name, docs);
      this.reverse = null;
    } finally {
      if (this.midLoad === replay) this.midLoad = null;
    }
    for (const op of replay) op();
  }

  /** A58: every document as it is now, by collection, to compare with after a reload. */
  copy(): Map<string, Map<string, StoredDoc>> {
    return new Map([...this.maps].map(([name, docs]) => [name, new Map(docs)]));
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
    this.reverse = null;
    this.midLoad?.push(() => this.put(collection, doc));
  }

  remove(collection: string, id: string): void {
    this.maps.get(collection)?.delete(id);
    this.reverse = null;
    this.midLoad?.push(() => this.remove(collection, id));
  }

  get(collection: string, id: string): StoredDoc | undefined {
    return this.maps.get(collection)?.get(id);
  }

  /** Find an entry by ID in any entry collection. */
  find(id: string): { collection: string; doc: StoredDoc } | undefined {
    for (const [collection, docs] of this.maps) {
      if (!isEntryCollection(collection)) continue;
      const doc = docs.get(id);
      if (doc) return { collection, doc };
    }
    return undefined;
  }

  all(collection: string): StoredDoc[] {
    return [...(this.maps.get(collection)?.values() ?? [])];
  }

  size(collection: string): number {
    return this.maps.get(collection)?.size ?? 0;
  }

  private buildReverse() {
    const reverse = new Map<string, { collection: string; id: string; kind: string }[]>();
    for (const [collection, docs] of this.maps) {
      if (!isEntryCollection(collection)) continue;
      const manifest = manifests[collection];
      for (const doc of docs.values()) {
        for (const ref of outgoingRefs(manifest, doc)) {
          let list = reverse.get(ref.targetId);
          if (!list) reverse.set(ref.targetId, (list = []));
          if (
            !list.some(
              (b) => b.collection === collection && b.id === doc._id && b.kind === ref.kind,
            )
          ) {
            list.push({ collection, id: doc._id, kind: ref.kind });
          }
        }
      }
    }
    return reverse;
  }

  /**
   * Entries that refer to `targetId` through a reference field, for the
   * Lists usage counts and Claude's `get_entry`. Entries in the trash are
   * left out unless asked for.
   */
  backlinks(targetId: string, opts: { includeDeleted?: boolean } = {}): Backlink[] {
    this.reverse ??= this.buildReverse();
    return (this.reverse.get(targetId) ?? [])
      .filter((b) => b.id !== targetId)
      .filter((b) => opts.includeDeleted || !this.get(b.collection, b.id)?.deletedAt)
      .map((b) => ({ ...b }));
  }
}
