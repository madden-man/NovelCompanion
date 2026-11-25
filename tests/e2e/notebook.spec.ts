import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import type { Document } from 'mongodb';
import type { Store } from '../../src/main/db';
import { BRIDGE_DOWN, BRIDGE_UP, BRIDGE_WORLDS } from '../../src/shared/bridge';
import type { NovelPocket } from '../../src/shared/bridge';
import type { Invoke } from '../helpers/t5';
import { readFixture } from '../helpers/loadFixture';
import {
  connectTo,
  fileDb,
  invokeVia,
  launch,
  rail,
  screenTab,
  sectionList,
  seedFixture,
} from './helpers';
import type { TestDb } from './helpers';

/**
 * A55: the phone's notebook in the bible. Rows are written into this spec's
 * database exactly as FlowState's function stores them in `bridge_up`, and
 * the window is brought to the front (its `focus` event) to pull them.
 */
let db: TestDb;
let app: ElectronApplication;
let page: Page;
let invoke: Invoke;
let store: Store;

const SLUG = 'notebook-fixture';
const WORLD = 'notebook-fixture';
const fixture = readFixture();
const NOV25 = Date.parse('2026-11-25T21:00:00.000Z');

test.describe.configure({ mode: 'serial' });

function strip(d: Record<string, unknown>): Record<string, unknown> {
  const { createdAt: _c, modifiedAt: _m, ...rest } = d;
  return rest;
}

async function send(table: string, id: string, rev: number, row: Record<string, unknown> | null) {
  const _id = `${WORLD}:${table}:${id}`;
  await store.db
    .collection(BRIDGE_UP)
    .replaceOne(
      { _id } as Document,
      { world: WORLD, table, id, rev, deleted: row === null, row, at: rev },
      { upsert: true },
    );
}

/** The window comes to the front, as when Tommy switches to it (NB-3). */
async function focusWindow() {
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.emit('focus');
  });
}

const keptRow = (id: string, text: string) => ({
  id,
  at: NOV25 + 1,
  updatedAt: NOV25 + 1,
  text,
  wise: false,
  kept: true,
  kind: 'kept',
  date: NOV25,
  year: 2045,
  chips: { characterIds: [], placeIds: [] },
});

test.beforeAll(async () => {
  db = fileDb();
  store = await connectTo(db);
  ({ app, page } = await launch(db));
  invoke = invokeVia(page);
  await invoke('bible.create', { slug: SLUG, name: 'Notebook fixture' });
  await invoke('bible.open', { slug: SLUG });
  await expect(page.getByTestId('workspace')).toBeVisible();
  for (const c of ['families', 'characters', 'places', 'parts', 'chapters']) {
    await seedFixture(
      invoke,
      fixture[c]!.map((d) => ({ collection: c as never, data: strip(d) })),
    );
  }
});

test.afterAll(async () => {
  await app?.close();
  await store?.close();
});

const editor = () => page.getByTestId('editor');
const list = () => editor().getByTestId('notebook-list');

async function openCharacter(name: string) {
  await rail(page, 'Characters').click();
  await page
    .getByTestId('entry-list')
    .getByRole('button', { name: new RegExp(`^${name}`) })
    .click();
  await expect(page.getByTestId('character-page')).toBeVisible();
}

test('NB-1 NB-2 opening the bible publishes its registry row and its pocket, and a new character moves the stamp', async () => {
  await expect
    .poll(async () => store.db.collection(BRIDGE_WORLDS).findOne({ _id: WORLD as never }))
    .toEqual({ _id: WORLD, name: 'Notebook fixture', kind: 'novel' });
  const pocket = async () =>
    (await store.db.collection(BRIDGE_DOWN).findOne({ _id: WORLD as never })) as {
      stamp: string;
      pocket: NovelPocket;
    } | null;
  // The seeded characters reach the pocket once the writes settle.
  await expect.poll(async () => (await pocket())?.pocket.characters.length ?? 0).toBe(13);
  const before = (await pocket())!.stamp;
  await invoke('entry.update', {
    collection: 'characters',
    id: 'Z3',
    patch: { names: { full: 'Zhou Lan', chinese: '周兰兰' } },
  });
  await expect.poll(async () => (await pocket())!.stamp).not.toBe(before);
  expect((await pocket())!.pocket.characters.find((c) => c.id === 'Z3')!.chineseName).toBe(
    '周兰兰',
  );
  await invoke('entry.update', {
    collection: 'characters',
    id: 'Z3',
    patch: { names: { full: 'Zhou Lan', chinese: '周兰' } },
  });
});

