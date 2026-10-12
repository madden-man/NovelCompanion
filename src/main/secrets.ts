import { Entry } from '@napi-rs/keyring';

export const KEYCHAIN_SERVICE = 'novel-companion-mongodb';
export const KEYCHAIN_ACCOUNT = 'novel-companion';

/**
 * Tests start their own local MongoDB and pass its address here. It is only
 * honoured for a local address, so a test can never be pointed at Atlas, and
 * when it is honoured the keychain is not read at all. A packaged app ignores
 * it unless ALLOW_TEST_URI_ENV is also set to 1 (for end-to-end tests against
 * the packaged build).
 */
export const TEST_URI_ENV = 'NOVEL_COMPANION_TEST_MONGODB_URI';
export const ALLOW_TEST_URI_ENV = 'NOVEL_COMPANION_ALLOW_TEST_URI';

export function isLocalMongoUri(uri: string): boolean {
  return /^mongodb:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|\?|,|$)/.test(uri);
}

/**
 * True when the app runs against a test database: an unpackaged build with
 * the test address set, or a packaged build that also has the allow flag
 * (the packaged smoke test, NF-4). Then nothing reads or writes the keychain,
 * and a packaged build may also take its data folder from the environment, so
 * a test run never touches the real data folder.
 */
export function testDatabaseHonoured(
  env: NodeJS.ProcessEnv,
  opts: { isPackaged: boolean },
): boolean {
  return env[TEST_URI_ENV] !== undefined && (!opts.isPackaged || env[ALLOW_TEST_URI_ENV] === '1');
}

export type UriLookup = { ok: true; uri: string } | { ok: false; message: string };

/** Read the MongoDB connection string (ARCH-5). It is never logged or stored. */
export function mongoUri(env: NodeJS.ProcessEnv, opts: { isPackaged: boolean }): UriLookup {
  const testUri = env[TEST_URI_ENV];
  if (testUri !== undefined && testDatabaseHonoured(env, opts)) {
    return isLocalMongoUri(testUri)
      ? { ok: true, uri: testUri }
      : { ok: false, message: 'The test database address must be a local MongoDB.' };
  }
  try {
    const uri = new Entry(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT).getPassword();
    if (uri) return { ok: true, uri };
  } catch {
    // Fall through to the plain explanation below.
  }
  return {
    ok: false,
    message: `No MongoDB connection string is stored in the keychain. Add it under the service "${KEYCHAIN_SERVICE}" and the account "${KEYCHAIN_ACCOUNT}".`,
  };
}

/**
 * ST-1, ARCH-5: where the MongoDB connection string is kept. The app reads it
 * here and replaces it here; nothing else stores it, and it never reaches the
 * renderer, a log, or an export.
 */
export interface MongoUriStore {
  get(): string | null;
  set(uri: string): void;
  /** Where it is kept, in plain words for the settings screen. */
  readonly where: string;
}

export class KeychainMongoUriStore implements MongoUriStore {
  readonly where = `the macOS keychain (service "${KEYCHAIN_SERVICE}")`;
  private entry(): Entry {
    return new Entry(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
  }
  get(): string | null {
    try {
      return this.entry().getPassword() || null;
    } catch {
      return null;
    }
  }
  set(uri: string): void {
    this.entry().setPassword(uri);
  }
}

/** Tests and end-to-end runs: the string lives in memory, so the keychain is never touched. */
export class MemoryMongoUriStore implements MongoUriStore {
  readonly where = 'memory, for this test run';
  constructor(private uri: string | null = null) {}
  get(): string | null {
    return this.uri;
  }
  set(uri: string): void {
    this.uri = uri;
  }
}

/**
 * The connection string as the settings screen shows it: the scheme and the
 * last few characters of the host, never the user name, password, or options.
 * The host is what follows the last `@` of the address part, as the driver
 * reads it; a user name or password holding an unencoded `/`, `?`, or `#` is
 * one the driver refuses too, and is never shown at all.
 */
export function maskMongoUri(uri: string): string {
  const unreadable = 'a connection string the app cannot read';
  const m = /^(mongodb(?:\+srv)?):\/\/(.*)$/s.exec(uri.trim());
  if (!m) return unreadable;
  const rest = m[2] ?? '';
  const at = rest.lastIndexOf('@');
  const credentials = at < 0 ? '' : rest.slice(0, at);
  if (/[/?#]/.test(credentials)) return unreadable;
  const host = /^[^/?#]*/.exec(rest.slice(at + 1))?.[0] ?? '';
  if (!host) return unreadable;
  const tail = host.length > 10 ? host.slice(-10) : host.slice(-Math.ceil(host.length / 2));
  return `${m[1]}://…${tail}`;
}

/** A pasted connection string: trimmed, one line, and shaped like a MongoDB address. */
export function cleanMongoUri(
  raw: string,
  opts: { localOnly: boolean },
): { ok: true; uri: string } | { ok: false; message: string } {
  const uri = raw.trim();
  if (!uri) return { ok: false, message: 'Paste the connection string first.' };
  if (/\s/.test(uri)) {
    return { ok: false, message: 'A connection string has no spaces or line breaks.' };
  }
  if (!/^mongodb(\+srv)?:\/\/[^/?#]+/.test(uri)) {
    return {
      ok: false,
      message:
        'A MongoDB connection string starts with "mongodb+srv://" or "mongodb://". Copy it again from Atlas under Connect, then Drivers.',
    };
  }
  if (opts.localOnly && !isLocalMongoUri(uri)) {
    return { ok: false, message: 'The test database address must be a local MongoDB.' };
  }
  return { ok: true, uri };
}
