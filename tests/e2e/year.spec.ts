import { expect, test } from '@playwright/test';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import type { Invoke } from '../helpers/t5';
import { readFixture } from '../helpers/loadFixture';
import { APP_MENU_ITEMS, RAIL_SCREENS, fileDb, invokeVia, launch, rail } from './helpers';
import type { TestDb } from './helpers';

/**
 * SM-6 the eight-screen rail with the App menu at its foot (KB-1's five
 * screens and More are withdrawn by it); KB-2 the Story Time dialog as the
 * year view, with Compare and Lived through inside it; KB-8 the new parts by
 * keyboard. The TL-2, TL-5 and TL-7 rows that used to open the Year view and
 * Compare screens live here, on the dialog.
 */
let db: TestDb;
let app: ElectronApplication;
let page: Page;
let invoke: Invoke;
let bibleId: string;

const SLUG = 'year-fixture';
const fixture = readFixture();

test.describe.configure({ mode: 'serial' });

function strip(d: Record<string, unknown>): Record<string, unknown> {
  const { createdAt: _c, modifiedAt: _m, ...rest } = d;
  return rest;
}

test.beforeAll(async () => {
  db = fileDb();
  ({ app, page } = await launch(db));
  invoke = invokeVia(page);
  bibleId = (await invoke('bible.create', { slug: SLUG, name: 'Year fixture' })).bible.id;
  await invoke('bible.open', { slug: SLUG });
  await expect(page.getByTestId('workspace')).toBeVisible();
  // A new bible starts with default decades (WE-2); the fixture brings its own eras.
  const seeded = await invoke('entry.list', { collection: 'eraStates', trash: 'exclude' });
  for (const e of seeded.entries) {
    await invoke('entry.delete', { collection: 'eraStates', id: e.entry._id });
  }
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
});

const nav = () => page.getByRole('navigation', { name: 'Sections' });
const appButton = () => nav().getByTestId('app-menu-button');
const appMenu = () => nav().getByRole('menu');
const dialog = () => page.getByTestId('story-time-dialog');
const editor = () => page.getByTestId('editor');

async function closeDialog() {
  await page.keyboard.press('Escape');
  await expect(dialog()).toHaveCount(0);
}

const isFocused = (loc: Locator) =>
  loc.evaluate((el) => el === document.activeElement || el.contains(document.activeElement));

/** Press Tab until the control has focus; fail when it never does. Nothing is clicked. */
async function tabTo(loc: Locator, max = 300) {
  await expect(loc).toBeVisible();
  for (let i = 0; i < max; i++) {
    if (await isFocused(loc)) return;
    await page.keyboard.press('Tab');
  }
  throw new Error(`Tab never reached ${String(loc)}`);
}

