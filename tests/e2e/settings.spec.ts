import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { Invoke } from '../helpers/t5';
import { fileDb, invokeVia, launch, rail } from './helpers';
import type { TestDb } from './helpers';

const SLUG = 'settings';
const KEY = 'sk-ant-api03-e2e-test-key-0123456789abcdef';
let db: TestDb;
let app: ElectronApplication | null = null;
let page: Page;
let invoke: Invoke;
/** One data folder across launches: app-wide settings live there, per-bible ones in MongoDB. */
const userData = mkdtempSync(join(tmpdir(), 'nc-e2e-settings-'));

async function start(): Promise<void> {
  ({ app, page } = await launch(db, { NOVEL_COMPANION_USER_DATA: userData }));
  invoke = invokeVia(page);
}

async function openSettings(): Promise<Locator> {
  await invoke('bible.open', { slug: SLUG });
  await expect(page.getByTestId('workspace')).toBeVisible();
  await rail(page, 'Settings').click();
  const view = page.getByTestId('settings-view');
  await expect(view).toBeVisible();
  return view;
}

async function closedUri(): Promise<string> {
  const port = await new Promise<number>((resolve) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port: p } = srv.address() as { port: number };
      srv.close(() => resolve(p));
    });
  });
  return `mongodb://127.0.0.1:${port}/?directConnection=true`;
}

test.beforeAll(async () => {
  db = fileDb();
  await start();
  await invoke('bible.create', { slug: SLUG, name: 'Settings' });
});

test.afterAll(async () => {
  await app?.close();
});

test('ST-1 every setting changed in Settings, by keyboard, is kept after the app restarts', async () => {
  const view = await openSettings();
  // Per-feature model (DB-4).
  const summaries = view.getByTestId('claude-model-summaries');
  await summaries.focus();
  await summaries.selectOption('claude-haiku-5-5');
  // Brief window and size budget (SB-2, SB-6): typed, then Tab moves on and saves.
  const briefs = view.getByTestId('settings-briefs');
  await briefs.getByLabel('World events window (years before, plus one ahead)').fill('7');
  await page.keyboard.press('Tab');
  await briefs.getByLabel('Size budget (characters)').fill('12345');
  await page.keyboard.press('Tab');
  // Romanization per language (GL-1).
  await view.getByTestId('settings-romanization-cantonese').selectOption('');
  await expect(view.getByTestId('settings-romanization')).toContainText(
    'Saved the romanization system for Cantonese.',
  );
  // Snapshot count (BK-1).
  const keep = view.getByTestId('settings-snapshot-keep');
  await keep.fill('12');
  await keep.press('Enter');
  await expect(view.getByTestId('settings-snapshots')).toContainText(
    'Saved. The newest 12 snapshots are kept.',
  );
  // Appearance, chosen with the keyboard: focus the group, arrow to Dark.
  await view.getByTestId('appearance-system').focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(view.getByTestId('appearance-dark')).toBeChecked();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  await expect
    .poll(async () => {
      const s = await invoke('brief.settings.get', {});
      return [s.window, s.budget];
    })
    .toEqual([7, 12345]);
  expect((await invoke('snapshot.list', {})).keep).toBe(12);
  expect((await invoke('appearance.get', {})).appearance).toBe('dark');

  await app?.close();
  await start();
  // Appearance is applied at launch, before any bible opens.
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  const again = await openSettings();
  await expect(again.getByTestId('claude-model-summaries')).toHaveValue('claude-haiku-5-5');
  await expect(again.getByLabel('World events window (years before, plus one ahead)')).toHaveValue(
    '7',
  );
  await expect(again.getByLabel('Size budget (characters)')).toHaveValue('12345');
  await expect(again.getByTestId('settings-romanization-cantonese')).toHaveValue('');
  await expect(again.getByTestId('settings-romanization-mandarin')).not.toHaveValue('');
  await expect(again.getByTestId('settings-snapshot-keep')).toHaveValue('12');
  await expect(again.getByTestId('appearance-dark')).toBeChecked();
});

test('ST-1 appearance applies live, light, dark, or the system, without a reload', async () => {
  const view = await openSettings();
  const background = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await view.getByTestId('appearance-light').check();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  const light = await background();
  await view.getByTestId('appearance-dark').check();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect.poll(background).not.toBe(light);
  await view.getByTestId('appearance-system').check();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'system');
  expect((await invoke('appearance.get', {})).appearance).toBe('system');
  // Every choice is reachable by keyboard and labelled.
  for (const label of ['Match the system', 'Light', 'Dark']) {
    await expect(view.getByRole('radio', { name: label })).toBeVisible();
  }
});

