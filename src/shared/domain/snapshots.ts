import { z } from 'zod';

export const SNAPSHOT_REASONS = ['daily', 'manual', 'import', 'restore', 'bulk'] as const;
export type SnapshotReason = (typeof SNAPSHOT_REASONS)[number];

export const SNAPSHOT_REASON_LABELS: Record<SnapshotReason, string> = {
  daily: 'First launch of the day',
  manual: 'Taken on request',
  import: 'Before an import',
  restore: 'Before a restore',
  bulk: 'Before a bulk change',
};

/** `manifest.json` of a snapshot (BK-1): what was dumped, when, why, and the schema version. */
export const SnapshotManifest = z.strictObject({
  format: z.literal('novel-companion-snapshot'),
  version: z.literal(1),
  bible: z.string().min(1),
  takenAt: z.iso.datetime({ offset: true }),
  reason: z.enum(SNAPSHOT_REASONS),
  /** What triggered it, in plain words, such as "list rename". */
  label: z.string().default(''),
  schemaVersion: z.int().min(0),
  /** The number of documents in each collection file. */
  counts: z.record(z.string().min(1), z.int().min(0)),
});
export type SnapshotManifest = z.infer<typeof SnapshotManifest>;

/** Collection names are safe file names: letters, digits, dashes, underscores. */
export const COLLECTION_FILE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

export interface SnapshotInfo extends SnapshotManifest {
  /** The folder name under the bible's snapshot folder: the ISO time it was taken. */
  id: string;
}

/** The day, in local time, as YYYY-MM-DD. */
export function localDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** BK-1: the first launch of the day takes a snapshot; later launches that day do not. */
export function needsDailySnapshot(
  existing: { takenAt: string; reason: string }[],
  now: Date,
): boolean {
  const today = localDay(now);
  return !existing.some((s) => s.reason === 'daily' && localDay(new Date(s.takenAt)) === today);
}

/** The snapshots to delete so that only the newest `keep` remain (BK-1). */
export function snapshotsToPrune<T extends { id: string }>(newestFirst: T[], keep: number): T[] {
  return newestFirst.slice(Math.max(1, keep));
}
