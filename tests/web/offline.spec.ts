import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { Store } from '../../src/main/db';
import { openBibleSession } from '../../src/main/db/session';
import type { OpenBible } from '../../src/main/db/session';
import { field } from '../e2e/helpers';
import {
  SLUG,
  TEST_KEY,
  connectTo,
  openCharacter,
  openFixture,
  seedFixtureNovel,
  startWebServer,
  webDb,
} from './server';
import type { WebDb, WebServer } from './server';

/**
 * A58 L1 (PH-25): read-only offline on WebKit at iPhone size. The phone
 * visits its screens online, the connection goes (the local function stops,
 * so every `/rpc` fails at the network), the installed shell reloads from its
 * service worker, and each screen visited reads from the transport's store.
 * A repository in this test process stands for the desk.
 */
let db: WebDb;
let server: WebServer;
let store: Store;
let desk: OpenBible;

test.describe.configure({ mode: 'serial' });
test.use({ serviceWorkers: 'allow' });

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

const OFFLINE_READ_ONLY =
  'The phone has no connection, so it shows what it read before and nothing can be changed.';
const NOT_STORED =
  'This was not opened on the phone before, so it cannot be shown without a connection.';

type Stored = { names: { full: string }; role?: string };
const stored = async (id: string) =>
  (await store.db
    .collection(`${SLUG}.characters`)
    .findOne({ _id: id as never })) as unknown as Stored;

/** How many records each part of the phone's read store holds. */
const storeCounts = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<Record<string, number>>((resolve, reject) => {
        const req = indexedDB.open('nc-phone-reads', 1);
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const d = req.result;
          const names = ['meta', 'values', 'bibles'];
          const t = d.transaction(names, 'readonly');
          const out: Record<string, number> = {};
          for (const n of names) {
            const c = t.objectStore(n).count();
            c.onsuccess = () => (out[n] = c.result);
          }
          t.oncomplete = () => {
            d.close();
            resolve(out);
          };
        };
      }),
  );

const tab = (page: Page, name: string) =>
  page.getByTestId('phone-bottom-bar').getByRole('button', { name, exact: true });

async function openTree(page: Page): Promise<void> {
  await page.getByTestId('bible-menu-button').tap();
  await page.getByTestId('phone-more').getByRole('button', { name: 'Family tree' }).tap();
  const svg = page.locator('[data-testid="tree-svg"]:visible');
  await expect(svg.locator('.tnode').first()).toBeVisible();
}

async function openYearPage(page: Page): Promise<void> {
  await page.getByTestId('phone-year').tap();
  await page.getByTestId('sheet-open-year').tap();
  const view = page.getByTestId('year-page');
  await expect(view).toBeVisible();
  await expect(view.getByTestId('year-person').first()).toBeVisible();
}

async function search(page: Page, query: string): Promise<void> {
  await tab(page, 'Search').tap();
  const input = page.getByTestId('search-view').locator('input[type="search"]');
  await input.fill(query);
  await expect(page.getByTestId('search-results')).toContainText('Ruth Hale');
}

/** Every screen the phone visits before the train. */
async function visitAll(page: Page): Promise<void> {
  await expect(page.getByTestId('entry-list').getByRole('button').first()).toBeVisible();
  await openCharacter(page, /^Ruth Hale/);
  await page.getByTestId('phone-back').tap();
  await tab(page, 'Outline').tap();
  await expect(page.getByTestId('phone-outline')).toBeVisible();
  await expect(page.getByTestId('phone-outline')).toContainText(/\S/);
  await tab(page, 'World').tap();
  await expect(page.getByTestId('world-grid').locator('.wg-row').first()).toBeVisible();
  await search(page, 'Ruth');
  await openTree(page);
  await openYearPage(page);
  await tab(page, 'People').tap();
  await expect(page.getByTestId('entry-list')).toBeVisible();
}

async function installed(page: Page): Promise<void> {
  await page.evaluate(() => navigator.serviceWorker.ready);
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null))
    .toBe(true);
}

