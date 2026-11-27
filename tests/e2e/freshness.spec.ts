import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import type { Store } from '../../src/main/db';
import { openBibleSession } from '../../src/main/db/session';
import type { OpenBible } from '../../src/main/db/session';
import type { Invoke } from '../helpers/t5';
import { readFixture } from '../helpers/loadFixture';
import {
  connectTo,
  field,
  fileDb,
  fillDateBox,
  fillEditable,
  invokeVia,
  launch,
  rail,
  seedFixture,
} from './helpers';
import type { TestDb } from './helpers';

/**
 * A58, P2 (PH-8, PH-10 on the desktop, PH-11): a second repository in this
 * test process writes to the same test database, as the phone's function
 * will. The window "comes to the front" through its `focus` event (a hidden
 * run cannot take the focus) and checks every 300 ms while in front
 * (`NOVEL_COMPANION_TEST_FRESHEN_MS`, honoured only under the test seams).
 */
let db: TestDb;
let app: ElectronApplication;
let page: Page;
let invoke: Invoke;
let store: Store;
let phone: OpenBible;

const SLUG = 'freshness-fixture';
const fixture = readFixture();

test.describe.configure({ mode: 'serial' });

function strip(d: Record<string, unknown>): Record<string, unknown> {
  const { createdAt: _c, modifiedAt: _m, ...rest } = d;
  return rest;
}

async function focusWindow() {
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.emit('focus');
  });
}

async function blurWindow() {
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.emit('blur');
  });
}

/** How many reloads from elsewhere the page has heard. */
const reloads = () =>
  page.evaluate(() => (window as unknown as { __elsewhere: number }).__elsewhere);

type Stored = Record<string, unknown> & { names: Record<string, unknown> };
const stored = async (id: string): Promise<Stored> =>
  (await store.db
    .collection(`${SLUG}.characters`)
    .findOne({ _id: id as never })) as unknown as Stored;

const charPage = () => page.getByTestId('character-page');

test.beforeAll(async () => {
  db = fileDb();
  store = await connectTo(db);
  ({ app, page } = await launch(db, { NOVEL_COMPANION_TEST_FRESHEN_MS: '300' }));
  invoke = invokeVia(page);
  await invoke('bible.create', { slug: SLUG, name: 'Freshness fixture' });
  await invoke('bible.open', { slug: SLUG });
  await expect(page.getByTestId('workspace')).toBeVisible();
  for (const c of ['families', 'characters']) {
    await seedFixture(
      invoke,
      fixture[c]!.map((d) => ({ collection: c as never, data: strip(d) })),
    );
  }
  phone = await openBibleSession(store, SLUG);
  await page.evaluate(() => {
    const w = window as unknown as { __elsewhere: number };
    w.__elsewhere = 0;
    window.api.on('bible.reloaded', (e) => {
      if (e.elsewhere) w.__elsewhere += 1;
    });
  });
  await rail(page, 'Characters').click();
  await page
    .getByTestId('entry-list')
    .getByRole('button', { name: /^Margaret Hale/ })
    .click();
  await expect(charPage()).toBeVisible();
});

test.afterAll(async () => {
  await app?.close();
  await store?.close();
});

test('PH-8 the window follows a write made elsewhere when it comes to the front and while it stays there, never for its own', async () => {
  // In the background nothing is read: the page keeps what it showed.
  await blurWindow();
  await phone.repo.update('characters', 'H1', { names: { full: 'Margaret Hale', chinese: '海' } });
  await page.waitForTimeout(1200);
  await expect(field(charPage(), 'names.chinese')).not.toContainText('海');
  expect(await reloads()).toBe(0);

  // Coming to the front reads it.
  await focusWindow();
  await expect(field(charPage(), 'names.chinese')).toContainText('海');
  await expect.poll(reloads).toBe(1);
  // No notice and no fresh workspace: the page redraws in place.
  await expect(page.getByTestId('reload-notice')).toHaveCount(0);

  // While it stays in front, the next write elsewhere shows without another focus.
  await phone.repo.update('characters', 'H1', {
    names: { full: 'Margaret Hale', chinese: '海燕' },
  });
  await expect(field(charPage(), 'names.chinese')).toContainText('海燕');
  await expect.poll(reloads).toBe(2);

  // The window's own writes, with the checks running, cause no reload.
  await invoke('entry.update', { collection: 'characters', id: 'H2', patch: { role: 'Ferryman' } });
  await page.waitForTimeout(1500);
  expect(await reloads()).toBe(2);
});

test('PH-10 typing in an open field keeps its text, caret and focus through a reload from elsewhere, and is then stored', async () => {
  const f = field(charPage(), 'names.chinese');
  await f.locator('.editable-text').first().click();
  const input = f.locator('input');
  await input.fill('海燕飞');
  await input.evaluate((el: HTMLInputElement) => el.setSelectionRange(1, 1));

  const before = await reloads();
  await phone.repo.update('characters', 'H1', { role: 'Keeps the light' });
  await phone.repo.update('characters', 'H3', { role: 'Written elsewhere' });
  await expect.poll(reloads).toBeGreaterThan(before);

  await expect(input).toBeFocused();
  await expect(input).toHaveValue('海燕飞');
  expect(
    await input.evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd]),
  ).toEqual([1, 1]);
  await input.press('Enter');
  await expect(f.locator('input')).toHaveCount(0);
  await expect.poll(async () => (await stored('H1')).names.chinese).toBe('海燕飞');
  // The other field written elsewhere is kept, not overwritten by the save.
  expect((await stored('H1')).role).toBe('Keeps the light');
});

test('PH-11 an undo whose entry changed elsewhere writes nothing, says so in the status bar, and the other steps still undo', async () => {
  // Step one: the birth year. Step two: the full name.
  await fillDateBox(field(charPage(), 'birth'), '1959');
  await expect.poll(async () => (await stored('H1')).birth).toEqual({ year: 1959 });
  await fillEditable(field(charPage(), 'names.full'), 'Margaret Hale-Rowe');
  await expect.poll(async () => (await stored('H1')).names.full).toBe('Margaret Hale-Rowe');

  // The window goes to the back, and the entry changes elsewhere before it reads it again.
  await blurWindow();
  await page.waitForTimeout(500);
  await phone.repo.update('characters', 'H1', { role: 'Moved on the phone' });
  const atPhone = await stored('H1');
  const before = await reloads();

  await page.getByTestId('top-undo').click();
  await expect(page.getByTestId('undo-notice')).toHaveText(
    'Undo skipped: this entry changed somewhere else since that step, so nothing was written.',
  );
  expect(await stored('H1')).toEqual(atPhone);

  // The refusal itself reads the bible again, so the window shows the entry as it is now.
  await expect.poll(reloads).toBeGreaterThan(before);

  // Back in front, the step before still undoes and redoes.
  await focusWindow();
  await page.getByTestId('top-undo').click();
  await expect(page.getByTestId('undo-notice')).toContainText('Undid:');
  await expect.poll(async () => (await stored('H1')).birth).toEqual({ year: 1958 });
  expect((await stored('H1')).names.full).toBe('Margaret Hale-Rowe');
  expect((await stored('H1')).role).toBe('Moved on the phone');
  await page.getByTestId('top-redo').click();
  await expect(page.getByTestId('undo-notice')).toContainText('Redid:');
  await expect.poll(async () => (await stored('H1')).birth).toEqual({ year: 1959 });
});
