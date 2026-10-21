import { expect, test } from '@playwright/test';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import type { Invoke } from '../helpers/t5';
import { readFixture } from '../helpers/loadFixture';
import { contrast } from '../helpers/contrast';
import type { Rgba } from '../helpers/contrast';
import { fileDb, invokeVia, launch, rail } from './helpers';
import type { TestDb } from './helpers';

let db: TestDb;
let app: ElectronApplication;
let page: Page;
let invoke: Invoke;

const SLUG = 'backstory-fixture';
const fixture = readFixture();
/** The grid's sticky label column. */
const LABEL_W = 220;

test.describe.configure({ mode: 'serial' });

function strip(d: Record<string, unknown>): Record<string, unknown> {
  const { createdAt: _c, modifiedAt: _m, ...rest } = d;
  return rest;
}

test.beforeAll(async () => {
  db = fileDb();
  ({ app, page } = await launch(db));
  invoke = invokeVia(page);
  await invoke('bible.create', { slug: SLUG, name: 'Backstory fixture' });
  await invoke('bible.open', { slug: SLUG });
  await expect(page.getByTestId('workspace')).toBeVisible();
  // A new bible starts with default decades (WE-2); the fixture brings its own eras.
  const seeded = await invoke('entry.list', { collection: 'eraStates', trash: 'exclude' });
  for (const e of seeded.entries) {
    await invoke('entry.delete', { collection: 'eraStates', id: e.entry._id });
  }
  for (const c of Object.keys(fixture)) {
    if (c === 'lists' || !fixture[c]?.length) continue;
    await invoke('entry.createMany', {
      items: fixture[c]!.map((d) => ({ collection: c as never, data: strip(d) })),
    });
  }
  await invoke('storyTime.set', { time: { year: 2040 } });
});

test.afterAll(async () => {
  await app?.close();
});

const view = () => page.getByTestId('backstory-view');
const grid = () => view().getByTestId('backstory-grid');
const row = (id: string) => grid().locator(`.bs-row[data-person="${id}"]`);
const label = (id: string) => row(id).locator('.bs-row-label');
const marker = (id: string) => grid().locator(`.bs-marker[data-id="${id}"]`);
const table = () => view().getByTestId('moments-table');
const tableRow = (id: string) => table().locator(`tr[data-id="${id}"]`);
const cell = (id: string, field: string) =>
  tableRow(id).locator(`[data-field="${field}"] textarea, [data-field="${field}"] input`).first();

const getMoment = async (id: string) =>
  (await invoke('entry.get', { collection: 'moments', id })).entry as Record<string, unknown>;
const liveMoments = async () =>
  (await invoke('entry.list', { collection: 'moments', trash: 'exclude' })).entries.map(
    (e) => e.entry as Record<string, unknown>,
  );

async function openBackstory() {
  await rail(page, 'Backstory').click();
  await expect(grid()).toBeVisible();
}

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
  await grid().evaluate(
    (el, [y, w]) => {
      const ppy = Number(el.dataset.ppy);
      const from = Number(el.dataset.from);
      el.scrollLeft = Math.max(0, (y - from + 0.5) * ppy - (el.clientWidth - w) / 2);
    },
    [year, LABEL_W] as const,
  );
}

/** Scroll the grid down so a person's row sits just below the sticky year header. */
async function showRow(personId: string) {
  await grid().evaluate((g, id) => {
    const r = g.querySelector<HTMLElement>(`.bs-row[data-person="${id}"]`);
    const head = g.querySelector<HTMLElement>('.wg-head');
    if (r && head) g.scrollTop = Math.max(0, r.offsetTop - head.offsetHeight - 8);
  }, personId);
}

/** The screen point in the middle of a year's column in a person's row, on the bare track. */
async function pointAt(personId: string, year: number) {
  const { ppy, from } = await axis();
  await showRow(personId);
  await showYear(year);
  const track = row(personId).locator('.wg-track');
  const box = (await track.boundingBox())!;
  // Below the lane's middle, clear of the lifespan bar and any marker label.
  const at = { x: box.x + (year - from + 0.5) * ppy, y: box.y + box.height - 4 };
  expect(await track.evaluate((el, p) => document.elementFromPoint(p.x, p.y) === el, at)).toBe(
    true,
  );
  return at;
}

async function blurAndUndo() {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Meta+z');
}

