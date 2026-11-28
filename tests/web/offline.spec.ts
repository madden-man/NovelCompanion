import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
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

const tab = (page: Page, name: string) => page.getByTestId(`tab-${name}`);

/** A screen's text once its reads have all answered: the same on two looks in a row. */
async function settled(l: Locator): Promise<string> {
  let last = '';
  await expect
    .poll(
      async () => {
        const now = await l.evaluate((e) =>
          e instanceof HTMLElement ? e.innerText : (e.textContent ?? ''),
        );
        const same = now === last;
        last = now;
        return same;
      },
      { intervals: [400] },
    )
    .toBe(true);
  return last;
}

async function openTree(page: Page): Promise<string> {
  await page.getByTestId('bible-menu-button').tap();
  await page.getByTestId('phone-more').getByRole('button', { name: 'Family tree' }).tap();
  const svg = page.locator('[data-testid="tree-svg"]:visible');
  await expect(svg.locator('.tnode').first()).toBeVisible();
  return settled(svg);
}

async function openYearPage(page: Page): Promise<string> {
  await page.getByTestId('phone-year').tap();
  await page.getByTestId('sheet-open-year').tap();
  const view = page.getByTestId('year-page');
  await expect(view).toBeVisible();
  await expect(view.getByTestId('year-person').first()).toBeVisible();
  return settled(view);
}

async function search(page: Page, query: string): Promise<string> {
  await tab(page, 'search').tap();
  const input = page.getByTestId('search-view').locator('input[type="search"]');
  await input.fill(query);
  const results = page.getByTestId('search-results');
  await expect(results).toContainText('Ruth Hale');
  return settled(results);
}

async function outline(page: Page): Promise<string> {
  await tab(page, 'outline').tap();
  const view = page.getByTestId('outline-view');
  await expect(view.getByTestId('chapter-bar').first()).toBeVisible();
  return settled(view);
}

async function world(page: Page): Promise<string> {
  await tab(page, 'world').tap();
  const grid = page.getByTestId('world-grid');
  await expect(grid.locator('.wg-row').first()).toBeVisible();
  // Its eras and events have all arrived.
  await expect(grid).toContainText('The late twenties');
  await expect(grid).toContainText('Pearl River delta seawall completed');
  return settled(grid);
}

/** Every screen the phone visits before the train, and the text each one shows. */
async function visitAll(page: Page) {
  const list = page.getByTestId('entry-list');
  await expect(list.getByRole('button').first()).toBeVisible();
  const people = await settled(list);
  const ruth = await settled(await openCharacter(page, /^Ruth Hale/));
  await page.getByTestId('phone-back').tap();
  const seen = {
    people,
    ruth,
    outline: await outline(page),
    world: await world(page),
    search: await search(page, 'Ruth'),
    tree: await openTree(page),
    year: await openYearPage(page),
  };
  // Back to the search field, so every tab is at its root when the app opens again.
  await page.getByTestId('phone-back').tap();
  await page.getByTestId('phone-back').tap();
  await expect(page.getByTestId('search-view')).toBeVisible();
  await tab(page, 'people').tap();
  await expect(list).toBeVisible();
  return seen;
}

/**
 * A screen's text without the lines that are only write controls (a chip's
 * remove, Add family, the outline's grips, a row's +): read-only hides some
 * and disables others, and the test checks those itself.
 */
const WRITE_ONLY_LINES = new Set(['×', 'Add family', '⋮⋮', '+']);
const asReadOnly = (text: string) =>
  text
    .split('\n')
    .filter((l) => !WRITE_ONLY_LINES.has(l))
    .join('\n');

async function installed(page: Page): Promise<void> {
  await page.evaluate(() => navigator.serviceWorker.ready);
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null))
    .toBe(true);
}

