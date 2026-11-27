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
  // A57: the message says what went wrong; the Try again button beside it is the next step.
  await expect(banner.getByTestId('connection-message')).toContainText(
    'The app could not reach the MongoDB deployment.',
  );
  await expect(banner.getByTestId('connection-message')).not.toContainText(/click|try again/i);
  await expect(banner.getByTestId('connection-retry')).toHaveText('Try again');
  await expect(banner.getByTestId('connection-message')).toContainText('no local snapshot');
  await expect(banner.getByTestId('open-snapshot')).toHaveCount(0);
  await expect(banner).not.toContainText(/ECONNREFUSED|Mongo\w*Error/);
  // The connection string can be fixed from here, without a bible open.
  await expect(page.getByTestId('mongo-settings')).toBeVisible();
  await expect(page.getByTestId('mongo-input')).toBeEnabled();
  await stop();
});

test('A57 ARCH-6 on the launch screen the connection string field tests a paste and opens the bibles when it connects', async () => {
  const bad = await closedUri();
  await start(bad, mkdtempSync(join(tmpdir(), 'nc-e2e-first-')));
  await expect(page.getByTestId('connection-banner')).toBeVisible({ timeout: 30_000 });
  const status = page.getByTestId('mongo-status');
  await expect(status).toContainText('Not reachable · mongodb://…');
  await expect(page.locator('body')).not.toContainText(bad);
  const input = page.getByTestId('mongo-input');
  await expect(input).toHaveAttribute('type', 'password');
  await input.focus();
  await input.evaluate((el, t) => {
    const data = new DataTransfer();
    data.setData('text/plain', t);
    el.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    );
  }, server.getUri());
  await expect(page.getByTestId('connection-banner')).toHaveCount(0, { timeout: 60_000 });
  await expect(page.getByTestId('bible-list')).toContainText(NAME);
  await expect(page.locator('body')).not.toContainText(server.getUri());
  await stop();
});

test('A57 NF-3 ARCH-6 at launch with MongoDB unreachable, the message says only what went wrong, the button names the snapshot it opens, and it opens read-only: views and search work, every write is off with the reason', async () => {
  // Online first: opening the bible takes the day's snapshot.
  await start(server.getUri());
  await invoke('bible.open', { slug: SLUG });
  await expect(page.getByTestId('workspace')).toBeVisible();
  await expect(page.getByTestId('connection-banner')).toHaveCount(0);
  await stop();

  await start(await closedUri());
  const banner = page.getByTestId('connection-banner');
  await expect(banner).toHaveAttribute('data-state', 'unavailable', { timeout: 30_000 });
  // A57 NF-3: the message says what went wrong; Try again and the snapshot button are the next steps.
  await expect(banner.getByTestId('connection-message')).toHaveText(
    'The app could not reach the MongoDB deployment.',
  );
  await expect(banner).not.toContainText(/Until then|you can open/i);
  await expect(banner.getByTestId('connection-retry')).toHaveText('Try again');
  const snapshot = (await invoke('connection.status', {})).snapshot!;
  const takenAt = await page.evaluate(
    (iso) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }),
    snapshot.takenAt,
  );
  await expect(banner.getByTestId('open-snapshot')).toHaveText(
    `Open ${NAME} from ${takenAt} read-only`,
  );
  await banner.getByTestId('open-snapshot').click();
  await expect(banner).toHaveAttribute('data-state', 'readOnly');
  await expect(page.getByTestId('read-only-reason')).toContainText(READ_ONLY_REASON);
  await expect(page.getByTestId('workspace')).toBeVisible();
  await expect(page.getByTestId('current-bible')).toHaveText(NAME);

  // Reading works: an entry, search, and the deterministic views.
  await openMargaret();
  const editor = page.getByTestId('editor');
  await expect(field(editor, 'role').getByRole('textbox').first()).toBeDisabled();
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
  await expect(page.getByTestId('tree-svg')).toBeVisible();

  // Write controls elsewhere are off too, and main refuses a write that gets through anyway.
  await rail(page, 'Backups').click();
  await expect(page.getByTestId('snapshot-take')).toBeDisabled();
  await rail(page, 'Settings').click();
  await expect(page.getByTestId('settings-snapshot-keep')).toBeDisabled();
  // CC-1: the alignment check writes findings, so its run button is off with the reason.
  await rail(page, 'Continuity checker').click();
  await expect(page.getByTestId('alignment-run')).toBeDisabled();
  await expect(page.getByTestId('alignment-run')).toHaveAttribute('title', READ_ONLY_REASON);
  await expect(
    invoke('entry.update', { collection: 'characters', id: 'H1', patch: { role: 'X' } }),
  ).rejects.toThrow(/read-only snapshot/);
  const h1 = await invoke('entry.get', { collection: 'characters', id: 'H1' });
  expect(h1.entry.role).not.toBe('X');
  await stop();
});