test('NB-3 NB-7 the window coming to the front pulls a kept line, which is its own row on the character it names', async () => {
  await send('messages', 'K1', 10, keptRow('K1', 'Zhou Lan keeps the letter until 2046.'));
  await focusWindow();
  await openCharacter('Zhou Lan');
  await expect(list()).toBeVisible();
  const row = list().locator('[data-notebook-id="K1"]');
  await expect(row).toContainText('Zhou Lan keeps the letter until 2046.');
  await expect(row).toContainText('Kept line · story year 2045');
  await expect(row.locator('time')).toHaveAttribute('datetime', '2026-11-25T21:00:00.000Z');
  // A kept line is all there is to read: no button opens it.
  await expect(row.getByRole('button')).toHaveCount(0);
  // Nothing in the list is a field: the page follows the phone.
  await expect(list().locator('input, textarea, [contenteditable="true"]')).toHaveCount(0);
});

test('NB-8 a council opens across the screen with every line; Escape goes back with its row in focus', async () => {
  await send('pages', 'C1', 20, {
    id: 'C1',
    kind: 'council',
    title: 'Does Zhou Lan open the letter?',
    state: 'open',
    createdAt: NOV25 + 10,
    updatedAt: NOV25 + 10,
    seats: ['c:Z3', 'c:H4'],
    reading: 'about',
    chips: { characterIds: [], placeIds: ['PLC3'], year: 2045 },
    year: 2045,
  });
  await send('messages', 'C1-a', 21, {
    id: 'C1-a',
    pageId: 'C1',
    at: NOV25 + 11,
    voiceId: 'c:Z3',
    text: 'Not before the wedding.',
    kept: false,
  });
  await send('messages', 'C1-b', 22, {
    id: 'C1-b',
    pageId: 'C1',
    at: NOV25 + 12,
    text: 'Then she waits a year.',
    kept: false,
    wise: true,
  });
  await focusWindow();
  const row = list().locator('[data-notebook-id="C1"]');
  await expect(row).toContainText('Does Zhou Lan open the letter?');
  await expect(row).toContainText('Council, about the story · story year 2045');
  await row.getByRole('button').click();

  const view = page.getByTestId('notebook-page');
  await expect(view).toBeVisible();
  // Across the screen: the character page is gone while the notebook page is open.
  await expect(page.getByTestId('character-page')).toHaveCount(0);
  await expect(view.getByRole('heading', { level: 2 })).toHaveText(
    'Does Zhou Lan open the letter?',
  );
  await expect(view.getByRole('heading', { level: 2 })).toBeFocused();
  const lines = view.getByRole('list', { name: 'Lines' }).getByRole('listitem');
  await expect(lines).toHaveCount(2);
  await expect(lines.nth(0)).toContainText('Zhou Lan');
  await expect(lines.nth(0)).toContainText('Not before the wedding.');
  // Plain ink is his: no name, and the wiser line is set in italic.
  await expect(lines.nth(1).locator('.nb-speaker')).toHaveCount(0);
  await expect(lines.nth(1)).toHaveClass(/wise/);
  await expect(lines.nth(1).locator('.nb-text')).toHaveCSS('font-style', 'italic');
  const names = view.getByRole('navigation', { name: 'What this page names' });
  await expect(names.getByRole('button', { name: 'Ruth Hale' })).toBeVisible();
  await expect(names.getByRole('button', { name: 'Guangzhou' })).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(view).toHaveCount(0);
  await expect(page.getByTestId('character-page')).toBeVisible();
  await expect(list().locator('[data-notebook-id="C1"] button')).toBeFocused();
});