/** Press Tab until the target has focus. */
async function tabTo(target: Locator, max = 200) {
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

test('SM-9 FT-1 TL-2 the fixture families are headings in tree order, their people rows in tree order, each lifespan at its years', async () => {
  await openBackstory();
  // The axis takes in every birth: Peter Hale, 1956.
  expect(await axis()).toMatchObject({ from: 1956, to: 2100 });
  await expect(grid().locator('.wg-group-label')).toHaveText([
    /Hale\s*\(6\)/,
    /Zhou\s*\(5\)/,
    /No family\s*\(2\)/,
  ]);
  // The tree reads top to bottom, left to right; Iris (in both families) is one row, under Hale.
  expect(
    await grid()
      .locator('.bs-row')
      .evaluateAll((els) =>
        els.map((e) => [(e as HTMLElement).dataset.person, (e as HTMLElement).dataset.family]),
      ),
  ).toEqual([
    ['H1', 'FAM-HALE'],
    ['H2', 'FAM-HALE'],
    ['H4', 'FAM-HALE'],
    ['H3', 'FAM-HALE'],
    ['H6', 'FAM-HALE'],
    ['H5', 'FAM-HALE'],
    ['Z1', 'FAM-ZHOU'],
    ['Z2', 'FAM-ZHOU'],
    ['Z3', 'FAM-ZHOU'],
    ['Z4', 'FAM-ZHOU'],
    ['Z5', 'FAM-ZHOU'],
    ['U1', '__nofamily'],
    ['X1', '__nofamily'],
  ]);
  // The label is the name with the Chinese name.
  await expect(label('Z1')).toHaveText('Zhou Meiling周美玲');
  await expect(label('H1')).toHaveText('Margaret Hale');
  // Margaret Hale: 1958 to 2041, solid, in the Hale colour, across exactly those years.
  await expect(row('H1')).toHaveAttribute('data-birth', '1958');
  await expect(row('H1')).toHaveAttribute('data-death', '2041');
  const life = row('H1').getByTestId('lifespan');
  await expect(life).toHaveAttribute('data-kind', 'dead');
  await expect(life).toHaveAttribute('data-from', '1958');
  await expect(life).toHaveAttribute('data-to', '2041');
  await expect(life.locator('.bs-life-dash')).toHaveCount(0);
  await zoomTo('Close');
  const { ppy, from } = await axis();
  await showYear(1990);
  const track = (await row('H1').locator('.wg-track').boundingBox())!;
  const bar = (await life.boundingBox())!;
  expect(Math.abs(bar.x - (track.x + (1958 - from) * ppy))).toBeLessThan(1.5);
  expect(Math.abs(bar.width - (2041 - 1958 + 1) * ppy)).toBeLessThan(1.5);
  const hale = await life
    .locator('.bs-life-solid')
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  const series1 = await page.evaluate(() => {
    const p = document.createElement('span');
    p.style.color = 'var(--series-1)';
    document.body.append(p);
    const c = getComputedStyle(p).color;
    p.remove();
    return c;
  });
  expect(hale).toBe(series1);
  // Daniel Hale is alive: the bar runs to the end of the axis, dashed past the story year.
  const daniel = row('H3').getByTestId('lifespan');
  await expect(daniel).toHaveAttribute('data-kind', 'alive');
  await expect(daniel).toHaveAttribute('data-to', '');
  await expect(daniel).toHaveAttribute('data-dash-from', '2041');
  await expect(daniel.locator('.bs-life-dash')).toHaveCount(1);
  expect(Math.abs((await daniel.boundingBox())!.width - (2100 - 1985 + 1) * ppy)).toBeLessThan(1.5);
  // The Archivist's birth is unknown: no bar, and it says so.
  await expect(row('U1')).toHaveAttribute('data-life', 'unknown');
  await expect(row('U1').getByTestId('lifespan')).toHaveText('Birth year unknown');
  await expect(row('U1').locator('.bs-life')).toHaveCount(0);
  // The story year is a line and the era band runs under the header.
  await expect(grid().getByTestId('grid-story-year')).toHaveAttribute('data-year', '2040');
  await expect(grid().getByTestId('era-band').locator('.wg-era').first()).toHaveText(
    'The late twenties',
  );
});

test('SM-9 SM-3 the fixture moments sit at their years in their people’s rows; hover shows the title', async () => {
  const where: [string, string, number, number][] = [
    ['H1-voice-0', 'H1', 2028, 2028],
    ['H5-voice-0', 'H5', 2060, 2060],
    ['Z3-lives-0', 'Z3', 1988, 2027],
    ['Z3-lives-1', 'Z3', 2027, 2027],
  ];
  await expect(grid().locator('.bs-marker')).toHaveCount(where.length);
  for (const [id, who, start, end] of where) {
    const m = row(who).locator(`.bs-marker[data-id="${id}"]`);
    await expect(m).toHaveAttribute('data-year', String(start));
    await expect(m).toHaveAttribute('data-end-year', String(end));
  }
  await expect(marker('Z3-lives-0')).toHaveClass(/\bbar\b/);
  const { ppy, from } = await axis();
  await showYear(2028);
  const track = (await row('H1').locator('.wg-track').boundingBox())!;
  const dot = (await marker('H1-voice-0').boundingBox())!;
  expect(Math.abs(dot.x + dot.width / 2 - (track.x + (2028 - from + 0.5) * ppy))).toBeLessThan(1.5);
  await marker('H1-voice-0').hover();
  const tip = grid().getByTestId('grid-tip');
  await expect(tip).toContainText('2028 Voice');
  await expect(tip).toContainText('Margaret Hale, age 70');
  // With room in the lane, the title is a direct label too.
  await expect(marker('H5-voice-0').locator('.wg-mlabel')).toHaveText('Voice');
});

test('SM-9 TL-3 picking a person lists their moments in year order with their ages', async () => {
  await expect(view().getByTestId('backstory-none')).toBeVisible();
  await label('Z3').click();
  await expect(label('Z3')).toHaveAttribute('aria-pressed', 'true');
  await expect(view().getByTestId('moments-heading')).toHaveText('Zhou Lan 周兰, 1988');
  await expect(table().locator('tbody tr')).toHaveCount(2);
  expect(
    await table()
      .locator('tbody tr')
      .evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.id)),
  ).toEqual(['Z3-lives-0', 'Z3-lives-1']);
  await expect(table().locator('th')).toHaveText([
    'Year',
    'Age',
    'What happens',
    'How they experience it',
    'Relevant world events',
    'Actions',
  ]);
  await expect(cell('Z3-lives-0', 'year')).toHaveValue('1988');
  await expect(tableRow('Z3-lives-0').locator('.bs-to')).toHaveText('to 2027');
  await expect(tableRow('Z3-lives-0').getByTestId('moment-age')).toHaveText('0');
  await expect(tableRow('Z3-lives-1').getByTestId('moment-age')).toHaveText('39');
  await expect(cell('Z3-lives-1', 'title')).toHaveValue('Lives in Portland, Oregon');
  // A marker click picks its person and highlights its row.
  await marker('H1-voice-0').click();
  await expect(label('H1')).toHaveAttribute('aria-pressed', 'true');
  await expect(tableRow('H1-voice-0')).toHaveAttribute('aria-current', 'true');
  await expect(tableRow('H1-voice-0').getByTestId('moment-age')).toHaveText('70');
  await expect(cell('H1-voice-0', 'body')).toHaveValue(
    'Speaks in short, dry sentences and never raises her voice.',
  );
});

