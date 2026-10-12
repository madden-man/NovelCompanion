import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BSON } from 'mongodb';
import type { Document } from 'mongodb';
import { COLLECTION_FILE, SnapshotManifest, snapshotsToPrune } from '../../shared/domain/snapshots';
import type { SnapshotInfo, SnapshotReason } from '../../shared/domain/snapshots';
import { LATEST_SCHEMA_VERSION } from '../db/migrations';
import type { BibleHandle } from '../db/bibles';
import { dumpBible } from './dump';
import type { CollectionDocs } from './dump';

export class SnapshotError extends Error {
  override name = 'SnapshotError';
}

export interface SnapshotData {
  manifest: SnapshotManifest;
  collections: CollectionDocs;
}

/** Documents as JSON text that keeps every BSON type exactly (relaxed extended JSON). */
export const toJson = (docs: unknown): string =>
  BSON.EJSON.stringify(docs as Document, { relaxed: true });
export const fromJson = (text: string): unknown => BSON.EJSON.parse(text, { relaxed: true });

/**
 * Local snapshots of one bible (BK-1, BK-2): a folder per snapshot under
 * `<root>/<bibleId>/<ISO timestamp>/` holding one JSON file per collection and
 * a `manifest.json`.
 */
export class SnapshotService {
  constructor(
    private readonly handle: BibleHandle,
    private readonly root: string,
    private readonly keep: () => number = () => 30,
    private readonly now: () => Date = () => new Date(),
  ) {}

  get folder(): string {
    return join(this.root, this.handle.id);
  }

  /** Dump every collection to a new snapshot folder, then drop the oldest beyond the limit. */
  async take(reason: SnapshotReason, label = ''): Promise<SnapshotInfo> {
    const dump = await dumpBible(this.handle);
    await mkdir(this.folder, { recursive: true });
    let at = this.now();
    const taken = new Set(await this.folders());
    while (taken.has(at.toISOString())) at = new Date(at.getTime() + 1);
    const id = at.toISOString();
    const manifest: SnapshotManifest = {
      format: 'novel-companion-snapshot',
      version: 1,
      bible: this.handle.id,
      name: dump.bible.name,
      createdAt: dump.bible.createdAt,
      takenAt: id,
      reason,
      label,
      schemaVersion: dump.bible.schemaVersion,
      counts: Object.fromEntries(Object.entries(dump.collections).map(([k, v]) => [k, v.length])),
    };
    // Write beside the final folder and rename, so a crash never leaves a half snapshot that looks whole.
    const partial = join(this.folder, `${id}.partial`);
    await rm(partial, { recursive: true, force: true });
    await mkdir(partial, { recursive: true });
    for (const [name, docs] of Object.entries(dump.collections)) {
      await writeFile(join(partial, `${name}.json`), toJson(docs));
    }
    await writeFile(join(partial, 'manifest.json'), JSON.stringify(manifest, null, 2));
    await rename(partial, join(this.folder, id));
    await this.prune();
    return { ...manifest, id };
  }

  private async folders(): Promise<string[]> {
    try {
      return (await readdir(this.folder)).filter((n) => !n.endsWith('.partial'));
    } catch {
      return [];
    }
  }

  /** Snapshots with a readable manifest, newest first. */
  async list(): Promise<SnapshotInfo[]> {
    const out: SnapshotInfo[] = [];
    for (const id of await this.folders()) {
      try {
        const text = await readFile(join(this.folder, id, 'manifest.json'), 'utf8');
        const parsed = SnapshotManifest.safeParse(JSON.parse(text));
        if (parsed.success) out.push({ ...parsed.data, id });
      } catch {
        // A folder without a manifest is not a snapshot.
      }
    }
    return out.sort((a, b) => b.takenAt.localeCompare(a.takenAt));
  }

  async prune(): Promise<number> {
    const stale = snapshotsToPrune(await this.list(), this.keep());
    for (const s of stale) await rm(join(this.folder, s.id), { recursive: true, force: true });
    return stale.length;
  }

  /**
   * Read a snapshot and check it before anything uses it (BK-2): the manifest
   * is valid, belongs to this bible, is not from a newer app, and every
   * collection file is there with the document count the manifest states.
   */
  async read(id: string): Promise<SnapshotData> {
    if (!/^[0-9T:.\-Z]+$/.test(id)) throw new SnapshotError('That is not a snapshot.');
    const dir = join(this.folder, id);
    let manifestText: string;
    try {
      manifestText = await readFile(join(dir, 'manifest.json'), 'utf8');
    } catch {
      throw new SnapshotError('The snapshot has no manifest, so it was not restored.');
    }
    let parsed: ReturnType<typeof SnapshotManifest.safeParse>;
    try {
      parsed = SnapshotManifest.safeParse(JSON.parse(manifestText));
    } catch {
      throw new SnapshotError('The snapshot manifest is not readable, so it was not restored.');
    }
    if (!parsed.success) {
      throw new SnapshotError('The snapshot manifest is not valid, so it was not restored.');
    }
    const manifest = parsed.data;
    if (manifest.bible !== this.handle.id) {
      throw new SnapshotError(`This snapshot belongs to the bible "${manifest.bible}".`);
    }
    if (manifest.schemaVersion > LATEST_SCHEMA_VERSION) {
      throw new SnapshotError(
        'This snapshot is from a newer version of the app. Update the app first.',
      );
    }
    const collections: CollectionDocs = {};
    for (const [name, count] of Object.entries(manifest.counts)) {
      if (!COLLECTION_FILE.test(name)) {
        throw new SnapshotError(`The snapshot lists a collection with an unusable name: ${name}.`);
      }
      let docs: unknown;
      try {
        docs = fromJson(await readFile(join(dir, `${name}.json`), 'utf8'));
      } catch {
        throw new SnapshotError(
          `The snapshot is missing or cannot read ${name}.json, so it was not restored.`,
        );
      }
      if (!Array.isArray(docs) || docs.length !== count) {
        throw new SnapshotError(
          `${name}.json does not match the manifest (${count} documents expected), so the snapshot was not restored.`,
        );
      }
      if (!docs.every((d) => typeof d === 'object' && d !== null && '_id' in d)) {
        throw new SnapshotError(
          `${name}.json has a document with no ID, so the snapshot was not restored.`,
        );
      }
      collections[name] = docs as Document[];
    }
    return { manifest, collections };
  }
}