test('NB-8 a name on the page opens that entry', async () => {
  await list().locator('[data-notebook-id="C1"] button').click();
  await page
    .getByTestId('notebook-page')
    .getByRole('navigation', { name: 'What this page names' })
    .getByRole('button', { name: 'Ruth Hale' })
    .click();
  await expect(page.getByTestId('character-page')).toBeVisible();
  await expect(page.getByTestId('char-heading')).toContainText('Ruth Hale');
  await expect(list().locator('[data-notebook-id="C1"]')).toBeVisible();
});

test('NB-7 the place and the chapter a page names list it too', async () => {
  await sectionList(page, 'Places');
  await page
    .getByTestId('entry-list')
    .getByRole('button', { name: /^Guangzhou/ })
    .click();
  await expect(list().locator('[data-notebook-id="C1"]')).toBeVisible();
  await expect(list().locator('[data-notebook-id="K1"]')).toHaveCount(0);

  await send('messages', 'K2', 30, keptRow('K2', 'Two Kitchens needs a second table.'));
  await focusWindow();
  await sectionList(page, 'Chapters');
  await page
    .getByTestId('entry-list')
    .getByRole('button', { name: /Two Kitchens/ })
    .click();
  await expect(list().locator('[data-notebook-id="K2"]')).toContainText(
    'Two Kitchens needs a second table.',
  );
});

test("NB-7 NB-8 on the Places tab, Edit shows the place's Notebook list; a page opens in place of the editor and Escape goes back", async () => {
  await screenTab(page, 'Cultural data', 'Places');
  const view = page.getByTestId('cultural-data').getByTestId('places-view');
  const row = view.locator('li[data-place="PLC3"]');
  await row.getByRole('button', { name: 'Edit Guangzhou' }).click();
  const box = row.getByTestId('place-editor');
  const nb = box.getByTestId('notebook-list');
  await expect(nb.locator('[data-notebook-id="C1"]')).toContainText(
    'Does Zhou Lan open the letter?',
  );
  await expect(nb.locator('[data-notebook-id="K1"]')).toHaveCount(0);
  await nb.locator('[data-notebook-id="C1"] button').click();
  const pageView = box.getByTestId('notebook-page');
  await expect(pageView).toBeVisible();
  await expect(box.getByTestId('editor')).toHaveCount(0);
  await expect(pageView.getByRole('list', { name: 'Lines' }).getByRole('listitem')).toHaveCount(2);
  await page.keyboard.press('Escape');
  await expect(box.getByTestId('editor')).toBeVisible();
  await expect(box.locator('[data-notebook-id="C1"] button')).toBeFocused();
  await box.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(row.getByTestId('place-editor')).toHaveCount(0);
});

test('NB-8 a question thread shows its kept mark, a paper line as the paper and another voice without a name; a page with no year says so', async () => {
  await send('pages', 'T1', 50, {
    id: 'T1',
    kind: 'question',
    title: 'Where does Zhou Lan hide the key?',
    state: 'open',
    createdAt: NOV25 + 20,
    updatedAt: NOV25 + 20,
  });
  await send('messages', 'T1-a', 51, {
    id: 'T1-a',
    pageId: 'T1',
    at: NOV25 + 21,
    text: 'Under the stair.',
    kept: true,
  });
  await send('messages', 'T1-b', 52, {
    id: 'T1-b',
    pageId: 'T1',
    at: NOV25 + 22,
    voiceId: 'v:for',
    text: 'Hiding places in old houses',
    kept: false,
    paper: { paperId: 'p9', side: 'for' },
  });
  await send('messages', 'T1-c', 53, {
    id: 'T1-c',
    pageId: 'T1',
    at: NOV25 + 23,
    voiceId: 'v:architect',
    text: 'Behind the stove.',
    kept: false,
  });
  await focusWindow();
  await openCharacter('Zhou Lan');
  const row = list().locator('[data-notebook-id="T1"]');
  await expect(row).toContainText('Question thread · no story year');
  await row.getByRole('button').click();
  const view = page.getByTestId('notebook-page');
  const lines = view.getByRole('list', { name: 'Lines' }).getByRole('listitem');
  await expect(lines).toHaveCount(3);
  await expect(lines.nth(0).locator('.nb-kept')).toHaveText('kept');
  await expect(lines.nth(0)).toHaveAttribute('data-voice', 'ink');
  await expect(lines.nth(1)).toHaveAttribute('data-voice', 'other');
  await expect(lines.nth(1).locator('.nb-voice-note')).toHaveText('Paper, for');
  await expect(lines.nth(1)).toContainText('Hiding places in old houses');
  await expect(lines.nth(2)).toHaveAttribute('data-voice', 'other');
  await expect(lines.nth(2).locator('.nb-speaker, .nb-voice-note')).toHaveCount(0);
  // Another voice is set apart from his plain ink.
  await expect(lines.nth(2)).toHaveCSS('border-left-style', 'solid');
  await expect(lines.nth(0)).toHaveCSS('border-left-style', 'none');
  await page.keyboard.press('Escape');
  await expect(view).toHaveCount(0);
});