test('SM-9 ED-3 a cell edit saves over IPC on Enter or blur, one undo step each, and Undo restores it', async () => {
  await label('Z3').click();
  const body = cell('Z3-lives-1', 'body');
  await body.fill('She misses the river smell and says so every spring.');
  await body.press('Enter');
  await expect
    .poll(async () => (await getMoment('Z3-lives-1')).body)
    .toBe('She misses the river smell and says so every spring.');
  // The year saves on blur, and the age follows.
  const year = cell('Z3-lives-1', 'year');
  await year.fill('2029');
  await page.keyboard.press('Tab');
  await expect.poll(async () => (await getMoment('Z3-lives-1')).year).toBe(2029);
  await expect(tableRow('Z3-lives-1').getByTestId('moment-age')).toHaveText('41');
  await expect(marker('Z3-lives-1')).toHaveAttribute('data-year', '2029');
  // A year that is not a number is refused in plain words and writes nothing.
  await year.fill('soon');
  await page.keyboard.press('Tab');
  await expect(tableRow('Z3-lives-1').getByRole('alert')).toHaveText(
    'The year is a whole number, such as 2042.',
  );
  await year.press('Escape');
  expect((await getMoment('Z3-lives-1')).year).toBe(2029);
  await blurAndUndo();
  await expect(cell('Z3-lives-1', 'year')).toHaveValue('2027');
  expect((await getMoment('Z3-lives-1')).year).toBe(2027);
  await page.keyboard.press('Meta+z');
  await expect(cell('Z3-lives-1', 'body')).toHaveValue('');
  expect((await getMoment('Z3-lives-1')).body).toBe('');
});

