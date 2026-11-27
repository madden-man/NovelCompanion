import { expect, test } from '@playwright/test';
import type { Store } from '../../src/main/db';
import { field, fillEditable } from '../e2e/helpers';
import {
  SLUG,
  TEST_KEY,
  connectTo,
  openCharacter,
  openFixture,
  pasteKey,
  seedFixtureNovel,
  startWebServer,
  webDb,
} from './server';
import type { WebDb, WebServer } from './server';

/**
 * A58 P4: the phone client on WebKit at iPhone 15 size, through the local
 * function (`scripts/serve-web.ts`) on the fixture novel.
 */
let db: WebDb;
let server: WebServer;
let store: Store;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  db = webDb();
  await seedFixtureNovel(db);
  store = await connectTo(db);
  server = await startWebServer(db);
});

test.afterAll(async () => {
  await server?.stop();
  await store?.close();
});

const stored = async (id: string) =>
  (await store.db.collection(`${SLUG}.characters`).findOne({ _id: id as never })) as unknown as {
    role?: string;
    names: { full: string };
  };

test('PH-16 with no key kept, the first screen is one field with Paste and nothing else', async ({
  page,
}) => {
  await page.goto(server.url);
  const gate = page.getByTestId('key-gate');
  await expect(gate).toBeVisible();
  await expect(gate.locator('input')).toHaveCount(1);
  await expect(gate.getByRole('button')).toHaveText(['Paste']);
  // Nothing else: no heading, no instruction text, no bible data.
  expect((await gate.innerText()).trim()).toBe('Paste');
  await expect(page.getByTestId('workspace')).toHaveCount(0);
  // PH-32: the field is 16px or more, so iOS does not zoom into it.
  const size = await gate
    .locator('input')
    .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  expect(size).toBeGreaterThanOrEqual(16);
});

test('PH-16 a wrong key is refused, said so in the field, and not kept', async ({ page }) => {
  await page.goto(server.url);
  await pasteKey(page, 'not-the-key');
  await expect(page.getByTestId('key-refused')).toHaveText('The phone key was not accepted.');
  await expect(page.getByTestId('key-input')).toHaveAttribute('aria-invalid', 'true');
  expect(await page.evaluate(() => localStorage.getItem('nc.phoneKey'))).toBeNull();
  await page.reload();
  await expect(page.getByTestId('key-gate')).toBeVisible();
});

test('PH-16 PH-12 the accepted key is kept, the fixture novel loads, and an entry saves a field through /rpc', async ({
  page,
}) => {
  const rpc: string[] = [];
  page.on('request', (r) => {
    if (r.url().endsWith('/rpc')) rpc.push(JSON.parse(r.postData() ?? '{}').channel as string);
  });
  await openFixture(page, server.url);
  expect(await page.evaluate(() => localStorage.getItem('nc.phoneKey'))).toBe(TEST_KEY);
  const person = await openCharacter(page, /^Margaret Hale/);
  await fillEditable(field(person, 'names.full'), 'Margaret Hale-Lin');
  await expect.poll(async () => (await stored('H1')).names.full).toBe('Margaret Hale-Lin');
  expect(rpc).toContain('entry.update');
  // The write's own event redrew the list (PH-12).
  await expect(page.getByTestId('entry-list')).toContainText('Margaret Hale-Lin');
  // The key survives a reload, and the app opens on the bible it was on.
  await page.reload();
  await expect(page.getByTestId('workspace')).toBeVisible();
  await expect(page.getByTestId('key-gate')).toHaveCount(0);
});

test('PH-5 PH-26 no control whose channel is desk only is drawn on the phone', async ({ page }) => {
  await openFixture(page, server.url);
  const shell = page.getByTestId('workspace');
  // A58 U1: the rail and the App menu became the bottom bar and the bible menu's More.
  await page.getByTestId('bible-menu-button').click();
  const more = page.getByTestId('bible-sheet');
  await expect(more.getByTestId('phone-more')).toContainText('Family tree');
  // No Continuity checker (the alignment check and the Word import), Review queue,
  // From the notebook or Backups.
  for (const gone of ['Continuity checker', 'Review queue', 'From the notebook', 'Backups']) {
    await expect(more.getByRole('button', { name: gone })).toHaveCount(0);
  }
  // The chooser: no New bible.
  await expect(page.getByTestId('bible-menu-new')).toHaveCount(0);
  // No Ask Claude, and the Claude panel is not mounted.
  await expect(shell.getByRole('button', { name: /Ask Claude/ })).toHaveCount(0);
  await more.getByRole('button', { name: 'Settings' }).click();
  const settings = page.getByTestId('settings-view');
  await expect(settings).toBeVisible();
  for (const id of [
    'claude-settings',
    'mongo-settings-section',
    'settings-snapshots',
    'phone-key-settings',
  ]) {
    await expect(settings.getByTestId(id)).toHaveCount(0);
  }
  await expect(settings.getByTestId('appearance-settings')).toBeVisible();
  // The family tree: no Export.
  await page.getByTestId('bible-menu-button').click();
  await page.getByTestId('phone-more').getByRole('button', { name: 'Family tree' }).click();
  await expect(page.getByRole('button', { name: 'Tidy layout' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Export', exact: true })).toHaveCount(0);
});

test('PH-17 a changed key signs the phone out: the key is forgotten, the bible leaves the screen, the paste screen shows', async ({
  page,
}) => {
  await openFixture(page, server.url);
  await openCharacter(page, /^Peter Hale/);
  // The site's key changes.
  const port = Number(new URL(server.url).port);
  await server.stop();
  server = await startWebServer(db, { NC_PHONE_KEY: 'a-new-key-on-the-site' }, port);
  // The next answer is 401: here, the phone coming back to the front checks the bible.
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.getByTestId('key-gate')).toBeVisible();
  await expect(page.getByTestId('workspace')).toHaveCount(0);
  await expect(page.getByText('Peter Hale')).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('nc.phoneKey'))).toBeNull();
  // The new key opens it again.
  await pasteKey(page, 'a-new-key-on-the-site');
  await expect(page.getByRole('button', { name: 'Open Fixture novel' })).toBeVisible();
  await server.stop();
  server = await startWebServer(db, {}, port);
});
