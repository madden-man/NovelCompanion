import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type * as ServerModule from '../src/server/index';
import { importSource } from './import-source.ts';

/**
 * A58: the hosted function on a local port, for development and tests. `/rpc`
 * is the same handler `netlify/functions/rpc.mts` wraps, one request at a time;
 * anything else is the web build in `dist/web` when it exists (or `--static`).
 *
 *   NC_PHONE_KEY=... NC_MONGODB_URI=mongodb://127.0.0.1:27017 node scripts/serve-web.ts --port 8787
 *
 * Tests may pass the local replica set through the test seam instead
 * (NOVEL_COMPANION_TEST_MONGODB_URI with NOVEL_COMPANION_ALLOW_TEST_URI=1).
 */
const ROOT = join(import.meta.dirname, '..');
const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '8787' },
    host: { type: 'string', default: '127.0.0.1' },
    static: { type: 'string' },
  },
});

const server = await importSource<typeof ServerModule>('src/server/index.ts');
const staticDir = values.static
  ? resolve(values.static)
  : existsSync(join(ROOT, 'dist/web'))
    ? join(ROOT, 'dist/web')
    : null;
if (!process.env.NC_PHONE_KEY) console.warn('NC_PHONE_KEY is not set, so every request gets 401.');

const rpc = server.createRpc({
  env: process.env,
  // PH-7: the open bible is made fresh before each request.
  freshen: server.freshenOpenBible,
});
const port = Number(values.port);
server.webServer({ rpc, staticDir }).listen(port, values.host, () => {
  console.log(`Novel Companion web server on http://${values.host}:${port}/rpc`);
  console.log(staticDir ? `Serving ${staticDir} at /` : 'No web build to serve at /.');
});
