import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { Invoke } from '../helpers/t5';
import { readFixture } from '../helpers/loadFixture';
import { field, invokeVia, launch, rail } from './helpers';

let server: MongoMemoryReplSet;
let app: ElectronApplication;
let page: Page;
let invoke: Invoke;

const SLUG = 'timeline-fixture';
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
  await invoke('bible.create', { slug: SLUG, name: 'Timeline fixture' });
  await invoke('bible.open', { slug: SLUG });
  await expect(page.getByTestId('workspace')).toBeVisible();
  // A new bible starts with default decades (WE-2); the fixture brings its own eras.
  const seeded = await invoke('entry.list', { collection: 'eraStates', trash: 'exclude' });
  expect(seeded.entries).toHaveLength(8);
  for (const e of seeded.entries) {
    await invoke('entry.delete', { collection: 'eraStates', id: e.entry._id });
  }
  // The fixture's subcategories, so its events file under them.
  for (const [label, parentId] of [
    ['Robotics', 'technology'],
    ['Energy', 'technology'],
    ['Climate', null],
  ] as const) {
    await invoke('lists.addItem', { listId: 'eventCategories', label, parentId });
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

const dialog = () => page.getByTestId('story-time-dialog');
const status = () => page.getByTestId('status-time');

async function openDialog() {
  await page.keyboard.press('Meta+t');
  await expect(dialog()).toBeVisible();
}

async function closeDialog() {
  await page.keyboard.press('Escape');
  await expect(dialog()).toHaveCount(0);
}

test('TM-1 TM-3 Cmd+T opens Story Time from every screen; setting 2040 updates the tree and the status bar', async () => {
  for (const screen of ['Characters', 'Family tree', 'Timeline', 'Lists']) {
    await rail(page, screen).click();
    await openDialog();
    await closeDialog();
  }
  await rail(page, 'Family tree').click();
  await expect(page.getByTestId('tree-view')).toBeVisible();
  // Before any story time is set, screens use the current position: chapter 5, 2040.
  await expect(status()).toHaveText(
    'Story time 2040, The forties (from the current position, not set)',
  );
  await openDialog();
  await dialog().getByTestId('time-year').fill('2039');
  await expect(dialog().getByTestId('time-now')).toHaveText('2039');
  await expect(page.getByTestId('tree-year')).toHaveValue('2039');
  await dialog().getByTestId('time-year').fill('2040');
  await expect(dialog().getByTestId('time-now')).toHaveText('2040');
  await closeDialog();
  await expect(page.getByTestId('tree-year')).toHaveValue('2040');
  await expect(page.getByTestId('tree-svg')).toHaveAttribute('data-year', '2040');
  await expect(page.locator('g.tnode[data-person="H5"]')).toHaveAttribute('data-age', '9');
  await expect(page.locator('g.tnode[data-person="H1"]')).toHaveAttribute('data-age', '82');
  await expect(status()).toHaveText('Story time 2040, The forties');
  // Persisted in meta: it survives a reload of the window.
  await expect.poll(async () => (await invoke('storyTime.get', {})).time).toEqual({ year: 2040 });
  await page.reload();
  await expect(page.getByTestId('workspace')).toBeVisible();
  await expect(status()).toHaveText('Story time 2040, The forties');
});

test('TM-2 the dialog shows everyone in the year, the era, the events, and the strands', async () => {
  await openDialog();
  await dialog().getByTestId('time-year').fill('2041');
  const states = dialog().getByTestId('time-states');
  await expect(states.locator('tr[data-person="H1"] [data-state]')).toHaveText(
    'alive, age 83, dies this year',
  );
  await expect(states.locator('tr[data-person="H2"] [data-state]')).toHaveText('dead since 2030');
  await expect(states.locator('tr[data-person="Z5"] [data-state]')).toHaveText(
    'not yet born (born 2058)',
  );
  await expect(states.locator('tr[data-person="U1"] [data-state]')).toHaveText('age unknown');
  await expect(dialog().getByTestId('time-era')).toContainText('The forties');
  await dialog().getByTestId('time-year').fill('2045');
  await expect(dialog().getByTestId('time-strands')).toContainText('Two Kitchens, present');
  await expect(dialog().getByTestId('time-strands')).toContainText('The Letter, present');
  await dialog().getByTestId('time-year').fill('2042');
  await expect(dialog().getByTestId('time-events')).toContainText(
    'Grid batteries replace the last coal plant in Guangdong',
  );
  await closeDialog();
});

test('NF-2 Tab inside the open Story Time dialog never leaves it', async () => {
  await openDialog();
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press(i % 2 === 0 ? 'Tab' : 'Shift+Tab');
    expect(await dialog().evaluate((d) => d.contains(document.activeElement))).toBe(true);
  }
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press('Tab');
    expect(await dialog().evaluate((d) => d.contains(document.activeElement))).toBe(true);
  }
  await closeDialog();
});

