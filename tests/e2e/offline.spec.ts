import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { connect } from '../../src/main/db';
import { READ_ONLY_REASON } from '../../src/shared/ipcApp';
import { loadFixture } from '../helpers/loadFixture';
import type { Invoke } from '../helpers/t5';
import { field, invokeVia, launch, rail } from './helpers';

const SLUG = 'offline';
/** The fixture bible's name, which the snapshot keeps (ARCH-6). */
const NAME = 'Fixture novel';
let server: MongoMemoryReplSet;
let app: ElectronApplication | null = null;
let page: Page;
let invoke: Invoke;
/** One data folder across launches, so the snapshot taken online is there offline. */
const userData = mkdtempSync(join(tmpdir(), 'nc-e2e-offline-'));

/** A local address nothing listens on. */
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

async function start(uri: string, data = userData): Promise<void> {
  ({ app, page } = await launch(uri, { NOVEL_COMPANION_USER_DATA: data }));
  invoke = invokeVia(page);
}

async function stop(): Promise<void> {
  await app?.close();
  app = null;
}

async function openMargaret(): Promise<void> {
  await rail(page, 'Characters').click();
  await page
    .locator('.ws-list')
    .getByRole('button', { name: /Margaret Hale/ })
    .first()
    .click();
  await expect(page.getByTestId('editor')).toBeVisible();
}

test.beforeAll(async () => {
  server = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  const store = await connect(server.getUri());
  await loadFixture(store, SLUG);
  await store.close();
});

test.afterAll(async () => {
  await stop();
  await server?.stop().catch(() => undefined);
});

test('ARCH-6 at launch with MongoDB unreachable and no snapshot yet, the window says so and what to do', async () => {
  await start(await closedUri(), mkdtempSync(join(tmpdir(), 'nc-e2e-empty-')));
  const banner = page.getByTestId('connection-banner');
  await expect(banner).toBeVisible({ timeout: 30_000 });
  await expect(banner).toHaveAttribute('data-state', 'unavailable');
  await expect(banner.getByTestId('connection-message')).toContainText(
    'could not reach the MongoDB deployment. Check your network connection, then click Try again.',
  );
  await expect(banner.getByTestId('connection-message')).toContainText('no local snapshot');
  await expect(banner.getByTestId('open-snapshot')).toHaveCount(0);
  await expect(banner).not.toContainText(/ECONNREFUSED|Mongo\w*Error/);
  // The connection string can be fixed from here, without a bible open.
  await expect(page.getByTestId('mongo-settings')).toBeVisible();
  await expect(page.getByTestId('mongo-test')).toBeEnabled();
  await stop();
});

test('ARCH-6 at launch with MongoDB unreachable, the latest snapshot opens read-only: views and search work, every write is off with the reason', async () => {
  // Online first: opening the bible takes the day's snapshot.
  await start(server.getUri());
  await invoke('bible.open', { slug: SLUG });
  await expect(page.getByTestId('workspace')).toBeVisible();
  await expect(page.getByTestId('connection-banner')).toHaveCount(0);
  await stop();

  await start(await closedUri());
  const banner = page.getByTestId('connection-banner');
  await expect(banner).toHaveAttribute('data-state', 'unavailable', { timeout: 30_000 });
  await expect(banner).toContainText(`The most recent snapshot is of ${NAME}`);
  await banner.getByTestId('open-snapshot').click();
  await expect(banner).toHaveAttribute('data-state', 'readOnly');
  await expect(page.getByTestId('read-only-reason')).toContainText(READ_ONLY_REASON);
  await expect(page.getByTestId('workspace')).toBeVisible();
  await expect(page.getByTestId('current-bible')).toHaveText(NAME);

  // Reading works: an entry, search, and the deterministic views.
  await openMargaret();
  const editor = page.getByTestId('editor');
  await expect(field(editor, 'birthplace').locator('input').first()).toBeDisabled();
  // A38: the character page is several write groups, one per section; every one carries the reason.
  const groups = editor.locator('fieldset.write-group');
  await expect(groups.first()).toHaveAttribute('title', READ_ONLY_REASON);
  await expect(groups.last()).toHaveAttribute('title', READ_ONLY_REASON);
  const newButton = page.locator('.ws-list .list-head button');
  await expect(newButton).toBeDisabled();
  await expect(newButton).toHaveAttribute('title', READ_ONLY_REASON);
  await expect(newButton).toHaveAttribute('aria-describedby', 'read-only-reason');
  await expect(page.getByRole('button', { name: 'Move to trash' })).toBeDisabled();

  await page.locator('#rail-search').fill('Margaret');
  await expect(page.getByTestId('search-results')).toContainText('Margaret Hale');

  // KB-2: the year view is the Story Time dialog.
  await page.getByTestId('top-open-year').click();
  await expect(page.getByTestId('story-time-dialog').getByTestId('time-states')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('story-time-dialog')).toHaveCount(0);
  await rail(page, 'Family tree').click();
  await expect(page.locator('.tree-stage svg').first()).toBeVisible();

  // Write controls elsewhere are off too, and main refuses a write that gets through anyway.
  await rail(page, 'Backups').click();
  await expect(page.getByTestId('snapshot-take')).toBeDisabled();
  await rail(page, 'Settings').click();
  await expect(page.getByTestId('settings-snapshot-keep')).toBeDisabled();
  // CC-1: the alignment check writes findings, so its run button is off with the reason.
  await rail(page, 'Dashboard').click();
  await page.getByTestId('dashboard').getByRole('button', { name: 'Check alignment' }).click();
  await expect(page.getByTestId('alignment-run')).toBeDisabled();
  await expect(page.getByTestId('alignment-run')).toHaveAttribute('title', READ_ONLY_REASON);
  await expect(
    invoke('entry.update', { collection: 'characters', id: 'H1', patch: { birthplace: 'X' } }),
  ).rejects.toThrow(/read-only snapshot/);
  const h1 = await invoke('entry.get', { collection: 'characters', id: 'H1' });
  expect(h1.entry.birthplace).not.toBe('X');
  await stop();
});

