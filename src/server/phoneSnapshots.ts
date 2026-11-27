import { gunzipSync, gzipSync } from 'node:zlib';
import { Binary } from 'mongodb';
import { ulid } from 'ulid';
import type { BibleHandle } from '../main/db/bibles';
import { dumpBible, replaceBible } from '../main/backup/dump';
import type { CollectionDocs } from '../main/backup/dump';
import { fromJson, toJson } from '../main/backup/snapshots';

/**
 * A58 (PH-23): the function has no disk, so its daily copy of a bible is a
 * document in this collection of `novel_companion`, beside `bibles` (ARCH-8:
 * still one database). The dump is the snapshot dump (`dumpBible`), stored as
 * gzipped extended JSON so a bible far larger than East Winds still fits in
 * one document.
 */
export const PHONE_SNAPSHOTS = 'phone_snapshots';
/** PH-23: the newest this many are kept for each bible. */
export const PHONE_SNAPSHOT_KEEP = 14;

export interface PhoneSnapshotInfo {
  _id: string;
  bible: string;
  name: string;
  /** The UTC day it was taken for, `YYYY-MM-DD`. */
  day: string;
  takenAt: string;
  /** `daily` before the first phone write of a day; `restore` before a restore replaced the bible. */
  reason: 'daily' | 'restore';
  schemaVersion: number;
  counts: Record<string, number>;
}

interface PhoneSnapshotDoc extends PhoneSnapshotInfo {
  data: Binary;
}

const snapshots = (handle: BibleHandle) => handle.db.collection<PhoneSnapshotDoc>(PHONE_SNAPSHOTS);

const utcDay = (at: Date): string => at.toISOString().slice(0, 10);

/** Dump the bible into one document, then drop the oldest beyond the keep. */
export async function takePhoneSnapshot(
  handle: BibleHandle,
  reason: PhoneSnapshotInfo['reason'],
  now: Date,
): Promise<PhoneSnapshotInfo> {
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
  const data = new Binary(gzipSync(Buffer.from(toJson(dump.collections))));
  await snapshots(handle).insertOne({ ...info, data });
  const old = await snapshots(handle)
    .find({ bible: handle.id }, { projection: { _id: 1 } })
    .sort({ takenAt: -1, _id: -1 })
    .skip(PHONE_SNAPSHOT_KEEP)
    .toArray();
  if (old.length) await snapshots(handle).deleteMany({ _id: { $in: old.map((d) => d._id) } });
  return info;
}

/**
 * PH-23: before the first phone write of a UTC day, a full dump of the bible.
 * Later writes that day take none. True when one was taken now.
 */
export async function takeDailyPhoneSnapshot(handle: BibleHandle, now: Date): Promise<boolean> {
  const taken = await snapshots(handle).findOne(
    { bible: handle.id, day: utcDay(now), reason: 'daily' },
    { projection: { _id: 1 } },
  );
  if (taken) return false;
  await takePhoneSnapshot(handle, 'daily', now);
  return true;
}

/** The bible's phone snapshots, newest first, without their data. */
export async function listPhoneSnapshots(handle: BibleHandle): Promise<PhoneSnapshotInfo[]> {
  return snapshots(handle)
    .find({ bible: handle.id }, { projection: { data: 0 } })
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
  const collections = fromJson(gunzipSync(doc.data.buffer).toString('utf8')) as CollectionDocs;
  const safety = await takePhoneSnapshot(handle, 'restore', now);
  await replaceBible(handle, collections, doc.schemaVersion);
  const { data: _data, ...restored } = doc;
  return { restored, safety };
}
