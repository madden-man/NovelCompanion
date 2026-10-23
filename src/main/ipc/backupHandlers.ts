import { writeFile, readFile } from 'node:fs/promises';
import { createBible, dropBible } from '../db/bibles';
import type { OpenBible } from '../db/session';
import { exportBibleJson, importBibleJson, readBibleFile } from '../backup/json';
import { restoreSnapshot } from '../backup/restore';
import type { Channel } from '../../shared/ipc';
import type { Handler } from './validate';

/** What the snapshot and backup channels need from the host, so tests can supply their own. */
export interface BackupDeps {
  /** Ask where to write the export. Null when cancelled. */
  pickSavePath?: (defaultName: string) => Promise<string | null>;
  /** Ask for an exported bible file to read. Null when cancelled. */
  pickBibleFile?: () => Promise<string | null>;
}

export type BackupChannel =
  | 'snapshot.list'
  | 'snapshot.take'
  | 'snapshot.restore'
  | 'snapshot.keep'
  | 'backup.export'
  | 'backup.import';

export type BackupHandlers = { [C in BackupChannel]: Handler<C & Channel> };

const NO_BIBLE = 'Open a bible first.';

export function backupHandlers(current: () => OpenBible | null, deps: BackupDeps): BackupHandlers {
  const session = (): OpenBible => {
    const s = current();
    if (!s) throw new Error(NO_BIBLE);
    return s;
  };
  return {
    'snapshot.list': async () => {
      const s = session();
      return { snapshots: (await s.snapshots?.list()) ?? [], keep: s.repo.snapshotKeep() };
    },

    'snapshot.take': async () => {
      const s = session();
      if (!s.snapshots) throw new Error('Snapshots are not set up for this bible.');
      return { snapshot: await s.snapshots.take('manual') };
    },

    'snapshot.restore': async ({ id }) => {
      return restoreSnapshot(session(), id);
    },

    'snapshot.keep': async ({ keep }) => {
      const s = session();
      const saved = await s.repo.setSnapshotKeep(keep);
      await s.snapshots?.prune();
      return { keep: saved };
    },

    'backup.export': async () => {
      const s = session();
      const { text, counts } = await exportBibleJson(s.handle);
      const stamp = new Date().toISOString().slice(0, 10);
      const path = await deps.pickSavePath?.(`${s.handle.id}-${stamp}.json`);
      if (!path) return { path: null, counts: {} };
      await writeFile(path, text);
      return { path, counts };
    },

    'backup.import': async ({ slug, name }) => {
      const s = session();
      const path = await deps.pickBibleFile?.();
      if (!path) return { bible: null, counts: {} };
      const text = await readFile(path, 'utf8');
      const store = { client: s.handle.client, db: s.handle.db, close: async () => undefined };
      // Check the file completely before making the bible, so a bad file leaves nothing behind.
      readBibleFile(text);
      const handle = await createBible(store, slug, name);
      try {
        const docs = await importBibleJson(handle, text);
        return {
          bible: { id: slug, name },
          counts: Object.fromEntries(Object.entries(docs).map(([k, v]) => [k, v.length])),
        };
      } catch (e) {
        await dropBible(store, slug).catch(() => undefined);
        throw e;
      }
    },
  };
}
