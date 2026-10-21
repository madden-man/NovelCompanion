import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import type { Invoke } from '../helpers/t5';
import { readFixture } from '../helpers/loadFixture';
import { contrast } from '../helpers/contrast';
import type { Rgba } from '../helpers/contrast';
import { fileDb, invokeVia, launch, rail, screenTab } from './helpers';
import type { TestDb } from './helpers';

let db: TestDb;
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
  db = fileDb();
  ({ app, page } = await launch(db));
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
  // The fixture's category list in its own order (SM-8 rows follow it): Technology with
  // Robotics and Energy, then Climate, Geopolitics, Economy, Culture.
  for (const itemId of ['geopolitics', 'economy', 'environment', 'demographics', 'culture']) {
    await invoke('lists.removeItem', { listId: 'eventCategories', itemId });
  }
  for (const [label, parentId] of [
    ['Robotics', 'technology'],
    ['Energy', 'technology'],
    ['Climate', null],
    ['Geopolitics', null],
    ['Economy', null],
    ['Culture', null],
  ] as const) {
    await invoke('lists.addItem', { listId: 'eventCategories', label, parentId });
  }
  const list = (await invoke('lists.get', {})).lists.find((l) => l._id === 'eventCategories');
  expect(list?.items.map((i) => [i.id, i.parentId])).toEqual(
    (
      fixture.lists!.find((l) => l._id === 'eventCategories')!.items as {
        id: string;
        parentId: string | null;
      }[]
    ).map((i) => [i.id, i.parentId]),
  );
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
  await dialog().getByLabel('Age', { exact: true }).fill('9');
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

test('WE-2 the eras screen flags a gap after an edit and never blocks the save', async () => {
  await screenTab(page, 'Cultural data', 'Eras');
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

// ---------- SM-8: the World events grid ----------

const view = () => page.getByTestId('timeline-view');
const grid = () => view().getByTestId('world-grid');
const marker = (id: string) => grid().locator(`.wg-marker[data-id="${id}"]`);
const inspector = () => view().getByTestId('timeline-inspector').getByTestId('editor');
const rowKeys = () =>
  grid()
    .locator('.wg-row')
    .evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.row));

async function zoomTo(name: 'Whole span' | 'Medium' | 'Close') {
  const b = view().getByRole('group', { name: 'Zoom' }).getByRole('button', { name, exact: true });
  await b.click();
  await expect(b).toHaveAttribute('aria-pressed', 'true');
}

async function axis(): Promise<{ ppy: number; from: number; to: number }> {
  const g = grid();
  return {
    ppy: Number(await g.getAttribute('data-ppy')),
    from: Number(await g.getAttribute('data-from')),
    to: Number(await g.getAttribute('data-to')),
  };
}

/** Scroll the grid sideways so a year sits in the middle of the track. */
async function showYear(year: number) {
  await grid().evaluate((el, y) => {
    const ppy = Number(el.dataset.ppy);
    const from = Number(el.dataset.from);
    // The track starts after the 200 pixel label column.
    el.scrollLeft = Math.max(0, (y - from + 0.5) * ppy - (el.clientWidth - 200) / 2);
  }, year);
}

