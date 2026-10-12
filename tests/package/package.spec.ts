import { mkdtempSync, openSync, readSync, closeSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { APP, EXECUTABLE, KEYRING_NODE, SDK_BINARY, findDmg } from './paths';

/**
 * NF-4 and T-4 against the packaged build in release/ (made by `npm run package`).
 * The app runs on a local test database through the one documented exception,
 * NOVEL_COMPANION_ALLOW_TEST_URI=1, so it never reads the keychain or reaches Atlas.
 */
test.describe.configure({ mode: 'serial' });

/** The first four bytes of a 64-bit Mach-O file (little-endian MH_MAGIC_64), or a universal binary. */
function machO(path: string): string {
  const fd = openSync(path, 'r');
  try {
    const head = Buffer.alloc(8);
    readSync(fd, head, 0, 8, 0);
    if (head.readUInt32LE(0) === 0xfeedfacf) {
      // CPU_TYPE_ARM64 is 0x0100000c.
      return head.readUInt32LE(4) === 0x0100000c ? 'arm64' : 'other 64-bit';
    }
    if (head.readUInt32BE(0) === 0xcafebabe) return 'universal';
    return 'not Mach-O';
  } finally {
    closeSync(fd);
  }
}

test('NF-4 npm run package wrote an unsigned arm64 dmg and an app bundle', () => {
  const dmg = findDmg();
  expect(dmg, 'run npm run package first').not.toBeNull();
  expect(statSync(dmg!).size).toBeGreaterThan(50 * 1024 * 1024);
  expect(existsSync(EXECUTABLE)).toBe(true);
  expect(machO(EXECUTABLE)).toBe('arm64');
  // Unsigned (A15): no embedded provisioning or Developer ID signature resources.
  expect(existsSync(join(APP, 'Contents', 'embedded.provisionprofile'))).toBe(false);
});

test('NF-4 ARCH-4 the Agent SDK binary and the keyring native module are unpacked from app.asar', () => {
  expect(existsSync(SDK_BINARY)).toBe(true);
  expect(statSync(SDK_BINARY).mode & 0o111).not.toBe(0);
  expect(machO(SDK_BINARY)).toBe('arm64');
  expect(existsSync(KEYRING_NODE)).toBe(true);
  expect(machO(KEYRING_NODE)).toBe('arm64');
});

let server: MongoMemoryReplSet;
let app: ElectronApplication;
let page: Page;

test.afterAll(async () => {
  // A packaged app ignores the skip flag, so closing would wait on the stop prompt: exit instead.
  await app?.evaluate(({ app: electron }) => electron.exit(0)).catch(() => undefined);
  await server?.stop();
});

test('NF-4 T-4 the packaged app launches on a test database, a bible opens, and the dashboard renders', async () => {
  test.setTimeout(180_000);
  server = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  app = await electron.launch({
    executablePath: EXECUTABLE,
    args: [],
    env: {
      ...process.env,
      NOVEL_COMPANION_ALLOW_TEST_URI: '1',
      NOVEL_COMPANION_TEST_MONGODB_URI: server.getUri(),
      NOVEL_COMPANION_USER_DATA: mkdtempSync(join(tmpdir(), 'nc-package-')),
      // Test seams a packaged app must refuse.
      NOVEL_COMPANION_TEST_CLAUDE: '1',
      NOVEL_COMPANION_TEST_ANTHROPIC_KEY: 'sk-ant-should-be-ignored-0000',
    },
  });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  expect(await app.evaluate(({ app: electron }) => electron.isPackaged)).toBe(true);
  await expect(page).toHaveTitle('Novel Companion');
  await expect(page.getByTestId('no-bibles')).toHaveText('No bibles yet');

  await page.getByLabel('Name').fill('Smoke Test');
  await page.getByRole('button', { name: 'Create bible' }).click();
  // A first launch writes the bible's collections and its first snapshot: allow a slow machine.
  await expect(page.getByTestId('bible-list')).toContainText('Smoke Test', { timeout: 60_000 });
  await page.getByRole('button', { name: 'Open Smoke Test' }).click();
  await expect(page.getByTestId('current-bible')).toHaveText('Smoke Test', { timeout: 60_000 });
  await expect(page.getByTestId('workspace')).toBeVisible();
  await expect(page.getByTestId('dashboard')).toBeVisible();
  await expect(
    page.getByTestId('dashboard').getByRole('button', { name: 'Start session' }),
  ).toBeVisible();

  // The data folder came from the environment, not ~/Library/Application Support.
  const userData = await app.evaluate(({ app: electron }) => electron.getPath('userData'));
  expect(userData).toContain('nc-package-');
  // The test seams are refused: no proposal seam, and Claude has no key (the fake key was ignored).
  const seam = await page.evaluate(async () => {
    try {
      await window.api.invoke('test.propose', {
        source: 'import',
        op: 'create',
        collection: 'facts',
        data: { title: 'x', status: 'idea' },
      } as never);
      return 'registered';
    } catch {
      return 'refused';
    }
  });
  expect(seam).toBe('refused');
  const status = await page.evaluate(() => window.api.invoke('claude.status', {}));
  expect(status.key).toEqual({ set: false, masked: null });
});
