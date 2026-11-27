import { gunzipSync, gzipSync } from 'node:zlib';
import { Binary } from 'mongodb';
import { ulid } from 'ulid';
import type { BibleHandle } from '../main/db/bibles';
import { dumpBible, replaceBible } from '../main/backup/dump';
import type { CollectionDocs } from '../main/backup/dump';
import { fromJson, toJson } from '../main/backup/snapshots';

/**
 * A58 (PH-23): the function has no disk, so its copy of a bible is a document
 * in this collection of `novel_companion`, beside `bibles` (ARCH-8: still one
 * database). The dump is the snapshot dump (`dumpBible`), stored as gzipped
 * extended JSON. A dump too large for one document (MongoDB's 16 MB limit) is
 * split into parts in `PHONE_SNAPSHOT_PARTS`, so a large bible never stops
 * phone writes.
 */
export const PHONE_SNAPSHOTS = 'phone_snapshots';
/** The parts of a dump too large for its snapshot document, in order. */
export const PHONE_SNAPSHOT_PARTS = 'phone_snapshot_parts';
/** PH-23: the newest this many daily snapshots are kept for each bible. */
export const PHONE_SNAPSHOT_KEEP = 14;
/** The newest this many `restore` and this many `bulk` snapshots are kept, apart from the daily ones. */
export const PHONE_SNAPSHOT_KEEP_OTHER = 5;
/** Data up to this size stays in the snapshot document; larger is split into parts of this size. */
export const PHONE_SNAPSHOT_PART_BYTES = 8 * 1024 * 1024;

export interface PhoneSnapshotInfo {
  _id: string;
  bible: string;
  name: string;
  /** The UTC day it was taken for, `YYYY-MM-DD`. */
  day: string;
  takenAt: string;
  /**
   * `daily` before the first phone write of a day; `restore` before a restore
   * replaced the bible; `bulk` before a bulk change from the phone (BK-1).
   */
  reason: 'daily' | 'restore' | 'bulk';
  schemaVersion: number;
  counts: Record<string, number>;
}

interface PhoneSnapshotDoc extends PhoneSnapshotInfo {
  /** The gzipped dump, or absent when it is split into `parts` parts. */
  data?: Binary;
  parts?: number;
}

interface PhoneSnapshotPart {
  _id: string;
  snapshot: string;
  n: number;
  data: Binary;
}

const snapshots = (handle: BibleHandle) => handle.db.collection<PhoneSnapshotDoc>(PHONE_SNAPSHOTS);
const parts = (handle: BibleHandle) =>
  handle.db.collection<PhoneSnapshotPart>(PHONE_SNAPSHOT_PARTS);

const utcDay = (at: Date): string => at.toISOString().slice(0, 10);

const DUPLICATE_KEY = 11000;
const isDuplicate = (e: unknown): boolean =>
  (e as { code?: unknown } | null)?.code === DUPLICATE_KEY;

/** One daily snapshot per bible and UTC day, held by MongoDB, so two warm instances never both take one. */
const indexed = new WeakMap<object, Promise<unknown>>();
function ensureIndexes(handle: BibleHandle): Promise<unknown> {
  let p = indexed.get(handle.db);
  if (!p) {
    p = Promise.all([
      snapshots(handle).createIndex(
        { bible: 1, day: 1 },
        { name: 'one_daily', unique: true, partialFilterExpression: { reason: 'daily' } },
      ),
      parts(handle).createIndex({ snapshot: 1, n: 1 }, { name: 'by_snapshot' }),
    ]).catch((e: unknown) => {
      // Never a reason to refuse a write: without the index the check before the insert still holds.
      console.error('Novel Companion phone snapshot index:', e);
    });
    indexed.set(handle.db, p);
  }
  return p;
}