async function fromTop() {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

/** What each screen of the rail shows when it opens. */
const SCREEN_SHOWS: Record<(typeof RAIL_SCREENS)[number], () => Locator> = {
  Characters: () => page.getByRole('heading', { name: 'Characters', level: 2 }),
  'Family tree': () => page.getByTestId('tree-view'),
  Outline: () => page.getByTestId('outline-view'),
  'World events': () => page.getByTestId('world-grid'),
  Backstory: () => page.getByTestId('backstory-view'),
  'Continuity checker': () => page.getByTestId('continuity-view'),
  Sessions: () => page.getByTestId('sessions-view'),
  'Cultural data': () => page.getByTestId('cultural-data'),
};

/** What each App menu item shows when it opens. */
const MENU_SHOWS: Record<(typeof APP_MENU_ITEMS)[number], () => Locator> = {
  'Search and filters': () => page.getByTestId('search-view'),
  'Review queue': () => page.getByTestId('review-queue'),
  Import: () => page.getByTestId('import-view'),
  Backups: () => page.getByTestId('backups-view'),
  'Google Drive': () => page.getByTestId('drive-view'),
  Lists: () => page.getByRole('heading', { name: 'Lists', level: 2 }),
  Trash: () => page.getByRole('heading', { name: 'Trash', level: 2 }),
  Bibles: () => page.getByTestId('bible-list'),
  Settings: () => page.getByTestId('settings-view'),
  'Place tree': () => page.getByTestId('places-view'),
  Romanization: () => page.getByTestId('romanization-view'),
  'Glossary table': () => page.getByTestId('glossary-table'),
};

test('SM-6 the rail is the eight screens in order under the search box, with no More, and the app opens on Sessions', async () => {
  // DB-1 SM-11: the app opens on Sessions, which holds what the dashboard held.
  await expect(page.getByTestId('sessions-view')).toBeVisible();
  await expect(page.getByTestId('dashboard')).toBeVisible();
  await expect(rail(page, 'Sessions')).toHaveAttribute('aria-current', 'page');
  await expect(nav().getByTestId('rail-main').getByRole('button')).toHaveText([...RAIL_SCREENS]);
  // The search box sits above the eight.
  const search = nav().getByRole('searchbox', { name: 'Search the bible' });
  await expect(search).toBeVisible();
  expect(
    await search.evaluate(
      (a, b) => !!(a.compareDocumentPosition(b!) & Node.DOCUMENT_POSITION_FOLLOWING),
      await nav().getByTestId('rail-main').elementHandle(),
    ),
  ).toBe(true);
  // No More disclosure, and nothing remembered for it (KB-1 withdrawn).
  await expect(nav().locator('details')).toHaveCount(0);
  await expect(nav().getByText('More', { exact: true })).toHaveCount(0);
  expect(await page.evaluate((id) => localStorage.getItem(`nc.rail.more.${id}`), bibleId)).toBe(
    null,
  );
  // Only the eight and the App button are visible in the rail; the menu is closed.
  await expect(nav().getByRole('button')).toHaveText([...RAIL_SCREENS, 'App']);
  await expect(appButton()).toHaveAttribute('aria-expanded', 'false');
  await expect(appMenu()).toBeHidden();
  // The old screens and the raw section lists are gone from the rail.
  for (const gone of [
    'Timeline',
    'Entries',
    'Dashboard',
    'Manuscript',
    'Relevant to Session',
    'Start session',
    'Moments',
    'Chapters',
    'Open questions',
    'Culture by year',
  ]) {
    await expect(nav().getByRole('button', { name: gone, exact: true })).toHaveCount(0);
    await expect(
      nav().getByRole('menuitem', { name: gone, exact: true, includeHidden: true }),
    ).toHaveCount(0);
  }
});

test('SM-6 each of the eight screens opens from its rail button', async () => {
  for (const screen of RAIL_SCREENS) {
    await rail(page, screen).click();
    await expect(rail(page, screen)).toHaveAttribute('aria-current', 'page');
    await expect(SCREEN_SHOWS[screen]()).toBeVisible();
  }
  // "Timeline" still names World events while the older specs are renamed.
  await rail(page, 'Timeline').click();
  await expect(rail(page, 'World events')).toHaveAttribute('aria-current', 'page');
  // A name the rail does not have fails at once, naming the valid ones, instead of timing out.
  expect(() => rail(page, 'Dashboard')).toThrow(
    /"Dashboard" is not in the rail\. The rail screens are Characters, Family tree, Outline, World events, Backstory, Continuity checker, Sessions, Cultural data \("Timeline" still names World events\)/,
  );
});

test('SM-6 the App menu holds the nine utilities and the reference views, and each item opens its screen', async () => {
  await appButton().click();
  await expect(appButton()).toHaveAttribute('aria-expanded', 'true');
  await expect(appMenu()).toBeVisible();
  await expect(appMenu().getByRole('group')).toHaveCount(2);
  await expect(appMenu().getByRole('group', { name: 'Manage' }).getByRole('menuitem')).toHaveText(
    APP_MENU_ITEMS.slice(0, 9),
  );
  await expect(
    appMenu().getByRole('group', { name: 'Reference' }).getByRole('menuitem'),
  ).toHaveText(['Place tree', 'Romanization', 'Glossary table']);
  // Escape closes it.
  await page.keyboard.press('Escape');
  await expect(appMenu()).toBeHidden();
  await expect(appButton()).toBeFocused();
  for (const item of APP_MENU_ITEMS) {
    await rail(page, item).click();
    await expect(appMenu()).toBeHidden();
    await expect(MENU_SHOWS[item]()).toBeVisible();
    await expect(rail(page, item)).toHaveAttribute('aria-current', 'page');
  }
  // A click outside closes an open menu.
  await appButton().click();
  await expect(appMenu()).toBeVisible();
  await page.getByTestId('status-bar').click({ position: { x: 4, y: 4 } });
  await expect(appMenu()).toBeHidden();
});

test('SM-6 SR-1 a section list that left the rail opens from Search and filters, and search still opens any entry', async () => {
  await rail(page, 'Search and filters').click();
  const view = page.getByTestId('search-view');
  await expect(view.getByTestId('search-open-section')).toHaveCount(0);
  await view.getByLabel('Section').selectOption({ label: 'Chapters' });
  await view.getByTestId('search-open-section').click();
  await expect(page.getByRole('heading', { name: 'Chapters', level: 2 })).toBeVisible();
  await expect(page.getByTestId('entry-list').getByRole('button')).toHaveCount(
    fixture.chapters!.length,
  );
  // A place and a glossary term open from the rail search box (SR-1).
  const box = nav().getByRole('searchbox', { name: 'Search the bible' });
  await box.fill('Portland');
  await page
    .getByTestId('search-results')
    .getByRole('button', { name: /Portland/ })
    .first()
    .click();
  await expect(editor()).toContainText('Portland');
  await box.fill('团圆');
  await page.getByTestId('search-results').getByRole('button', { name: /团圆/ }).first().click();
  await expect(editor()).toContainText('团圆');
});

test('KB-2 the top bar year button opens the dialog: everyone first, then the era, the five-year strip, and the strands', async () => {
  await invoke('storyTime.set', { time: { year: 2045 } });
  const open = page.getByTestId('top-open-year');
  await expect(open).toHaveText('The forties');
  await expect(open).toHaveAccessibleName('Open the year, The forties');
  await open.click();
  await expect(dialog()).toBeVisible();
  await expect(dialog().getByTestId('time-now')).toHaveText('2045');

  const states = dialog().getByTestId('time-states');
  await expect(dialog().getByRole('heading', { name: 'Everyone in 2045' })).toBeVisible();
  await expect(states.locator('tbody tr')).toHaveCount(13);
  await expect(states.locator('tr[data-person="H3"] [data-testid="year-age"]')).toHaveText('60');
  await expect(states.locator('tr[data-person="H1"] [data-state]')).toHaveText('dead since 2041');
  await expect(states.locator('tr[data-person="Z5"] [data-testid="year-age"]')).toHaveText(
    'born 2058',
  );
  await expect(states.locator('tr[data-person="U1"] [data-testid="year-age"]')).toHaveText(
    'unknown',
  );
  await expect(states.locator('tr[data-person="H5"]')).toContainText('Hale');

  const world = dialog().getByTestId('time-world');
  await expect(world.getByRole('heading', { name: 'The world in 2045' })).toBeVisible();
  // The states come right under the time controls, before the world.
  expect(
    await states.evaluate(
      (a, b) => !!(a.compareDocumentPosition(b!) & Node.DOCUMENT_POSITION_FOLLOWING),
      await world.elementHandle(),
    ),
  ).toBe(true);
  await expect(world.getByTestId('time-era')).toContainText('The forties (2040 to 2049)');
  await expect(world.getByTestId('time-era')).toContainText('Grid batteries everywhere.');
  const stripYears = world.getByTestId('time-events').locator('li.we-col');
  await expect(stripYears).toHaveCount(5);
  expect(
    await stripYears.evaluateAll((els) => els.map((e) => e.getAttribute('data-year'))),
  ).toEqual(['2042', '2043', '2044', '2045', '2046']);
  await expect(world.locator('li.we-col[data-year="2045"]')).toHaveAttribute(
    'aria-current',
    'date',
  );
  await expect(world.locator('li.we-col[data-year="2042"]')).toContainText(
    'Grid batteries replace the last coal plant in Guangdong',
  );
  await expect(world.getByTestId('time-strands')).toContainText('Two Kitchens, present');
  // KB-2: inside the world, the era, then the strip, then the strands.
  expect(
    await world
      .locator(
        '[data-testid="time-era"], [data-testid="time-events"], [data-testid="time-strands"]',
      )
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid'))),
  ).toEqual(['time-era', 'time-events', 'time-strands']);

  // TL-4: in the year of death a character is alive and flagged.
  await dialog().getByRole('button', { name: 'Back 1 year' }).click();
  await dialog().getByRole('button', { name: 'Back 1 year' }).click();
  await dialog().getByRole('button', { name: 'Back 1 year' }).click();
  await dialog().getByRole('button', { name: 'Back 1 year' }).click();
  await expect(dialog().getByTestId('time-now')).toHaveText('2041');
  await expect(states.locator('tr[data-person="H1"] [data-state]')).toHaveText(
    'alive, age 83, dies this year',
  );
  await expect(states.locator('tr[data-person="H1"] [data-testid="year-age"]')).toHaveText('83');
  await dialog().getByTestId('time-year').fill('2045');
  await expect(dialog().getByTestId('time-now')).toHaveText('2045');
});

test('KB-2 an event title in the strip opens its entry and closes the dialog', async () => {
  await expect(dialog()).toBeVisible();
  await dialog()
    .getByTestId('time-events')
    .getByRole('button', { name: 'Grid batteries replace the last coal plant in Guangdong' })
    .click();
  await expect(dialog()).toHaveCount(0);
  await expect(editor()).toBeVisible();
  await expect(editor()).toContainText('Grid batteries replace the last coal plant in Guangdong');
});

test('KB-2 TL-2 TL-5 the dialog lists everyone at 2075 and what a character lived through', async () => {
  await page.keyboard.press('Meta+t');
  await expect(dialog()).toBeVisible();
  await dialog().getByTestId('time-year').fill('2075');
  await expect(dialog().getByTestId('time-now')).toHaveText('2075');
  const table = dialog().getByTestId('time-states');
  await expect(table.locator('tr[data-person="H3"] [data-testid="year-age"]')).toHaveText('90');
  await expect(table.locator('tr[data-person="Z5"] [data-testid="year-age"]')).toHaveText('17');
  await expect(table.locator('tr[data-person="H1"] [data-testid="year-age"]')).toHaveText(
    'died 2041',
  );
  await expect(table.locator('tr[data-person="U1"] [data-testid="year-age"]')).toHaveText(
    'unknown',
  );
  const disclosure = dialog().getByTestId('time-lived');
  await disclosure.getByText('Lived through', { exact: true }).click();
  const lived = disclosure.getByTestId('lived-through');
  await lived.getByLabel('Lived through by').selectOption({ label: 'Iris Hale-Zhou' });
  await expect(lived.locator('tr[data-event="E3"]')).toContainText('2034');
  await expect(lived.locator('tr[data-event="E3"] td').nth(1)).toHaveText('3');
  await expect(lived.locator('tr[data-event="E3"]')).toContainText('formative');
  await expect(lived.locator('tr[data-event="E10"]')).toHaveCount(0);
  await closeDialog();
});

test('KB-2 TL-7 compare is a disclosure in the dialog: two characters side by side, every 5 years or every year', async () => {
  await page.keyboard.press('Meta+t');
  const disclosure = dialog().getByTestId('time-compare');
  await expect(disclosure).not.toHaveAttribute('open', '');
  await disclosure.getByText('Compare two characters', { exact: true }).click();
  const view = disclosure.getByTestId('compare-view');
  await view.getByLabel('First').selectOption({ label: 'Margaret Hale' });
  await view.getByLabel('Second').selectOption({ label: 'Iris Hale-Zhou' });
  await view.getByLabel('From').fill('2030');
  await view.getByLabel('To').fill('2045');
  const rows = view.getByTestId('compare-table').locator('tbody tr');
  await expect(rows).toHaveCount(4);
  await expect(view.locator('tr[data-year="2040"]')).toContainText('82');
  await expect(view.locator('tr[data-year="2040"]')).toContainText('73 years');
  await expect(view.locator('tr[data-year="2045"]')).toContainText('dead (2041)');
  await view.getByLabel('Step', { exact: true }).selectOption({ label: 'Every year' });
  await expect(rows).toHaveCount(16);
  await closeDialog();
});

test('KB-8 NF-2 SM-6 by keyboard: the App menu opens from the rail, the top bar button opens the dialog, and its disclosures and strip answer Enter', async () => {
  await rail(page, 'Characters').click();
  // The App menu: Enter opens it on its first item, the arrows move, Enter picks, focus comes back.
  await fromTop();
  await tabTo(appButton());
  await page.keyboard.press('Enter');
  await expect(appMenu()).toBeVisible();
  await expect(appMenu().getByRole('menuitem', { name: 'Search and filters' })).toBeFocused();
  await page.keyboard.press('End');
  await expect(appMenu().getByRole('menuitem', { name: 'Glossary table' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(appMenu().getByRole('menuitem', { name: 'Search and filters' })).toBeFocused();
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowDown');
  await expect(appMenu().getByRole('menuitem', { name: 'Lists' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(appMenu()).toBeHidden();
  await expect(rail(page, 'Lists')).toHaveAttribute('aria-current', 'page');
  await expect(appButton()).toBeFocused();
  // ArrowUp on the button opens it on the last item; Tab closes it and moves on.
  await page.keyboard.press('ArrowUp');
  await expect(appMenu().getByRole('menuitem', { name: 'Glossary table' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(appMenu()).toBeHidden();

  // The top bar's year button, then Escape returns focus to it.
  await invoke('storyTime.set', { time: { year: 2045 } });
  await expect(page.getByTestId('status-time')).toContainText('Story time 2045');
  const open = page.getByTestId('top-open-year');
  await fromTop();
  await tabTo(open);
  await page.keyboard.press('Enter');
  await expect(dialog()).toBeVisible();
  await expect(dialog().getByTestId('time-year')).toBeFocused();
  await closeDialog();
  await expect(open).toBeFocused();

  // Cmd+T, then Tab to the Compare disclosure and open it with Enter.
  await page.keyboard.press('Meta+t');
  await expect(dialog()).toBeVisible();
  const compare = dialog().getByTestId('time-compare');
  await tabTo(compare.locator('summary'));
  await page.keyboard.press('Enter');
  await expect(compare).toHaveAttribute('open', '');
  await tabTo(compare.getByLabel('First'));
  await page.keyboard.type('Ruth');
  await expect(compare.getByTestId('compare-table')).toContainText('Ruth Hale');
  const lived = dialog().getByTestId('time-lived');
  await tabTo(lived.locator('summary'));
  await page.keyboard.press('Enter');
  await expect(lived.getByTestId('lived-table')).toBeVisible();
  // Focus stays in the dialog through the new parts (the trap knows the disclosures).
  for (let i = 0; i < 60; i++) {
    await page.keyboard.press('Tab');
    expect(await dialog().evaluate((d) => d.contains(document.activeElement))).toBe(true);
  }
  // An event title in the strip opens its entry with Enter.
  const event = dialog()
    .getByTestId('time-events')
    .getByRole('button', { name: 'Grid batteries replace the last coal plant in Guangdong' });
  await tabTo(event);
  await page.keyboard.press('Enter');
  await expect(dialog()).toHaveCount(0);
  await expect(editor()).toContainText('Grid batteries replace the last coal plant in Guangdong');
});