test('PH-25 screens visited before read as they did with no connection, read-only, writes refused, then live again', async ({
  page,
}) => {
  test.setTimeout(300_000);
  await openFixture(page, server.url);
  await installed(page);
  const before = await test.step('visit every screen online', () => visitAll(page));
  await expect.poll(async () => (await storeCounts(page)).values).toBeGreaterThan(10);

  // The train: no connection at all, and the installed app is opened again.
  const port = Number(new URL(server.url).port);
  await server.stop();
  await page.reload();
  const banner = page.getByTestId('connection-banner');
  await test.step('the reload opens read-only from the store', async () => {
    await expect(banner).toBeVisible();
    await expect(banner).toHaveAttribute('data-state', 'readOnly');
    await expect(banner.getByTestId('read-only-reason')).toHaveText(OFFLINE_READ_ONLY);
    await expect(page.getByTestId('open-snapshot')).toHaveCount(0);
    await expect(page.getByTestId('key-gate')).toHaveCount(0);
    await expect(page.getByTestId('workspace')).toBeVisible();
  });

  const list = page.getByTestId('entry-list');
  await test.step('People and an entry page read as before, with editing off', async () => {
    await expect(list.getByRole('button').first()).toBeVisible();
    expect(await settled(list)).toBe(before.people);
    const person = await openCharacter(page, /^Ruth Hale/);
    // The same page, less its write controls (a chip's remove, Add family).
    expect(asReadOnly(await settled(person))).toBe(asReadOnly(before.ruth));
    await expect(person.getByRole('button', { name: /Add family/ })).toHaveCount(0);
    const name = field(person, 'names.full');
    await expect(name.locator('.editable-text').first()).toHaveAttribute('aria-disabled', 'true');
    await name.locator('.editable-text').first().tap({ force: true });
    await expect(name.locator('input')).toHaveCount(0);
  });

  await test.step('a write that still reaches the transport is refused on the phone', async () => {
    const sent: string[] = [];
    page.on('request', (r) => {
      if (r.url().endsWith('/rpc')) sent.push(r.postData() ?? '');
    });
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
    expect(sent.filter((b) => b.includes('entry.update'))).toEqual([]);
    expect((await stored('H4')).role).not.toBe('Written on the train');
    await page.getByTestId('phone-back').tap();
  });

  await test.step('a person never opened says so', async () => {
    await list.getByRole('button', { name: /^Zhou Lan/ }).tap();
    await expect(page.getByText(NOT_STORED).first()).toBeVisible();
    await page.getByTestId('phone-back').tap();
  });

  await test.step('the outline, the world grid, a search, the tree and the year page read as before', async () => {
    // The outline keeps its divider buttons, disabled, and loses its drag grips.
    expect(asReadOnly(await outline(page))).toBe(asReadOnly(before.outline));
    const view = page.getByTestId('outline-view');
    for (const b of await view.getByTestId('remove-divider').all()) await expect(b).toBeDisabled();
    await expect(view.getByTestId('new-chapter')).toBeDisabled();
    await expect(view.getByTestId('chapter-grip')).toHaveCount(0);
    expect(asReadOnly(await world(page))).toBe(asReadOnly(before.world));
    expect(asReadOnly(await search(page, 'Ruth'))).toBe(asReadOnly(before.search));
    expect(asReadOnly(await openTree(page))).toBe(asReadOnly(before.tree));
    expect(asReadOnly(await openYearPage(page))).toBe(asReadOnly(before.year));
    await expect(banner).toHaveAttribute('data-state', 'readOnly');
  });

  // Meanwhile the desk renames Ruth (her page's name; the list keeps her title).
  await desk.repo.freshen();
  await desk.repo.update('characters', 'H4', { names: { full: 'Ruth Hale Desk' } });

  await test.step('back online, Try again clears the banner and the change made meanwhile shows', async () => {
    server = await startWebServer(db, {}, port);
    await banner.getByTestId('connection-retry').tap();
    await expect(banner).toHaveCount(0);
    await tab(page, 'people').tap();
    const again = await openCharacter(page, /^Ruth Hale/);
    await expect(field(again, 'names.full')).toContainText('Ruth Hale Desk');
  });

  await test.step('editing works again and the edit is stored', async () => {
    const live = field(page.getByTestId('character-page'), 'names.full');
    await live.locator('.editable-text').first().tap();
    await live.locator('input').fill('Ruth Hale Phone');
    await live.locator('input').press('Enter');
    await expect(live.locator('input')).toHaveCount(0);
    await expect.poll(async () => (await stored('H4')).names.full).toBe('Ruth Hale Phone');
  });
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
  const port = Number(new URL(server.url).port);
  await server.stop();
  await input.press('Enter');
  await expect(page.getByTestId('connection-banner')).toHaveAttribute('data-state', 'readOnly');
  await expect(f.locator('.editable-error')).toContainText('The phone has no connection');
  await expect(input).toHaveValue('Daniel Hale Offline');
  server = await startWebServer(db, {}, port);
  expect((await stored('H3')).names.full).not.toBe('Daniel Hale Offline');
});

test("PH-25 the phone's own edits read offline as they did online: an entry page and the People list", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await openFixture(page, server.url);
  await installed(page);
  const list = page.getByTestId('entry-list');
  await expect(list.getByRole('button', { name: /^Peter Hale/ })).toBeVisible();
  await settled(list);

  // An "In the story" edit on Ruth's page, saved when the phone goes back.
  const person = await openCharacter(page, /^Ruth Hale/);
  await settled(person);
  const role = person.locator('[data-field="role"] .rich-text-input');
  await role.tap();
  await page.keyboard.type('Keeps the letters Margaret left.');
  await page.getByTestId('phone-back').tap();
  await expect.poll(async () => (await stored('H4')).role ?? '').toContain('Keeps the letters');

  // Someone renamed from the phone: the People list shows the new name.
  const renamed = await page.evaluate(() =>
    window.api
      .invoke(
        'entry.update',
        { collection: 'characters', id: 'H2', patch: { title: 'Peter Hale-Okafor' } },
        { bible: 'fixture-novel' },
      )
      .then(() => 'saved'),
  );
  expect(renamed).toBe('saved');
  await expect(list.getByRole('button', { name: /^Peter Hale-Okafor/ })).toBeVisible();
  const online = await settled(list);
  // What the phone holds once its reads have landed.
  await page.evaluate(() =>
    (window.api as unknown as { readsSettled?: () => Promise<void> }).readsSettled?.(),
  );

  const port = Number(new URL(server.url).port);
  await server.stop();
  try {
    await page.reload();
    const banner = page.getByTestId('connection-banner');
    await expect(banner).toHaveAttribute('data-state', 'readOnly');
    await expect(list.getByRole('button').first()).toBeVisible();
    expect(await settled(list)).toBe(online);
    await expect(list.getByRole('button', { name: /^Peter Hale-Okafor/ })).toBeVisible();
    const again = await openCharacter(page, /^Ruth Hale/);
    await settled(again);
    await expect(again.locator('[data-field="role"]')).toContainText(
      'Keeps the letters Margaret left.',
    );
  } finally {
    server = await startWebServer(db, {}, port);
  }
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
  await page
    .getByTestId('entry-list')
    .getByRole('button', { name: /^Daniel Hale/ })
    .tap();
  await expect(page.getByTestId('key-gate')).toBeVisible();
  await expect.poll(() => storeCounts(page)).toEqual({ meta: 0, values: 0, bibles: 0 });
  expect(await page.evaluate(() => localStorage.getItem('nc.phoneKey'))).toBeNull();
});