test('TM-4 anchors: "Iris Hale-Zhou is 9" gives 2040, +10 steps to 2050, and a strand sets its year', async () => {
  await openDialog();
  await dialog().getByTestId('time-year').fill('2000');
  await dialog().getByLabel('Character').selectOption({ label: 'Iris Hale-Zhou' });
  await dialog().getByLabel('is this old').fill('9');
  await dialog().getByRole('button', { name: 'Set year from age' }).click();
  await expect(dialog().getByTestId('time-now')).toHaveText('2040');
  await expect(dialog().getByTestId('time-note')).toContainText('Iris Hale-Zhou is 9 in 2040');
  await dialog().getByRole('button', { name: 'Forward 10 years' }).click();
  await expect(dialog().getByTestId('time-now')).toHaveText('2050');
  await expect(status()).toContainText('Story time 2050');
  await dialog().getByRole('button', { name: 'Back 1 year' }).click();
  await expect(dialog().getByTestId('time-now')).toHaveText('2049');
  await dialog()
    .getByLabel('Strand')
    .selectOption({ label: 'Chapter 2: Two Kitchens, backstory (2032)' });
  await dialog().getByRole('button', { name: 'Use this strand’s year' }).click();
  await expect(dialog().getByTestId('time-now')).toHaveText('2032');
  await expect(dialog().getByTestId('time-chapter')).toContainText(
    'Chapter 2: Two Kitchens, backstory (2032)',
  );
  await expect(page.getByTestId('status-strand')).toContainText('Two Kitchens, backstory');
  await expect
    .poll(async () => (await invoke('storyTime.get', {})).time)
    .toEqual({ year: 2032, chapterId: 'CH2', strandId: 'CH2-backstory' });
});

test('TM-5 setting the time writes no entry; "Use as strand year" shows the change and writes only after approval', async () => {
  const before = (await invoke('entry.get', { collection: 'chapters', id: 'CH2' })).entry;
  await dialog().getByRole('button', { name: 'Forward 1 year' }).click();
  await expect(dialog().getByTestId('time-now')).toHaveText('2033');
  // The time moved; the chapter did not.
  await expect.poll(async () => (await invoke('storyTime.get', {})).time?.year).toBe(2033);
  expect((await invoke('entry.get', { collection: 'chapters', id: 'CH2' })).entry.modifiedAt).toBe(
    before.modifiedAt,
  );
  await dialog().getByRole('button', { name: 'Use 2033 as strand year' }).click();
  const preview = dialog().getByTestId('promote-preview');
  await expect(preview).toContainText('Two Kitchens, backstory strand year');
  await expect(preview.locator('del')).toHaveText('2032');
  await expect(preview.locator('ins')).toHaveText('2033');
  await preview.getByRole('button', { name: 'Cancel' }).click();
  await expect(preview).toHaveCount(0);
  expect((await invoke('entry.get', { collection: 'chapters', id: 'CH2' })).entry.modifiedAt).toBe(
    before.modifiedAt,
  );
  await dialog().getByRole('button', { name: 'Use 2033 as strand year' }).click();
  await dialog().getByRole('button', { name: 'Approve and write' }).click();
  await expect(dialog().getByTestId('time-note')).toContainText('now has the year 2033');
  const after = (await invoke('entry.get', { collection: 'chapters', id: 'CH2' })).entry;
  expect((after.strands as { id: string; startYear: number }[]).map((s) => s.startYear)).toEqual([
    2045, 2033,
  ]);
  const revs = await invoke('revisions.list', { collection: 'chapters', id: 'CH2' });
  expect(revs.revisions[0]?.note).toBe('Set the backstory strand year to 2033 from the story time');
  await closeDialog();
});

