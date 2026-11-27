import { Entry } from '@napi-rs/keyring';
import { testMongoUri } from './host/uri';
import type { MongoUriStore, UriLookup } from './host/uri';
import type { PhoneKeyStore } from './host/phoneKey';

// A58: the rules for the address and the test seams live in host/uri.ts, free of the
// keychain, so the handler table loads in a process with no keychain. They are re-exported
// here so every caller of secrets.ts keeps working.
export {
  ALLOW_TEST_URI_ENV,
  MemoryMongoUriStore,
  TEST_DB_NAME_ENV,
  TEST_URI_ENV,
  cleanMongoUri,
  isLocalMongoUri,
  maskMongoUri,
  testDatabaseHonoured,
  testDatabaseName,
  testMongoUri,
  testSeamsHonoured,
} from './host/uri';
export type { MongoUriStore, UriLookup } from './host/uri';

export const KEYCHAIN_SERVICE = 'novel-companion-mongodb';
export const KEYCHAIN_ACCOUNT = 'novel-companion';

/** Read the MongoDB connection string (ARCH-5). It is never logged or stored. */
export function mongoUri(env: NodeJS.ProcessEnv, opts: { isPackaged: boolean }): UriLookup {
  const test = testMongoUri(env, opts);
  if (test) return test;
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

/** A58 (PH-15): the phone key the site's `NC_PHONE_KEY` must hold, in its own keychain item. */
export const PHONE_KEY_SERVICE = 'novel-companion-phone-key';

export class KeychainPhoneKeyStore implements PhoneKeyStore {
  private entry(): Entry {
    return new Entry(PHONE_KEY_SERVICE, KEYCHAIN_ACCOUNT);
  }
  get(): string | null {
    try {
      return this.entry().getPassword() || null;
    } catch {
      return null;
    }
  }
  set(key: string): void {
    this.entry().setPassword(key);
  }
}
