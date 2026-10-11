/**
 * On-demand import of the East Winds material (M5). Run with
 * `npm run import:eastwinds`, optionally followed by `-- --dry-run`.
 *
 * It bundles scripts/eastwinds-cli.ts with esbuild (a dev dependency)
 * and runs it under Node, because the app code uses extensionless
 * TypeScript imports that Node cannot load directly. The MongoDB connection
 * string comes from the macOS keychain, as in the app, and is never printed.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = join(import.meta.dirname, '..');
const outDir = join(root, 'node_modules/.cache/import-eastwinds');
const outfile = join(outDir, 'run.mjs');
mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [join(root, 'scripts/eastwinds-cli.ts')],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  packages: 'external',
  logLevel: 'error',
});

const { main } = (await import(pathToFileURL(outfile).href)) as {
  main: (argv: string[]) => Promise<void>;
};
main(process.argv.slice(2)).catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
