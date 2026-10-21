import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { startTestMongo } from '../helpers/testMongo';

/** Where the run's one replica set is passed to the workers, which inherit this process's env. */
export const E2E_URI_ENV = 'NC_E2E_MONGODB_URI';

/**
 * Refuse to run against a half-installed Electron. While `npm install` is
 * still unpacking it, the binary exists but its framework does not, and every
 * launch dies in dyld with "Library missing", one macOS crash report and one
 * "Electron quit unexpectedly" dialog per test. One clear error instead.
 */
export function assertElectronInstalled(): void {
  const binary = createRequire(import.meta.url)('electron') as string;
  const needed = [binary];
  if (process.platform === 'darwin') {
    needed.push(join(binary, '../../Frameworks/Electron Framework.framework/Electron Framework'));
  }
  const missing = needed.filter((path) => !existsSync(path));
  if (missing.length > 0) {
    throw new Error(
      `Electron is not fully installed (missing ${missing.join(', ')}). ` +
        'Wait for npm install to finish, or run `node node_modules/electron/install.js`.',
    );
  }
}

/**
 * One local MongoDB replica set for the whole end-to-end run
 * (`startTestMongo()`, as the integration suite uses). Each spec file gets its
 * own database on it through the NOVEL_COMPANION_TEST_DB_NAME seam (`fileDb()`
 * in helpers.ts), so files stay apart while running on parallel workers. It
 * runs for a single-file run too (`npx playwright test tests/e2e/x.spec.ts`).
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  assertElectronInstalled();
  const server = await startTestMongo();
  process.env[E2E_URI_ENV] = server.uri;
  return () => server.stop();
}
