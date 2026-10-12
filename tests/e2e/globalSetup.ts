import { startTestMongo } from '../helpers/testMongo';

/** Where the run's one replica set is passed to the workers, which inherit this process's env. */
export const E2E_URI_ENV = 'NC_E2E_MONGODB_URI';

/**
 * One local MongoDB replica set for the whole end-to-end run
 * (`startTestMongo()`, as the integration suite uses). Each spec file gets its
 * own database on it through the NOVEL_COMPANION_TEST_DB_NAME seam (`fileDb()`
 * in helpers.ts), so files stay apart while running on parallel workers. It
 * runs for a single-file run too (`npx playwright test tests/e2e/x.spec.ts`).
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const server = await startTestMongo();
  process.env[E2E_URI_ENV] = server.uri;
  return () => server.stop();
}
