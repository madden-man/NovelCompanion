import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { collectionInfo, entryTitle } from '../../src/shared/schema';
import type { EntryCollection } from '../../src/shared/schema';
import { startFakeGoogle } from '../helpers/fakeGoogle';
import type { FakeGoogle } from '../helpers/fakeGoogle';
import { readFixture } from '../helpers/loadFixture';
import { readSupplement } from '../helpers/briefFixture';
import type { Invoke } from '../helpers/t5';
import { invokeVia, launch, rail } from './helpers';

/**
 * NF-2: every action is reachable by keyboard. Nothing here clicks: each
 * screen is opened by tabbing to its rail button and pressing Enter, every
 * visible control on it is shown to take focus with Tab, and each screen's
 * primary controls are activated with Enter, Space, typing, or the app's
 * shortcuts, with the visible result asserted.
 */
let server: MongoMemoryReplSet;
let fake: FakeGoogle;
let app: ElectronApplication;
let page: Page;
let invoke: Invoke;

const SLUG = 'keyboard';
const KEY = 'sk-ant-api03-e2e-test-key-0123456789abcdef';
const fixture = readFixture();
const FIXTURES = join(import.meta.dirname, '../../fixtures/files');
const dir = mkdtempSync(join(tmpdir(), 'nc-e2e-keyboard-'));
const WORKBOOK = join(dir, 'fixture-workbook.xlsx');

test.describe.configure({ mode: 'serial' });

function strip(d: Record<string, unknown>): Record<string, unknown> {
  const { createdAt: _c, modifiedAt: _m, ...rest } = d;
  return rest;
}

test.beforeAll(async () => {
  test.setTimeout(300_000);
  copyFileSync(join(FIXTURES, 'fixture-workbook.xlsx'), WORKBOOK);
  fake = await startFakeGoogle({ email: 'tommy@example.com' });
  fake.addFile({
    id: 'folderNovel',
    name: 'Novel',
    mimeType: 'application/vnd.google-apps.folder',
  });
  fake.addFile({
    id: 'docCh3',
    name: 'Chapter 3',
    mimeType: 'application/vnd.google-apps.document',
    parents: ['folderNovel'],
    content: Buffer.from('not used'),
  });
  server = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  ({ app, page } = await launch(server.getUri(), {
    NOVEL_COMPANION_TEST_GOOGLE_BASE: fake.base,
    NOVEL_COMPANION_TEST_PICK_FILE: WORKBOOK,
  }));
  invoke = invokeVia(page);
  await invoke('bible.create', { slug: SLUG, name: 'Keyboard' });
  await invoke('bible.open', { slug: SLUG });
  await expect(page.getByTestId('workspace')).toBeVisible();
  const order = ['customSections', ...Object.keys(fixture).filter((c) => c !== 'customSections')];
  for (const c of order) {
    if (c === 'lists' || !fixture[c]?.length) continue;
    await invoke('entry.createMany', {
      items: fixture[c]!.map((d) => ({ collection: c as never, data: strip(d) })),
    });
  }
});

test.afterAll(async () => {
  await app?.close();
  await server?.stop();
  await fake?.close();
});

const isFocused = (loc: Locator) =>
  loc.evaluate((el) => el === document.activeElement || el.contains(document.activeElement));

