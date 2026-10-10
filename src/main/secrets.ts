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

export type UriLookup = { ok: true; uri: string } | { ok: false; message: string };

/** Read the MongoDB connection string (ARCH-5). It is never logged or stored. */
export function mongoUri(env: NodeJS.ProcessEnv, opts: { isPackaged: boolean }): UriLookup {
  const testUri = env[TEST_URI_ENV];
  const honoured = !opts.isPackaged || env[ALLOW_TEST_URI_ENV] === '1';
  if (testUri !== undefined && honoured) {
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
