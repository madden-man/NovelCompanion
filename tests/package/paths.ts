import { readdirSync } from 'node:fs';
import { join } from 'node:path';

export const ROOT = join(import.meta.dirname, '../..');
export const RELEASE = join(ROOT, 'release');
export const APP = join(RELEASE, 'mac-arm64', 'Novel Companion.app');
export const EXECUTABLE = join(APP, 'Contents', 'MacOS', 'Novel Companion');
export const UNPACKED = join(APP, 'Contents', 'Resources', 'app.asar.unpacked');
export const SDK_BINARY = join(
  UNPACKED,
  'node_modules',
  '@anthropic-ai',
  'claude-agent-sdk-darwin-arm64',
  'claude',
);
export const KEYRING_NODE = join(
  UNPACKED,
  'node_modules',
  '@napi-rs',
  'keyring-darwin-arm64',
  'keyring.darwin-arm64.node',
);

/** The arm64 dmg `npm run package` writes, or null when there is none. */
export function findDmg(): string | null {
  try {
    const name = readdirSync(RELEASE).find((f) => /-arm64\.dmg$/.test(f));
    return name ? join(RELEASE, name) : null;
  } catch {
    return null;
  }
}
