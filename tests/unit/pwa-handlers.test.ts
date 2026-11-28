import { afterEach, describe, expect, test, vi } from 'vitest';
import { MemoryPhoneKeyStore } from '../../src/main/host/phoneKey';
import type { PhoneKeyStore } from '../../src/main/host/phoneKey';
import type { Host } from '../../src/main/host/types';
import { TEST_URI_ENV } from '../../src/main/host/uri';
import { TEST_PHONE_KEY_SEAM, pwaHandlers } from '../../src/main/ipc/pwaHandlers';
import type { PhoneKeySeam } from '../../src/main/ipc/pwaHandlers';

/** A58 P4 (PH-15): the phone key handlers, on a fake host with no keychain and no clipboard. */
function fakeHost(store: PhoneKeyStore | null, copyText = vi.fn()) {
  return {
    host: {
      isPackaged: false,
      hosted: false,
      copyText,
      secrets: { phoneKey: store ? () => store : undefined },
    } as unknown as Host,
    copyText,
  };
}

const seam = () =>
  (globalThis as Record<string, unknown>)[TEST_PHONE_KEY_SEAM] as PhoneKeySeam | undefined;

const before = process.env[TEST_URI_ENV];
afterEach(() => {
  vi.unstubAllEnvs();
  if (before === undefined) Reflect.deleteProperty(process.env, TEST_URI_ENV);
  else process.env[TEST_URI_ENV] = before;
  Reflect.deleteProperty(globalThis, TEST_PHONE_KEY_SEAM);
});

describe('PH-15 the phone key on the Mac', () => {
  test('PH-15 Copy puts the whole stored key on the clipboard', async () => {
    Reflect.deleteProperty(process.env, TEST_URI_ENV);
    const keys = new MemoryPhoneKeyStore();
    const { host, copyText } = fakeHost(keys);
    const h = pwaHandlers(host, () => null);
    await h['phoneKey.make']({});
    const key = keys.get();
    expect(key).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(await h['phoneKey.copy']({})).toEqual({ ok: true });
    expect(copyText).toHaveBeenCalledTimes(1);
    expect(copyText).toHaveBeenCalledWith(key);
  });

  test('PH-15 under test, Copy puts the whole stored key on a clipboard seam a test reads back', async () => {
    vi.stubEnv(TEST_URI_ENV, 'mongodb://127.0.0.1:1/');
    const { host, copyText } = fakeHost(null);
    const h = pwaHandlers(host, () => null);
    expect(seam()?.copied ?? null).toBeNull();
    const status = await h['phoneKey.make']({});
    expect(await h['phoneKey.copy']({})).toEqual({ ok: true });
    const stored = seam()!.store.get();
    expect(stored).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(seam()!.copied).toBe(stored);
    expect(status.masked).toBe(`••••••••${stored!.slice(-4)}`);
    // The system clipboard is never touched under test.
    expect(copyText).not.toHaveBeenCalled();
  });

  test('PH-15 a keychain that cannot be read is not taken for no key: Make keeps the stored key', async () => {
    Reflect.deleteProperty(process.env, TEST_URI_ENV);
    const set = vi.fn();
    const broken: PhoneKeyStore = {
      get: () => {
        throw new Error('The keychain could not be read.');
      },
      set,
    };
    const h = pwaHandlers(fakeHost(broken).host, () => null);
    await expect(async () => h['phoneKey.status']({})).rejects.toThrow(
      'The keychain could not be read.',
    );
    await expect(async () => h['phoneKey.make']({})).rejects.toThrow(
      'The keychain could not be read.',
    );
    expect(set).not.toHaveBeenCalled();
  });
});
