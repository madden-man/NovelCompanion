import { mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

/**
 * Scripts run under plain `node`, which cannot resolve the app's extensionless
 * imports. This bundles one source file with esbuild (packages stay external,
 * resolved from node_modules) into node_modules/.cache and imports it.
 */
const ROOT = join(import.meta.dirname, '..');

export async function importSource<T>(entry: string): Promise<T> {
  const dir = join(ROOT, 'node_modules/.cache/novel-companion-scripts');
  mkdirSync(dir, { recursive: true });
  const outfile = join(dir, basename(entry).replace(/\.m?ts$/, '.mjs'));
  await build({
    entryPoints: [join(ROOT, entry)],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    packages: 'external',
    logLevel: 'warning',
  });
  return (await import(pathToFileURL(outfile).href)) as T;
}
