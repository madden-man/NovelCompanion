import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { claudeDeps } from '../../src/main/claude';
import { FakeModelCatalog } from '../../src/main/claude/fake';
import { MemoryKeyStore } from '../../src/main/claude/keys';
import {
  ALLOW_TEST_URI_ENV,
  TEST_URI_ENV,
  testDatabaseHonoured,
  testSeamsHonoured,
} from '../../src/main/secrets';

const ROOT = join(import.meta.dirname, '../..');
const LOCAL = 'mongodb://127.0.0.1:27017/?replicaSet=testset';
const KEY = 'sk-ant-api03-seam-test-key-0123456789abcdef';

/** The env a test run sets for the recorded Claude, plus the database switches under test. */
function env(extra: Record<string, string>): NodeJS.ProcessEnv {
  return {
    NOVEL_COMPANION_TEST_CLAUDE: '1',
    NOVEL_COMPANION_TEST_ANTHROPIC_KEY: KEY,
    NOVEL_COMPANION_TEST_CLAUDE_RECORDINGS: join(ROOT, 'fixtures/claude/recordings.json'),
    ...extra,
  };
}

function deps(e: NodeJS.ProcessEnv, isPackaged: boolean) {
  return claudeDeps({
    isPackaged,
    testDatabase: testDatabaseHonoured(e, { isPackaged }),
    testSeams: testSeamsHonoured(e, { isPackaged }),
    userData: mkdtempSync(join(tmpdir(), 'nc-seams-')),
    appRoot: ROOT,
    env: e,
    version: '0.0.0',
    emit: () => undefined,
  });
}

describe('T-4 the packaged app honours the test seams only under the documented exception', () => {
  test('T-4 an unpackaged build always honours the seams', () => {
    expect(testSeamsHonoured({}, { isPackaged: false })).toBe(true);
    const d = deps(env({ [TEST_URI_ENV]: LOCAL }), false);
    expect(d.catalog).toBeInstanceOf(FakeModelCatalog);
    expect(d.keys.get()).toBe(KEY);
  });

  test('T-4 a packaged build refuses every seam without the allow flag and a local test database', () => {
    const refused: NodeJS.ProcessEnv[] = [
      {},
      { [ALLOW_TEST_URI_ENV]: '1' },
      { [TEST_URI_ENV]: LOCAL },
      { [ALLOW_TEST_URI_ENV]: 'yes', [TEST_URI_ENV]: LOCAL },
      { [ALLOW_TEST_URI_ENV]: '1', [TEST_URI_ENV]: 'mongodb+srv://u:p@cluster0.example.net/' },
    ];
    for (const e of refused)
      expect(testSeamsHonoured(e, { isPackaged: true }), JSON.stringify(e)).toBe(false);
    // With the allow flag but an Atlas address: no recorded Claude, no key from the environment,
    // and (on that test database) a key store in memory, so the keychain is never read.
    const e = env({ [ALLOW_TEST_URI_ENV]: '1', [TEST_URI_ENV]: 'mongodb+srv://c.example.net/' });
    const d = deps(e, true);
    expect(d.catalog).not.toBeInstanceOf(FakeModelCatalog);
    expect(d.keys).toBeInstanceOf(MemoryKeyStore);
    expect(d.keys.get()).toBeNull();
  });

  test('T-4 a packaged build with the allow flag and a local test database honours the recorded Claude', () => {
    const e = env({ [ALLOW_TEST_URI_ENV]: '1', [TEST_URI_ENV]: LOCAL });
    expect(testSeamsHonoured(e, { isPackaged: true })).toBe(true);
    const d = deps(e, true);
    expect(d.catalog).toBeInstanceOf(FakeModelCatalog);
    expect(d.keys.get()).toBe(KEY);
  });

  test('T-4 the pickers and the fake Google go through the same check in main', async () => {
    const { readFileSync } = await import('node:fs');
    const handlers = readFileSync(join(ROOT, 'src/main/ipc/handlers.ts'), 'utf8');
    // Every test seam in main reads the environment only through seams().
    expect(handlers).toMatch(/const testPath = \(name: string\): string \| null =>\s+seams\(\)/);
    expect(handlers).toMatch(/seams\(\) && process\.env\.NOVEL_COMPANION_TEST_FAKE_CLAUDE === '1'/);
    expect(handlers).toMatch(/testSeams: seams\(\)/);
    // The proposal seam stays refused in every packaged build.
    expect(handlers).toMatch(/if \(!app\.isPackaged\) \{\s+handle\(\s+'test\.propose'/);
  });
});
