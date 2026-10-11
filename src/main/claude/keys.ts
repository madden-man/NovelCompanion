import { Entry } from '@napi-rs/keyring';

/** ARCH-4, ARCH-5: the Anthropic API key lives in the macOS keychain under this service. */
export const ANTHROPIC_KEYCHAIN_SERVICE = 'novel-companion-anthropic';
export const ANTHROPIC_KEYCHAIN_ACCOUNT = 'novel-companion';

/** Where the key is kept. The renderer never sees it; settings show a masked form only. */
export interface KeyStore {
  get(): string | null;
  set(key: string): void;
  clear(): void;
}

export class KeychainKeyStore implements KeyStore {
  private entry(): Entry {
    return new Entry(ANTHROPIC_KEYCHAIN_SERVICE, ANTHROPIC_KEYCHAIN_ACCOUNT);
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

  clear(): void {
    try {
      this.entry().deletePassword();
    } catch {
      // Nothing stored is the outcome wanted.
    }
  }
}

/** Tests and end-to-end runs: a key that exists only in memory, so the real keychain is never touched. */
export class MemoryKeyStore implements KeyStore {
  constructor(private key: string | null = null) {}

  get(): string | null {
    return this.key;
  }

  set(key: string): void {
    this.key = key;
  }

  clear(): void {
    this.key = null;
  }
}

/** A key as pasted: trimmed, one line, and shaped like an Anthropic key. */
export function cleanKey(raw: string): { ok: true; key: string } | { ok: false; message: string } {
  const key = raw.trim();
  if (!key) return { ok: false, message: 'Paste the API key first.' };
  if (/\s/.test(key)) return { ok: false, message: 'An API key has no spaces or line breaks.' };
  if (!key.startsWith('sk-ant-')) {
    return {
      ok: false,
      message: 'Anthropic API keys start with "sk-ant-". Check the key and paste it again.',
    };
  }
  return { ok: true, key };
}
