import { ReadModel } from '../readmodel';
import { SearchIndex } from '../search';
import { createBible, migrate, openBible, schemaVersion } from './bibles';
import { LATEST_SCHEMA_VERSION } from './migrations';
import { needsDailySnapshot } from '../../shared/domain/snapshots';
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
  /**
   * The first-open-of-the-day snapshot (BK-1), taken after the bible opens so
   * it never holds up launch (NF-1). Always resolves; a failure is ignored.
   */
  dailySnapshot?: Promise<void>;
}

export interface SessionOptions {
  /** Where snapshots go: `<root>/<bibleId>/<ISO time>/`. */
  snapshotRoot?: string;
  repository?: RepositoryOptions;
  now?: () => Date;
  /**
   * Open without changing anything on the cluster: when the bible has
   * migrations pending, stop with a plain message instead of running them.
   */
  readOnly?: boolean;
}

/** Open a bible, bring its schema up to date, and load the read model and index. */
export async function openBibleSession(
  store: Store,
  id: string,
  options: SessionOptions = {},
): Promise<OpenBible> {
  const handle = await openBible(store, id);
  if (options.readOnly) {
    const have = await schemaVersion(handle);
    if (have < LATEST_SCHEMA_VERSION) {
      const pending = LATEST_SCHEMA_VERSION - have;
      throw new Error(
        `The bible "${id}" has ${pending} ${pending === 1 ? 'migration' : 'migrations'} pending (it is at version ${have}; this app needs ${LATEST_SCHEMA_VERSION}). A dry run never migrates a bible, so it stopped. Open the bible in the app to bring it up to date, then run the dry run again.`,
      );
    }
  } else {
    await migrate(handle);
  }
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

/**
 * Open a bible as the app does (BK-1): bring it up to date, and take a
 * snapshot when none has been taken today. The snapshot is written after the
 * bible is open, in the background (`dailySnapshot`), because dumping 5,000
 * entries to disk took longer than the rest of opening (NF-1). A failed
 * snapshot never blocks opening.
 */
export async function openBibleForApp(
  store: Store,
  id: string,
  options: SessionOptions,
): Promise<OpenBible> {
  const session = await openBibleSession(store, id, options);
  session.dailySnapshot = (async () => {
    try {
      if (
        session.snapshots &&
        needsDailySnapshot(await session.snapshots.list(), (options.now ?? (() => new Date()))())
      ) {
        await session.snapshots.take('daily');
      }
    } catch {
      // The person can still take one on request.
    }
  })();
  return session;
}