test('NB-8 a research page lists its question and the papers picked, each with its journal, year, side and DOI', async () => {
  await send('inquiries', 'R1', 60, {
    id: 'R1',
    askedAt: NOV25 + 30,
    question: 'How long can Zhou Lan keep a secret?',
    state: 'done',
    papers: [
      {
        id: 'p1',
        title: 'Secrecy and health',
        journal: 'Psych Review',
        year: 2019,
        doi: '10.1/abc',
        kind: 'study',
        tier: 1,
        side: 'for',
      },
      {
        id: 'p2',
        title: 'Keeping quiet',
        journal: 'Mind',
        year: 2021,
        doi: '10.1/def',
        kind: 'study',
        tier: 2,
        side: 'against',
      },
    ],
  });
  await focusWindow();
  const row = list().locator('[data-notebook-id="R1"]');
  await expect(row).toContainText('Research · no story year');
  await row.getByRole('button').click();
  const view = page.getByTestId('notebook-page');
  await expect(view.getByRole('heading', { level: 2 })).toHaveText(
    'How long can Zhou Lan keep a secret?',
  );
  const papers = view.getByRole('region', { name: 'Papers' }).getByRole('listitem');
  await expect(papers).toHaveCount(2);
  await expect(papers.nth(0)).toContainText('Secrecy and health');
  await expect(papers.nth(0)).toContainText('Psych Review · 2019 · for · 10.1/abc');
  await expect(papers.nth(1)).toContainText('Mind · 2021 · against · 10.1/def');
  await page.keyboard.press('Escape');
});

test('NB-9 search finds a notebook page and opens it across the screen; Close goes back to the results', async () => {
  await rail(page, 'Search and filters').click();
  const view = page.getByTestId('search-view');
  await view.getByLabel('Search terms').fill('wedding');
  const hit = view.getByTestId('search-results').locator('[data-hit="C1"]');
  await expect(hit).toContainText('Notebook page');
  await expect(hit).toContainText('Does Zhou Lan open the letter?');
  await hit.click();
  const nb = page.getByTestId('notebook-page');
  await expect(nb).toBeVisible();
  await nb.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByTestId('search-view')).toBeVisible();
  await expect(view.getByLabel('Search terms')).toHaveValue('wedding');
});

test('NB-6 a line no longer kept leaves the list and waits in the trash under Notebook pages', async () => {
  await send('messages', 'K1', 40, null);
  await focusWindow();
  await openCharacter('Zhou Lan');
  await expect(list().locator('[data-notebook-id="C1"]')).toBeVisible();
  await expect(list().locator('[data-notebook-id="K1"]')).toHaveCount(0);
  await rail(page, 'Trash').click();
  const group = page.getByTestId('trash-notebook');
  await expect(group.locator('[data-id="K1"]')).toContainText(
    'Zhou Lan keeps the letter until 2046.',
  );
  await expect(group.locator('[data-id="K1"]')).toContainText('Kept line');
  // Read-only: no Restore and no Delete forever on a page that follows the phone.
  await expect(group.getByRole('button')).toHaveCount(0);
});
