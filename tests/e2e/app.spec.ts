import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { HIDDEN_ENV, fileDb, rail } from './helpers';

const ROOT = join(import.meta.dirname, '../..');

let app: ElectronApplication;
let page: Page;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  // This file's database on the run's local MongoDB replica set (the write path
  // uses transactions), so the app never reads the keychain or reaches Atlas.
  const db = fileDb();
  app = await electron.launch({
    args: [ROOT],
    env: {
      ...process.env,
      NOVEL_COMPANION_TEST_MONGODB_URI: db.uri,
      NOVEL_COMPANION_TEST_DB_NAME: db.name,
      NOVEL_COMPANION_SKIP_STOP_PROMPT: '1',
      // Its own data folder, never the real one, so parallel files never share it.
      NOVEL_COMPANION_USER_DATA: mkdtempSync(join(tmpdir(), 'nc-e2e-app-')),
      ...HIDDEN_ENV,
    },
  });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await app?.close();
});

test('ARCH-1 the app launches with the window title "Novel Companion"', async () => {
  await expect(page).toHaveTitle('Novel Companion');
  const nativeTitle = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.getTitle(),
  );
  expect(nativeTitle).toBe('Novel Companion');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Novel Companion');
});

test('ARCH-1 the renderer is sandboxed with no Node integration', async () => {
  const prefs = await app.evaluate(({ BrowserWindow }) => {
    // getLastWebPreferences exists at runtime but is missing from Electron's typings.
    const wc = BrowserWindow.getAllWindows()[0]?.webContents as unknown as {
      getLastWebPreferences(): Record<string, unknown> | null;
    };
    const p = wc.getLastWebPreferences();
    return {
      nodeIntegration: p?.nodeIntegration,
      contextIsolation: p?.contextIsolation,
      sandbox: p?.sandbox,
    };
  });
  expect(prefs).toEqual({ nodeIntegration: false, contextIsolation: true, sandbox: true });
  const globals = await page.evaluate(() => ({
    require: typeof (window as unknown as { require?: unknown }).require,
    process: typeof (window as unknown as { process?: unknown }).process,
    module: typeof (window as unknown as { module?: unknown }).module,
    api: Object.keys(window.api).sort(),
  }));
  expect(globals).toEqual({
    require: 'undefined',
    process: 'undefined',
    module: 'undefined',
    api: ['invoke', 'on'],
  });
});

test('ARCH-1 the Content-Security-Policy forbids remote scripts and remote connections', async () => {
  const csp = await page
    .locator('meta[http-equiv="Content-Security-Policy"]')
    .getAttribute('content');
  expect(csp).toContain("script-src 'self'");
  expect(csp).toContain("connect-src 'self'");
  expect(csp).toContain("default-src 'self'");
  const fetched = await page.evaluate(async () => {
    try {
      await fetch('https://example.com/');
      return 'reached the network';
    } catch {
      return 'blocked';
    }
  });
  expect(fetched).toBe('blocked');
  const scriptLoaded = await page.evaluate(
    () =>
      new Promise<string>((resolve) => {
        const s = document.createElement('script');
        s.src = 'https://example.com/remote.js';
        s.onload = () => resolve('loaded');
        s.onerror = () => resolve('blocked');
        document.head.appendChild(s);
      }),
  );
  expect(scriptLoaded).toBe('blocked');
});

test('ARCH-1 app.ping round-trips through window.api', async () => {
  const reply = await page.evaluate(() =>
    window.api.invoke('app.ping', { message: 'hello from the renderer' }),
  );
  expect(reply.message).toBe('hello from the renderer');
  expect(Number.isNaN(Date.parse(reply.receivedAt))).toBe(false);
});

test('ARCH-1 window.api rejects a request that fails the contract', async () => {
  const outcome = await page.evaluate(async () => {
    try {
      await window.api.invoke('app.ping', { message: 42 } as never);
      return 'accepted';
    } catch (e) {
      return String(e);
    }
  });
  expect(outcome).toMatch(/not valid/);
});

