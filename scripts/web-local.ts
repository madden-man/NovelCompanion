import { execFileSync, spawn } from 'node:child_process';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { importSource } from './import-source.ts';
import type * as Deps from './web-local-deps.ts';

/**
 * A58 P4: the phone client on this Mac in one command, against a throwaway
 * local database holding the fixture novel. Never Atlas, never the keychain.
 *
 *   npm run web:local            then open the printed address and paste the printed key
 *
 * Builds `dist/web`, starts a local replica set (the repository writes in
 * transactions), seeds the fixture novel, and serves the build and `/rpc`
 * through `scripts/serve-web.ts`. Ctrl+C stops all of it.
 */
const ROOT = join(import.meta.dirname, '..');
const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '8787' },
    host: { type: 'string', default: '127.0.0.1' },
    key: { type: 'string', default: 'local-phone-key' },
  },
});

const deps = await importSource<typeof Deps>('scripts/web-local-deps.ts');

execFileSync('npm', ['run', 'build:web'], { cwd: ROOT, stdio: 'inherit' });
process.env.NC_TEST_RAM_DISK ??= '0';
const mongo = await deps.startTestMongo();
const DB = 'novel_companion_web_local';
const store = await deps.connect(mongo.uri, {}, DB);
await deps.loadFixture(store, 'fixture-novel');
await store.close();

const server = spawn(
  process.execPath,
  ['scripts/serve-web.ts', '--port', values.port, '--host', values.host],
  {
    cwd: ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      NC_PHONE_KEY: values.key,
      NOVEL_COMPANION_TEST_MONGODB_URI: mongo.uri,
      NOVEL_COMPANION_ALLOW_TEST_URI: '1',
      NOVEL_COMPANION_TEST_DB_NAME: DB,
    },
  },
);
console.log(`Phone key: ${values.key}`);
console.log(
  `Open http://${values.host}:${values.port}/ (in Safari's responsive mode for a phone).`,
);

const stop = async () => {
  server.kill('SIGTERM');
  await mongo.stop();
  process.exit(0);
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
server.on('exit', () => void stop());