/** The screen point at the middle of a year's column in a row. */
async function pointAt(rowKey: string, year: number) {
  const { ppy, from } = await axis();
  await grid()
    .locator(`.wg-row[data-row="${rowKey}"] .wg-row-label`)
    .evaluate((el) => el.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
  await showYear(year);
  const track = grid().locator(`.wg-row[data-row="${rowKey}"] .wg-track`);
  const box = (await track.boundingBox())!;
  const at = { x: box.x + (year - from + 0.5) * ppy, y: box.y + box.height / 2 };
  // Nothing covers the spot: the click lands on the row's track itself.
  expect(await track.evaluate((el, p) => document.elementFromPoint(p.x, p.y) === el, at)).toBe(
    true,
  );
  return at;
}

async function blurAndUndo() {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Meta+z');
}

const getEvent = async (id: string) =>
  (await invoke('entry.get', { collection: 'worldEvents', id })).entry as Record<string, unknown>;

test('SM-8 the fixture categories are rows under their group headings in list order, each event at its year', async () => {
  await invoke('storyTime.set', { time: { year: 2040 } });
  await rail(page, 'Timeline').click();
  await expect(grid()).toBeVisible();
  // The span starts at 2025 by default; the 2008 Olympics widen it.
  expect(await axis()).toMatchObject({ from: 2008, to: 2100 });
  await expect(grid().locator('.wg-group-label')).toHaveText([
    /Technology/,
    /Climate/,
    /Geopolitics/,
    /Economy/,
    /Culture/,
  ]);
  // Technology has an event filed under it with no subcategory, so it keeps a row of its own first.
  expect(await rowKeys()).toEqual([
    'technology',
    'robotics',
    'energy',
    'climate',
    'geopolitics',
    'economy',
    'culture',
  ]);
  await expect(grid().locator('.wg-row[data-row="robotics"] .wg-row-label')).toHaveText('Robotics');
  await expect(grid().locator('.wg-row[data-row="robotics"]')).toHaveAttribute(
    'data-group',
    'technology',
  );
  const where: [string, string, number, number][] = [
    ['E1', 'culture', 2008, 2008],
    ['E2', 'robotics', 2027, 2027],
    ['E3', 'climate', 2034, 2034],
    ['E4', 'geopolitics', 2036, 2036],
    ['E5', 'energy', 2042, 2042],
    ['E6', 'climate', 2048, 2051],
    ['E7', 'geopolitics', 2057, 2057],
    ['E8', 'economy', 2063, 2063],
    ['E9', 'robotics', 2072, 2072],
    ['E10', 'climate', 2090, 2090],
    ['E11', 'technology', 2081, 2081],
  ];
  await expect(grid().locator('.wg-marker')).toHaveCount(where.length);
  for (const [id, row, start, end] of where) {
    const m = grid().locator(`.wg-row[data-row="${row}"] .wg-marker[data-id="${id}"]`);
    await expect(m).toHaveAttribute('data-year', String(start));
    await expect(m).toHaveAttribute('data-end-year', String(end));
  }
  // A range is a bar to its end year; formative events are larger.
  await expect(marker('E6')).toHaveClass(/\bbar\b/);
  await expect(marker('E3')).toHaveClass(/\bbig\b/);
  await expect(marker('E2')).not.toHaveClass(/\bbig\b/);
  // The marker sits in its year's column on screen.
  await zoomTo('Close');
  const { ppy, from } = await axis();
  const track = (await grid().locator('.wg-row[data-row="energy"] .wg-track').boundingBox())!;
  const dot = (await marker('E5').boundingBox())!;
  expect(Math.abs(dot.x + dot.width / 2 - (track.x + (2042 - from + 0.5) * ppy))).toBeLessThan(1.5);
  const bar = (await marker('E6').boundingBox())!;
  expect(bar.width).toBeCloseTo(4 * ppy, 0);
  // The era band runs under the year header, one segment per era.
  const eras = grid().getByTestId('era-band').locator('.wg-era');
  await expect(eras).toHaveCount(8);
  await expect(eras.first()).toHaveText('The late twenties');
  await expect(eras.first()).toHaveAttribute('data-from', '2025');
});

test('SM-8 hover shows the title; a label shows beside a marker only when the row leaves room', async () => {
  await zoomTo('Close');
  await showYear(2027);
  await marker('E2').hover();
  const tip = grid().getByTestId('grid-tip');
  await expect(tip).toContainText('2027 Care robots licensed for home use in Oregon');
  await expect(tip).toContainText('Robotics. Oregon');
  // Close: the 2090 ice event has the rest of the century to its right.
  await expect(marker('E10').locator('.wg-mlabel')).toHaveText(
    'Arctic summer sea ice is gone for good',
  );
  await zoomTo('Whole span');
  // Whole span: ten years of columns is no longer room for that title.
  await expect(marker('E10').locator('.wg-mlabel')).toHaveCount(0);
  await marker('E10').hover();
  await expect(tip).toContainText('Arctic summer sea ice is gone for good');
  // The whole span fits the panel: no sideways scroll.
  expect(await grid().evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
});

test('SM-8 a group heading collapses its rows and their markers merge onto the heading line', async () => {
  const heading = grid().locator('.wg-group[data-group="technology"] .wg-group-label');
  await expect(heading).toHaveAttribute('aria-expanded', 'true');
  await heading.click();
  await expect(heading).toHaveAttribute('aria-expanded', 'false');
  expect(await rowKeys()).toEqual(['climate', 'geopolitics', 'economy', 'culture']);
  const merged = grid().locator('.wg-group[data-group="technology"] .wg-marker');
  await expect(merged).toHaveCount(4);
  expect(await merged.evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.id))).toEqual([
    'E2',
    'E5',
    'E9',
    'E11',
  ]);
  await heading.click();
  await expect(heading).toHaveAttribute('aria-expanded', 'true');
  await expect(grid().locator('.wg-group[data-group="technology"] .wg-marker')).toHaveCount(0);
  await expect(grid().locator('.wg-row[data-group="technology"]')).toHaveCount(3);
});