test('PH-25 screens visited before read from the store with no connection, read-only, and come back live', async ({
  page,
}) => {
  await openFixture(page, server.url);
  await installed(page);
  await visitAll(page);
  await expect.poll(async () => (await storeCounts(page)).values).toBeGreaterThan(10);

  // The train: no connection at all, and the installed app is opened again.
  const port = Number(new URL(server.url).port);
  await server.stop();
  await page.reload();
  const banner = page.getByTestId('connection-banner');
  await expect(banner).toBeVisible();
  await expect(banner).toHaveAttribute('data-state', 'readOnly');
  await expect(banner.getByTestId('read-only-reason')).toHaveText(OFFLINE_READ_ONLY);
  await expect(page.getByTestId('open-snapshot')).toHaveCount(0);
  await expect(page.getByTestId('key-gate')).toHaveCount(0);

  // People and an entry page, as they read before.
  const list = page.getByTestId('entry-list');
  await expect(list.getByRole('button', { name: /^Ruth Hale/ })).toBeVisible();
  const person = await openCharacter(page, /^Ruth Hale/);
  const name = field(person, 'names.full');
  await expect(name).toContainText('Ruth Hale');
  // Write controls are off: a tap opens no editor.
  await expect(name.locator('[aria-disabled="true"]').first()).toBeVisible();
  await name.locator('.editable-text').first().tap({ force: true });
  await expect(name.locator('input')).toHaveCount(0);
  // A write that still reaches the transport is refused here, not shown as saved.
  const refused = await page.evaluate(() =>
    window.api
      .invoke(
        'entry.update',
        { collection: 'characters', id: 'H4', patch: { role: 'Written on the train' } },
        { bible: 'fixture-novel' },
      )
      .then(
        () => 'saved',
        (e: unknown) => (e as Error).message,
      ),
  );
  expect(refused).toBe('The phone has no connection, so this change was not saved.');
  await page.getByTestId('phone-back').tap();

  // A person never opened says so.
  await list.getByRole('button', { name: /^Zhou Lan/ }).tap();
  await expect(page.getByText(NOT_STORED).first()).toBeVisible();
  await page.getByTestId('phone-back').tap();

  // The outline, the world grid, a search made before, the tree and the year page.
  await tab(page, 'Outline').tap();
  await expect(page.getByTestId('phone-outline')).toContainText(/\S/);
  await tab(page, 'World').tap();
  await expect(page.getByTestId('world-grid').locator('.wg-row').first()).toBeVisible();
  await search(page, 'Ruth');
  await openTree(page);
  await openYearPage(page);
  await expect(banner).toHaveAttribute('data-state', 'readOnly');

  // Meanwhile the desk renames Ruth.
  await desk.repo.freshen();
  await desk.repo.update('characters', 'H4', { names: { full: 'Ruth Hale Desk' } });

  // Back online: Try again clears the banner, and the desk's change shows.
  server = await startWebServer(db, {}, port);
  await banner.getByTestId('connection-retry').tap();
  await expect(banner).toHaveCount(0);
  await tab(page, 'People').tap();
  await expect(list.getByRole('button', { name: /^Ruth Hale Desk/ })).toBeVisible();
  const again = await openCharacter(page, /^Ruth Hale Desk/);
  const live = field(again, 'names.full');
  await expect(live).toContainText('Ruth Hale Desk');
  // Editing works again.
  await live.locator('.editable-text').first().tap();
  await live.locator('input').fill('Ruth Hale Phone');
  await live.locator('input').press('Enter');
  await expect(live.locator('input')).toHaveCount(0);
  await expect.poll(async () => (await stored('H4')).names.full).toBe('Ruth Hale Phone');
});

test('PH-25 an edit open when the connection goes is refused and keeps its typing', async ({
  page,
}) => {
  await openFixture(page, server.url);
  const person = await openCharacter(page, /^Daniel Hale/);
  const f = field(person, 'names.full');
  await f.locator('.editable-text').first().tap();
  const input = f.locator('input');
  await input.fill('Daniel Hale Offline');
  // The connection goes while the field is open.
  await page.route('**/rpc', (route) => route.abort('internetdisconnected'));
  await input.press('Enter');
  await expect(page.getByTestId('connection-banner')).toHaveAttribute('data-state', 'readOnly');
  await expect(f.locator('.editable-error')).toContainText(/no connection/);
  await expect(input).toHaveValue('Daniel Hale Offline');
  await page.unroute('**/rpc');
  expect((await stored('H3')).names.full).not.toBe('Daniel Hale Offline');
});

test('PH-25 PH-17 a refused key clears the store with the key', async ({ page }) => {
  await openFixture(page, server.url);
  await openCharacter(page, /^Margaret Hale/);
  await expect.poll(async () => (await storeCounts(page)).values).toBeGreaterThan(0);
  // The key is changed on the site: the next answer is 401.
  const port = Number(new URL(server.url).port);
  await server.stop();
  server = await startWebServer(db, { NC_PHONE_KEY: `${TEST_KEY}-new` }, port);
  await page.getByTestId('phone-back').tap();
  await page.getByTestId('entry-list').getByRole('button', { name: /^Daniel Hale/ }).tap();
  await expect(page.getByTestId('key-gate')).toBeVisible();
  await expect.poll(() => storeCounts(page)).toEqual({ meta: 0, values: 0, bibles: 0 });
  expect(await page.evaluate(() => localStorage.getItem('nc.phoneKey'))).toBeNull();
});
