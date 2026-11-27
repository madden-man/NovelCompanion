import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * A58 (PH-21): one build id for the web build and the hosted function, which
 * Netlify bundles from the same checkout in the same build. `vite.web.config.ts`
 * writes it before the web bundle is made; the web bundle and
 * `netlify/functions/rpc.mts` both import the file, so their ids cannot differ.
 * The file is generated and never committed.
 */
export const BUILD_ID_FILE = 'src/generated/build-id.json';

/** Netlify's commit at build time; else this checkout's commit, marked local when it has changes. */
export function currentBuildId(root: string, env: NodeJS.ProcessEnv = process.env): string {
  if (env.COMMIT_REF) return env.COMMIT_REF.slice(0, 12);
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    const head = git('rev-parse', '--short=12', 'HEAD').trim();
    const dirty = git('status', '--porcelain', '--untracked-files=no').trim() !== '';
    return dirty ? `${head}-local-${Date.now().toString(36)}` : head;
  } catch {
    return `local-${Date.now().toString(36)}`;
  }
}

/** Write the build id file under `root` and return the id. */
export function writeBuildId(root: string, id = currentBuildId(root)): string {
  const file = join(root, BUILD_ID_FILE);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ id }, null, 2)}\n`);
  return id;
}

/** The id the last build wrote, or null before any build. */
export function readBuildId(root: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(join(root, BUILD_ID_FILE), 'utf8')) as { id?: unknown };
    return typeof parsed.id === 'string' ? parsed.id : null;
  } catch {
    return null;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(writeBuildId(join(import.meta.dirname, '..')));
}
