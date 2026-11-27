import { randomBytes } from 'node:crypto';
import type { PhoneKeyStatus } from '../../shared/ipcPwa';

/**
 * A58 (PH-15): where the Mac keeps the phone key, the one the site's
 * `NC_PHONE_KEY` must hold. The keychain on the Mac (`secrets.ts`); memory
 * under test, so a test never touches the keychain.
 */
export interface PhoneKeyStore {
  get(): string | null;
  set(key: string): void;
}

export class MemoryPhoneKeyStore implements PhoneKeyStore {
  constructor(private key: string | null = null) {}
  get(): string | null {
    return this.key;
  }
  set(key: string): void {
    this.key = key;
  }
}

/** A new random phone key: 32 URL-safe characters (192 bits), easy to paste. */
export function makePhoneKey(): string {
  return randomBytes(24).toString('base64url');
}

/** PH-15: the key as Settings shows it, its last four characters behind dots. */
export function phoneKeyStatus(key: string | null): PhoneKeyStatus {
  return key ? { set: true, masked: `••••••••${key.slice(-4)}` } : { set: false, masked: null };
}