test('SM-9 Add a moment makes a row at the story year with focus on What happens, and the grid shows its marker', async () => {
  const before = (await liveMoments()).length;
  await view().getByRole('button', { name: 'Add a moment' }).click();
  await expect.poll(async () => (await liveMoments()).length).toBe(before + 1);
  const made = (await liveMoments()).find((m) => !fixture.moments!.some((f) => f._id === m._id))!;
  expect([made.characterId, made.year, made.endYear, made.title]).toEqual(['Z3', 2040, null, '']);
  const id = String(made._id);
  await expect(cell(id, 'title')).toBeFocused();
  await expect(tableRow(id).getByTestId('moment-age')).toHaveText('52');
  await page.keyboard.type('Opens a noodle shop on Division Street');
  await page.keyboard.press('Enter');
  await expect
    .poll(async () => (await getMoment(id)).title)
    .toBe('Opens a noodle shop on Division Street');
  await expect(row('Z3').locator(`.bs-marker[data-id="${id}"]`)).toHaveAttribute(
    'data-year',
    '2040',
  );
  // Two steps back: the title, then the moment itself.
  await blurAndUndo();
  await expect(cell(id, 'title')).toHaveValue('');
  await page.keyboard.press('Meta+z');
  await expect(marker(id)).toHaveCount(0);
  await expect(tableRow(id)).toHaveCount(0);
  expect((await getMoment(id)).deletedAt).toBeTruthy();
});

test('SM-9 a click on an empty spot in a row adds a moment for that person at that year', async () => {
  await zoomTo('Close');
  const at = await pointAt('H4', 2050);
  await page.mouse.click(at.x, at.y);
  await expect(label('H4')).toHaveAttribute('aria-pressed', 'true');
  await expect(view().getByTestId('moments-heading')).toHaveText('Ruth Hale, 1990 to 2067');
  const made = (await liveMoments()).find((m) => m.characterId === 'H4')!;
  expect(made.year).toBe(2050);
  const id = String(made._id);
  await expect(cell(id, 'title')).toBeFocused();
  await expect(tableRow(id).getByTestId('moment-age')).toHaveText('60');
  await expect(row('H4').locator(`.bs-marker[data-id="${id}"]`)).toHaveAttribute(
    'data-year',
    '2050',
  );
  await blurAndUndo();
  await expect(marker(id)).toHaveCount(0);
  expect((await getMoment(id)).deletedAt).toBeTruthy();
});

test('SM-9 ED-3 a marker drags along its row to a new year and Undo restores it; ArrowRight does the same', async () => {
  await zoomTo('Close');
  await showRow('H1');
  await showYear(2029);
  const { ppy } = await axis();
  const box = (await marker('H1-voice-0').boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + ppy, cy, { steps: 3 });
  await page.mouse.move(cx + 3 * ppy, cy, { steps: 3 });
  await expect(grid().getByTestId('drag-year')).toHaveText('2031');
  await page.mouse.up();
  await expect(grid().getByTestId('drag-year')).toHaveCount(0);
  await expect(marker('H1-voice-0')).toHaveAttribute('data-year', '2031');
  await expect.poll(async () => (await getMoment('H1-voice-0')).year).toBe(2031);
  await expect(row('H1').locator('.bs-marker[data-id="H1-voice-0"]')).toHaveCount(1);
  await blurAndUndo();
  await expect(marker('H1-voice-0')).toHaveAttribute('data-year', '2028');
  expect((await getMoment('H1-voice-0')).year).toBe(2028);

  // From the keyboard: ArrowRight a year, the focus stays; a range keeps its length.
  await marker('H1-voice-0').focus();
  await page.keyboard.press('ArrowRight');
  await expect(marker('H1-voice-0')).toHaveAttribute('data-year', '2029');
  await expect(marker('H1-voice-0')).toBeFocused();
  expect((await getMoment('H1-voice-0')).year).toBe(2029);
  await blurAndUndo();
  await expect(marker('H1-voice-0')).toHaveAttribute('data-year', '2028');
  expect((await getMoment('H1-voice-0')).year).toBe(2028);
  await marker('Z3-lives-0').focus();
  await page.keyboard.press('ArrowLeft');
  await expect(marker('Z3-lives-0')).toHaveAttribute('data-year', '1987');
  await expect(marker('Z3-lives-0')).toHaveAttribute('data-end-year', '2026');
  const moved = await getMoment('Z3-lives-0');
  expect([moved.year, moved.endYear]).toEqual([1987, 2026]);
  await blurAndUndo();
  await expect(marker('Z3-lives-0')).toHaveAttribute('data-year', '1988');
  await expect(marker('Z3-lives-0')).toHaveAttribute('data-end-year', '2027');
});

