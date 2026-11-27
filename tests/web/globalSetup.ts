import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { startTestMongo } from '../helpers/testMongo';
import { E2E_URI_ENV } from '../e2e/globalSetup';
import { WEB_URI_ENV } from './server';

/**
 * A58 P4: the phone client's run. Builds `dist/web` (a few seconds), then
 * starts one local replica set; each spec file seeds the fixture novel into
 * its own database and starts `scripts/serve-web.ts` on it. The PH-38 spec
 * also launches the Electron app on the same database, so the address is
 * passed under the end-to-end name too.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  execFileSync('npm', ['run', 'build:web'], {
    cwd: join(import.meta.dirname, '../..'),
    stdio: 'inherit',
  });
  const server = await startTestMongo();
  process.env[WEB_URI_ENV] = server.uri;
  process.env[E2E_URI_ENV] = server.uri;
  return () => server.stop();
}
