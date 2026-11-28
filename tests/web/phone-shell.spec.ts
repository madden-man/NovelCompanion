import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { createBible } from '../../src/main/db';
import type { Store } from '../../src/main/db';
import { field } from '../e2e/helpers';
import {
  SLUG,
  connectTo,
  openCharacter,
  openFixture,
  pasteKey,
  seedFixtureNovel,
  startWebServer,
  webDb,
} from './server';
import type { WebDb, WebServer } from './server';
import { noSidewaysScroll, smallTargets } from './layout';

/**
 * A58 U1: the phone's shell on WebKit at iPhone 15 size, through the local
 * function on the fixture novel. The top bar (PH-29), the bottom bar
 * (PH-30), pages with back (PH-31), editing by touch (PH-32), nothing behind
 * a pointer or a key (PH-35), no instructions (PH-36), the chooser (PH-37).
 */
let db: WebDb;
let server: WebServer;
let store: Store;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  db = webDb();
  await seedFixtureNovel(db);
  store = await connectTo(db);
  await createBible(store, 'second-novel', 'Second novel');
  server = await startWebServer(db);
});

test.afterAll(async () => {
  await server?.stop();
  await store?.close();
});

type StoredCharacter = {
  names: { full: string };
  birth?: { year?: number; unknown?: boolean } | null;
  role?: string;
};
const character = async (id: string) =>
  (await store.db
    .collection(`${SLUG}.characters`)
    .findOne({ _id: id as never })) as unknown as StoredCharacter;
const glossary = async (id: string) =>
  (await store.db.collection(`${SLUG}.glossaryTerms`).findOne({ _id: id as never })) as unknown as {
    language: string;
  };

/** The channels the page sends to /rpc, from now on. */
function rpcChannels(page: Page): string[] {
  const seen: string[] = [];
  page.on('request', (r) => {
    if (r.url().endsWith('/rpc')) {
      try {
        seen.push(JSON.parse(r.postData() ?? '{}').channel as string);
      } catch {
        // A keepalive batch or an empty body.
      }
    }
  });
  return seen;
}

const box = async (l: Locator) => {
  const b = await l.boundingBox();
  if (!b) throw new Error('The element has no box.');
  return b;
};

/** Every field that takes typing inside `scope`, with its computed font size. */
async function fieldSizes(scope: Locator): Promise<{ what: string; size: number }[]> {
  return scope.evaluate((root) =>
    [...root.querySelectorAll<HTMLElement>('input, select, textarea, [contenteditable="true"]')]
      .filter((el) => el.getClientRects().length > 0)
      .map((el) => ({
        what: `${el.tagName.toLowerCase()} ${el.getAttribute('aria-label') ?? el.className}`,
        size: parseFloat(getComputedStyle(el).fontSize),
      })),
  );
}

/** Sentences that tell the reader how to use a screen (IP-19, the A57 rule). */
const INSTRUCTION =
  /(^|[.!?]\s+)(Click|Tap|Drag|Swipe|Press|Type|Pick|Choose|Use|Leave|Enter|Hold|Select)\b|to save\b|undo step|still saves|\bCmd\b|⌘|\bCtrl\b|double-click|right-click/i;

