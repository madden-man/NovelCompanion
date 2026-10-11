import type { OpenBible } from '../db/session';
import type { SnapshotInfo } from '../../shared/domain/snapshots';
import { replaceBible } from './dump';
import { SnapshotError } from './snapshots';
import { importBibleJson } from './json';

/** Rebuild the read model and the search index from the database after a whole-bible change. */
export async function reloadSession(open: OpenBible, message: string): Promise<void> {
  await open.model.load(open.handle);
  open.search.rebuild(open.model);
  open.repo.announceReload(message);
}

/**
 * BK-2: restore a snapshot. The snapshot is checked first, so a bad one
 * changes nothing. A new snapshot of the current state is taken, then every
 * collection is replaced in one transaction.
 */
export async function restoreSnapshot(
  open: OpenBible,
  id: string,
): Promise<{ restored: SnapshotInfo; safety: SnapshotInfo }> {
  const service = open.snapshots;
  if (!service) throw new SnapshotError('Snapshots are not set up for this bible.');
  const data = await service.read(id);
  const safety = await service.take(
    'restore',
    `Before restoring the snapshot from ${data.manifest.takenAt}`,
  );
  await replaceBible(open.handle, data.collections, data.manifest.schemaVersion);
  await reloadSession(
    open,
    `Restored the snapshot from ${data.manifest.takenAt}. A snapshot of the earlier state was taken first.`,
  );
  return { restored: { ...data.manifest, id }, safety };
}

/** BK-3: load an exported bible file into the open bible, which must be empty. */
export async function loadBibleFile(
  open: OpenBible,
  text: string,
): Promise<Record<string, number>> {
  const docs = await importBibleJson(open.handle, text);
  await reloadSession(open, 'Loaded the bible file.');
  return Object.fromEntries(Object.entries(docs).map(([k, v]) => [k, v.length]));
}
