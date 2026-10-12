import { describe, expect, test, vi } from 'vitest';

const getPassword = vi.fn(() => null as string | null);
vi.mock('@napi-rs/keyring', () => ({
  Entry: class {
    getPassword() {
      return getPassword();
    }
  },
}));

const {
  ALLOW_TEST_URI_ENV,
  TEST_DB_NAME_ENV,
  TEST_URI_ENV,
  isLocalMongoUri,
  mongoUri,
  testDatabaseHonoured,
  testDatabaseName,
} = await import('../../src/main/secrets');

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

describe('NF-4 the packaged smoke test runs on a test database without the keychain', () => {
  test('NF-4 testDatabaseHonoured is true unpackaged with a test address, and packaged only with the allow flag', () => {
    expect(testDatabaseHonoured({}, { isPackaged: false })).toBe(false);
    expect(testDatabaseHonoured({ [TEST_URI_ENV]: LOCAL }, { isPackaged: false })).toBe(true);
    expect(testDatabaseHonoured({ [TEST_URI_ENV]: LOCAL }, { isPackaged: true })).toBe(false);
    expect(
      testDatabaseHonoured(
        { [TEST_URI_ENV]: LOCAL, [ALLOW_TEST_URI_ENV]: '1' },
        { isPackaged: true },
      ),
    ).toBe(true);
    expect(
      testDatabaseHonoured(
        { [TEST_URI_ENV]: LOCAL, [ALLOW_TEST_URI_ENV]: 'true' },
        { isPackaged: true },
      ),
    ).toBe(false);
    expect(testDatabaseHonoured({ [ALLOW_TEST_URI_ENV]: '1' }, { isPackaged: true })).toBe(false);
  });
});

describe('ARCH-8 the per-file test database name is honoured only where the test address is', () => {
  const name = { [TEST_DB_NAME_ENV]: 'e2e_tree' };
  test('ARCH-8 an unpackaged build with a local test address uses the named database', () => {
    expect(testDatabaseName({ ...name, [TEST_URI_ENV]: LOCAL }, { isPackaged: false })).toBe(
      'e2e_tree',
    );
    expect(
      testDatabaseName(
        { ...name, [TEST_URI_ENV]: LOCAL, [ALLOW_TEST_URI_ENV]: '1' },
        { isPackaged: true },
      ),
    ).toBe('e2e_tree');
  });

  test('ARCH-8 the name is ignored without a test address, for a non-local one, and packaged without the allow flag', () => {
    const atlas = 'mongodb+srv://u:p@cluster0.example.net/';
    expect(testDatabaseName(name, { isPackaged: false })).toBeNull();
    expect(testDatabaseName({ ...name, [TEST_URI_ENV]: atlas }, { isPackaged: false })).toBeNull();
    expect(
      testDatabaseName(
        { ...name, [TEST_URI_ENV]: atlas, [ALLOW_TEST_URI_ENV]: '1' },
        { isPackaged: true },
      ),
    ).toBeNull();
    expect(testDatabaseName({ ...name, [TEST_URI_ENV]: LOCAL }, { isPackaged: true })).toBeNull();
    expect(
      testDatabaseName(
        { ...name, [TEST_URI_ENV]: LOCAL, [ALLOW_TEST_URI_ENV]: 'yes' },
        { isPackaged: true },
      ),
    ).toBeNull();
  });

  test('ARCH-8 a name MongoDB would refuse, or none, leaves novel_companion in place', () => {
    for (const bad of ['', 'a.b', 'a/b', 'x'.repeat(64), 'with space']) {
      expect(
        testDatabaseName({ [TEST_DB_NAME_ENV]: bad, [TEST_URI_ENV]: LOCAL }, { isPackaged: false }),
        bad,
      ).toBeNull();
    }
    expect(testDatabaseName({ [TEST_URI_ENV]: LOCAL }, { isPackaged: false })).toBeNull();
  });
});
