import { execSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * T-4: make sure release/ holds a packaged app built from this source before
 * the journey drives it. Runs `npm run package` when there is no packaged app,
 * or when anything it is built from is newer than its app.asar.
 */
const ROOT = join(import.meta.dirname, '..');
const ASAR = join(
  ROOT,
  'release/build.noindex/mac-arm64/Novel Companion.app/Contents/Resources/app.asar',
);
const SOURCES = [
  'src',
  'package.json',
  'package-lock.json',
  'electron-builder.yml',
  'electron.vite.config.ts',
];

function newest(path: string): number {
  const st = statSync(path);
  if (!st.isDirectory()) return st.mtimeMs;
  return readdirSync(path).reduce((m, n) => Math.max(m, newest(join(path, n))), st.mtimeMs);
}

const built = existsSync(ASAR) ? statSync(ASAR).mtimeMs : 0;
const source = Math.max(...SOURCES.map((s) => newest(join(ROOT, s))));
if (built >= source) {
  process.stdout.write('The packaged app in release/ is newer than its source; using it.\n');
} else {
  process.stdout.write(
    built
      ? 'The source changed since the app was packaged; packaging it again.\n'
      : 'There is no packaged app in release/ yet; packaging it.\n',
  );
  execSync('npm run package', { cwd: ROOT, stdio: 'inherit' });
}
