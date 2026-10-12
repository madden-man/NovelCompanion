import { expect, test } from '@playwright/test';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { Invoke } from '../helpers/t5';
import { readFixture } from '../helpers/loadFixture';
import { invokeVia, launch, rail } from './helpers';

/**
 * KB-1 the five-screen rail with everything else under More; KB-2 the Story
 * Time dialog as the year view, with Compare and Lived through inside it; KB-8
 * the new parts by keyboard. The TL-2, TL-5 and TL-7 rows that used to open
 * the Year view and Compare screens live here now, on the dialog.
 */
let server: MongoMemoryReplSet;
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
  server = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  ({ app, page } = await launch(server.getUri()));
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
  await server?.stop();
});

const nav = () => page.getByRole('navigation', { name: 'Sections' });
const more = () => nav().locator('details.rail-more');
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

const MORE = {
  Sessions: [
    'Dashboard',
    'Manuscript',
    'Relevant to Session',
    'Start session',
    'Session log',
    'Briefs',
    'Continuity findings',
  ],
  People: ['Families', 'Unions', 'Parent links', 'Relationships'],
  Story: ['Books', 'Parts', 'Arcs', 'Chapters', 'Plot beats'],
  World: ['World events', 'Era states'],
  Knowledge: ['Facts', 'Knowledge records', 'Themes and motifs', 'Open questions'],
  Custom: ['Custom sections', 'Family recipes'],
  Manage: [
    'Search and filters',
    'Review queue',
    'Import',
    'Backups',
    'Google Drive',
    'Lists',
    'Trash',
    'Bibles',
    'Settings',
  ],
};

test('KB-1 the rail holds five screens in order, then a closed More with every other screen in its group', async () => {
  // DB-1: the app still opens on the dashboard, which now sits under More.
  await expect(page.getByTestId('dashboard')).toBeVisible();
  await expect(rail(page, 'Dashboard')).toHaveAttribute('aria-current', 'page');
  await expect(nav().getByTestId('rail-main').getByRole('button')).toHaveText([
    'Characters',
    'Family tree',
    'Outline',
    'Timeline',
    'Entries',
  ]);
  // The search box stays at the top; More sits below the five, closed by default.
  await expect(nav().getByRole('searchbox', { name: 'Search the bible' })).toBeVisible();
  await expect(more()).not.toHaveAttribute('open', '');
  await expect(nav().getByRole('button', { name: 'Dashboard' })).toBeHidden();
  await nav().getByText('More', { exact: true }).click();
  await expect(more()).toHaveAttribute('open', '');
  const groups = more().locator('.rail-group');
  await expect(groups.locator('.eyebrow')).toHaveText(Object.keys(MORE));
  for (const [i, buttons] of Object.values(MORE).entries()) {
    await expect(groups.nth(i).getByRole('button')).toHaveText(buttons);
  }
  // Year view and Compare live in the year dialog, the four world tools in Entries.
  for (const gone of [
    'Year view',
    'Compare',
    'Culture by year',
    'Place tree',
    'Romanization',
    'Glossary table',
  ]) {
    await expect(rail(page, gone)).toHaveCount(0);
  }
  // Every screen under More still opens.
  await rail(page, 'Chapters').click();
  await expect(page.getByRole('heading', { name: 'Chapters', level: 2 })).toBeVisible();
  await rail(page, 'Entries').click();
  await expect(page.getByTestId('entries-view')).toBeVisible();
  await expect(rail(page, 'Entries')).toHaveAttribute('aria-current', 'page');
});

test('KB-1 More remembers its state for the bible across a reload', async () => {
  await expect(more()).toHaveAttribute('open', '');
  expect(await page.evaluate((id) => localStorage.getItem(`nc.rail.more.${id}`), bibleId)).toBe(
    'open',
  );
  await page.reload();
  await expect(page.getByTestId('workspace')).toBeVisible();
  await expect(more()).toHaveAttribute('open', '');
  await more().locator('summary').click();
  await expect(more()).not.toHaveAttribute('open', '');
  await page.reload();
  await expect(page.getByTestId('workspace')).toBeVisible();
  await expect(more()).not.toHaveAttribute('open', '');
  // rail() opens More for a button inside it.
  await rail(page, 'Dashboard').click();
  await expect(more()).toHaveAttribute('open', '');
  await expect(page.getByTestId('dashboard')).toBeVisible();
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
  await expect(rail(page, 'World events')).toHaveAttribute('aria-current', 'page');
});

test('KB-2 TL-2 TL-5 the dialog lists everyone at 2075 and what a character lived through', async () => {
  await invoke('storyTime.set', { time: { year: 2075 } });
  await page.keyboard.press('Meta+t');
  await expect(dialog()).toBeVisible();
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

test('KB-8 NF-2 by keyboard: More opens from the rail, the top bar button opens the dialog, and its disclosures and strip answer Enter', async () => {
  await rail(page, 'Characters').click();
  // More, closed, opens with Enter on its summary and its buttons take focus.
  if (await more().evaluate((d) => (d as HTMLDetailsElement).open)) {
    await more().locator('summary').click();
  }
  await fromTop();
  await tabTo(more().locator('summary'));
  await page.keyboard.press('Enter');
  await expect(more()).toHaveAttribute('open', '');
  await tabTo(nav().getByRole('button', { name: 'Lists', exact: true }));
  await page.keyboard.press('Enter');
  await expect(rail(page, 'Lists')).toHaveAttribute('aria-current', 'page');

  // The top bar's year button, then Escape returns focus to it.
  await invoke('storyTime.set', { time: { year: 2045 } });
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