/** Start the Tab order again from the top of the page. Not a click: nothing is pressed. */
async function fromTop() {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

/** Press Tab (or Shift+Tab) until the control has focus; fail when it never does. */
async function tabTo(loc: Locator, max = 300, key: 'Tab' | 'Shift+Tab' = 'Tab') {
  await expect(loc).toBeVisible();
  for (let i = 0; i < max; i++) {
    if (await isFocused(loc)) return;
    await page.keyboard.press(key);
  }
  throw new Error(`Tab never reached ${String(loc)}`);
}

/** Tab to a control and press a key on it. */
async function press(loc: Locator, key = 'Enter') {
  await tabTo(loc);
  await page.keyboard.press(key);
}

/**
 * Open a screen from the rail with the keyboard. A screen under More (KB-1)
 * is reached by tabbing to the disclosure and opening it with Enter first.
 */
async function go(screen: string) {
  const button = rail(page, screen);
  await fromTop();
  if (!(await button.isVisible())) {
    await press(page.getByRole('navigation', { name: 'Sections' }).locator('summary'));
    await expect(button).toBeVisible();
  }
  await press(button);
  await expect(button).toHaveAttribute('aria-current', 'page');
}

/** KB-5: a view that left the rail opens from the Entries screen (until integration, its placeholder). */
async function goEntries(name: string) {
  await go('Entries');
  await press(page.getByTestId('entries-view').getByRole('button', { name, exact: true }));
}

/** Close the rail's More disclosure with the keyboard, when it is open. */
async function closeMore() {
  const more = page.getByRole('navigation', { name: 'Sections' }).locator('details.rail-more');
  if (await more.evaluate((d) => (d as HTMLDetailsElement).open)) {
    await fromTop();
    await press(more.locator('summary'));
  }
  await expect(more).not.toHaveAttribute('open', '');
}

/**
 * Tab through the whole page once, marking every element that takes focus,
 * and return the visible, enabled controls that never did. Controls inside a
 * closed disclosure are left out: they appear when it opens.
 */
async function unreachable(scope?: string): Promise<string[]> {
  // A screen can render more controls once its data loads (Google Drive's client
  // fields wait on the connection status), so a miss gets one more full walk.
  const left = await walk(scope);
  return left.length ? walk(scope) : left;
}

async function walk(scope?: string): Promise<string[]> {
  await page.evaluate(() => {
    for (const el of document.querySelectorAll('[data-kb-seen]'))
      el.removeAttribute('data-kb-seen');
  });
  await fromTop();
  const total = await page.evaluate(() => document.querySelectorAll('*').length);
  let first: string | null = null;
  for (let i = 0; i < Math.min(total, 1500); i++) {
    await page.keyboard.press('Tab');
    const id = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return 'body';
      if (el.hasAttribute('data-kb-seen')) return el.getAttribute('data-kb-seen')!;
      const mark = `kb${document.querySelectorAll('[data-kb-seen]').length}`;
      el.setAttribute('data-kb-seen', mark);
      return `new:${mark}`;
    });
    if (first === null) first = id.replace(/^new:/, '');
    else if (id === first) break;
  }
  return page.evaluate((scopeSel) => {
    const root = scopeSel ? document.querySelector(scopeSel)! : document;
    const controls =
      'button, a[href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"]), [role=button], [role=link], [contenteditable=true]';
    return [...root.querySelectorAll(controls)]
      .filter((el) => {
        const box = (el as HTMLElement).getBoundingClientRect();
        if (box.width === 0 || box.height === 0) return false;
        if (getComputedStyle(el).visibility === 'hidden') return false;
        if ((el as HTMLButtonElement).disabled || el.closest('[inert], fieldset:disabled'))
          return false;
        if (el.getAttribute('tabindex') === '-1') return false;
        const details = el.closest('details');
        if (details && !details.open && el.tagName !== 'SUMMARY') return false;
        // A radio group is one Tab stop; arrow keys move inside it.
        if (el instanceof HTMLInputElement && el.type === 'radio') {
          const group = document.querySelectorAll(`input[type=radio][name="${el.name}"]`);
          return ![...group].some((r) => r.hasAttribute('data-kb-seen'));
        }
        return !el.hasAttribute('data-kb-seen') && !el.querySelector('[data-kb-seen]');
      })
      .map((el) => {
        const name =
          el.getAttribute('aria-label') ||
          (el as HTMLElement).innerText ||
          el.getAttribute('placeholder') ||
          el.getAttribute('data-testid') ||
          el.id;
        return `${el.tagName.toLowerCase()} "${String(name).slice(0, 60).replace(/\s+/g, ' ')}"`;
      });
  }, scope);
}