test('TL-2 TL-5 the year view lists everyone at the story time and what a character lived through', async () => {
  await invoke('storyTime.set', { time: { year: 2075 } });
  await rail(page, 'Year view').click();
  const table = page.getByTestId('year-table');
  await expect(page.getByRole('heading', { name: 'Who is alive in 2075' })).toBeVisible();
  await expect(table.locator('tr[data-person="H3"] [data-testid="year-age"]')).toHaveText('90');
  await expect(table.locator('tr[data-person="Z5"] [data-testid="year-age"]')).toHaveText('17');
  await expect(table.locator('tr[data-person="H1"] [data-testid="year-age"]')).toHaveText(
    'died 2041',
  );
  await expect(table.locator('tr[data-person="U1"] [data-testid="year-age"]')).toHaveText(
    'unknown',
  );
  const lived = page.getByTestId('lived-through');
  await lived.getByLabel('Character').selectOption({ label: 'Iris Hale-Zhou' });
  await expect(lived.locator('tr[data-event="E3"]')).toContainText('2034');
  await expect(lived.locator('tr[data-event="E3"] td').nth(1)).toHaveText('3');
  await expect(lived.locator('tr[data-event="E3"]')).toContainText('formative');
  await expect(lived.locator('tr[data-event="E10"]')).toHaveCount(0);
});

test('TL-7 compare shows two characters side by side, every 5 years or every year', async () => {
  await rail(page, 'Compare').click();
  const view = page.getByTestId('compare-view');
  await view.getByLabel('First').selectOption({ label: 'Margaret Hale' });
  await view.getByLabel('Second').selectOption({ label: 'Iris Hale-Zhou' });
  await view.getByLabel('From').fill('2030');
  await view.getByLabel('To').fill('2045');
  const rows = view.getByTestId('compare-table').locator('tbody tr');
  await expect(rows).toHaveCount(4);
  await expect(view.locator('tr[data-year="2040"]')).toContainText('82');
  await expect(view.locator('tr[data-year="2040"]')).toContainText('73 years');
  await expect(view.locator('tr[data-year="2045"]')).toContainText('dead (2041)');
  await view.getByLabel('Step').selectOption({ label: 'Every year' });
  await expect(rows).toHaveCount(16);
});