test('SM-8 ED-3 a click on an empty spot adds an event at that row and year through the write path; the inspector opens it and Undo removes it', async () => {
  await zoomTo('Close');
  await showYear(2045);
  const before = (await invoke('entry.list', { collection: 'worldEvents', trash: 'exclude' }))
    .entries.length;
  const at = await pointAt('robotics', 2045);
  await page.mouse.click(at.x, at.y);
  const form = grid().getByTestId('grid-add');
  await expect(form).toBeVisible();
  await expect(form).toHaveAccessibleName('New world event in Robotics');
  await expect(form.getByLabel('Year', { exact: true })).toHaveValue('2045');
  await expect(form.getByLabel('Title')).toBeFocused();
  await form.getByLabel('Title').fill('Robot nurses staff Portland hospitals');
  await form.getByLabel('End year').fill('2047');
  await form.getByLabel('Formative').check();
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(form).toHaveCount(0);
  await expect(inspector()).toContainText('Robot nurses staff Portland hospitals');
  const id = (await inspector().getAttribute('data-entry-id'))!;
  const made = await getEvent(id);
  expect(made).toMatchObject({
    title: 'Robot nurses staff Portland hospitals',
    categoryId: 'robotics',
    start: { year: 2045 },
    end: { year: 2047 },
    formative: true,
    status: 'idea',
  });
  expect(
    (await invoke('entry.list', { collection: 'worldEvents', trash: 'exclude' })).entries,
  ).toHaveLength(before + 1);
  const m = grid().locator(`.wg-row[data-row="robotics"] .wg-marker[data-id="${id}"]`);
  await expect(m).toHaveAttribute('data-year', '2045');
  await expect(m).toHaveClass(/\bbig\b/);
  // One undo step takes it away again (ED-3).
  await blurAndUndo();
  await expect(m).toHaveCount(0);
  expect((await getEvent(id)).deletedAt).toBeTruthy();
  // Escape closes the form without writing.
  const again = await pointAt('robotics', 2045);
  await page.mouse.click(again.x, again.y);
  await expect(form).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(form).toHaveCount(0);
  expect(
    (await invoke('entry.list', { collection: 'worldEvents', trash: 'exclude' })).entries,
  ).toHaveLength(before);
});

test('SM-8 ED-1 a click on a marker opens its event in the inspector, and a saved edit shows on the marker', async () => {
  await showYear(2036);
  await marker('E4').click();
  await expect(inspector()).toHaveAttribute('data-entry-id', 'E4');
  await expect(marker('E4')).toHaveAttribute('aria-current', 'true');
  await invoke('entry.update', {
    collection: 'worldEvents',
    id: 'E4',
    patch: { title: 'Pacific Rim trade accord ratified' },
  });
  await expect(marker('E4')).toHaveAttribute('aria-label', /Pacific Rim trade accord ratified/);
  await invoke('entry.update', {
    collection: 'worldEvents',
    id: 'E4',
    patch: { title: 'Pacific Rim trade accord signed' },
  });
});

