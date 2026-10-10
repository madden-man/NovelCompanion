import { describe, expect, test, vi } from 'vitest';

const getPassword = vi.fn(() => null as string | null);
vi.mock('@napi-rs/keyring', () => ({
  Entry: class {
    getPassword() {
      return getPassword();
    }
  },
}));

const { ALLOW_TEST_URI_ENV, TEST_URI_ENV, isLocalMongoUri, mongoUri } =
  await import('../../src/main/secrets');

const LOCAL = 'mongodb://127.0.0.1:1/';

describe('ARCH-1 secrets stay in main', () => {
  test('ARCH-1 the test database override only accepts a local MongoDB address', () => {
    expect(isLocalMongoUri(LOCAL)).toBe(true);
    expect(isLocalMongoUri('mongodb://localhost:27017/?replicaSet=testset')).toBe(true);
    expect(isLocalMongoUri('mongodb+srv://cluster0.example.mongodb.net/')).toBe(false);
    expect(isLocalMongoUri('mongodb://localhost.evil.example/')).toBe(false);
    expect(
      mongoUri(
        { [TEST_URI_ENV]: 'mongodb+srv://cluster0.example.mongodb.net/' },
        { isPackaged: false },
      ),
    ).toEqual({ ok: false, message: 'The test database address must be a local MongoDB.' });
  });

  test('ARCH-1 an unpackaged app honours the test database override without reading the keychain', () => {
    getPassword.mockClear();
    expect(mongoUri({ [TEST_URI_ENV]: LOCAL }, { isPackaged: false })).toEqual({
      ok: true,
      uri: LOCAL,
    });
    expect(getPassword).not.toHaveBeenCalled();
  });

  test('ARCH-1 a packaged app ignores the test database override and reads the keychain', () => {
    getPassword.mockClear();
    getPassword.mockReturnValueOnce('mongodb://from-keychain.example/');
    expect(mongoUri({ [TEST_URI_ENV]: LOCAL }, { isPackaged: true })).toEqual({
      ok: true,
      uri: 'mongodb://from-keychain.example/',
    });
    expect(getPassword).toHaveBeenCalledTimes(1);
  });

  test('ARCH-1 a packaged app honours the override only when the allow flag is exactly 1', () => {
    getPassword.mockClear();
    expect(
      mongoUri({ [TEST_URI_ENV]: LOCAL, [ALLOW_TEST_URI_ENV]: '1' }, { isPackaged: true }),
    ).toEqual({ ok: true, uri: LOCAL });
    expect(getPassword).not.toHaveBeenCalled();
    const denied = mongoUri(
      { [TEST_URI_ENV]: LOCAL, [ALLOW_TEST_URI_ENV]: 'yes' },
      { isPackaged: true },
    );
    expect(denied.ok).toBe(false);
    expect(getPassword).toHaveBeenCalledTimes(1);
  });

  test('ARCH-1 a missing keychain entry gives a plain instruction', () => {
    getPassword.mockReturnValueOnce(null);
    const r = mongoUri({}, { isPackaged: true });
    expect(r).toEqual({
      ok: false,
      message: expect.stringMatching(/keychain.*novel-companion-mongodb/),
    });
  });
});