test('SM-9 ED-5 Delete moves a moment to the trash and Undo brings it back', async () => {
  await label('Z3').click();
  await tableRow('Z3-lives-1')
    .getByRole('button', { name: /^Delete Lives in Portland/ })
    .click();
  await expect(tableRow('Z3-lives-1')).toHaveCount(0);
  await expect(marker('Z3-lives-1')).toHaveCount(0);
  await expect.poll(async () => Boolean((await getMoment('Z3-lives-1')).deletedAt)).toBe(true);
  const notice = view().getByTestId('moment-trashed');
  await expect(notice).toContainText('Moved Lives in Portland, Oregon to the trash.');
  await notice.getByRole('button', { name: 'Undo' }).click();
  await expect(tableRow('Z3-lives-1')).toHaveCount(1);
  await expect(marker('Z3-lives-1')).toHaveCount(1);
  expect((await getMoment('Z3-lives-1')).deletedAt).toBeUndefined();
  await expect(notice).toHaveCount(0);
  // The same delete is one step of the app's undo history too.
  await tableRow('Z3-lives-1')
    .getByRole('button', { name: /^Delete/ })
    .click();
  await expect(tableRow('Z3-lives-1')).toHaveCount(0);
  await blurAndUndo();
  await expect(tableRow('Z3-lives-1')).toHaveCount(1);
  expect((await getMoment('Z3-lives-1')).deletedAt).toBeUndefined();
});

test('SM-9 A33 the picker lists the world events of the year plus or minus one and inserts a title into Relevant world events', async () => {
  await label('H1').click();
  const pickButton = tableRow('H1-voice-0').getByRole('button', {
    name: 'Pick events from 2027 to 2029 for Voice',
  });
  await pickButton.click();
  const picker = tableRow('H1-voice-0').getByTestId('event-picker');
  await expect(picker.locator('.bs-picker-item')).toHaveText([
    '2027 Care robots licensed for home use in Oregon',
  ]);
  await expect(picker.locator('.bs-picker-item').first()).toBeFocused();
  await picker.locator('.bs-picker-item').first().click();
  await expect(picker).toHaveCount(0);
  await expect(pickButton).toBeFocused();
  await expect
    .poll(async () => (await getMoment('H1-voice-0')).worldContext)
    .toBe('Care robots licensed for home use in Oregon');
  await expect(cell('H1-voice-0', 'worldContext')).toHaveValue(
    'Care robots licensed for home use in Oregon',
  );
  // Picking it again adds nothing; Escape closes the list.
  await pickButton.click();
  await page.keyboard.press('Escape');
  await expect(picker).toHaveCount(0);
  await blurAndUndo();
  await expect(cell('H1-voice-0', 'worldContext')).toHaveValue('');
  expect((await getMoment('H1-voice-0')).worldContext).toBe('');
  // Z3 in 1988: no events within a year.
  await label('Z3').click();
  await tableRow('Z3-lives-0')
    .getByRole('button', { name: /^Pick events/ })
    .click();
  await expect(tableRow('Z3-lives-0').getByTestId('event-picker')).toContainText(
    'No world events in these years.',
  );
  await page.keyboard.press('Escape');
});

test('SM-9 a family heading collapses its rows and their markers merge onto the heading line', async () => {
  const heading = grid().locator('.wg-group[data-family="FAM-ZHOU"] .wg-group-label');
  await expect(heading).toHaveAttribute('aria-expanded', 'true');
  await heading.click();
  await expect(heading).toHaveAttribute('aria-expanded', 'false');
  await expect(grid().locator('.bs-row[data-family="FAM-ZHOU"]')).toHaveCount(0);
  const merged = grid().locator('.wg-group[data-family="FAM-ZHOU"] .bs-marker');
  expect(await merged.evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.id))).toEqual([
    'Z3-lives-0',
    'Z3-lives-1',
  ]);
  await heading.click();
  await expect(heading).toHaveAttribute('aria-expanded', 'true');
  await expect(grid().locator('.bs-row[data-family="FAM-ZHOU"]')).toHaveCount(5);
  await expect(grid().locator('.wg-group[data-family="FAM-ZHOU"] .bs-marker')).toHaveCount(0);
});