test('SM-8 ED-3 dragging a marker along its row changes its year, shown live, and Undo restores it', async () => {
  await zoomTo('Close');
  await showYear(2044);
  const { ppy } = await axis();
  const box = (await marker('E5').boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + ppy, cy, { steps: 3 });
  await page.mouse.move(cx + 3 * ppy, cy, { steps: 3 });
  await expect(grid().getByTestId('drag-year')).toHaveText('2045');
  await page.mouse.up();
  await expect(grid().getByTestId('drag-year')).toHaveCount(0);
  await expect(marker('E5')).toHaveAttribute('data-year', '2045');
  // After a drag, a plain click on another marker opens it: no click is lost.
  await marker('E3').click();
  await expect(inspector()).toHaveAttribute('data-entry-id', 'E3');
  await expect.poll(async () => (await getEvent('E5')).start).toEqual({ year: 2045 });
  // Still in its own row.
  await expect(grid().locator('.wg-row[data-row="energy"] .wg-marker[data-id="E5"]')).toHaveCount(
    1,
  );
  await blurAndUndo();
  await expect(marker('E5')).toHaveAttribute('data-year', '2042');
  expect((await getEvent('E5')).start).toEqual({ year: 2042 });

  // A range moves with its end year.
  await showYear(2049);
  const bar = (await marker('E6').boundingBox())!;
  const bx = bar.x + 10;
  const by = bar.y + bar.height / 2;
  await page.mouse.move(bx, by);
  await page.mouse.down();
  await page.mouse.move(bx - 2 * ppy, by, { steps: 4 });
  await expect(grid().getByTestId('drag-year')).toHaveText('2046');
  await page.mouse.up();
  await expect(marker('E6')).toHaveAttribute('data-year', '2046');
  await expect(marker('E6')).toHaveAttribute('data-end-year', '2049');
  const moved = await getEvent('E6');
  expect([moved.start, moved.end]).toEqual([{ year: 2046 }, { year: 2049 }]);
  await blurAndUndo();
  await expect(marker('E6')).toHaveAttribute('data-year', '2048');
  await expect(marker('E6')).toHaveAttribute('data-end-year', '2051');
  // A click without movement opens the event instead of moving it.
  await marker('E6').click();
  await expect(inspector()).toHaveAttribute('data-entry-id', 'E6');
  expect((await getEvent('E6')).start).toEqual({ year: 2048 });
});

test('SM-8 NF-2 ArrowRight moves a focused marker a year and Shift+ArrowRight its end year, one undo step each', async () => {
  await marker('E4').focus();
  await page.keyboard.press('ArrowRight');
  await expect(marker('E4')).toHaveAttribute('data-year', '2037');
  expect(await marker('E4').evaluate((el) => el === document.activeElement)).toBe(true);
  expect((await getEvent('E4')).start).toEqual({ year: 2037 });
  await page.keyboard.press('Shift+ArrowRight');
  await expect(marker('E4')).toHaveAttribute('data-end-year', '2038');
  expect((await getEvent('E4')).end).toEqual({ year: 2038 });
  await page.keyboard.press('ArrowLeft');
  await expect(marker('E4')).toHaveAttribute('data-year', '2036');
  await expect(marker('E4')).toHaveAttribute('data-end-year', '2037');
  // Three steps back: the left move, the end year, the right move.
  await blurAndUndo();
  await expect(marker('E4')).toHaveAttribute('data-year', '2037');
  await page.keyboard.press('Meta+z');
  await expect(marker('E4')).toHaveAttribute('data-end-year', '2037');
  await page.keyboard.press('Meta+z');
  await expect(marker('E4')).toHaveAttribute('data-year', '2036');
  await expect(marker('E4')).toHaveAttribute('data-end-year', '2036');
  const back = await getEvent('E4');
  expect([back.start, back.end]).toEqual([{ year: 2036 }, null]);
});