test('ARCH-8 bible.list returns the bibles in the registry and the window shows "No bibles yet"', async () => {
  const list = await page.evaluate(() => window.api.invoke('bible.list', {}));
  expect(list).toEqual({ connection: 'connected', bibles: [] });
  await expect(page.getByTestId('no-bibles')).toHaveText('No bibles yet');
});

test('ARCH-1 window.api refuses to open a link to a host that is not allowlisted', async () => {
  const reply = await page.evaluate(() =>
    window.api.invoke('app.openExternal', { url: 'https://example.com/' }),
  );
  expect(reply).toEqual({
    ok: false,
    message: expect.stringMatching(/does not open links to example\.com/),
  });
});

test('ARCH-8 a bible created through window.api appears in bible.list and in the window', async () => {
  const created = await page.evaluate(() =>
    window.api.invoke('bible.create', { slug: 'tide-lines', name: 'Tide Lines' }),
  );
  expect(created).toEqual({ bible: { id: 'tide-lines', name: 'Tide Lines' } });
  const list = await page.evaluate(() => window.api.invoke('bible.list', {}));
  expect(list).toEqual({
    connection: 'connected',
    bibles: [{ id: 'tide-lines', name: 'Tide Lines' }],
  });
  await expect(page.getByTestId('bible-list')).toContainText('Tide Lines');
  expect(await page.evaluate(() => window.api.invoke('bible.current', {}))).toEqual({
    bible: null,
  });
});

test('ARCH-8 creating a bible with a bad or duplicate ID fails with a plain message', async () => {
  const bad = await page.evaluate(async () => {
    try {
      await window.api.invoke('bible.create', { slug: 'Bad.ID', name: 'Bad' });
      return 'accepted';
    } catch (e) {
      return String(e);
    }
  });
  expect(bad).toMatch(/not valid/);
  const dupe = await page.evaluate(async () => {
    try {
      await window.api.invoke('bible.create', { slug: 'tide-lines', name: 'Again' });
      return 'accepted';
    } catch (e) {
      return String(e);
    }
  });
  expect(dupe).toMatch(/already exists/);
});

test('ARCH-8 opening a bible makes it current and shows its name in the window', async () => {
  const opened = await page.evaluate(() => window.api.invoke('bible.open', { slug: 'tide-lines' }));
  expect(opened).toEqual({ bible: { id: 'tide-lines', name: 'Tide Lines' } });
  expect(await page.evaluate(() => window.api.invoke('bible.current', {}))).toEqual({
    bible: { id: 'tide-lines', name: 'Tide Lines' },
  });
  await expect(page.getByTestId('current-bible')).toHaveText('Tide Lines');
});

test('ARCH-8 a second bible made with the New bible form can be switched to', async () => {
  // With a bible open, the bible list and the New bible form live under Bibles in the rail.
  await rail(page, 'Bibles').click();
  await page.getByLabel('Name').fill('East Winds');
  await expect(page.getByLabel('ID')).toHaveValue('east-winds');
  await page.getByRole('button', { name: 'Create bible' }).click();
  await expect(page.getByTestId('bible-list')).toContainText('East Winds');
  const list = await page.evaluate(() => window.api.invoke('bible.list', {}));
  expect(list.bibles.map((b) => b.id)).toEqual(['east-winds', 'tide-lines']);

  await page.getByRole('button', { name: 'Open East Winds' }).click();
  await expect(page.getByTestId('current-bible')).toHaveText('East Winds');
  expect(await page.evaluate(() => window.api.invoke('bible.current', {}))).toEqual({
    bible: { id: 'east-winds', name: 'East Winds' },
  });

  await rail(page, 'Bibles').click();
  await page.getByRole('button', { name: 'Open Tide Lines' }).click();
  await expect(page.getByTestId('current-bible')).toHaveText('Tide Lines');
  expect(await page.evaluate(() => window.api.invoke('bible.current', {}))).toEqual({
    bible: { id: 'tide-lines', name: 'Tide Lines' },
  });
});