test('ARCH-6 when MongoDB goes away mid-session, an edit shows Not saved, never Saved, and the window offers the snapshot', async () => {
  await start(server.getUri());
  await invoke('bible.open', { slug: SLUG });
  await openMargaret();
  const autosave = page.getByTestId('editor').getByTestId('autosave').first();
  await expect(autosave).toHaveText('Saved');
  await server.stop({ doCleanup: false, force: true });

  await field(page.getByTestId('editor'), 'role').getByRole('textbox').first().fill('Lost town');
  await expect(autosave).toContainText('Not saved', { timeout: 60_000 });
  await expect(autosave).toContainText('lost its connection to MongoDB');
  await expect(autosave).not.toHaveText('Saved');
  const banner = page.getByTestId('connection-banner');
  await expect(banner).toHaveAttribute('data-state', 'unavailable', { timeout: 30_000 });
  await expect(banner.getByTestId('open-snapshot')).toBeVisible();
  // The typed text is still in the field, so nothing is lost on screen either.
  await expect(field(page.getByTestId('editor'), 'role').getByRole('textbox').first()).toHaveText(
    'Lost town',
  );
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
  const role = () => field(page.getByTestId('editor'), 'role').getByRole('textbox').first();
  await expect(editor.getByTestId('autosave').first()).toHaveText('Saved');
  await member.stop({ doCleanup: false, force: true });

  // The lost connection shows on the next write, and the snapshot opens read-only mid-session.
  await role().fill('Offline town');
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
  await expect(role()).toBeDisabled();
  await expect(role()).not.toHaveText('Offline town');

  // MongoDB is back: Try again closes the snapshot and opens the live bible, writable again.
  await member.start(true);
  await banner.getByTestId('connection-retry').click();
  await expect(page.getByTestId('connection-banner')).toHaveCount(0, { timeout: 60_000 });
  expect((await invoke('connection.status', {})).state).toBe('connected');
  await expect(page.getByTestId('current-bible')).toHaveText(NAME);
  await openMargaret();
  await expect(role()).toBeEnabled();
  await role().fill('Back online');
  await expect(page.getByTestId('editor').getByTestId('autosave').first()).toHaveText('Saved', {
    timeout: 30_000,
  });
  const h1 = await invoke('entry.get', { collection: 'characters', id: 'H1' });
  expect(h1.entry.role).toBe('Back online');
  await stop();
  await own.stop();
});

/** A server of its own with the fixture bible, whose one member stops and starts with its data and port. */
async function ownServer(): Promise<MongoMemoryReplSet> {
  const own = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });
  const store = await connect(own.getUri());
  await loadFixture(store, SLUG);
  await store.close();
  return own;
}

test('A57 ARCH-8 with MongoDB out of reach at launch, Try again opens the bible used last once it answers', async () => {
  const own = await ownServer();
  const member = own.servers[0]!;
  const data = mkdtempSync(join(tmpdir(), 'nc-e2e-last-'));
  try {
    await start(own.getUri(), data);
    await invoke('bible.open', { slug: SLUG });
    await expect(page.getByTestId('workspace')).toBeVisible();
    await stop();

    await member.stop({ doCleanup: false, force: true });
    await start(own.getUri(), data);
    const banner = page.getByTestId('connection-banner');
    await expect(banner).toHaveAttribute('data-state', 'unavailable', { timeout: 30_000 });
    await expect(page.getByTestId('workspace')).toHaveCount(0);

    await member.start(true);
    await banner.getByTestId('connection-retry').click();
    await expect(page.getByTestId('connection-banner')).toHaveCount(0, { timeout: 60_000 });
    await expect(page.getByTestId('workspace')).toBeVisible();
    await expect(page.getByTestId('current-bible')).toHaveText(NAME);
    expect((await invoke('connection.status', {})).state).toBe('connected');
  } finally {
    await stop();
    await own.stop();
  }
});

test('A57 ARCH-8 a snapshot opened read-only is never reopened at launch; the bible opened last from MongoDB is', async () => {
  const fs = await import('node:fs');
  const own = await ownServer();
  const member = own.servers[0]!;
  const data = mkdtempSync(join(tmpdir(), 'nc-e2e-snap-'));
  try {
    // Online: the fixture bible opens (its snapshot is taken), then another bible opens last.
    await start(own.getUri(), data);
    await invoke('bible.open', { slug: SLUG });
    await invoke('bible.create', { slug: 'other', name: 'Other novel' });
    await invoke('bible.open', { slug: 'other' });
    await expect(page.getByTestId('current-bible')).toHaveText('Other novel');
    await stop();
    // Only the fixture bible keeps a snapshot, so the read-only one below is of it.
    fs.rmSync(join(data, 'snapshots', 'other'), { recursive: true, force: true });

    await member.stop({ doCleanup: false, force: true });
    await start(own.getUri(), data);
    const banner = page.getByTestId('connection-banner');
    await expect(banner).toHaveAttribute('data-state', 'unavailable', { timeout: 30_000 });
    await expect(banner.getByTestId('open-snapshot')).toContainText(`Open ${NAME} from`);
    await banner.getByTestId('open-snapshot').click();
    await expect(banner).toHaveAttribute('data-state', 'readOnly');
    await expect(page.getByTestId('current-bible')).toHaveText(NAME);
    await stop();

    // MongoDB is back: the next launch opens the bible opened last from MongoDB, writable.
    await member.start(true);
    await start(own.getUri(), data);
    await expect(page.getByTestId('current-bible')).toHaveText('Other novel', { timeout: 60_000 });
    await expect(page.getByTestId('connection-banner')).toHaveCount(0);
    expect(JSON.parse(fs.readFileSync(join(data, 'last-bible.json'), 'utf8'))).toEqual({
      bible: 'other',
    });
  } finally {
    await stop();
    await own.stop();
  }
});
