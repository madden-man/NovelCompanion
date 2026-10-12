import { MongoMemoryReplSet } from 'mongodb-memory-server';

/** Where the run's one replica set is passed to the workers, which inherit this process's env. */
export const E2E_URI_ENV = 'NC_E2E_MONGODB_URI';

/**
 * One local MongoDB replica set for the whole end-to-end run (a replica set,
 * because the repository writes in transactions). Each spec file gets its own
 * database on it through the NOVEL_COMPANION_TEST_DB_NAME seam (`fileDb()` in
 * helpers.ts), so files stay apart while running on parallel workers. It runs
 * for a single-file run too (`npx playwright test tests/e2e/x.spec.ts`).
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const server = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
    // As in tests/helpers/mongoGlobalSetup.ts: every bible is its own set of
    // collections, and WiredTiger keeps a handle open for each one it has
    // touched. Close idle handles quickly, so a full run never hits ENFILE.
    instanceOpts: [
      {
        args: [
          '--wiredTigerEngineConfigString',
          'file_manager=(close_idle_time=2,close_scan_interval=1,close_handle_minimum=100)',
        ],
      },
    ],
  });
  process.env[E2E_URI_ENV] = server.getUri();
  return async () => {
    await server.stop();
  };
}