test('SM-8 the region chips narrow the markers', async () => {
  const chips = view().getByRole('group', { name: 'Regions' });
  const all = chips.getByRole('button', { name: 'All regions' });
  await expect(all).toHaveAttribute('aria-pressed', 'true');
  await expect(chips.getByRole('button')).toHaveText([
    'All regions',
    'Arctic',
    'China',
    'Guangdong',
    'Oregon',
    'Pacific',
    'United States',
    'Washington',
  ]);
  await chips.getByRole('button', { name: 'Oregon' }).click();
  await expect(chips.getByRole('button', { name: 'Oregon' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(all).toHaveAttribute('aria-pressed', 'false');
  await expect(grid().locator('.wg-marker')).toHaveCount(4);
  expect(
    await grid()
      .locator('.wg-marker')
      .evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.id).sort()),
  ).toEqual(['E2', 'E3', 'E8', 'E9']);
  await chips.getByRole('button', { name: 'Guangdong' }).click();
  await expect(grid().locator('.wg-marker')).toHaveCount(7);
  await chips.getByRole('button', { name: 'Oregon' }).click();
  await expect(grid().locator('.wg-marker')).toHaveCount(3);
  await all.click();
  await expect(grid().locator('.wg-marker')).toHaveCount(11);
  await expect(chips.getByRole('button', { name: 'Guangdong' })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
});

test('WE-1 SM-8 the category filter narrows the rows', async () => {
  const filter = view().getByRole('group', { name: 'Categories' });
  const category = filter.getByLabel('Category', { exact: true });
  const all = ['technology', 'robotics', 'energy', 'climate', 'geopolitics', 'economy', 'culture'];
  expect(await rowKeys()).toEqual(all);
  await expect(category.locator('option')).toHaveText([
    'All categories',
    'Technology',
    'Climate',
    'Geopolitics',
    'Economy',
    'Culture',
  ]);
  // A group with no subcategories offers no second level.
  await category.selectOption({ label: 'Climate' });
  expect(await rowKeys()).toEqual(['climate']);
  await expect(filter.getByLabel('Subcategory')).toHaveCount(0);
  await expect(grid().locator('.wg-marker')).toHaveCount(3);
  await category.selectOption({ label: 'Technology' });
  expect(await rowKeys()).toEqual(['technology', 'robotics', 'energy']);
  await expect(grid().locator('.wg-group')).toHaveCount(1);
  await expect(grid().locator('.wg-marker')).toHaveCount(4);
  const sub = filter.getByLabel('Subcategory');
  await expect(sub.locator('option')).toHaveText(['All subcategories', 'Robotics', 'Energy']);
  await sub.selectOption({ label: 'Robotics' });
  expect(await rowKeys()).toEqual(['robotics']);
  expect(
    await grid()
      .locator('.wg-marker')
      .evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.id)),
  ).toEqual(['E2', 'E9']);
  await category.selectOption({ label: 'All categories' });
  expect(await rowKeys()).toEqual(all);
  await expect(grid().locator('.wg-marker')).toHaveCount(11);
});

test('SM-8 TM-3 the story year line and the writing band sit where the story time says', async () => {
  // For this test Chapter 7's present strand runs 2060 to 2063, and it gains a backstory
  // strand, not primary, from 2052 to 2054.
  const ch7 = (await invoke('entry.get', { collection: 'chapters', id: 'CH7' })).entry;
  const strands = ch7.strands as Record<string, unknown>[];
  await invoke('entry.update', {
    collection: 'chapters',
    id: 'CH7',
    patch: {
      strands: [
        ...strands.map((s) => ({ ...s, endYear: 2063 })),
        {
          ...strands[0],
          id: 'CH7-backstory',
          label: 'backstory',
          primary: false,
          startYear: 2052,
          endYear: 2054,
        },
      ],
    },
  });
  await invoke('storyTime.set', {
    time: { year: 2061, chapterId: 'CH7', strandId: 'CH7-present' },
  });
  await zoomTo('Close');
  const line = grid().getByTestId('grid-story-year');
  await expect(line).toHaveAttribute('data-year', '2061');
  const band = grid().getByTestId('grid-writing');
  await expect(band).toHaveAttribute('data-from', '2060');
  await expect(band).toHaveAttribute('data-to', '2063');
  await expect(band).toHaveAttribute('title', /Chapter 7: Rain in Guangzhou/);
  const { ppy, from } = await axis();
  const track = (await grid().locator('.wg-row[data-row="climate"] .wg-track').boundingBox())!;
  const lb = (await line.boundingBox())!;
  expect(Math.abs(lb.x + lb.width / 2 - (track.x + (2061 - from + 0.5) * ppy))).toBeLessThan(1.5);
  const bb = (await band.boundingBox())!;
  expect(Math.abs(bb.x - (track.x + (2060 - from) * ppy))).toBeLessThan(1.5);
  expect(bb.width).toBeCloseTo(4 * ppy, 0);
  // The line crosses every row, from the first to the last.
  const first = (await grid().locator('.wg-line').first().boundingBox())!;
  const last = (await grid().locator('.wg-line').last().boundingBox())!;
  expect(lb.y).toBeLessThanOrEqual(first.y + 1);
  expect(lb.y + lb.height).toBeGreaterThanOrEqual(last.y + last.height - 1);
  // The Writing picker on the backstory strand: the band follows that strand, not the primary.
  await invoke('storyTime.set', {
    time: { year: 2053, chapterId: 'CH7', strandId: 'CH7-backstory' },
  });
  await expect(band).toHaveAttribute('data-from', '2052');
  await expect(band).toHaveAttribute('data-to', '2054');
  await expect(band).toHaveAttribute('title', /Rain in Guangzhou, backstory/);
  await expect(line).toHaveAttribute('data-year', '2053');
  // Story time moves the line; no chapter, no band.
  await invoke('storyTime.set', { time: { year: 2050 } });
  await expect(line).toHaveAttribute('data-year', '2050');
  await expect(band).toHaveCount(0);
  await expect(view().getByTestId('timeline-time')).toHaveText('Story time 2050');
  await invoke('entry.update', { collection: 'chapters', id: 'CH7', patch: { strands } });
});