test('TL-6 WE-1 the timeline draws every lane with a cursor; filters by family, status, category, and place', async () => {
  await invoke('storyTime.set', { time: { year: 2040 } });
  await rail(page, 'Timeline').click();
  const view = page.getByTestId('timeline-view');
  const svg = view.getByTestId('timeline-svg');
  const filters = view.getByRole('group', { name: 'Timeline filters' });
  const marks = (kind: string) => svg.locator(`g.tl-mark[data-kind="${kind}"]`);
  await expect(marks('era')).toHaveCount(8);
  await expect(marks('event')).toHaveCount(11);
  await expect(marks('strand')).toHaveCount(9);
  await expect(marks('life')).toHaveCount(12);
  await expect(view.getByTestId('timeline-cursor')).toHaveAttribute('data-year', '2040');
  await expect(view.getByTestId('timeline-undrawn')).toContainText('The Archivist');
  // A primary strand is a filled mark and a backstory strand a hollow one.
  await expect(svg.locator('g[data-key="strand:CH2:CH2-present"] rect.tl-chap-p')).toHaveCount(1);
  await expect(svg.locator('g[data-key="strand:CH2:CH2-backstory"] rect.tl-chap-b')).toHaveCount(1);
  // Hover shows title, category, and region.
  await svg.locator('g[data-key="event:E2"]').hover();
  await expect(view.getByTestId('timeline-tip')).toContainText(
    'Care robots licensed for home use in Oregon',
  );
  await expect(view.getByTestId('timeline-tip')).toContainText('Technology > Robotics. Oregon');

  await filters.getByLabel('Family', { exact: true }).selectOption({ label: 'Zhou' });
  await expect(marks('life')).toHaveCount(6);
  await expect(marks('event')).toHaveCount(3);
  await filters.getByLabel('Family', { exact: true }).selectOption({ label: 'All families' });
  await filters.getByLabel('Status', { exact: true }).selectOption({ label: 'Planned' });
  await expect(marks('life')).toHaveCount(3);
  await filters.getByLabel('Status', { exact: true }).selectOption({ label: 'All statuses' });
  await filters.getByLabel('Category', { exact: true }).selectOption({ label: 'Technology' });
  await expect(marks('event')).toHaveCount(4);
  await filters
    .getByLabel('Category', { exact: true })
    .selectOption({ label: 'Technology > Robotics' });
  await expect(marks('event')).toHaveCount(2);
  await filters.getByRole('button', { name: 'Clear filters' }).click();
  await expect(marks('event')).toHaveCount(11);

  const place = await invoke('entry.create', {
    collection: 'places',
    data: { title: 'Portland, Oregon', status: 'canon' },
  });
  await invoke('entry.update', {
    collection: 'worldEvents',
    id: 'E3',
    patch: { placeIds: [place.entry._id] },
  });
  await filters.getByLabel('Place', { exact: true }).selectOption({ label: 'Portland, Oregon' });
  await expect(marks('event')).toHaveCount(1);
  await expect(svg.locator('g[data-key="event:E3"]')).toHaveCount(1);
  await expect(marks('life')).toHaveCount(6);
  await filters.getByRole('button', { name: 'Clear filters' }).click();
});

test('TL-6 NF-2 an event is edited from the timeline; arrow keys move between marks and Enter opens', async () => {
  const view = page.getByTestId('timeline-view');
  const svg = view.getByTestId('timeline-svg');
  await svg.locator('g[data-key="event:E4"]').click();
  const editor = view.getByTestId('timeline-inspector').getByTestId('editor');
  await expect(editor).toHaveAttribute('data-entry-id', 'E4');
  await field(editor, 'title').locator('input').fill('Pacific Rim trade accord ratified');
  await expect(editor.getByTestId('autosave')).toHaveText('Saved');
  await expect(svg.locator('g[data-key="event:E4"]')).toHaveAttribute(
    'aria-label',
    /Pacific Rim trade accord ratified/,
  );
  expect((await invoke('entry.get', { collection: 'worldEvents', id: 'E4' })).entry.title).toBe(
    'Pacific Rim trade accord ratified',
  );

  // Keyboard: the selected mark holds focus; arrows move to its neighbours.
  await svg.locator('g[data-key="event:E4"]').focus();
  await page.keyboard.press('ArrowRight');
  const next = page.locator('g.tl-mark:focus');
  await expect(next).toHaveAttribute('data-key', 'event:E5');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('g.tl-mark:focus')).toHaveAttribute('data-key', 'event:E3');
  await page.keyboard.press('Enter');
  await expect(editor).toHaveAttribute('data-entry-id', 'E3');
});