test('ST-1 the API key and the MongoDB connection string are shown masked, never in full', async () => {
  const view = await openSettings();
  await view.getByTestId('claude-key-input').fill(KEY);
  await view.getByTestId('claude-key-save').click();
  await expect(view.getByTestId('claude-key-status')).toContainText('sk-ant-…cdef');
  const status = view.getByTestId('mongo-status');
  await expect(status).toContainText('A connection string is stored in memory');
  await expect(status).toContainText('mongodb://…');
  const uri = db.uri;
  const host = new URL(uri).host;
  await expect(page.locator('body')).not.toContainText(uri);
  await expect(page.locator('body')).not.toContainText(host);
  await expect(page.locator('body')).not.toContainText(KEY);
  const wire = await invoke('mongo.status', {});
  expect(JSON.stringify(wire)).not.toContain(host);
  expect(wire.masked).toBe(`mongodb://…${host.slice(-10)}`);
  await expect(view.getByTestId('mongo-input')).toHaveAttribute('type', 'password');
});

test('ST-1 NF-3 a setting that cannot be read, or a key that cannot be removed, says so on screen', async () => {
  // Main answers these channels with a failure, as a broken settings file or keychain would.
  const fail = (channels: string[]) =>
    app!.evaluate(({ ipcMain }, list) => {
      for (const c of list) {
        ipcMain.removeHandler(`nc:${c}`);
        ipcMain.handle(`nc:${c}`, () => {
          throw new Error('The keychain did not answer. Restart the app, then try again.');
        });
      }
    }, channels);
  await fail(['snapshot.list', 'appearance.get', 'claude.clearKey']);
  try {
    await invoke('claude.setKey', { key: KEY });
    // Leave Settings first, so it mounts again and reads every setting afresh.
    await rail(page, 'Characters').click();
    const view = await openSettings();
    await expect(view.getByTestId('settings-snapshots-failed')).toHaveText(
      'The snapshot setting could not be read. The keychain did not answer. Restart the app, then try again.',
    );
    await expect(view.getByTestId('appearance-failed')).toContainText(
      'The appearance setting could not be read.',
    );
    await expect(view.getByText('Loading the snapshot setting.')).toHaveCount(0);
    await view.getByRole('button', { name: 'Remove key' }).click();
    await expect(view.getByTestId('claude-key-note')).toHaveText(
      'The key was not removed. The keychain did not answer. Restart the app, then try again.',
    );
    await expect(view.getByTestId('claude-key-status')).toContainText('A key is stored');
  } finally {
    // A fresh launch registers the real handlers again.
    await app?.close();
    await start();
  }
});

test('ST-1 Test connection reports success and failure plainly; Replace switches only after the test passes', async () => {
  const view = await openSettings();
  const note = view.getByTestId('mongo-note');
  // The stored string, with the box empty.
  await view.getByTestId('mongo-test').click();
  await expect(note).toContainText('Connected. MongoDB answered');
  // A string that cannot connect: plain words, nothing saved.
  const before = await view.getByTestId('mongo-status').textContent();
  const bad = await closedUri();
  await view.getByTestId('mongo-input').fill(bad);
  await view.getByTestId('mongo-test').click();
  await expect(note).toContainText(/Nothing answered at that address|did not answer in time/, {
    timeout: 30_000,
  });
  await expect(note).not.toContainText(/ECONNREFUSED|Error/);
  await view.getByTestId('mongo-replace').click();
  await expect(note).toContainText('The connection string was not changed.', { timeout: 30_000 });
  await expect(view.getByTestId('mongo-status')).toHaveText(before ?? '');
  // The bible is still open on the old connection.
  expect((await invoke('bible.current', {})).bible?.id).toBe(SLUG);

  // A second deployment that connects: the app switches to it after the test passes.
  const other = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });
  try {
    await view.getByTestId('mongo-input').fill(other.getUri());
    await view.getByTestId('mongo-replace').click();
    await expect(page.getByTestId('no-bibles')).toBeVisible({ timeout: 30_000 });
    // That deployment has no bible "settings", so the app went back to the list, now from it.
    expect((await invoke('bible.list', {})).bibles).toEqual([]);
    const otherHost = new URL(other.getUri()).host;
    expect((await invoke('mongo.status', {})).masked).toBe(`mongodb://…${otherHost.slice(-10)}`);
    await expect(page.locator('body')).not.toContainText(other.getUri());
  } finally {
    await app?.close();
    app = null;
    await other.stop();
  }
});
