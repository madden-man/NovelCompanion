import { customFieldSpecs, isEntryCollection, manifests } from '../../shared/schema';
import type { CustomSection, FieldSpec } from '../../shared/schema';
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
  /** target ID to the entries that refer to it; rebuilt after a write when next asked. */
  private reverse: Map<string, { collection: string; id: string; kind: string }[]> | null = null;

  /** Load every collection of one bible (its prefixed collections only). */
  async load(bible: BibleHandle): Promise<void> {
    this.maps.clear();
    this.reverse = null;
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
    this.reverse = null;
  }

  remove(collection: string, id: string): void {
    this.maps.get(collection)?.delete(id);
    this.reverse = null;
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

  /** The specs of a custom section's own fields, for custom entries. */
  customSpecs(sectionId: string): FieldSpec[] | undefined {
    const section = this.get('customSections', sectionId) as CustomSection | undefined;
    return section ? customFieldSpecs(section) : undefined;
  }

  private buildReverse() {
    const reverse = new Map<string, { collection: string; id: string; kind: string }[]>();
    const custom = (id: string) => this.customSpecs(id);
    for (const [collection, docs] of this.maps) {
      if (!isEntryCollection(collection)) continue;
      const manifest = manifests[collection];
      for (const doc of docs.values()) {
        for (const ref of outgoingRefs(manifest, doc, custom)) {
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
   * Entries that refer to `targetId` through their links or any reference
   * field (ARCHITECTURE rule 4, ED-9). Entries in the trash are left out
   * unless asked for, so "Linked from" shows only live entries.
   */
  backlinks(targetId: string, opts: { includeDeleted?: boolean } = {}): Backlink[] {
    this.reverse ??= this.buildReverse();
    return (this.reverse.get(targetId) ?? [])
      .filter((b) => b.id !== targetId)
      .filter((b) => opts.includeDeleted || !this.get(b.collection, b.id)?.deletedAt)
      .map((b) => ({ ...b }));
  }
}
