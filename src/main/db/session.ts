import { ReadModel } from '../readmodel';
import { SearchIndex } from '../search';
import { createBible, migrate, openBible, schemaVersion } from './bibles';
import { LATEST_SCHEMA_VERSION } from './migrations';
import {
  MIGRATION10_SNAPSHOT_LABEL,
  MIGRATION11_SNAPSHOT_LABEL,
  MIGRATION9_SNAPSHOT_LABEL,
  needsDailySnapshot,
} from '../../shared/domain/snapshots';
import type { BibleHandle } from './bibles';
import type { Store } from './connection';
import { Repository } from './repository';
import type { RepositoryOptions } from './repository';
import { SnapshotService } from '../backup/snapshots';

/** The schema version of migration 9 (A39), the one that drops collections. */
const SIMPLIFIED_MODEL_VERSION = 9;
/** The schema version of migration 10 (A44), the one that rewrites long text as Markdown. */
const MARKDOWN_TEXT_VERSION = 10;
/** The schema version of migration 11 (A47), the one that turns regions and family colours into list IDs and hex. */
const VOCABULARY_VERSION = 11;

/** The bible's snapshot keep setting (BK-1), read straight from `meta` before the read model exists. */
async function storedSnapshotKeep(handle: BibleHandle): Promise<number> {
  const doc = await handle
    .collection<{ _id: string; keep?: unknown }>('meta')
    .findOne({ _id: 'snapshotSettings' });
  return typeof doc?.keep === 'number' && doc.keep >= 1 ? Math.floor(doc.keep) : 30;
}

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
    // SM-2: migration 9 drops whole collections, A44: migration 10 rewrites every long
    // text, and A47: migration 11 rewrites regions and family colours, so the bible is
    // snapshotted as it is first. One snapshot covers them all.
    const have = options.snapshotRoot ? await schemaVersion(handle) : LATEST_SCHEMA_VERSION;
    if (options.snapshotRoot && have < VOCABULARY_VERSION) {
      // A migration snapshot is never pruned; the keep setting applies to the others.
      const keep = await storedSnapshotKeep(handle);
      const before = new SnapshotService(handle, options.snapshotRoot, () => keep, options.now);
      await before.take(
        'migration',
        have < SIMPLIFIED_MODEL_VERSION
          ? MIGRATION9_SNAPSHOT_LABEL
          : have < MARKDOWN_TEXT_VERSION
            ? MIGRATION10_SNAPSHOT_LABEL
            : MIGRATION11_SNAPSHOT_LABEL,
      );
    }
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
  /** IP-12: the default eras to copy (the open bible's, edited in Settings); the seeded ones when absent. */
  eraDefaults?: readonly { name: string; startYear: number; endYear: number }[],
): Promise<OpenBible> {
  await createBible(store, id, name);
  const session = await openBibleSession(store, id);
  if (eraDefaults) await session.repo.setEraDefaults(eraDefaults);
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
