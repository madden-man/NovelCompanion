import { z } from 'zod';
import { BSON } from 'mongodb';
import type { Document } from 'mongodb';
import { COLLECTION_FILE } from '../../shared/domain/snapshots';
import { configSchemas, entrySchemas, isEntryCollection } from '../../shared/schema';
import { LATEST_SCHEMA_VERSION } from '../db/migrations';
import type { BibleHandle } from '../db/bibles';
import { dumpBible, replaceBible } from './dump';
import type { CollectionDocs } from './dump';

export class BibleFileError extends Error {
  override name = 'BibleFileError';
}

/** The one JSON file a whole bible exports to (BK-3). */
export const BibleFile = z.strictObject({
  format: z.literal('novel-companion-bible'),
  version: z.literal(1),
  exportedAt: z.iso.datetime({ offset: true }),
  bible: z.strictObject({
    id: z.string().min(1),
    name: z.string().min(1),
    createdAt: z.string(),
    schemaVersion: z.int().min(0),
  }),
  collections: z.record(z.string(), z.array(z.looseObject({ _id: z.unknown() }))),
});
export type BibleFile = z.infer<typeof BibleFile>;

export interface BibleExport {
  text: string;
  counts: Record<string, number>;
}

/** Every collection of a bible, revisions and settings included, as one JSON text. */
export async function exportBibleJson(
  handle: BibleHandle,
  now: Date = new Date(),
): Promise<BibleExport> {
  const dump = await dumpBible(handle);
  const file = {
    format: 'novel-companion-bible' as const,
    version: 1 as const,
    exportedAt: now.toISOString(),
    bible: dump.bible,
    collections: dump.collections,
  };
  return {
    text: BSON.EJSON.stringify(file as unknown as Document, { relaxed: true }),
    counts: Object.fromEntries(Object.entries(dump.collections).map(([k, v]) => [k, v.length])),
  };
}

/** Every entry and settings document of the current schema, checked one by one (BK-3). */
function validateCollections(collections: Record<string, Record<string, unknown>[]>): void {
  // a47-model (IP-9): a status or provenance must be an item of the file's own list.
  const itemIds = (listId: string) => {
    const list = (collections.lists ?? []).find((l) => l._id === listId);
    const items = Array.isArray(list?.items) ? (list.items as { id?: unknown }[]) : null;
    return items ? new Set(items.map((i) => i.id)) : null;
  };
  const vocab: [string, Set<unknown> | null][] = [
    ['status', itemIds('statuses')],
    ['provenance', itemIds('provenance')],
  ];
  for (const [name, docs] of Object.entries(collections)) {
    const schema = isEntryCollection(name)
      ? entrySchemas[name]
      : Object.hasOwn(configSchemas, name)
        ? configSchemas[name as keyof typeof configSchemas]
        : null;
    if (!schema) continue;
    for (const doc of docs) {
      const r = schema.safeParse(doc);
      if (!r.success) {
        throw new BibleFileError(
          `The entry ${String(doc._id)} in ${name} is not valid, so nothing was imported: ${z.prettifyError(r.error)}`,
        );
      }
      for (const [field, ids] of isEntryCollection(name) ? vocab : []) {
        const v = doc[field];
        if (ids && typeof v === 'string' && !ids.has(v)) {
          throw new BibleFileError(
            `The entry ${String(doc._id)} in ${name} is not valid, so nothing was imported: ${field} ${v} is not in the list.`,
          );
        }
      }
    }
  }
}

/** What the file says, checked completely before anything is written (BK-3). */
export function readBibleFile(text: string): BibleFile {
  let raw: unknown;
  try {
    raw = BSON.EJSON.parse(text, { relaxed: true });
  } catch {
    throw new BibleFileError('That file is not a bible export. It is not valid JSON.');
  }
  const parsed = BibleFile.safeParse(raw);
  if (!parsed.success) {
    throw new BibleFileError('That file is not a bible export from this app.');
  }
  const file = parsed.data;
  if (file.bible.schemaVersion > LATEST_SCHEMA_VERSION) {
    throw new BibleFileError('That file is from a newer version of the app. Update the app first.');
  }
  for (const name of Object.keys(file.collections)) {
    if (!COLLECTION_FILE.test(name)) {
      throw new BibleFileError(`The file has a collection with an unusable name: ${name}.`);
    }
  }
  // Entries of the current schema are checked now; older files are checked after they are migrated.
  if (file.bible.schemaVersion === LATEST_SCHEMA_VERSION) {
    validateCollections(file.collections as Record<string, Record<string, unknown>[]>);
  }
  return file;
}

/** True when a bible holds no entries, history, or proposals. Lists and settings may exist. */
export async function isEmptyBible(handle: BibleHandle): Promise<boolean> {
  for (const name of await handle.collectionNames()) {
    if (name === 'lists' || name === 'meta') continue;
    if ((await handle.collection(name).estimatedDocumentCount()) > 0) return false;
  }
  return true;
}

/**
 * Load an exported bible into an empty one: every entry, link, revision, list,
 * and setting, identical (BK-3). All or nothing.
 */
export async function importBibleJson(handle: BibleHandle, text: string): Promise<CollectionDocs> {
  const file = readBibleFile(text);
  if (!(await isEmptyBible(handle))) {
    throw new BibleFileError('Import into an empty bible. This one already has entries.');
  }
  if (file.bible.schemaVersion === LATEST_SCHEMA_VERSION) {
    await replaceBible(handle, file.collections as CollectionDocs, file.bible.schemaVersion);
    return file.collections as CollectionDocs;
  }
  // An older file is migrated by the app's own migrations, then every document is checked against
  // the current schemas. A document the migration left invalid puts the bible back as it was.
  const before = await dumpBible(handle);
  await replaceBible(handle, file.collections as CollectionDocs, file.bible.schemaVersion);
  const after = await dumpBible(handle);
  try {
    validateCollections(after.collections as Record<string, Record<string, unknown>[]>);
  } catch (e) {
    await replaceBible(handle, before.collections, before.bible.schemaVersion);
    throw e;
  }
  return after.collections as CollectionDocs;
}