test('WE-2 the eras screen flags a gap after an edit and never blocks the save', async () => {
  await rail(page, 'Era states').click();
  await expect(page.getByTestId('era-coverage-ok')).toBeVisible();
  await invoke('entry.update', {
    collection: 'eraStates',
    id: 'ERA-2060',
    patch: { endYear: 2065 },
  });
  const flag = page.getByTestId('era-coverage');
  await expect(flag).toContainText('No era covers 2066 to 2069.');
  await expect(flag).toContainText('Every era still saves.');
  expect(
    (await invoke('entry.get', { collection: 'eraStates', id: 'ERA-2060' })).entry.endYear,
  ).toBe(2065);
  await invoke('entry.update', {
    collection: 'eraStates',
    id: 'ERA-2060',
    patch: { endYear: 2069 },
  });
  await expect(page.getByTestId('era-coverage-ok')).toBeVisible();
});

test('NF-2 FT-8 Enter on a tree node with children collapses it, Enter on a leaf and I open the inspector', async () => {
  await rail(page, 'Family tree').click();
  const node = (id: string) => page.locator(`g.tnode[data-person="${id}"]`);
  await node('H3').focus();
  await page.keyboard.press('Enter');
  await expect(node('H5')).toHaveCount(0);
  await expect(node('H3')).toHaveAttribute('aria-expanded', 'false');
  await page.keyboard.press(' ');
  await expect(node('H5')).toHaveCount(1);
  await page.keyboard.press('i');
  await expect(page.getByTestId('tree-inspector').getByTestId('inspector-name')).toHaveText(
    'Daniel Hale',
  );
  await node('Z5').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('tree-inspector').getByTestId('inspector-name')).toHaveText(
    'Noor Zhou',
  );
  await expect(page.getByTestId('tree-keys')).toContainText('I opens the inspector for anyone');
});

test('KB-4 A33 the whole-span strip sits under the chart, the story year marked, and a title opens the inspector', async () => {
  await invoke('storyTime.set', { time: { year: 2040 } });
  await rail(page, 'Timeline').click();
  const view = page.getByTestId('timeline-view');
  await expect(view.getByTestId('timeline-chart')).toBeVisible();
  const strip = view.getByTestId('we-timeline');
  await expect(strip).toBeVisible();
  // The chart comes first, then the strip, then the list.
  const top = async (id: string) => (await view.getByTestId(id).boundingBox())!.y;
  expect(await top('timeline-chart')).toBeLessThan(await top('we-timeline'));
  expect(await top('we-timeline')).toBeLessThan(await top('world-list'));
  // Eleven fixture events in eleven distinct years; years with no event collapse to a tick.
  await expect(strip.locator('.we-col:not(.empty)')).toHaveCount(11);
  await expect(strip.locator('.we-col').first()).toHaveAttribute('data-year', '2008');
  await expect(strip.locator('.we-col').last()).toHaveAttribute('data-year', '2090');
  await expect(strip.locator('.we-col.current')).toHaveAttribute('data-year', '2040');
  await strip.getByRole('button', { name: 'Care robots licensed for home use in Oregon' }).click();
  await expect(view.getByTestId('timeline-inspector').getByTestId('editor')).toHaveAttribute(
    'data-entry-id',
    'E2',
  );
});