test('SM-9 NF-2 the screen works from the keyboard and its labels use the primary text colour in both themes', async () => {
  await rail(page, 'Family tree').click();
  await openBackstory();
  // A row label picks the person with Enter.
  await view().getByRole('button', { name: 'Change' }).focus();
  await tabTo(label('Z1'));
  await expect(label('Z1')).toHaveAccessibleName(
    'Zhou Meiling 周美玲, 1962 to 2050, show their moments',
  );
  await page.keyboard.press('Enter');
  await expect(label('Z1')).toHaveAttribute('aria-pressed', 'true');
  await expect(view().getByText('No moments yet.')).toBeVisible();
  // A family heading collapses with Enter.
  const heading = grid().locator('.wg-group[data-family="FAM-HALE"] .wg-group-label');
  await heading.focus();
  await page.keyboard.press('Enter');
  await expect(heading).toHaveAttribute('aria-expanded', 'false');
  await page.keyboard.press('Enter');
  await expect(heading).toHaveAttribute('aria-expanded', 'true');
  // The markers are one Tab stop: Home, End, Up and Down walk them; Enter picks one.
  const order = await grid()
    .locator('.bs-marker')
    .evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.id));
  expect(order).toEqual(['H1-voice-0', 'H5-voice-0', 'Z3-lives-0', 'Z3-lives-1']);
  await expect(grid().locator('.bs-marker[tabindex="0"]')).toHaveCount(1);
  await tabTo(grid().locator('.bs-marker[tabindex="0"]'));
  await page.keyboard.press('End');
  await expect(marker('Z3-lives-1')).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(marker('Z3-lives-0')).toBeFocused();
  await page.keyboard.press('Home');
  await expect(marker('H1-voice-0')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(marker('H5-voice-0')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(label('H5')).toHaveAttribute('aria-pressed', 'true');
  await expect(tableRow('H5-voice-0')).toHaveAttribute('aria-current', 'true');
  // Tab from the markers' stop reaches no other marker on its way to the table.
  const addMoment = view().getByRole('button', { name: 'Add a moment' });
  let markersReached = 0;
  for (let i = 0; i < 60; i++) {
    await page.keyboard.press('Tab');
    if (await addMoment.evaluate((el) => el === document.activeElement)) break;
    if (await page.evaluate(() => document.activeElement?.classList.contains('bs-marker'))) {
      markersReached += 1;
    }
  }
  expect(markersReached).toBe(0);
  await expect(addMoment).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(cell('H5-voice-0', 'year')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(cell('H5-voice-0', 'title')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(cell('H5-voice-0', 'body')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(cell('H5-voice-0', 'worldContext')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(tableRow('H5-voice-0').getByRole('button', { name: /^Pick events/ })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(tableRow('H5-voice-0').getByRole('button', { name: /^Delete/ })).toBeFocused();
  // Focus is visible on a marker.
  await marker('H5-voice-0').focus();
  expect(await marker('H5-voice-0').evaluate((el) => getComputedStyle(el).outlineStyle)).not.toBe(
    'none',
  );

  // Labels: the primary text colour, never a muted grey, and 4.5:1 on their background.
  const labels = [
    '.bs-row-label',
    '.bs-zh',
    '.wg-group-label',
    '.wg-tick',
    '.wg-corner',
    '.wg-era',
    '.wg-toolbar-label',
    '.bs-table th',
    '[data-testid="moment-age"]',
    '.legend',
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
          const el = document.querySelector(`[data-testid="backstory-view"] ${s}`);
          return { s, ok: Boolean(el), color: el ? getComputedStyle(el).color : '', bg: bgOf(el) };
        }),
      };
    }, labels);
    for (const f of read.found) {
      expect(f.ok, `${f.s} is on the screen`).toBe(true);
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
  // The year header and the names stay put while the grid scrolls.
  await zoomTo('Close');
  await grid().evaluate((el) => {
    el.scrollLeft = 400;
    el.scrollTop = 60;
  });
  const g = (await grid().boundingBox())!;
  const lab = (await grid().locator('.bs-row-label').last().boundingBox())!;
  expect(Math.abs(lab.x - g.x)).toBeLessThan(2);
  const head = (await grid().locator('.wg-head').boundingBox())!;
  expect(Math.abs(head.y - g.y)).toBeLessThan(2);
});