test('ARCH-8 opening a bible that is not registered fails plainly and keeps the current one', async () => {
  const outcome = await page.evaluate(async () => {
    try {
      await window.api.invoke('bible.open', { slug: 'missing' });
      return 'opened';
    } catch (e) {
      return String(e);
    }
  });
  expect(outcome).toMatch(/There is no bible with the ID "missing"/);
  expect(await page.evaluate(() => window.api.invoke('bible.current', {}))).toEqual({
    bible: { id: 'tide-lines', name: 'Tide Lines' },
  });
});

test('IP-13 the App menu lists every section under All sections; each opens its list, where New makes an entry and a row renames in place', async () => {
  const { ENTRY_COLLECTIONS, collectionInfo } = await import('../../src/shared/schema');
  await expect(page.getByTestId('current-bible')).toHaveText('Tide Lines');
  const nav = page.getByRole('navigation', { name: 'Sections' });
  const button = nav.getByTestId('app-menu-button');
  await button.click();
  const group = nav.getByRole('group', { name: 'All sections' });
  // A50: moments have one door, Backstory, so they have no list here.
  const listed = ENTRY_COLLECTIONS.filter((c) => c !== 'moments');
  await expect(group.getByRole('menuitem')).toHaveText(listed.map((c) => collectionInfo[c].plural));
  // Every section opens its own list.
  for (const c of listed) {
    if ((await button.getAttribute('aria-expanded')) !== 'true') await button.click();
    await group.getByRole('menuitem', { name: collectionInfo[c].plural, exact: true }).click();
    await expect(
      page.getByRole('heading', { name: collectionInfo[c].plural, level: 2 }),
    ).toBeVisible();
    await expect(
      nav.getByRole('group', { name: 'All sections', includeHidden: true }).getByRole('menuitem', {
        name: collectionInfo[c].plural,
        exact: true,
        includeHidden: true,
      }),
    ).toHaveAttribute('aria-current', 'page');
  }
  // From the keyboard: Enter on the App button opens the menu, Enter on an item opens its list.
  await button.focus();
  await page.keyboard.press('Enter');
  await group.getByRole('menuitem', { name: 'Open questions', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Open questions', level: 2 })).toBeVisible();
  // New makes one.
  await page.getByRole('button', { name: 'New open question' }).click();
  const form = page.getByTestId('new-entry');
  await form.locator('[data-field="title"] input').fill('Who keeps the harbor log?');
  await form.getByRole('button', { name: 'Create open question' }).click();
  const list = page.getByTestId('entry-list');
  const row = list.getByRole('button', { name: /Who keeps the harbor log\?/ });
  await expect(row).toBeVisible();
  // The row renames in place: F2 opens its title as a field, Enter saves.
  await row.focus();
  await page.keyboard.press('F2');
  const rename = list.getByTestId('row-rename');
  await rename.locator('input').fill('Who keeps the tide log?');
  await rename.locator('input').press('Enter');
  await expect(list.getByRole('button', { name: /Who keeps the tide log\?/ })).toBeVisible();
  const stored = await page.evaluate(() =>
    window.api.invoke('entry.list', { collection: 'openQuestions', trash: 'exclude' }),
  );
  expect(stored.entries.map((e) => e.entry.title)).toContain('Who keeps the tide log?');
  // A double-click renames too, here a place.
  await button.click();
  await group.getByRole('menuitem', { name: 'Places', exact: true }).click();
  await page.getByRole('button', { name: 'New place' }).click();
  await page.getByTestId('new-entry').locator('[data-field="title"] input').fill('Pier Nine');
  await page.getByTestId('new-entry').getByRole('button', { name: 'Create place' }).click();
  await list.getByRole('button', { name: /Pier Nine/ }).dblclick();
  await rename.locator('input').fill('Pier Ten');
  await rename.locator('input').press('Enter');
  await expect(list.getByRole('button', { name: /Pier Ten/ })).toBeVisible();
});