async function instructionLines(page: Page): Promise<string[]> {
  const text = await page.locator('body').innerText();
  const titles = await page
    .locator('[title]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('title') ?? ''));
  return [...text.split('\n'), ...titles]
    .map((l) => l.trim())
    .filter((l) => l && INSTRUCTION.test(l));
}

test('PH-29 the top bar is one fixed row with the bible name and the whole story year', async ({
  page,
}) => {
  await openFixture(page, server.url);
  const bar = page.getByTestId('phone-top-bar');
  await expect(bar.getByTestId('current-bible')).toHaveText('Fixture novel');
  const year = bar.getByTestId('phone-year');
  await expect(year).toHaveText(/^-?\d{4,5}$/);
  // The year is whole: nothing of it is cut.
  expect(await year.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  // One row: every control sits within the bar's height, and the bar is near the top.
  const b = await box(bar);
  expect(b.y).toBeLessThanOrEqual(1);
  expect(b.height).toBeLessThanOrEqual(64);
  for (const control of await bar.getByRole('button').all()) {
    const c = await box(control);
    expect(c.y).toBeGreaterThanOrEqual(b.y);
    expect(c.y + c.height).toBeLessThanOrEqual(b.y + b.height + 1);
  }
  // Content starts right under it: the People list is on the first screen.
  await expect(page.getByTestId('entry-list')).toBeInViewport();
  // Fixed: it stays at the top while the page scrolls.
  await page.evaluate(() => window.scrollTo(0, 400));
  expect((await box(bar)).y).toBeLessThanOrEqual(1);
});

test('PH-29 the year opens a sheet that sets the story year; a tap outside, a swipe down and back put it away', async ({
  page,
}) => {
  await openFixture(page, server.url);
  const year = page.getByTestId('phone-year');
  const before = (await year.innerText()).trim();
  const next = String(Number(before) + 3);
  await year.tap();
  const sheet = page.getByTestId('year-sheet');
  await expect(sheet).toBeVisible();
  await expect(sheet.getByTestId('sheet-grab')).toBeVisible();
  const input = sheet.getByTestId('sheet-year');
  await input.fill(next);
  await input.press('Enter');
  await expect(year).toHaveText(next);
  await expect
    .poll(() =>
      page.evaluate(async () => (await window.api.invoke('storyTime.get', {})).time?.year),
    )
    .toBe(Number(next));

  // A tap outside.
  await page.getByTestId('sheet-scrim').tap({ position: { x: 20, y: 120 } });
  await expect(sheet).toHaveCount(0);

  // A swipe down on the grab handle.
  await year.tap();
  await expect(sheet).toBeVisible();
  const grab = sheet.getByTestId('sheet-grab');
  const g = await box(grab);
  const at = { clientX: g.x + g.width / 2, pointerId: 7, pointerType: 'touch', isPrimary: true };
  await grab.dispatchEvent('pointerdown', { ...at, clientY: g.y + 5 });
  await grab.dispatchEvent('pointermove', { ...at, clientY: g.y + 80 });
  await grab.dispatchEvent('pointerup', { ...at, clientY: g.y + 160 });
  await expect(sheet).toHaveCount(0);

  // Back (the browser's, or the iOS edge swipe through the history).
  await year.tap();
  await expect(sheet).toBeVisible();
  await page.goBack();
  await expect(sheet).toHaveCount(0);
  await expect(page.getByTestId('workspace')).toBeVisible();

  await year.tap();
  await sheet.getByTestId('sheet-year').fill(before);
  await sheet.getByTestId('sheet-year').press('Enter');
  await expect(year).toHaveText(before);
});

test('PH-37 the chooser lists every bible and opens the one picked', async ({ page }) => {
  await openFixture(page, server.url);
  await page.getByTestId('bible-menu-button').tap();
  const list = page.getByTestId('phone-bibles');
  await expect(list.getByRole('button')).toHaveText(['Fixture novel', 'Second novel']);
  await expect(list.getByRole('button', { name: 'Fixture novel' })).toHaveAttribute(
    'aria-current',
    'true',
  );
  // No New bible on the phone.
  await expect(page.getByTestId('bible-menu-new')).toHaveCount(0);
  await list.getByRole('button', { name: 'Second novel' }).tap();
  await expect(page.getByTestId('current-bible')).toHaveText('Second novel');
  await expect(page.getByTestId('bible-sheet')).toHaveCount(0);
  await expect(page.getByTestId('list-empty')).toBeVisible();

  await page.getByTestId('bible-menu-button').tap();
  await page.getByTestId('phone-bibles').getByRole('button', { name: 'Fixture novel' }).tap();
  await expect(page.getByTestId('current-bible')).toHaveText('Fixture novel');
  await expect(page.getByTestId('entry-list')).toContainText('Margaret Hale');
});

test('PH-37 the browser back after picking another bible stays in it, on no page of the old one', async ({
  page,
}) => {
  await openFixture(page, server.url);
  await openCharacter(page, /^Margaret Hale/);
  await page.getByTestId('bible-menu-button').tap();
  await page.getByTestId('phone-bibles').getByRole('button', { name: 'Second novel' }).tap();
  await expect(page.getByTestId('current-bible')).toHaveText('Second novel');
  await expect(page.getByTestId('list-empty')).toBeVisible();
  await page.goBack();
  await expect(page.getByTestId('current-bible')).toHaveText('Second novel');
  await expect(page.getByTestId('list-empty')).toBeVisible();
  await expect(page.locator('[data-testid="editor"]:visible')).toHaveCount(0);
  await expect(page.getByTestId('phone-back')).toHaveCount(0);
  await page.getByTestId('bible-menu-button').tap();
  await page.getByTestId('phone-bibles').getByRole('button', { name: 'Fixture novel' }).tap();
  await expect(page.getByTestId('entry-list')).toContainText('Margaret Hale');
});

test('PH-30 the bottom bar: People, Outline, World, Search and +, 44 px targets, fixed while the page scrolls', async ({
  page,
}) => {
  await openFixture(page, server.url);
  const bar = page.getByTestId('phone-bottom-bar');
  const buttons = bar.getByRole('button');
  await expect(buttons).toHaveCount(5);
  await expect(buttons).toHaveText(['People', 'Outline', 'World', 'Search', '+']);
  const viewport = page.viewportSize()!;
  for (const b of await buttons.all()) {
    const r = await box(b);
    expect(r.height).toBeGreaterThanOrEqual(44);
    expect(r.width).toBeGreaterThanOrEqual(44);
    expect(r.y + r.height).toBeLessThanOrEqual(viewport.height + 1);
  }
  const at = await box(bar);
  expect(at.y + at.height).toBeGreaterThanOrEqual(viewport.height - 1);

  await openCharacter(page, /^Margaret Hale/);
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  expect((await box(bar)).y).toBeCloseTo(at.y, 0);

  // Each opens its screen; + opens the capture box.
  await bar.getByRole('button', { name: 'Outline' }).tap();
  await expect(page.getByTestId('phone-outline')).toBeVisible();
  await bar.getByRole('button', { name: 'World' }).tap();
  await expect(page.getByTestId('phone-world')).toBeVisible();
  await bar.getByRole('button', { name: 'Search' }).tap();
  await expect(page.getByTestId('search-view')).toBeVisible();
  await bar.getByRole('button', { name: 'People' }).tap();
  // The People tab kept its page.
  await expect(page.getByTestId('character-page')).toBeVisible();
  await bar.getByRole('button', { name: 'People' }).tap();
  await expect(page.getByTestId('entry-list')).toBeVisible();
  await bar.getByRole('button', { name: 'Add' }).tap();
  // A58 U5: + opens capture as a page over the tab.
  await expect(page.locator('[data-testid="phone-capture"]:visible')).toBeVisible();
});

test('PH-31 a person opens as a page; back, browser back and a reload all keep the place', async ({
  page,
}) => {
  await openFixture(page, server.url);
  // A short window, so the list scrolls.
  await page.setViewportSize({ width: 393, height: 420 });
  const list = page.getByTestId('entry-list');
  const row = list.getByRole('button', { name: /^Zhou Lan/ });
  await row.scrollIntoViewIfNeeded();
  const y = await page.evaluate(() => window.scrollY);
  expect(y).toBeGreaterThan(100);

  // The back control.
  await list.getByRole('button', { name: /^Zhou Lan/ }).tap();
  const person = page.getByTestId('character-page');
  await expect(person).toBeVisible();
  await expect(list).toBeHidden();
  expect(page.url()).toMatch(/#\/people\/e:characters:Z3$/);
  expect(await page.evaluate(() => window.scrollY)).toBeLessThan(5);
  await page.getByTestId('phone-back').tap();
  await expect(list).toBeVisible();
  expect(await page.evaluate(() => window.scrollY)).toBeCloseTo(y, -1);
  await expect(page.getByTestId('phone-back')).toHaveCount(0);

  // The browser's back (and so the iOS edge swipe).
  await list.getByRole('button', { name: /^Zhou Lan/ }).tap();
  await expect(person).toBeVisible();
  await page.goBack();
  await expect(list).toBeVisible();
  expect(await page.evaluate(() => window.scrollY)).toBeCloseTo(y, -1);
  await page.goForward();
  await expect(person).toBeVisible();

  // A reload, or an app update, comes back to the page; back then goes to the list.
  await page.reload();
  await expect(page.getByTestId('character-page')).toBeVisible();
  await expect(field(page.getByTestId('character-page'), 'names.full')).toContainText('Zhou Lan');
  await page.getByTestId('phone-back').tap();
  await expect(page.getByTestId('entry-list')).toBeVisible();

  // A deep link in a fresh page opens the page, with back to the list.
  const fresh = await page.context().newPage();
  await fresh.goto(`${server.url}/#/people/e:characters:H4`);
  await expect(fresh.getByTestId('character-page')).toBeVisible();
  await expect(field(fresh.getByTestId('character-page'), 'names.full')).toContainText('Ruth Hale');
  await fresh.getByTestId('phone-back').tap();
  await expect(fresh.getByTestId('entry-list')).toBeVisible();
  await fresh.close();
});

test('PH-31 after switching tabs, the browser back steps back within the tab showing, not to the other tab', async ({
  page,
}) => {
  await openFixture(page, server.url);
  await openCharacter(page, /^Margaret Hale/);
  await page.getByTestId('tab-outline').tap();
  const open = page
    .locator('[data-testid="chapter-bar"][data-chapter="CH2"]')
    .getByTestId('chapter-open');
  await open.tap();
  await expect(page.locator('[data-testid="editor"][data-entry-id="CH2"]')).toBeVisible();
  await page.getByTestId('tab-people').tap();
  await expect(page.getByTestId('character-page')).toBeVisible();
  await page.goBack();
  await expect(page.getByTestId('entry-list')).toBeVisible();
  await expect(page.getByTestId('tab-people')).toHaveAttribute('aria-current', 'page');
  // The Outline kept its chapter.
  await page.getByTestId('tab-outline').tap();
  await expect(page.locator('[data-testid="editor"][data-entry-id="CH2"]')).toBeVisible();
});

test('PH-32 one tap opens a text field, a year, a select and a rich field, each saved through /rpc', async ({
  page,
}) => {
  await openFixture(page, server.url);
  const channels = rpcChannels(page);
  const person = await openCharacter(page, /^Sam Hale/);

  // Text: the name.
  const name = field(person, 'names.full');
  await name.locator('.editable-text').first().tap();
  await expect(name.locator('input')).toBeFocused();
  await name.locator('input').fill('Sam Hale Junior');
  await name.locator('input').press('Enter');
  await expect.poll(async () => (await character('H6')).names.full).toBe('Sam Hale Junior');

  // A year: the birth box takes a year.
  const birth = field(person, 'birth');
  await birth.locator('.editable-text').first().tap();
  await expect(birth.locator('input')).toBeFocused();
  await birth.locator('input').fill('1999');
  await birth.locator('input').press('Enter');
  await expect.poll(async () => (await character('H6')).birth?.year).toBe(1999);

  // Rich: In the story.
  const role = person.locator('[data-field="role"] .rich-text-input');
  await role.tap();
  await expect(role).toBeFocused();
  await page.keyboard.type('The youngest');
  await expect.poll(async () => (await character('H6')).role).toBe('The youngest');

  // A select: a glossary term's language, opened from Search.
  await page.getByTestId('tab-search').tap();
  await page.getByTestId('search-view').locator('input[type="search"]').fill('团圆');
  await page.getByTestId('search-results').locator('[data-hit="GL3"]').tap();
  const editor = page.getByTestId('editor');
  await expect(editor).toHaveAttribute('data-entry-id', 'GL3');
  const language = editor.locator('[data-field="language"] select');
  const other = await language.evaluate(
    (el: HTMLSelectElement) =>
      [...el.options].find((o) => o.value && o.value !== el.value && !o.text.startsWith('Add new'))
        ?.value ?? '',
  );
  expect(other).not.toBe('');
  await language.selectOption(other);
  await expect.poll(async () => (await glossary('GL3')).language).toBe(other);

  expect(channels.filter((c) => c === 'entry.update').length).toBeGreaterThanOrEqual(4);
});

test('PH-32 every field on an entry page is 16 px or more, opened or not', async ({ page }) => {
  await openFixture(page, server.url);
  const person = await openCharacter(page, /^Margaret Hale/);
  const sizes = [...(await fieldSizes(person))];
  for (const path of ['names.full', 'names.chinese', 'birth', 'death']) {
    const f = field(person, path);
    await f.locator('.editable-text').first().tap();
    await expect(f.locator('input')).toBeVisible();
    sizes.push(...(await fieldSizes(f)));
    await f.locator('input').press('Escape');
  }
  await person.getByRole('button', { name: 'Add family' }).tap();
  sizes.push(...(await fieldSizes(field(person, 'familyIds'))));
  await page.keyboard.press('Escape');
  // A generic entry page: a place.
  await page.getByTestId('bible-menu-button').tap();
  await page.getByTestId('phone-sections').getByRole('button', { name: 'Places' }).tap();
  await page
    .locator('[data-testid="entry-list"]:visible')
    .getByRole('button', { name: /^Portland/ })
    .tap();
  const place = page.locator('[data-testid="editor"]:visible');
  await expect(place).toHaveAttribute('data-entry-id', 'PLC1');
  const placeSizes = await fieldSizes(place);
  expect(placeSizes.length, JSON.stringify(placeSizes)).toBeGreaterThan(2);
  sizes.push(...placeSizes);
  expect(sizes.length).toBeGreaterThan(10);
  for (const s of sizes) expect(s.size, s.what).toBeGreaterThanOrEqual(16);
});

test('PH-32 the field being typed in stays inside the visual viewport when the keyboard rises', async ({
  page,
}) => {
  await openFixture(page, server.url);
  const person = await openCharacter(page, /^Daniel Hale/);
  const box = person.locator('[data-field="backstory"] .rich-text-input');
  await box.tap();
  await expect(box).toBeFocused();
  // The keyboard takes the lower half: the visual viewport shrinks.
  await page.setViewportSize({ width: 393, height: 330 });
  const inView = () =>
    box.evaluate((el) => {
      const vv = window.visualViewport!;
      const r = el.getBoundingClientRect();
      const sel = window.getSelection();
      const caret =
        sel && sel.rangeCount && el.contains(sel.anchorNode)
          ? sel.getRangeAt(0).getBoundingClientRect()
          : r;
      const c = caret.height > 0 ? caret : r;
      const top = document.querySelector('.ph-top')!.getBoundingClientRect().bottom;
      return c.top >= top - 1 && c.bottom <= vv.offsetTop + vv.height + 1;
    });
  await expect.poll(inView).toBe(true);
  // And for a field low on the page, from the top.
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.setViewportSize({ width: 393, height: 659 });
  await box.tap();
  await page.setViewportSize({ width: 393, height: 300 });
  await expect.poll(inView).toBe(true);
});

test('PH-31 Search takes the focus, finds a person and opens the page; back returns to the results', async ({
  page,
}) => {
  await openFixture(page, server.url);
  await page.getByTestId('tab-search').tap();
  const input = page.getByTestId('search-view').locator('input[type="search"]');
  await expect(input).toBeFocused();
  await page.keyboard.type('Ruth');
  const results = page.getByTestId('search-results');
  await expect(results).toContainText('Ruth Hale');
  await results.locator('[data-hit="H4"]').tap();
  await expect(page.getByTestId('character-page')).toBeVisible();
  expect(page.url()).toMatch(/#\/search\/e:characters:H4$/);
  await page.getByTestId('phone-back').tap();
  await expect(results).toBeVisible();
  await expect(input).toHaveValue('Ruth');
});

test('PH-35 nothing on these screens shows only on hover: pencils, chip buttons, undo', async ({
  page,
}) => {
  await openFixture(page, server.url);
  const person = await openCharacter(page, /^Daniel Hale/);
  // Each value's pencil shows without a pointer over it.
  const pencils = await person
    .locator('.editable > .editable-text')
    .evaluateAll((els) => els.map((el) => Number(getComputedStyle(el, '::after').opacity)));
  expect(pencils.length).toBeGreaterThan(3);
  for (const o of pencils) expect(o).toBeGreaterThan(0.3);
  await expect(person.locator('.chip-remove').first()).toBeVisible();
  await expect(person.getByRole('button', { name: 'Add family' })).toBeVisible();
  for (const id of ['phone-back', 'phone-undo', 'phone-redo', 'phone-year', 'bible-menu-button']) {
    await expect(page.getByTestId(id)).toBeVisible();
  }
  // Changes is a tap away, under the bible menu.
  await page.getByTestId('bible-menu-button').tap();
  await page.getByTestId('phone-more').getByRole('button', { name: 'Changes' }).tap();
  await expect(page.getByTestId('changes-sheet')).toBeVisible();
});

test('PH-35 Undo and Redo are thumb-sized buttons that step a change back and forward', async ({
  page,
}) => {
  await openFixture(page, server.url);
  const person = await openCharacter(page, /^Peter Hale/);
  const undo = page.getByTestId('phone-undo');
  const redo = page.getByTestId('phone-redo');
  for (const b of [undo, redo]) {
    const r = await box(b);
    expect(r.width).toBeGreaterThanOrEqual(44);
    expect(r.height).toBeGreaterThanOrEqual(44);
  }
  await expect(undo).toBeDisabled();
  const name = field(person, 'names.full');
  await name.locator('.editable-text').first().tap();
  await name.locator('input').fill('Peter Hale Senior');
  await name.locator('input').press('Enter');
  await expect.poll(async () => (await character('H2')).names.full).toBe('Peter Hale Senior');
  await expect(undo).toBeEnabled();
  await undo.tap();
  await expect.poll(async () => (await character('H2')).names.full).toBe('Peter Hale');
  await expect(name).toContainText('Peter Hale');
  // What the undo did shows as a toast above the bottom bar.
  await expect(page.getByTestId('phone-toast')).toBeVisible();
  await expect(redo).toBeEnabled();
  await redo.tap();
  await expect.poll(async () => (await character('H2')).names.full).toBe('Peter Hale Senior');
  await undo.tap();
  await expect.poll(async () => (await character('H2')).names.full).toBe('Peter Hale');
});

test('PH-35 every target on People, a person, a place, Search, the top bar and the toast is 44 px, with no sideways scroll', async ({
  page,
}) => {
  await openFixture(page, server.url);
  const frame = page.locator('.ph-frame');
  const misses: string[] = [];
  const check = async (what: string, scope: Locator = frame) => {
    await noSidewaysScroll(page);
    misses.push(...(await smallTargets(scope)).map((m) => `${what}: ${m}`));
  };
  await page.getByTestId('entry-list').waitFor();
  await check('people');
  const person = await openCharacter(page, /^Daniel Hale/);
  await expect(person.locator('.chip-remove').first()).toBeVisible();
  await check('person');
  await person.getByRole('button', { name: 'Add family' }).tap();
  await check('person, adding family');
  await page.keyboard.press('Escape');
  await page.getByTestId('bible-menu-button').tap();
  await page.getByTestId('phone-sections').getByRole('button', { name: 'Places' }).tap();
  await page
    .locator('[data-testid="entry-list"]:visible')
    .getByRole('button', { name: /^Portland/ })
    .tap();
  await expect(page.locator('[data-testid="editor"]:visible')).toHaveAttribute(
    'data-entry-id',
    'PLC1',
  );
  await check('place');
  await page.getByTestId('tab-search').tap();
  await page.keyboard.type('Hale');
  await expect(page.getByTestId('search-results')).toBeVisible();
  await page.getByTestId('search-filters').locator('summary').tap();
  await expect(page.getByRole('group', { name: 'Search filters' })).toBeVisible();
  await check('search');
  // The toast a move to the trash shows, with its Undo button.
  await page.getByTestId('tab-people').tap();
  await page.getByTestId('tab-people').tap();
  await openCharacter(page, /^Peter Hale/);
  await page.getByRole('button', { name: 'Move to trash', exact: true }).tap();
  await page
    .getByRole('dialog', { name: 'Move to trash' })
    .getByRole('button', { name: 'Move to trash' })
    .tap();
  const toast = page.getByTestId('phone-toast');
  await expect(toast.getByRole('button', { name: 'Undo' })).toBeVisible();
  await check('toast', toast);
  await toast.getByRole('button', { name: 'Undo' }).tap();
  await expect.poll(async () => (await character('H2'))?.names.full).toBe('Peter Hale');
  expect(misses).toEqual([]);
});

test('PH-35 PH-37 the first-run chooser rows run full width with 44 px Open buttons, and Try again on the connection banner is 44 px', async ({
  page,
}) => {
  // A first run: no bible open yet, so the chooser shows (the function may hold one from earlier tests).
  await page.route('**/rpc', async (route) => {
    const body = JSON.parse(route.request().postData() ?? '{}') as { channel?: string };
    if (body.channel !== 'bible.current') return route.continue();
    await route.fulfill({ json: { result: { bible: null }, events: [] } });
  });
  await page.goto(server.url);
  await pasteKey(page);
  const open = page.getByRole('button', { name: 'Open Fixture novel' });
  await expect(open).toBeVisible();
  await page.unroute('**/rpc');
  await expect(page.getByRole('button', { name: 'Open Second novel' })).toBeVisible();
  const main = page.locator('main');
  await noSidewaysScroll(page);
  expect(await smallTargets(main)).toEqual([]);
  // Each bible is a row as wide as the screen between its gutters, its Open button the whole row.
  const width = page.viewportSize()!.width;
  for (const row of await page.getByTestId('bible-list').locator('li').all()) {
    const r = await box(row);
    expect(r.width).toBeGreaterThanOrEqual(width - 2 * 16 - 1);
    const b = await box(row.getByRole('button'));
    expect(b.width).toBeGreaterThanOrEqual(r.width - 1);
    expect(b.height).toBeGreaterThanOrEqual(44);
  }

  // The connection goes on the chooser, then inside a bible: Try again is a thumb's target each time.
  const banner = page.getByTestId('connection-banner');
  for (const where of ['chooser', 'workspace']) {
    if (where === 'workspace') {
      // Back online, the app may reopen the function's bible itself.
      const workspace = page.getByTestId('workspace');
      await expect(open.or(workspace)).toBeVisible();
      if (await open.isVisible()) await open.tap();
      await expect(workspace).toBeVisible();
    }
    await page.route('**/rpc', (r) => r.abort());
    await page.evaluate(() => window.dispatchEvent(new Event('offline')));
    await expect(banner).toBeVisible();
    expect(await smallTargets(banner), where).toEqual([]);
    await noSidewaysScroll(page);
    await page.unroute('**/rpc');
    await banner.getByTestId('connection-retry').tap();
    await expect(banner).toHaveCount(0);
  }
});

test('PH-35 no key hints on the phone: no kbd shows on any of these screens', async ({ page }) => {
  await openFixture(page, server.url);
  const none = async () => expect(page.locator('kbd:visible')).toHaveCount(0);
  await page.getByTestId('entry-list').waitFor();
  await page.getByTestId('find-or-add').fill('Someone New');
  await expect(page.getByTestId('find-add-new')).toBeVisible();
  await none();
  await page.getByTestId('find-or-add').fill('');
  await openCharacter(page, /^Margaret Hale/);
  await none();
  await page.getByTestId('phone-year').tap();
  await none();
  await page.goBack();
  await page.getByTestId('bible-menu-button').tap();
  await none();
  await page.goBack();
  await page.getByTestId('tab-search').tap();
  await none();
  // A toast with Undo: the button, without its key.
  await page.getByTestId('tab-people').tap();
  const person = page.getByTestId('character-page');
  const name = field(person, 'names.full');
  await name.locator('.editable-text').first().tap();
  await name.locator('input').fill('Margaret Hale Lin');
  await name.locator('input').press('Enter');
  await page.getByTestId('phone-undo').tap();
  await expect(page.getByTestId('phone-toast')).toBeVisible();
  await none();
});

test('PH-36 the shell, People, the entry page, Search and the sheets carry no instruction sentences', async ({
  page,
}) => {
  await openFixture(page, server.url);
  const seen: string[] = [];
  seen.push(...(await instructionLines(page)));
  await openCharacter(page, /^Margaret Hale/);
  seen.push(...(await instructionLines(page)));
  await page.getByTestId('phone-year').tap();
  seen.push(...(await instructionLines(page)));
  await page.goBack();
  await page.getByTestId('bible-menu-button').tap();
  seen.push(...(await instructionLines(page)));
  await page.getByTestId('phone-more').getByRole('button', { name: 'Changes' }).tap();
  seen.push(...(await instructionLines(page)));
  await page.goBack();
  await page.getByTestId('tab-search').tap();
  await page.keyboard.type('Hale');
  await expect(page.getByTestId('search-results')).toBeVisible();
  seen.push(...(await instructionLines(page)));
  expect(seen).toEqual([]);
});