const status = () => page.getByTestId('status-bar');
const topBar = () => page.getByTestId('top-bar');
const editor = () => page.getByTestId('editor');

test('NF-2 KB-8 every screen in the rail, the five and everything under More, opens from the keyboard, and every control on it takes focus with Tab', async () => {
  test.setTimeout(600_000);
  const nav = page.getByRole('navigation', { name: 'Sections' });
  await closeMore();
  // KB-1: five screens, then More, closed, holding the rest.
  expect(await nav.getByRole('button').allTextContents()).toEqual([
    'Characters',
    'Family tree',
    'Outline',
    'Timeline',
    'Entries',
  ]);
  const screens = await nav.getByRole('button', { includeHidden: true }).allTextContents();
  expect(screens.length).toBeGreaterThan(35);
  const missed: Record<string, string[]> = {};
  for (const screen of screens) {
    await go(screen);
    const left = await unreachable();
    if (left.length) missed[screen] = left;
  }
  expect(missed).toEqual({});
});

test('NF-2 every section list opens an entry into its editor from the keyboard, and every editor control takes focus', async () => {
  test.setTimeout(600_000);
  const sections = Object.keys(collectionInfo) as EntryCollection[];
  const missed: Record<string, string[]> = {};
  let opened = 0;
  for (const c of sections) {
    const info = collectionInfo[c];
    if (await rail(page, info.plural).count()) await go(info.plural);
    else {
      // KB-5: a list with no rail item of its own opens from the Entries screen.
      await go('Entries');
      const kind = page
        .getByTestId('entries-view')
        .getByRole('button', { name: info.plural, exact: true });
      if (!(await kind.count())) continue;
      await press(kind);
    }
    const list = page.getByTestId('entry-list');
    const empty = page.getByText(`No ${info.plural.toLowerCase()} yet.`, { exact: true });
    await expect(page.getByRole('heading', { name: info.plural, level: 2 })).toBeVisible();
    const stored = (await invoke('entry.list', { collection: c, trash: 'exclude' })).entries;
    const rows = list.locator('button.entry-row');
    // Wait for this section's own list, not the one the screen showed before:
    // two sections can hold the same number of entries, so match the titles too.
    const titles = new Set(stored.map((e) => entryTitle(e.entry)));
    const rowTitle = async () => (await rows.first().innerText()).split('\n')[0]!.trim();
    if (stored.length) {
      await expect(rows).toHaveCount(stored.length);
      await expect.poll(async () => titles.has(await rowTitle())).toBe(true);
    } else await expect(empty).toBeVisible();
    const first = rows.first();
    if (stored.length) {
      const title = await rowTitle();
      await press(first);
      await expect(editor()).toBeVisible();
      await expect(editor()).toContainText(title.slice(0, 12));
      opened += 1;
    } else {
      await press(
        page.getByRole('button', { name: `New ${info.singular.toLowerCase()}`, exact: true }),
      );
      await expect(
        page.getByRole('button', { name: `Create ${info.singular.toLowerCase()}` }),
      ).toBeVisible();
    }
    const left = await unreachable();
    if (left.length) missed[info.plural] = left;
  }
  expect(opened).toBeGreaterThan(12);
  expect(missed).toEqual({});
});

test('NF-2 ED-1 a new character is made, edited, and saved from the keyboard', async () => {
  await go('Characters');
  await press(page.getByRole('button', { name: 'New character', exact: true }));
  await tabTo(page.getByRole('textbox', { name: 'Full name' }));
  await page.keyboard.type('Keyboard Person');
  await press(page.getByRole('button', { name: 'Create character' }));
  await expect(editor()).toBeVisible();
  await expect(editor().getByTestId('autosave')).toHaveText('Saved');
  const birthplace = editor().locator('[data-field="birthplace"] input');
  await tabTo(birthplace);
  await page.keyboard.type('Tacoma');
  await expect(editor().getByTestId('autosave')).toHaveText('Saved');
  const saved = await invoke('entry.list', { collection: 'characters', trash: 'exclude' });
  expect(saved.entries.some((e) => e.entry.birthplace === 'Tacoma')).toBe(true);
});