test('ARCH-6 when MongoDB goes away mid-session, an edit shows Not saved, never Saved, and the window offers the snapshot', async () => {
  await start(server.getUri());
  await invoke('bible.open', { slug: SLUG });
  await openMargaret();
  const autosave = page.getByTestId('editor').getByTestId('autosave').first();
  await expect(autosave).toHaveText('Saved');
  await server.stop({ doCleanup: false, force: true });

  await field(page.getByTestId('editor'), 'birthplace').locator('input').first().fill('Lost town');
  await expect(autosave).toContainText('Not saved', { timeout: 60_000 });
  await expect(autosave).toContainText('lost its connection to MongoDB');
  await expect(autosave).not.toHaveText('Saved');
  const banner = page.getByTestId('connection-banner');
  await expect(banner).toHaveAttribute('data-state', 'unavailable', { timeout: 30_000 });
  await expect(banner.getByTestId('open-snapshot')).toBeVisible();
  // The typed text is still in the field, so nothing is lost on screen either.
  await expect(
    field(page.getByTestId('editor'), 'birthplace').locator('input').first(),
  ).toHaveValue('Lost town');
  await stop();
});

test('ARCH-6 mid-session, the snapshot opens read-only, and Try again reopens the live bible once MongoDB is back', async () => {
  // A server of its own, whose one member is stopped and started again with its data and port.
  const own = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });
  const member = own.servers[0]!;
  const store = await connect(own.getUri());
  await loadFixture(store, SLUG);
  await store.close();
  await start(own.getUri());
  await invoke('bible.open', { slug: SLUG });
  await openMargaret();
  const editor = page.getByTestId('editor');
  const birthplace = () => field(page.getByTestId('editor'), 'birthplace').locator('input').first();
  await expect(editor.getByTestId('autosave').first()).toHaveText('Saved');
  await member.stop({ doCleanup: false, force: true });

  // The lost connection shows on the next write, and the snapshot opens read-only mid-session.
  await birthplace().fill('Offline town');
  await expect(editor.getByTestId('autosave').first()).toContainText('Not saved', {
    timeout: 60_000,
  });
  const banner = page.getByTestId('connection-banner');
  await expect(banner).toHaveAttribute('data-state', 'unavailable', { timeout: 30_000 });
  await banner.getByTestId('open-snapshot').click();
  await expect(banner).toHaveAttribute('data-state', 'readOnly');
  await expect(page.getByTestId('read-only-reason')).toContainText(
    `You are looking at the snapshot of ${NAME}`,
  );
  await expect(page.getByTestId('current-bible')).toHaveText(NAME);
  await openMargaret();
  await expect(birthplace()).toBeDisabled();
  await expect(birthplace()).not.toHaveValue('Offline town');

  // MongoDB is back: Try again closes the snapshot and opens the live bible, writable again.
  await member.start(true);
  await banner.getByTestId('connection-retry').click();
  await expect(page.getByTestId('connection-banner')).toHaveCount(0, { timeout: 60_000 });
  expect((await invoke('connection.status', {})).state).toBe('connected');
  await expect(page.getByTestId('current-bible')).toHaveText(NAME);
  await openMargaret();
  await expect(birthplace()).toBeEnabled();
  await birthplace().fill('Back online');
  await expect(page.getByTestId('editor').getByTestId('autosave').first()).toHaveText('Saved', {
    timeout: 30_000,
  });
  const h1 = await invoke('entry.get', { collection: 'characters', id: 'H1' });
  expect(h1.entry.birthplace).toBe('Back online');
  await stop();
  await own.stop();
});
