import { ReadModel } from '../readmodel';
import { SearchIndex } from '../search';
import { createBible, migrate, openBible } from './bibles';
import type { BibleHandle } from './bibles';
import type { Store } from './connection';
import { Repository } from './repository';
import type { RepositoryOptions } from './repository';
import { SnapshotService } from '../backup/snapshots';

/** An open bible: its handle, read model, search index, and the write path. */
export interface OpenBible {
  handle: BibleHandle;
  model: ReadModel;
  search: SearchIndex;
  repo: Repository;
  /** Local snapshots (BK-1); absent when the host gave no folder for them. */
  snapshots?: SnapshotService;
}

export interface SessionOptions {
  /** Where snapshots go: `<root>/<bibleId>/<ISO time>/`. */
  snapshotRoot?: string;
  repository?: RepositoryOptions;
  now?: () => Date;
}

/** Open a bible, bring its schema up to date, and load the read model and index. */
export async function openBibleSession(
  store: Store,
  id: string,
  options: SessionOptions = {},
): Promise<OpenBible> {
  const handle = await openBible(store, id);
  await migrate(handle);
  const model = new ReadModel();
  await model.load(handle);
  const search = new SearchIndex();
  search.rebuild(model);
  const repo = new Repository(handle, model, search, options.now, options.repository);
  const open: OpenBible = { handle, model, search, repo };
  if (options.snapshotRoot) {
    const snapshots = new SnapshotService(
      handle,
      options.snapshotRoot,
      () => repo.snapshotKeep(),
      options.now,
    );
    open.snapshots = snapshots;
    // BK-1: a snapshot before every bulk change.
    repo.beforeBulk = async (reason) => {
      await snapshots.take(reason === 'import' ? 'import' : 'bulk', reason);
    };
  }
  return open;
}

/**
 * Make a new bible as the app does (ARCH-8): register it, migrate it, and
 * seed its default eras through the write path (WE-2). Returns the open session.
 */
export async function createBibleWithDefaults(
  store: Store,
  id: string,
  name: string,
): Promise<OpenBible> {
  await createBible(store, id, name);
  const session = await openBibleSession(store, id);
  await session.repo.seedDefaultEras();
  return session;
}