test('SM-8 A33 "The world around" lists the five-year window and a title opens the event; the grid opens on the story year', async () => {
  await invoke('storyTime.set', { time: { year: 2051 } });
  const around = view().getByTestId('world-around');
  await expect(around.getByRole('heading')).toHaveText('The world around 2051');
  const strip = around.getByTestId('world-around-strip');
  await expect(strip.locator('.we-col')).toHaveCount(5);
  await expect(strip.locator('.we-col').first()).toHaveAttribute('data-year', '2048');
  await expect(strip.locator('.we-col').last()).toHaveAttribute('data-year', '2052');
  await expect(strip.getByTestId('sel-item')).toHaveCount(1);
  await expect(strip.getByTestId('sel-item')).toHaveAttribute('data-id', 'E6');
  await invoke('storyTime.set', { time: { year: 2039 } });
  await expect(around.getByRole('heading')).toHaveText('The world around 2039');
  await expect(strip.getByTestId('sel-item')).toHaveCount(1);
  await strip.getByRole('button', { name: 'Pacific Rim trade accord signed' }).click();
  await expect(inspector()).toHaveAttribute('data-entry-id', 'E4');
  // The window sits above the grid.
  const top = async (l: ReturnType<Page['locator']>) => (await l.boundingBox())!.y;
  expect(await top(around)).toBeLessThan(await top(grid()));
  // Opening the screen again, close up, scrolls the grid to the story year.
  await rail(page, 'Characters').click();
  await rail(page, 'Timeline').click();
  await zoomTo('Close');
  const g = (await grid().boundingBox())!;
  const lb = (await grid().getByTestId('grid-story-year').boundingBox())!;
  expect(lb.x).toBeGreaterThan(g.x + 200);
  expect(lb.x).toBeLessThan(g.x + g.width);
});