test('KB-4 the list under the chart shows the events and eras in view; a row opens the inspector and an edit saves', async () => {
  const view = page.getByTestId('timeline-view');
  const events = view.getByTestId('world-list-worldEvents').locator('.world-row');
  const eras = view.getByTestId('world-list-eraStates').locator('.world-row');
  await expect(events).toHaveCount(11);
  await expect(eras).toHaveCount(8);
  // By year: the earliest first.
  await expect(events.first()).toHaveAttribute('data-id', 'E1');
  await expect(eras.first()).toHaveAttribute('data-id', 'ERA-2025');
  // The chart filters narrow the list as they narrow the chart.
  const filters = view.getByRole('group', { name: 'Timeline filters' });
  await filters.getByLabel('Category', { exact: true }).selectOption({ label: 'Technology' });
  await expect(events).toHaveCount(4);
  await filters.getByRole('button', { name: 'Clear filters' }).click();
  await expect(events).toHaveCount(11);

  await view.locator('.world-row[data-id="ERA-2040"]').click();
  const editor = view.getByTestId('timeline-inspector').getByTestId('editor');
  await expect(editor).toHaveAttribute('data-entry-id', 'ERA-2040');
  await field(editor, 'technology').locator('textarea').fill('Home robots in most kitchens.');
  await expect(editor.getByTestId('autosave')).toHaveText('Saved');
  expect(
    (await invoke('entry.get', { collection: 'eraStates', id: 'ERA-2040' })).entry.technology,
  ).toBe('Home robots in most kitchens.');
  await expect(view.locator('.world-row[data-id="ERA-2040"]')).toHaveAttribute(
    'aria-current',
    'true',
  );
  // Newest first puts the era just edited at the top of its column.
  await view.getByRole('button', { name: 'Newest first' }).click();
  await expect(eras.first()).toHaveAttribute('data-id', 'ERA-2040');
  await view.getByRole('button', { name: 'By year' }).click();
  await expect(eras.first()).toHaveAttribute('data-id', 'ERA-2025');
});

test('KB-4 New world event writes one at the story year and opens it in the inspector; New era state too', async () => {
  await invoke('storyTime.set', { time: { year: 2047 } });
  const view = page.getByTestId('timeline-view');
  const before = (await invoke('entry.list', { collection: 'worldEvents', trash: 'exclude' }))
    .entries.length;
  await view.getByRole('button', { name: 'New world event' }).click();
  const editor = view.getByTestId('timeline-inspector').getByTestId('editor');
  await expect(editor).toContainText('New world event');
  const id = (await editor.getAttribute('data-entry-id'))!;
  const made = (await invoke('entry.get', { collection: 'worldEvents', id })).entry;
  expect(made.start).toEqual({ year: 2047 });
  expect(
    (await invoke('entry.list', { collection: 'worldEvents', trash: 'exclude' })).entries,
  ).toHaveLength(before + 1);
  await field(editor, 'title').locator('input').fill('Harbor seawall finished');
  await expect(editor.getByTestId('autosave')).toHaveText('Saved');
  await expect(view.locator(`.world-row[data-id="${id}"]`)).toContainText(
    'Harbor seawall finished',
  );
  await expect(view.getByTestId('we-timeline').locator('.we-col[data-year="2047"]')).toContainText(
    'Harbor seawall finished',
  );
  await expect(view.getByTestId('timeline-svg').locator(`g[data-key="event:${id}"]`)).toHaveCount(
    1,
  );
  // Undo steps back through the rename and then the new event itself (ED-3); redo restores both.
  const row = view.locator(`.world-row[data-id="${id}"]`);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Meta+z');
  await expect(row).toContainText('New world event');
  await page.keyboard.press('Meta+z');
  await expect(row).toHaveCount(0);
  expect(
    (await invoke('entry.get', { collection: 'worldEvents', id })).entry.deletedAt,
  ).toBeTruthy();
  await page.keyboard.press('Shift+Meta+z');
  await expect(row).toContainText('New world event');
  await page.keyboard.press('Shift+Meta+z');
  await expect(row).toContainText('Harbor seawall finished');

  await view.getByRole('button', { name: 'New era state' }).click();
  await expect(editor).toContainText('New era');
  const eraId = (await editor.getAttribute('data-entry-id'))!;
  const era = (await invoke('entry.get', { collection: 'eraStates', id: eraId })).entry;
  expect(era).toMatchObject({ startYear: 2047, endYear: 2047 });
  await expect(view.locator(`.world-row[data-id="${eraId}"]`)).toBeVisible();
  // Undo takes the new era away again (ED-3).
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Meta+z');
  await expect(view.locator(`.world-row[data-id="${eraId}"]`)).toHaveCount(0);
});