test('NF-2 TM-3 the top bar: the story year box, the Writing picker, Relevant to Session, and Start session', async () => {
  await go('Dashboard');
  await fromTop();
  const year = topBar().getByRole('spinbutton', { name: 'Story year' });
  await tabTo(year);
  await page.keyboard.press('Meta+a');
  await page.keyboard.type('2050');
  await page.keyboard.press('Enter');
  await expect(status()).toContainText('Story time 2050');
  const writing = topBar().getByLabel('Writing');
  await tabTo(writing);
  await page.keyboard.type('Chapter 5');
  await expect(writing).not.toHaveValue('');
  await expect(status()).not.toContainText('Story time 2050');
  await press(topBar().getByRole('button', { name: 'Relevant to Session' }));
  await expect(rail(page, 'Relevant to Session')).toHaveAttribute('aria-current', 'page');
  await fromTop();
  await press(topBar().getByRole('button', { name: 'Start session' }));
  await expect(rail(page, 'Start session')).toHaveAttribute('aria-current', 'page');
});

test('NF-2 DB-1 the dashboard: Start session and Check alignment open their screens', async () => {
  await go('Dashboard');
  const dash = page.getByTestId('dashboard');
  await press(dash.getByRole('button', { name: 'Start session' }));
  await expect(rail(page, 'Start session')).toHaveAttribute('aria-current', 'page');
  await go('Dashboard');
  await press(page.getByTestId('dashboard').getByRole('button', { name: 'Check alignment' }));
  // CC-1: since M8 the button opens the alignment check screen, which has no rail button.
  await expect(page.getByRole('heading', { name: 'Alignment check', level: 2 })).toBeVisible();
  await expect(page.getByTestId('alignment-view').getByTestId('alignment-run')).toBeVisible();
});

test('NF-2 FT-8 the tree: a person opens in the inspector with I, and Fit to window answers Enter', async () => {
  await go('Family tree');
  const daniel = page.locator('g.tnode[data-person="H3"]');
  await press(daniel, 'i');
  await expect(page.getByTestId('tree-inspector').getByTestId('inspector-name')).toHaveText(
    'Daniel Hale',
  );
  await press(page.getByRole('button', { name: 'Fit to window' }));
  await expect(page.getByTestId('tree-svg')).toBeVisible();
});

test('NF-2 TL-6 the timeline: the family filter by typing, and an era mark opens in the inspector with Enter', async () => {
  await go('Timeline');
  const family = page.getByLabel('Timeline filters').getByRole('combobox').first();
  await tabTo(family);
  await page.keyboard.type('Zhou');
  await expect(family).not.toHaveValue('');
  // The marks are one Tab stop (arrow keys move between them); eras come first.
  const era = page.locator('g.tl-mark[data-kind="era"]').first();
  await press(era);
  await expect(era).toHaveClass(/selected/);
  await expect(page.getByTestId('timeline-inspector')).toContainText(/\d{4}/);
});