/** Dump the bible into one document (or a document and its parts), then drop the oldest beyond the keep. */
export async function takePhoneSnapshot(
  handle: BibleHandle,
  reason: PhoneSnapshotInfo['reason'],
  now: Date,
  partBytes: number = PHONE_SNAPSHOT_PART_BYTES,
): Promise<PhoneSnapshotInfo> {
  await ensureIndexes(handle);
  const dump = await dumpBible(handle);
  const info: PhoneSnapshotInfo = {
    _id: ulid(now.getTime()),
    bible: handle.id,
    name: dump.bible.name,
    day: utcDay(now),
    takenAt: now.toISOString(),
    reason,
    schemaVersion: dump.bible.schemaVersion,
    counts: Object.fromEntries(Object.entries(dump.collections).map(([k, v]) => [k, v.length])),
  };
  const gz = gzipSync(Buffer.from(toJson(dump.collections)));
  if (gz.length <= partBytes) {
    await snapshots(handle).insertOne({ ...info, data: new Binary(gz) });
  } else {
    // The parts first, then the document that names them; a refused document takes its parts with it.
    const count = Math.ceil(gz.length / partBytes);
    for (let n = 0; n < count; n++) {
      await parts(handle).insertOne({
        _id: `${info._id}:${n}`,
        snapshot: info._id,
        n,
        data: new Binary(gz.subarray(n * partBytes, (n + 1) * partBytes)),
      });
    }
    try {
      await snapshots(handle).insertOne({ ...info, parts: count });
    } catch (e) {
      await parts(handle).deleteMany({ snapshot: info._id });
      throw e;
    }
  }
  await prune(handle);
  return info;
}

/** Keep the newest daily snapshots and, apart from them, the newest few of each other kind. */
async function prune(handle: BibleHandle): Promise<void> {
  const keep: Record<PhoneSnapshotInfo['reason'], number> = {
    daily: PHONE_SNAPSHOT_KEEP,
    restore: PHONE_SNAPSHOT_KEEP_OTHER,
    bulk: PHONE_SNAPSHOT_KEEP_OTHER,
  };
  for (const [reason, n] of Object.entries(keep)) {
    const old = await snapshots(handle)
      .find({ bible: handle.id, reason } as never, { projection: { _id: 1 } })
      .sort({ takenAt: -1, _id: -1 })
      .skip(n)
      .toArray();
    if (!old.length) continue;
    const ids = old.map((d) => d._id);
    await snapshots(handle).deleteMany({ _id: { $in: ids } });
    await parts(handle).deleteMany({ snapshot: { $in: ids } });
  }
}

/**
 * PH-23: before the first phone write of a UTC day, a full dump of the bible.
 * Later writes that day take none, and of two instances racing for the same
 * day only one keeps its dump. True when one was taken now.
 */
export async function takeDailyPhoneSnapshot(handle: BibleHandle, now: Date): Promise<boolean> {
  const taken = await snapshots(handle).findOne(
    { bible: handle.id, day: utcDay(now), reason: 'daily' },
    { projection: { _id: 1 } },
  );
  if (taken) return false;
  try {
    await takePhoneSnapshot(handle, 'daily', now);
    return true;
  } catch (e) {
    if (isDuplicate(e)) return false;
    throw e;
  }
}

/** The bible's phone snapshots, newest first, without their data. */
export async function listPhoneSnapshots(handle: BibleHandle): Promise<PhoneSnapshotInfo[]> {
  return snapshots(handle)
    .find({ bible: handle.id }, { projection: { data: 0, parts: 0 } })
    .sort({ takenAt: -1, _id: -1 })
    .toArray();
}

/**
 * BK-2 for a phone snapshot: a `restore` snapshot of the bible as it is now is
 * taken first, then every collection is replaced in one transaction by the
 * snapshot restore (`replaceBible`), which migrates it up to date. Runs on
 * the desk (`scripts/restore-phone-snapshot.ts`), never in the function.
 */
export async function restorePhoneSnapshot(
  handle: BibleHandle,
  id: string,
  now: Date = new Date(),
): Promise<{ restored: PhoneSnapshotInfo; safety: PhoneSnapshotInfo }> {
  const doc = await snapshots(handle).findOne({ _id: id, bible: handle.id });
  if (!doc) throw new Error(`There is no phone snapshot ${id} of ${handle.id}.`);
  const gz = await snapshotData(handle, doc);
  const collections = fromJson(gunzipSync(gz).toString('utf8')) as CollectionDocs;
  const safety = await takePhoneSnapshot(handle, 'restore', now);
  await replaceBible(handle, collections, doc.schemaVersion);
  const { data: _data, parts: _parts, ...restored } = doc;
  return { restored, safety };
}

/** The gzipped dump of a snapshot, from its document or put together from its parts. */
async function snapshotData(handle: BibleHandle, doc: PhoneSnapshotDoc): Promise<Buffer> {
  if (doc.data) return Buffer.from(doc.data.buffer);
  const found = await parts(handle).find({ snapshot: doc._id }).sort({ n: 1 }).toArray();
  if (found.length !== doc.parts) {
    throw new Error(
      `Phone snapshot ${doc._id} is missing some of its parts, so it cannot be restored.`,
    );
  }
  return Buffer.concat(found.map((p) => Buffer.from(p.data.buffer)));
}