/** Press Tab until the target has focus. */
async function tabTo(target: ReturnType<Page['locator']>, max = 200) {
  for (let i = 0; i < max; i++) {
    if (await target.evaluate((el) => el === document.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  throw new Error('Tab never reached the target.');
}

const parseRgb = (s: string): Rgba => {
  const p = s.match(/[\d.]+/g)!.map(Number);
  return [p[0]!, p[1]!, p[2]!, p[3] ?? 1];
};

test('SM-8 NF-2 the whole screen works from the keyboard and its labels use the primary text colour in both themes', async () => {
  await invoke('storyTime.set', { time: { year: 2044 } });
  await rail(page, 'Timeline').click();
  await expect(grid()).toBeVisible();
  // Region chips and zoom by keyboard.
  const oregon = view()
    .getByRole('group', { name: 'Regions' })
    .getByRole('button', { name: 'Oregon' });
  await view().getByRole('button', { name: 'Change' }).focus();
  await tabTo(oregon);
  await page.keyboard.press('Space');
  await expect(grid().locator('.wg-marker')).toHaveCount(4);
  await page.keyboard.press('Space');
  await expect(grid().locator('.wg-marker')).toHaveCount(11);
  // A group heading collapses with Enter.
  const heading = grid().locator('.wg-group[data-group="climate"] .wg-group-label');
  await tabTo(heading);
  await page.keyboard.press('Enter');
  await expect(heading).toHaveAttribute('aria-expanded', 'false');
  await page.keyboard.press('Enter');
  await expect(heading).toHaveAttribute('aria-expanded', 'true');
  // A row label adds an event at the story year, all from the keyboard.
  const label = grid().locator('.wg-row[data-row="energy"] .wg-row-label');
  await expect(label).toHaveAccessibleName('Energy, add an event in 2044');
  await tabTo(label);
  await page.keyboard.press('Enter');
  const form = grid().getByTestId('grid-add');
  await expect(form.getByLabel('Title')).toBeFocused();
  await expect(form.getByLabel('Year', { exact: true })).toHaveValue('2044');
  await page.keyboard.type('Fusion pilot plant opens');
  await page.keyboard.press('Enter');
  await expect(form).toHaveCount(0);
  await expect(inspector()).toContainText('Fusion pilot plant opens');
  const id = (await inspector().getAttribute('data-entry-id'))!;
  expect((await getEvent(id)).categoryId).toBe('energy');
  await blurAndUndo();
  await expect(marker(id)).toHaveCount(0);
  // The markers are one Tab stop. Up and Down walk them in reading order, row by row and
  // year by year; Home and End jump to the ends; Enter opens one; Tab leaves them.
  const order = await grid()
    .locator('.wg-marker')
    .evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.id));
  expect(order).toEqual(['E11', 'E2', 'E9', 'E5', 'E3', 'E6', 'E10', 'E4', 'E7', 'E8', 'E1']);
  const stop = grid().locator('.wg-marker[tabindex="0"]');
  await expect(stop).toHaveCount(1);
  const focusedMarker = () =>
    page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      return el?.classList.contains('wg-marker') ? (el.dataset.id ?? null) : null;
    });
  await view().getByRole('button', { name: 'Change' }).focus();
  let reached = 0;
  for (let i = 0; i < 80 && !(await focusedMarker()); i++) await page.keyboard.press('Tab');
  const landed = (await focusedMarker())!;
  expect(landed).toBe(await stop.getAttribute('data-id'));
  await page.keyboard.press('Home');
  await expect(marker('E11')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(marker('E2')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(marker('E9')).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(marker('E2')).toBeFocused();
  await page.keyboard.press('End');
  await expect(marker('E1')).toBeFocused();
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(marker('E9')).toBeFocused();
  await expect(stop).toHaveAttribute('data-id', 'E9');
  await page.keyboard.press('Enter');
  await expect(inspector()).toHaveAttribute('data-entry-id', 'E9');
  // Tab from the grid's stop reaches no other marker: the rest of the screen, then out.
  await marker('E9').focus();
  await page.keyboard.press('Tab');
  expect(await focusedMarker()).toBeNull();
  for (let i = 0; i < 60; i++) {
    await page.keyboard.press('Tab');
    if (await focusedMarker()) reached += 1;
    const inGrid = await grid().evaluate((g) => g.contains(document.activeElement));
    if (!inGrid) break;
  }
  expect(reached).toBe(0);
  expect(await grid().evaluate((g) => g.contains(document.activeElement))).toBe(false);
  // An era opens from the keyboard too.
  const era = grid().getByTestId('era-band').locator('.wg-era[data-id="ERA-2040"]');
  await era.focus();
  await page.keyboard.press('Enter');
  await expect(inspector()).toHaveAttribute('data-entry-id', 'ERA-2040');

  // Labels: the primary text colour, never a muted grey, and 4.5:1 on their background.
  const labels = [
    '.wg-row-label',
    '.wg-group-label',
    '.wg-tick',
    '.wg-corner',
    '.wg-era',
    '.wg-toolbar-label',
  ];
  const theme0 = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
    const read = await page.evaluate((sels) => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--fg)';
      document.body.append(probe);
      const fg = getComputedStyle(probe).color;
      probe.remove();
      const bgOf = (el: Element | null): string => {
        for (let e = el; e; e = e.parentElement) {
          const b = getComputedStyle(e).backgroundColor;
          if (b && !/rgba\(0, 0, 0, 0\)|transparent/.test(b)) return b;
        }
        return getComputedStyle(document.body).backgroundColor;
      };
      return {
        fg,
        found: sels.map((s) => {
          const el = document.querySelector(`[data-testid="timeline-view"] ${s}`);
          return { s, color: el ? getComputedStyle(el).color : '', bg: bgOf(el) };
        }),
      };
    }, labels);
    for (const f of read.found) {
      expect(f.color, `${f.s} in ${theme}`).toBe(read.fg);
      expect(
        contrast(parseRgb(f.color), parseRgb(f.bg)),
        `${f.s} in ${theme}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  }
  await page.evaluate((t) => {
    if (t === null) document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', t);
  }, theme0);
  // The year header and the labels stay put while the grid scrolls.
  await zoomTo('Close');
  await grid().evaluate((el) => {
    el.scrollLeft = 400;
    el.scrollTop = 60;
  });
  const g = (await grid().boundingBox())!;
  const lab = (await grid().locator('.wg-row-label').last().boundingBox())!;
  expect(Math.abs(lab.x - g.x)).toBeLessThan(2);
  const head = (await grid().locator('.wg-head').boundingBox())!;
  expect(Math.abs(head.y - g.y)).toBeLessThan(2);
});