test('NF-2 KB-2 TL-2 TL-5 the year view is the dialog: the top bar button opens it, and Lived through opens and picks by typing', async () => {
  await go('Dashboard');
  const open = topBar().getByTestId('top-open-year');
  await fromTop();
  await press(open);
  const dialog = page.getByTestId('story-time-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('time-states')).toContainText('Margaret Hale');
  const lived = dialog.getByTestId('time-lived');
  await press(lived.locator('summary'));
  await tabTo(lived.getByRole('combobox'));
  await page.keyboard.type('Ruth');
  await expect(lived.getByTestId('lived-through')).toContainText('Ruth Hale');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(open).toBeFocused();
});

test('NF-2 KB-2 TL-7 compare in the dialog: Cmd+T, Enter on the disclosure, and two characters picked by typing fill the table', async () => {
  await go('Dashboard');
  await page.keyboard.press('Meta+t');
  const dialog = page.getByTestId('story-time-dialog');
  await expect(dialog).toBeVisible();
  const view = dialog.getByTestId('time-compare');
  await press(view.locator('summary'));
  const [a, b] = [view.getByRole('combobox').nth(0), view.getByRole('combobox').nth(1)];
  await tabTo(a);
  await page.keyboard.type('Margaret');
  await tabTo(b);
  await page.keyboard.type('Zhou Meiling');
  await expect(view.getByTestId('compare-table')).toContainText('Zhou Meiling');
  await expect(view.getByTestId('compare-table').locator('tbody tr').first()).toBeVisible();
  expect(await unreachable('[data-testid="story-time-dialog"]')).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

test('NF-2 PL-1 PL-4 the plot outline: Enter on a chapter opens its chapter page, and its controls answer the keyboard', async () => {
  await go('Outline');
  await press(page.getByTestId('outline-grid').getByRole('button', { name: 'Candles' }));
  const chapter = page.getByTestId('chapter-page');
  await expect(chapter).toBeVisible();
  await expect(chapter).toContainText('Candles');
  expect(await unreachable()).toEqual([]);
  await press(page.getByRole('button', { name: 'Close the chapter' }));
  await expect(chapter).toBeHidden();
});

test('NF-2 CU-2 GL-1 culture by year, the place tree, and the glossary table answer the keyboard', async () => {
  // This bible starts with no communities; the screen needs one to pick.
  await invoke('lists.addItem', { listId: 'communities', label: 'Portland', parentId: null });
  await goEntries('Culture by year');
  const culture = page.getByTestId('culture-view');
  await tabTo(culture.getByRole('spinbutton', { name: 'Year' }));
  await page.keyboard.press('Meta+a');
  await page.keyboard.type('2045');
  await expect(
    culture.getByTestId('culture-results').or(culture.getByTestId('culture-empty')),
  ).toBeVisible();

  await goEntries('Place tree');
  await press(page.getByTestId('places-view').getByRole('button', { name: 'Portland' }));
  await expect(editor()).toContainText('Portland');

  await goEntries('Glossary table');
  await press(page.getByRole('button', { name: 'Edit 团圆' }));
  await expect(editor()).toContainText('团圆');
});

test('NF-2 KN-2 a fact page records who learned it from the keyboard', async () => {
  await go('Facts');
  await press(page.getByTestId('entry-list').getByRole('button', { name: /Peter's letter/ }));
  const form = page.getByTestId('fact-record-form');
  await tabTo(form.getByLabel('Character'));
  await page.keyboard.type('Sam');
  await tabTo(form.getByLabel('Year learned'));
  await page.keyboard.type('2052');
  await press(form.getByRole('button', { name: 'Record who learned it' }));
  await expect(page.getByTestId('fact-record-result')).toBeVisible();
});

test('NF-2 SR-1 search from the rail box: type, Tab to a result, Enter opens it', async () => {
  await fromTop();
  await tabTo(page.getByRole('searchbox', { name: 'Search the bible' }));
  await page.keyboard.type('Meiling');
  const result = page
    .getByTestId('search-results')
    .getByRole('button', { name: /Zhou Meiling/ })
    .first();
  await press(result);
  await expect(editor()).toContainText('Zhou Meiling');
});

test('NF-2 IM-1 import: choosing a workbook and mapping it work from the keyboard', async () => {
  await go('Import');
  const view = page.getByTestId('import-view');
  await press(view.getByRole('button', { name: 'Choose an Excel workbook' }));
  await expect(view).toContainText('fixture-workbook.xlsx');
  expect(await unreachable()).toEqual([]);
});

test('NF-2 BK-1 backups: Take a snapshot now adds a row', async () => {
  await go('Backups');
  const rows = page.getByTestId('snapshot-row');
  const before = await rows.count();
  await press(page.getByTestId('snapshot-take'));
  await expect(rows).toHaveCount(before + 1);
});

test('NF-2 ED-7 the review queue: a proposal is approved with the keyboard', async () => {
  await invoke('test.propose', {
    source: 'import',
    op: 'update',
    collection: 'characters',
    targetId: 'H3',
    data: { birthplace: 'Salem, Oregon' },
  });
  await go('Review queue');
  const queue = page.getByTestId('review-queue');
  await press(queue.getByRole('button', { name: 'Approve' }).first());
  await expect(queue.getByRole('button', { name: 'Approve' })).toHaveCount(0);
  const h3 = await invoke('entry.get', { collection: 'characters', id: 'H3' });
  expect(h3.entry.birthplace).toBe('Salem, Oregon');
});

test('NF-2 ST-1 GD-1 settings and Drive: the key, the Drive client, connecting, and linking a file, all by keyboard', async () => {
  await go('Settings');
  const settings = page.getByTestId('settings-view');
  await tabTo(settings.getByTestId('claude-key-input'));
  await page.keyboard.type(KEY);
  await press(settings.getByTestId('claude-key-save'));
  await expect(settings.getByTestId('claude-key-status')).toContainText('sk-ant-…cdef');
  const conn = settings.getByTestId('drive-connection');
  await tabTo(conn.getByLabel('OAuth client ID'));
  await page.keyboard.type(fake.clientId);
  await tabTo(conn.getByLabel('OAuth client secret'));
  await page.keyboard.type(fake.clientSecret);
  await press(conn.getByRole('button', { name: 'Save the client' }));
  await expect(conn.getByTestId('drive-state')).toHaveText('Not connected.');
  await press(conn.getByTestId('drive-connect'));
  await expect(conn.getByTestId('drive-state')).toContainText('Connected as tommy@example.com');

  await go('Google Drive');
  const drive = page.getByTestId('drive-view');
  await press(drive.getByRole('button', { name: 'Add files or folders from Drive' }));
  const browser = drive.getByTestId('drive-browser');
  await press(browser.getByRole('button', { name: 'Open Novel' }));
  await press(browser.getByRole('checkbox', { name: 'Chapter 3' }), 'Space');
  await expect(browser.getByRole('checkbox', { name: 'Chapter 3' })).toBeChecked();
  await press(browser.getByTestId('drive-link-selected'));
  await expect(drive.getByTestId('drive-link')).toHaveCount(1);
  expect(await unreachable()).toEqual([]);
});

test('NF-2 AI-1 the Claude panel: Cmd+J, the disclosure, Cmd+Enter to ask, and Escape', async () => {
  await go('Dashboard');
  await page.keyboard.press('Meta+j');
  const panel = page.getByTestId('claude-panel');
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId('claude-input')).toBeFocused();
  await page.keyboard.type('How old is Margaret in 2040?');
  const disclosure = panel.getByTestId('claude-disclosure');
  if (await disclosure.isVisible()) {
    await press(disclosure.getByRole('button', { name: 'Continue' }));
    await expect(disclosure).toBeHidden();
  }
  await tabTo(panel.getByTestId('claude-input'), 50, 'Shift+Tab');
  await page.keyboard.press('Meta+Enter');
  const turn = panel.getByTestId('claude-turn').last();
  await expect(turn).toHaveAttribute('data-status', 'done');
  await expect(turn.getByTestId('claude-answer')).toContainText('In 2040 Margaret Hale is 82.');
  expect(await unreachable('[data-testid="claude-panel"]')).toEqual([]);
  // Escape closes the panel from inside it; the Tab walk above ended outside it.
  await tabTo(panel.getByTestId('claude-input'));
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
});

test('NF-2 TM-1 TM-4 the Story Time dialog: Cmd+T, the year box, the step buttons, and Escape', async () => {
  await go('Dashboard');
  await page.keyboard.press('Meta+t');
  const dialog = page.getByTestId('story-time-dialog');
  await expect(dialog).toBeVisible();
  await tabTo(dialog.getByTestId('time-year'));
  await page.keyboard.press('Meta+a');
  await page.keyboard.type('2041');
  await expect(dialog.getByTestId('time-states')).toContainText('Margaret Hale');
  await press(dialog.getByRole('button', { name: 'Forward 1 year' }));
  await expect(dialog.getByTestId('time-now')).toHaveText('2042');
  await expect(status()).toContainText('Story time 2042');
  // KB-2: the world for the year sits under the states; its event titles take focus too.
  await expect(dialog.getByTestId('time-era')).toContainText('2040 to 2049');
  await tabTo(
    dialog
      .getByTestId('time-events')
      .getByRole('button', { name: 'Grid batteries replace the last coal plant in Guangdong' }),
  );
  expect(await unreachable('[data-testid="story-time-dialog"]')).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

test('NF-2 ED-5 the delete confirm: Move to trash opens it, every control in it takes focus, and Keep it and Escape close it', async () => {
  await go('Characters');
  await press(
    page
      .getByTestId('entry-list')
      .getByRole('button', { name: /Daniel Hale/ })
      .first(),
  );
  await expect(editor()).toBeVisible();
  const inspector = page.getByTestId('inspector');
  await press(inspector.getByRole('button', { name: 'Move to trash' }));
  const dialog = inspector.getByRole('dialog', { name: 'Move to trash' });
  await expect(dialog).toBeVisible();
  expect(await unreachable('[role="dialog"]')).toEqual([]);
  await press(dialog.getByRole('button', { name: 'Keep it' }));
  await expect(dialog).toBeHidden();
  await press(inspector.getByRole('button', { name: 'Move to trash' }));
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  const h3 = await invoke('entry.get', { collection: 'characters', id: 'H3' });
  expect(h3.entry.deletedAt ?? null).toBeNull();
});

test('NF-2 ED-4 the history drawer: a revision opens its comparison, and every control in the drawer takes focus', async () => {
  // A second revision, so there is an older one to compare.
  await invoke('entry.update', {
    collection: 'characters',
    id: 'H3',
    patch: { birthplace: 'Hood River, Oregon' },
  });
  await go('Characters');
  await press(
    page
      .getByTestId('entry-list')
      .getByRole('button', { name: /Daniel Hale/ })
      .first(),
  );
  await press(page.getByTestId('inspector').getByRole('button', { name: 'History' }));
  const drawer = page.getByTestId('history');
  await expect(drawer).toBeVisible();
  const revisions = drawer
    .getByRole('list', { name: 'Revisions, newest first' })
    .getByRole('button');
  await expect(revisions.first()).toBeVisible();
  await press(revisions.last());
  await expect(drawer.getByTestId('revision-diff')).toBeVisible();
  expect(await unreachable('[data-testid="history"]')).toEqual([]);
  await press(drawer.getByRole('button', { name: 'Close' }));
  await expect(drawer).toBeHidden();
});

test('NF-2 ED-7 the review queue with a proposal diff open: every control takes focus, and Reject answers Enter', async () => {
  await invoke('test.propose', {
    source: 'import',
    op: 'update',
    collection: 'characters',
    targetId: 'H1',
    data: { birthplace: 'Astoria, Oregon' },
  });
  await go('Review queue');
  const queue = page.getByTestId('review-queue');
  await expect(queue.getByTestId('proposal-diff')).toContainText('Astoria, Oregon');
  expect(await unreachable()).toEqual([]);
  await press(queue.getByRole('button', { name: 'Reject' }).first());
  await expect(queue.getByTestId('proposal-diff')).toHaveCount(0);
});

test('NF-2 SB-7 the brief view after generation: every control takes focus', async () => {
  // Without a key the brief is the structured one (SB-7): this test is about the keyboard, not Claude.
  await invoke('claude.clearKey', {});
  await go('Start session');
  const view = page.getByTestId('start-session');
  await press(view.getByRole('button', { name: 'A chapter', exact: true }));
  await expect(view.getByTestId('start-chapter')).toBeVisible();
  await press(view.getByTestId('start-session-go'));
  const brief = page.getByTestId('brief-view');
  await expect(brief).toBeVisible({ timeout: 60_000 });
  await expect(brief.getByTestId('brief-body').locator('h2').first()).toBeVisible({
    timeout: 60_000,
  });
  expect(await unreachable()).toEqual([]);
});

test('NF-2 CC-1 CC-4 the alignment screen: run, Stop, Manuscript wins and its diff, Rewrite recommended, and Dismiss, all by keyboard', async () => {
  test.setTimeout(300_000);
  // A launch whose recorded Claude streams slowly, so Stop can be reached while a run is going.
  await app.close();
  ({ app, page } = await launch(server.getUri(), {
    NOVEL_COMPANION_TEST_ANTHROPIC_KEY: KEY,
    NOVEL_COMPANION_TEST_CLAUDE_STEP_DELAY_MS: '400',
  }));
  invoke = invokeVia(page);
  await invoke('bible.open', { slug: SLUG });
  // The M7 supplement gives the chapters their manuscript text, which the recorded check reads.
  const supplement = readSupplement();
  for (const c of ['arcs', 'plotBeats']) {
    const docs = supplement.entries[c]!.filter((d) => !d.deletedAt);
    await invoke('entry.createMany', {
      items: docs.map((d) => ({ collection: c as never, data: strip(d) })),
    });
  }
  for (const [id, patch] of Object.entries(supplement.patches.chapters ?? {})) {
    await invoke('entry.update', { collection: 'chapters', id, patch });
  }
  await invoke('bible.open', { slug: SLUG });
  await expect(page.getByTestId('dashboard')).toBeVisible();

  await fromTop();
  await press(page.getByTestId('dashboard').getByRole('button', { name: 'Check alignment' }));
  const view = page.getByTestId('alignment-view');
  const run = view.getByTestId('alignment-run');
  const stop = view.getByTestId('alignment-stop');
  const status = view.getByTestId('alignment-status');
  const acknowledge = async () => {
    const ok = page.getByTestId('claude-acknowledge');
    if (await ok.isVisible().catch(() => false)) await press(ok);
  };

  // Run, then Stop while Claude is reading.
  await press(run);
  await expect(
    page.getByTestId('claude-acknowledge').or(status.filter({ hasText: 'Claude is reading' })),
  ).toBeVisible({ timeout: 30_000 });
  await acknowledge();
  await expect(status).toContainText('Claude is reading', { timeout: 30_000 });
  await press(stop);
  await expect(status).toContainText('Stopped.', { timeout: 30_000 });

  // Run to the end; then every control on the screen, findings and actions included, takes focus.
  await press(run);
  await acknowledge();
  await expect(status).toContainText('Done.', { timeout: 120_000 });
  const finding = (check: string) => view.locator(`[data-testid="finding"][data-check="${check}"]`);
  await expect(finding('age')).toBeVisible();
  expect(await unreachable('[data-testid="alignment-view"]')).toEqual([]);

  // Manuscript wins opens the change set as a diff, and its controls take focus too.
  await press(finding('age').getByRole('button', { name: 'Manuscript wins' }));
  await expect(finding('age').getByTestId('finding-diff')).toBeVisible();
  expect(await unreachable('[data-testid="alignment-view"]')).toEqual([]);
  await press(finding('age').getByTestId('finding-apply'));
  await expect(finding('age')).toHaveAttribute('data-state', 'manuscriptWins');

  await press(finding('place').getByRole('button', { name: 'Rewrite recommended' }));
  await expect(view.getByTestId('rewrite-task')).toHaveCount(1);

  const structural = view.getByTestId('structural-findings').getByTestId('finding');
  const before = await structural.count();
  expect(before).toBeGreaterThan(0);
  await press(structural.first().getByRole('button', { name: 'Dismiss' }));
  await expect(structural).toHaveCount(before - 1);
  expect(await unreachable('[data-testid="alignment-view"]')).toEqual([]);
});
