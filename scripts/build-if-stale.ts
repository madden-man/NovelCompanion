import { execSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `npm run test:e2e`: build the app into out/ only when something it is built
 * from is newer than the oldest file of the last build, or there is no build.
 * `npm run test:e2e:force` always builds.
 */
const ROOT = join(import.meta.dirname, '..');
const OUT = join(ROOT, 'out');
const SOURCES = [
  'src',
  'package.json',
  'package-lock.json',
  'electron.vite.config.ts',
  'tsconfig.base.json',
  'tsconfig.json',
  'tsconfig.node.json',
  'tsconfig.web.json',
];

function files(path: string): string[] {
  if (!existsSync(path)) return [];
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path).flatMap((n) => files(join(path, n)));
}

const mtimes = (paths: string[]) => paths.map((p) => statSync(p).mtimeMs);
const built = files(OUT);
const parts = ['main', 'preload', 'renderer'].every((p) => existsSync(join(OUT, p)));
const oldestBuilt = built.length && parts ? Math.min(...mtimes(built)) : 0;
const newestSource = Math.max(...mtimes(SOURCES.flatMap((s) => files(join(ROOT, s)))));

if (oldestBuilt > newestSource) {
  process.stdout.write('out/ is newer than its source; skipping electron-vite build.\n');
} else {
  process.stdout.write(
    oldestBuilt
      ? 'The source changed since out/ was built; building.\n'
      : 'No build in out/; building.\n',
  );
  execSync('npx electron-vite build', { cwd: ROOT, stdio: 'inherit' });
}
