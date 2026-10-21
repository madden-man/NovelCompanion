import { readdirSync } from 'node:fs';
import { join } from 'node:path';

export const ROOT = join(import.meta.dirname, '../..');
export const RELEASE = join(ROOT, 'release', 'build.noindex');
export const APP = join(RELEASE, 'mac-arm64', 'Novel Companion.app');

/** Where the parts the tests check sit inside an app bundle (in release/, or on the mounted dmg). */
export function inApp(app: string) {
  const unpacked = join(app, 'Contents', 'Resources', 'app.asar.unpacked');
  return {
    EXECUTABLE: join(app, 'Contents', 'MacOS', 'Novel Companion'),
    UNPACKED: unpacked,
    SDK_BINARY: join(
      unpacked,
      'node_modules',
      '@anthropic-ai',
      'claude-agent-sdk-darwin-arm64',
      'claude',
    ),
    KEYRING_NODE: join(
      unpacked,
      'node_modules',
      '@napi-rs',
      'keyring-darwin-arm64',
      'keyring.darwin-arm64.node',
    ),
  };
}

export const { EXECUTABLE, UNPACKED, SDK_BINARY, KEYRING_NODE } = inApp(APP);

/** The arm64 dmg `npm run package` writes, or null when there is none. */
export function findDmg(): string | null {
  try {
    const name = readdirSync(RELEASE).find((f) => /-arm64\.dmg$/.test(f));
    return name ? join(RELEASE, name) : null;
  } catch {
    return null;
  }
}
