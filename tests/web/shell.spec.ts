import { expect, test } from '@playwright/test';
import type { Store } from '../../src/main/db';
import { field } from '../e2e/helpers';
import {
  SLUG,
  connectTo,
  openCharacter,
  openFixture,
  seedFixtureNovel,
  setVisible,
  startWebServer,
  webDb,
} from './server';
import type { WebDb, WebServer } from './server';

/** A58 P4 (PH-21, PH-24): the installed shell, its build id and its service worker. */
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
    names: { full: string };
  };

test.describe('with the service worker', () => {
  test.use({ serviceWorkers: 'allow' });

  test('PH-24 the manifest, icons and meta tags make an installable app', async ({ page }) => {
    await page.goto(server.url);
    const head = page.locator('head');
    await expect(head.locator('meta[name="viewport"]')).toHaveAttribute(
      'content',
      /viewport-fit=cover/,
    );
    await expect(head.locator('link[rel="apple-touch-icon"]')).toHaveAttribute(
      'href',
      '/icons/apple-touch-icon.png',
    );
    await expect(head.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
    const csp = await head
      .locator('meta[http-equiv="Content-Security-Policy"]')
      .getAttribute('content');
    expect(csp).toContain("connect-src 'self'");
    expect(csp).not.toMatch(/connect-src[^;]*(https?:|ws:|\*)/);
    const manifest = (await (
      await page.request.get(`${server.url}/manifest.webmanifest`)
    ).json()) as {
      name: string;
      display: string;
      icons: { src: string }[];
    };
    expect(manifest.name).toBe('Novel Companion');
    expect(manifest.display).toBe('standalone');
    for (const icon of manifest.icons) {
      const res = await page.request.get(`${server.url}${icon.src}`);
      expect(res.headers()['content-type']).toBe('image/png');
    }
  });

  test('PH-24 the shell opens with no connection, and the lost connection shows the banner with no snapshot', async ({
    page,
  }) => {
    await openFixture(page, server.url);
    await page.evaluate(() => navigator.serviceWorker.ready);
    await expect
      .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null))
      .toBe(true);
    // No connection at all: the local server is gone.
    const port = Number(new URL(server.url).port);
    await server.stop();
    await page.reload();
    const banner = page.getByTestId('connection-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toHaveAttribute('data-state', 'unavailable');
    await expect(banner.getByTestId('connection-message')).toHaveText(
      'The phone has no connection to the bible.',
    );
    await expect(page.getByTestId('open-snapshot')).toHaveCount(0);
    await expect(page.getByTestId('key-gate')).toHaveCount(0);
    // Back again: Try again clears the banner and the bible opens.
    server = await startWebServer(db, {}, port);
    await page.getByTestId('connection-retry').click();
    await expect(banner).toHaveCount(0);
    await expect(page.getByTestId('workspace')).toBeVisible();
  });
});

test('PH-24 an edit made while the connection is lost is not shown as saved and is not stored', async ({
  page,
}) => {
  await openFixture(page, server.url);
  const person = await openCharacter(page, /^Ruth Hale/);
  const port = Number(new URL(server.url).port);
  await server.stop();
  const f = field(person, 'names.full');
  await f.locator('.editable-text').first().click();
  await f.locator('input').fill('Ruth Hale Offline');
  await f.locator('input').press('Enter');
  await expect(page.getByTestId('connection-banner')).toBeVisible();
  // The field stays open with the typing and says it was not stored.
  await expect(f.locator('.editable-error')).toContainText(
    'The phone has no connection to the bible.',
  );
  await expect(f.locator('input')).toHaveValue('Ruth Hale Offline');
  server = await startWebServer(db, {}, port);
  expect((await stored('H4')).names.full).toBe('Ruth Hale');
});

test('PH-21 a new build id reloads the app only once no field holds typing', async ({ page }) => {
  await openFixture(page, server.url);
  const person = await openCharacter(page, /^Daniel Hale/);
  const f = field(person, 'names.full');
  await f.locator('.editable-text').first().click();
  const input = f.locator('input');
  await input.fill('Daniel Hale Junior');
  await page.evaluate(() => ((window as unknown as { __before: boolean }).__before = true));

  // From now on the function answers as a newer build.
  await page.route('**/rpc', async (route) => {
    const res = await route.fetch();
    await route.fulfill({
      response: res,
      headers: { ...res.headers(), 'x-nc-build': 'newer-build' },
    });
  });
  await setVisible(page, true);
  await page.waitForTimeout(2500);
  // Typing is held: no reload.
  expect(await page.evaluate(() => (window as unknown as { __before?: boolean }).__before)).toBe(
    true,
  );
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('Daniel Hale Junior');

  // The field is stored; at the next moment with no typing the app reloads, once.
  const loaded = page.waitForEvent('load');
  await input.press('Enter');
  await loaded;
  await expect(page.getByTestId('workspace')).toBeVisible();
  expect(
    await page.evaluate(() => (window as unknown as { __before?: boolean }).__before),
  ).toBeUndefined();
  expect((await stored('H3')).names.full).toBe('Daniel Hale Junior');
  await page.evaluate(() => ((window as unknown as { __after: boolean }).__after = true));
  await setVisible(page, true);
  await page.waitForTimeout(2500);
  expect(await page.evaluate(() => (window as unknown as { __after?: boolean }).__after)).toBe(
    true,
  );
});

test('PH-21 a new build id never reloads while a field off focus still holds typing not yet stored', async ({
  page,
}) => {
  await openFixture(page, server.url);
  await page.getByTestId('tab-add').tap();
  const box = page
    .locator('[data-testid="phone-capture"]:visible')
    .getByTestId('phone-capture-input');
  await expect(box).toBeFocused();
  await box.fill('Margaret kept a diary in 1979.');
  // Focus leaves the box, as when a chip opens its sheet: the sentence is not filed yet.
  await box.evaluate((el) => (el as HTMLElement).blur());
  await expect(box).not.toBeFocused();
  await page.evaluate(() => ((window as unknown as { __before: boolean }).__before = true));
  await page.route('**/rpc', async (route) => {
    const res = await route.fetch();
    await route.fulfill({
      response: res,
      headers: { ...res.headers(), 'x-nc-build': 'newest-build' },
    });
  });
  await setVisible(page, true);
  await page.waitForTimeout(2500);
  expect(await page.evaluate(() => (window as unknown as { __before?: boolean }).__before)).toBe(
    true,
  );
  await expect(box).toHaveValue('Margaret kept a diary in 1979.');
  // The box is emptied (as filing does): the app reloads at the next moment.
  const loaded = page.waitForEvent('load');
  await box.fill('');
  await box.evaluate((el) => (el as HTMLElement).blur());
  await loaded;
  await expect(page.getByTestId('workspace')).toBeVisible();
});
