import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { Store } from '../../src/main/db';
import { openBibleSession } from '../../src/main/db/session';
import type { OpenBible } from '../../src/main/db/session';
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

/**
 * A58 P4 (PH-9, PH-10, PH-13 on the phone): a repository in this test
 * process stands for the desk, writing to the same database as the local
 * function. The phone becomes visible through `visibilitychange`.
 */
let db: WebDb;
let server: WebServer;
let store: Store;
let desk: OpenBible;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  db = webDb();
  await seedFixtureNovel(db);
  store = await connectTo(db);
  desk = await openBibleSession(store, SLUG);
  server = await startWebServer(db);
});

test.afterAll(async () => {
  await server?.stop();
  await store?.close();
});

type Stored = { names: { full: string; chinese?: string }; role?: string };
const stored = async (id: string) =>
  (await store.db
    .collection(`${SLUG}.characters`)
    .findOne({ _id: id as never })) as unknown as Stored;

/** Count the reloads from elsewhere the phone fires. */
async function countReloads(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __elsewhere: number };
    w.__elsewhere = 0;
    window.api.on('bible.reloaded', (e) => {
      if (e.elsewhere) w.__elsewhere += 1;
    });
  });
  return () => page.evaluate(() => (window as unknown as { __elsewhere: number }).__elsewhere);
}

test('PH-9 the phone shows a desk write when it becomes visible, and fires bible.reloaded; its own writes do not', async ({
  page,
}) => {
  await openFixture(page, server.url);
  const person = await openCharacter(page, /^Margaret Hale/);
  const reloads = await countReloads(page);
  const chinese = field(person, 'names.chinese');

  // The phone's own write causes no reload.
  await desk.repo.freshen();
  await page.evaluate(() =>
    window.api.invoke(
      'entry.update',
      { collection: 'characters', id: 'H2', patch: { role: 'Phone wrote this' } },
      { bible: 'fixture-novel' },
    ),
  );
  await setVisible(page, true);
  await page.waitForTimeout(1000);
  expect(await reloads()).toBe(0);

  // The desk writes; nothing is read until the phone becomes visible.
  await desk.repo.freshen();
  await desk.repo.update('characters', 'H1', { names: { full: 'Margaret Hale', chinese: '海' } });
  await setVisible(page, true);
  await expect(chinese).toContainText('海');
  await expect.poll(reloads).toBe(1);
  // In place: no notice and no fresh workspace.
  await expect(page.getByTestId('reload-notice')).toHaveCount(0);
});

test('PH-9 while visible, the phone checks every 20 seconds', async ({ page }) => {
  await openFixture(page, server.url);
  const person = await openCharacter(page, /^Margaret Hale/);
  await desk.repo.freshen();
  await desk.repo.update('characters', 'H1', {
    names: { full: 'Margaret Hale', chinese: '海燕' },
  });
  await page.waitForTimeout(3000);
  await expect(field(person, 'names.chinese')).not.toContainText('海燕');
  await expect(field(person, 'names.chinese')).toContainText('海燕', { timeout: 25_000 });
});

test('PH-10 typing in an open field keeps its text, caret and focus through a reload from the desk, and is then stored', async ({
  page,
}) => {
  await openFixture(page, server.url);
  const person = await openCharacter(page, /^Margaret Hale/);
  const reloads = await countReloads(page);
  const f = field(person, 'names.chinese');
  await f.locator('.editable-text').first().click();
  const input = f.locator('input');
  await input.fill('海燕飞');
  await input.evaluate((el: HTMLInputElement) => el.setSelectionRange(1, 1));

  await desk.repo.freshen();
  await desk.repo.update('characters', 'H1', { role: 'Keeps the light' });
  await desk.repo.update('characters', 'H3', { role: 'Written on the desk' });
  await setVisible(page, true);
  await expect.poll(reloads).toBeGreaterThan(0);

  await expect(input).toBeFocused();
  await expect(input).toHaveValue('海燕飞');
  expect(
    await input.evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd]),
  ).toEqual([1, 1]);
  await input.press('Enter');
  await expect(f.locator('input')).toHaveCount(0);
  await expect.poll(async () => (await stored('H1')).names.chinese).toBe('海燕飞');
  expect((await stored('H1')).role).toBe('Keeps the light');
});

test('PH-13 hiding the app sends the typing not yet stored with keepalive requests under 64 KiB', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const real = window.fetch.bind(window);
    const w = window as unknown as { __keepalive: { keepalive: boolean; size: number }[] };
    w.__keepalive = [];
    window.fetch = (input, init) => {
      w.__keepalive.push({
        keepalive: init?.keepalive === true,
        size: new TextEncoder().encode(String(init?.body ?? '')).length,
      });
      return real(input, init);
    };
  });
  await openFixture(page, server.url);
  const person = await openCharacter(page, /^Peter Hale/);
  const f = field(person, 'names.full');
  await f.locator('.editable-text').first().click();
  await f.locator('input').fill('Peter Hale the Elder');
  const sentBefore = await page.evaluate(
    () => (window as unknown as { __keepalive: unknown[] }).__keepalive.length,
  );

  await setVisible(page, false);
  await expect.poll(async () => (await stored('H2')).names.full).toBe('Peter Hale the Elder');
  const sent = await page.evaluate(
    (n) =>
      (
        window as unknown as { __keepalive: { keepalive: boolean; size: number }[] }
      ).__keepalive.slice(n),
    sentBefore,
  );
  const kept = sent.filter((s) => s.keepalive);
  expect(kept.length).toBeGreaterThan(0);
  for (const s of kept) expect(s.size).toBeLessThan(64 * 1024);

  // Visible again: writes are normal requests, and the typing shows as stored.
  await setVisible(page, true);
  await expect(field(person, 'names.full')).toContainText('Peter Hale the Elder');
});
