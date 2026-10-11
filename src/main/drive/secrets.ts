import { Entry } from '@napi-rs/keyring';

/**
 * GD-1, ARCH-5: the Google OAuth client and the Drive tokens live in the
 * macOS keychain, never in a file, the database, a log, or an export.
 */
export const GOOGLE_KEYCHAIN_SERVICE = 'novel-companion-google';
/** The OAuth client ID and secret Tommy creates in Google Cloud (docs/DRIVE-SETUP.md). */
export const CLIENT_ACCOUNT = 'oauth-client';
/** The refresh token, the current access token, and the scopes granted. */
export const TOKENS_ACCOUNT = 'oauth-tokens';

export interface SecretStore {
  get(account: string): string | null;
  set(account: string, value: string): void;
  delete(account: string): void;
}

/** The real store: one keychain item per account under one service. */
export function keychainStore(service = GOOGLE_KEYCHAIN_SERVICE): SecretStore {
  return {
    get(account) {
      try {
        return new Entry(service, account).getPassword() ?? null;
      } catch {
        return null;
      }
    },
    set(account, value) {
      new Entry(service, account).setPassword(value);
    },
    delete(account) {
      try {
        new Entry(service, account).deletePassword();
      } catch {
        // Nothing stored: already gone.
      }
    },
  };
}

/** For tests and the unpackaged end-to-end build: nothing touches the keychain. */
export function memoryStore(initial: Record<string, string> = {}): SecretStore & {
  dump(): Record<string, string>;
} {
  const data = new Map(Object.entries(initial));
  return {
    get: (a) => data.get(a) ?? null,
    set: (a, v) => void data.set(a, v),
    delete: (a) => void data.delete(a),
    dump: () => Object.fromEntries(data),
  };
}
