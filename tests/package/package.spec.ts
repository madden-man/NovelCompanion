import { execFileSync } from 'node:child_process';
import { mkdtempSync, openSync, readSync, closeSync, statSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { APP, EXECUTABLE, KEYRING_NODE, ROOT, SDK_BINARY, findDmg, inApp } from './paths';

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

test('NF-4 ARCH-4 the dmg holds the app with the Agent SDK binary and the keyring native module unpacked', () => {
  const dmg = findDmg();
  expect(dmg, 'run npm run package first').not.toBeNull();
  const mount = mkdtempSync(join(tmpdir(), 'nc-dmg-'));
  // Mounted read-only and out of sight in Finder; always detached again.
  execFileSync('hdiutil', [
    'attach',
    dmg!,
    '-readonly',
    '-nobrowse',
    '-noautoopen',
    '-mountpoint',
    mount,
  ]);
  try {
    const app = join(mount, 'Novel Companion.app');
    expect(existsSync(app)).toBe(true);
    const exe = inApp(app).EXECUTABLE;
    expect(machO(exe)).toBe('arm64');
    const sdk = inApp(app).SDK_BINARY;
    expect(existsSync(sdk), sdk).toBe(true);
    expect(statSync(sdk).mode & 0o111).not.toBe(0);
    expect(machO(sdk)).toBe('arm64');
    const keyring = inApp(app).KEYRING_NODE;
    expect(existsSync(keyring), keyring).toBe(true);
    expect(machO(keyring)).toBe('arm64');
    // The same bytes as the app folder npm run package wrote beside it.
    expect(statSync(sdk).size).toBe(statSync(SDK_BINARY).size);
    expect(statSync(keyring).size).toBe(statSync(KEYRING_NODE).size);
  } finally {
    execFileSync('hdiutil', ['detach', mount, '-force']);
    rmSync(mount, { recursive: true, force: true });
  }
});

test('T-4 without a local test database the packaged app refuses the test seams, and reads no keychain', async () => {
  test.setTimeout(120_000);
  const refused = await electron.launch({
    executablePath: EXECUTABLE,
    args: [],
    env: {
      ...process.env,
      // The rule for every run that drives the app: hidden, so it never takes the focus.
      NOVEL_COMPANION_HIDDEN: process.env.NOVEL_COMPANION_E2E_SHOW === '1' ? '0' : '1',
      // The allow flag with an address that is not local: the exception does not apply.
      NOVEL_COMPANION_ALLOW_TEST_URI: '1',
      NOVEL_COMPANION_TEST_MONGODB_URI: 'mongodb+srv://cluster0.example.mongodb.net/',
      NOVEL_COMPANION_USER_DATA: mkdtempSync(join(tmpdir(), 'nc-package-refused-')),
      NOVEL_COMPANION_TEST_CLAUDE: '1',
      NOVEL_COMPANION_TEST_ANTHROPIC_KEY: 'sk-ant-should-be-ignored-0000',
    },
  });
  try {
    const p = await refused.firstWindow();
    await p.waitForLoadState('domcontentloaded');
    expect(await refused.evaluate(({ app: electron }) => electron.isPackaged)).toBe(true);
    await expect(p.getByTestId('connection-banner')).toContainText(
      'The test database address must be a local MongoDB.',
      { timeout: 30_000 },
    );
    // No recorded Claude and no key from the environment.
    const status = await p.evaluate(() => window.api.invoke('claude.status', {}));
    expect(status.key).toEqual({ set: false, masked: null });
    const models = await p.evaluate(() => window.api.invoke('claude.models', {}));
    expect(models.live).toBe(false);
  } finally {
    // Wait until it has gone, so the next launch is not the second instance of a running app.
    const gone = refused.waitForEvent('close');
    await refused.evaluate(({ app: electron }) => electron.exit(0)).catch(() => undefined);
    await gone;
  }
});

let server: MongoMemoryReplSet;
let app: ElectronApplication;
let page: Page;

test.afterAll(async () => {
  // Exit rather than close, so the test never waits on the close-time flush.
  await app?.evaluate(({ app: electron }) => electron.exit(0)).catch(() => undefined);
  await server?.stop();
});

test('NF-4 T-4 the packaged app launches on a test database, a bible opens, and the workspace renders', async () => {
  test.setTimeout(180_000);
  server = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  app = await electron.launch({
    executablePath: EXECUTABLE,
    args: [],
    env: {
      ...process.env,
      // The rule for every run that drives the app: hidden, so it never takes the focus.
      NOVEL_COMPANION_HIDDEN: process.env.NOVEL_COMPANION_E2E_SHOW === '1' ? '0' : '1',
      NOVEL_COMPANION_ALLOW_TEST_URI: '1',
      NOVEL_COMPANION_TEST_MONGODB_URI: server.getUri(),
      NOVEL_COMPANION_USER_DATA: mkdtempSync(join(tmpdir(), 'nc-package-')),
      // T-4: under the exception, with a local test database, the recorded Claude is honoured.
      NOVEL_COMPANION_TEST_CLAUDE: '1',
      NOVEL_COMPANION_TEST_ANTHROPIC_KEY: 'sk-ant-api03-package-key-0123456789abcdef',
      // The packaged app holds no fixtures, so the recordings are named from the checkout.
      NOVEL_COMPANION_TEST_CLAUDE_RECORDINGS: join(ROOT, 'fixtures/claude/recordings.json'),
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
  await expect(page.getByTestId('rail')).toBeVisible();
  await expect(page.getByTestId('rail').getByRole('button', { name: 'Questions' })).toBeVisible();

  // The data folder came from the environment, not ~/Library/Application Support.
  const userData = await app.evaluate(({ app: electron }) => electron.getPath('userData'));
  expect(userData).toContain('nc-package-');
  // The proposal seam is refused in every packaged build; the recorded Claude and its key in
  // memory are honoured under the exception, so the keychain is never read.
  const seam = await page.evaluate(async () => {
    try {
      await window.api.invoke('test.propose', {
        source: 'import',
        op: 'create',
        collection: 'facts',
        data: { title: 'x' },
      } as never);
      return 'registered';
    } catch {
      return 'refused';
    }
  });
  expect(seam).toBe('refused');
  const status = await page.evaluate(() => window.api.invoke('claude.status', {}));
  expect(status.key).toEqual({ set: true, masked: expect.stringMatching(/^sk-ant-.*cdef$/) });
});
