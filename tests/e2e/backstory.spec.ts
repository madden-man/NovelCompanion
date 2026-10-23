import { expect, test } from '@playwright/test';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import type { Invoke } from '../helpers/t5';
import { contrast } from '../helpers/contrast';
import type { Rgba } from '../helpers/contrast';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { connect } from '../../src/main/db';
import { READ_ONLY_REASON } from '../../src/shared/ipcApp';
import { loadFixture, readFixture } from '../helpers/loadFixture';
import { openBackstory } from '../../src/renderer/src/workspace/backstory/nav';
import {
  fileDb,
  fillEditable,
  invokeVia,
  launch,
  openEditable,
  openMoment,
  rail,
  seedFixture,
} from './helpers';
import type { TestDb } from './helpers';

let db: TestDb;
let app: ElectronApplication;
let page: Page;
let invoke: Invoke;

const SLUG = 'backstory-fixture';
const fixture = readFixture();
/** The grid's sticky label column. */
const LABEL_W = 200;

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
    await seedFixture(
      invoke,
      fixture[c]!.map((d) => ({ collection: c as never, data: strip(d) })),
    );
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
/** The row's label cell: the name (a link to the page) and the Chinese name (IP-4). */
const rowCell = (id: string) => row(id).locator('.bs-row-cell');
/**
 * A50: open a person's timeline: a click in the label cell clear of the name, which opens their
 * page (IP-4).
 */
const openPerson = (id: string) => label(id).click({ position: { x: LABEL_W - 12, y: 6 } });
/** A50: true while one person's timeline fills the grid's frame. */
const personView = () => grid().and(page.locator('.bs-person'));
const showEveryone = () => view().getByRole('button', { name: 'Show everyone', exact: true });
/** Pick a person: open their timeline and go back to everyone, which keeps them picked (A50). */
async function pickRow(id: string) {
  await openPerson(id);
  await expect(personView()).toHaveCount(1);
  await showEveryone().click();
  await expect(personView()).toHaveCount(0);
}
/** A50: the person's row sits inside the grid's frame, below the sticky year header. */
async function expectRowInView(id: string) {
  const g = (await grid().boundingBox())!;
  const r = (await row(id).boundingBox())!;
  expect(r.y).toBeGreaterThanOrEqual(g.y + 56 - 1);
  expect(r.y + r.height).toBeLessThanOrEqual(g.y + g.height + 1);
}
const marker = (id: string) => grid().locator(`.bs-marker[data-id="${id}"]`);
/** A49: the moment dialog, and the same dialog only while it shows a given moment. */
const dialog = () => page.getByTestId('moment-dialog');
const momentDialog = (id: string) => page.locator(`[data-testid="moment-dialog"][data-id="${id}"]`);
/** The person picked, as the head bar names them beside Add a moment. */
const picked = () => view().getByTestId('picked-person');
/** IP-1: a field's `Editable` (its root) in the moment's dialog, and the text it shows while closed. */
const cell = (id: string, field: string) =>
  momentDialog(id).locator(`.editable[data-field="${field}"]`);
const cellText = (id: string, field: string) => cell(id, field).locator('.editable-text');
/** A rich field (A44) opened: its text box. */
const cellBox = (id: string, field: string) => cell(id, field).locator('[role="textbox"]');

/** Close the moment dialog with its head's Close button. */
async function closeMoment() {
  await dialog().locator('.bs-dialog-head').getByRole('button', { name: 'Close' }).click();
  await expect(dialog()).toHaveCount(0);
}

/** Type into a rich field and save it with Enter, or leave the text typed and unsaved. */
async function fillRich(id: string, field: string, text: string, how: 'Enter' | 'none' = 'Enter') {
  await openEditable(cell(id, field));
  const box = cellBox(id, field);
  await expect(box).toBeVisible();
  await box.fill(text);
  if (how === 'Enter') {
    await box.press('Enter');
    await expect(box).toHaveCount(0);
  }
}

const getMoment = async (id: string) =>
  (await invoke('entry.get', { collection: 'moments', id })).entry as Record<string, unknown>;
const liveMoments = async () =>
  (await invoke('entry.list', { collection: 'moments', trash: 'exclude' })).entries.map(
    (e) => e.entry as Record<string, unknown>,
  );

async function showBackstory() {
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
  await showBackstory();
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
        els.map((e) => [(e as HTMLElement).dataset.person, (e as HTMLElement).dataset.group]),
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
  // IP-4: the name drawn in the cell is a link to the page, the Chinese name beside it.
  await expect(rowCell('Z1').locator('.bs-row-text')).toHaveText('Zhou Meiling周美玲');
  await expect(rowCell('Z1').getByRole('link')).toHaveText('Zhou Meiling');
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

test('SM-9 TL-3 A50 a click on a name opens that person’s timeline: only their row, every title drawn, the name and Add a moment and Show everyone in the head; Show everyone, Escape and the name cell each return to the grid with the row in view and the name focused; the dialog shows the ages through Next', async () => {
  // With nobody picked, the head offers New moment.
  await expect(picked()).toHaveCount(0);
  await expect(view().getByRole('button', { name: 'New moment' })).toBeVisible();
  await openPerson('Z3');
  await expect(personView()).toHaveCount(1);
  await expect(grid().locator('.bs-row')).toHaveCount(1);
  await expect(grid().locator('.wg-group')).toHaveCount(0);
  await expect(label('Z3')).toHaveAttribute('aria-pressed', 'true');
  await expect(label('Z3')).toHaveAccessibleName('Zhou Lan 周兰, 1988, show everyone');
  // The label cell: the family swatch, the name, the Chinese name, the life years under them.
  await expect(rowCell('Z3').locator('.bs-swatch')).toHaveCount(1);
  await expect(rowCell('Z3').locator('.bs-name')).toHaveText('Zhou Lan');
  await expect(rowCell('Z3').locator('.bs-zh')).toHaveText('周兰');
  await expect(row('Z3').getByTestId('person-years')).toHaveText('1988');
  // Every title is drawn beside its marker, with no hover.
  await expect(marker('Z3-lives-0').locator('.wg-mlabel')).toHaveText('Lives in Guangzhou');
  await expect(marker('Z3-lives-1').locator('.wg-mlabel')).toHaveText('Lives in Portland, Oregon');
  await expect(grid().getByTestId('grid-tip')).toHaveCount(0);
  // The one row fills the frame under the year header.
  const inner = await grid().evaluate((el) => el.clientHeight);
  expect((await row('Z3').boundingBox())!.height).toBeCloseTo(inner - 56, 0);
  // The head: the name, Add a moment, Show everyone.
  await expect(picked()).toHaveText('Zhou Lan 周兰, 1988');
  await expect(view().getByRole('button', { name: 'Add a moment' })).toBeVisible();
  await expect(showEveryone()).toBeVisible();
  await expect(view().getByRole('button', { name: 'Clear pick' })).toHaveCount(0);
  await expect(view().getByRole('button', { name: 'New moment' })).toHaveCount(0);

  // Show everyone: the grid again, the person still picked, their row in view, their name focused.
  await showEveryone().click();
  await expect(personView()).toHaveCount(0);
  await expect(grid().locator('.bs-row')).toHaveCount(13);
  await expect(label('Z3')).toHaveAttribute('aria-pressed', 'true');
  await expect(row('Z3')).toHaveClass(/\bpicked\b/);
  await expect(label('Z3')).toBeFocused();
  await expectRowInView('Z3');
  await expect(picked()).toHaveText('Zhou Lan 周兰, 1988');
  await expect(view().getByRole('button', { name: 'Add a moment' })).toBeVisible();
  await expect(view().getByRole('button', { name: 'Clear pick' })).toBeVisible();
  await expect(showEveryone()).toHaveCount(0);
  // Escape in the person view goes back the same way.
  await openPerson('Z3');
  await expect(personView()).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(personView()).toHaveCount(0);
  await expect(label('Z3')).toBeFocused();
  await expectRowInView('Z3');
  // So does the name cell again: it is a toggle.
  await openPerson('Z3');
  await expect(personView()).toHaveCount(1);
  await openPerson('Z3');
  await expect(personView()).toHaveCount(0);
  await expect(label('Z3')).toHaveAttribute('aria-pressed', 'true');
  await expect(label('Z3')).toBeFocused();
  await expectRowInView('Z3');
  // A family collapsed meanwhile opens on the way back, so the row is there to focus.
  const zhou = grid().locator('.wg-group[data-group="FAM-ZHOU"] .wg-group-label');
  await zhou.click();
  await expect(zhou).toHaveAttribute('aria-expanded', 'false');
  await expect(row('Z3')).toHaveCount(0);
  await page.evaluate(openBackstory, 'Z3');
  await expect(personView()).toHaveCount(1);
  await showEveryone().click();
  await expect(personView()).toHaveCount(0);
  await expect(zhou).toHaveAttribute('aria-expanded', 'true');
  await expect(label('Z3')).toBeFocused();
  await expectRowInView('Z3');
  const d = await openMoment(page, 'Z3-lives-0');
  await expect(d.locator('.bs-field-title')).toHaveText([
    'Year',
    'To',
    'Whose moment',
    'What happens',
    'How they experience it',
    'Relevant world events',
  ]);
  await expect(d.getByTestId('moment-who')).toHaveText('Zhou Lan 周兰, 1988 to 2027, age 0');
  await expect(cellText('Z3-lives-0', 'year')).toHaveText('1988');
  await expect(cellText('Z3-lives-0', 'endYear')).toHaveText('2027');
  await expect(d.getByTestId('moment-age')).toHaveText('0');
  // Next is the person's next moment by year, in the same dialog.
  await d.getByRole('button', { name: 'Next' }).click();
  await expect(d).toHaveAttribute('data-id', 'Z3-lives-1');
  await expect(d.getByRole('heading')).toHaveText('Lives in Portland, Oregon');
  await expect(cellText('Z3-lives-1', 'endYear')).toHaveText('Same year');
  await expect(cellText('Z3-lives-1', 'characterId')).toHaveText('Zhou Lan 周兰');
  await expect(d.getByTestId('moment-age')).toHaveText('39');
  await expect(cellText('Z3-lives-1', 'title')).toHaveText('Lives in Portland, Oregon');
  await closeMoment();
  // A marker click picks its person and opens its moment.
  await openMoment(page, 'H1-voice-0');
  await expect(label('H1')).toHaveAttribute('aria-pressed', 'true');
  await expect(marker('H1-voice-0')).toHaveAttribute('aria-current', 'true');
  await expect(dialog().getByTestId('moment-age')).toHaveText('70');
  await expect(cellText('H1-voice-0', 'body')).toHaveText(
    'Speaks in short, dry sentences and never raises her voice.',
  );
  await closeMoment();
});

test('SM-9 A49 NF-2 a marker opens the moment in a dialog; Escape in an open field puts the value back and a second Escape closes it, focus back on the marker', async () => {
  const d = await openMoment(page, 'H5-voice-0');
  await expect(d).toHaveAttribute('role', 'dialog');
  await expect(d).toHaveAttribute('aria-modal', 'true');
  await expect(d).toHaveAccessibleName('Voice');
  // The dialog takes the focus, on What happens, closed.
  await expect(cellText('H5-voice-0', 'title')).toBeFocused();
  const width = (await d.boundingBox())!.width;
  expect(width).toBeLessThanOrEqual(720.5);
  // One Escape in an open field puts the stored value back and leaves the dialog open.
  await openEditable(cell('H5-voice-0', 'title'));
  const input = cell('H5-voice-0', 'title').locator('input');
  await input.fill('Something else');
  await page.keyboard.press('Escape');
  await expect(input).toHaveCount(0);
  await expect(d).toBeVisible();
  await expect(cellText('H5-voice-0', 'title')).toHaveText('Voice');
  await expect(cellText('H5-voice-0', 'title')).toBeFocused();
  expect((await getMoment('H5-voice-0')).title).toBe('Voice');
  // The same in a rich field.
  await openEditable(cell('H5-voice-0', 'body'));
  await cellBox('H5-voice-0', 'body').fill('Not kept');
  await page.keyboard.press('Escape');
  await expect(cellBox('H5-voice-0', 'body')).toHaveCount(0);
  await expect(d).toBeVisible();
  // The next Escape closes the dialog, and the focus is back on the marker that opened it.
  await page.keyboard.press('Escape');
  await expect(dialog()).toHaveCount(0);
  await expect(marker('H5-voice-0')).toBeFocused();
  expect((await getMoment('H5-voice-0')).body).toBe(
    fixture.moments!.find((m) => m._id === 'H5-voice-0')!.body,
  );
  // Enter on the focused marker opens it again; a click on the backdrop closes it.
  await page.keyboard.press('Enter');
  await expect(momentDialog('H5-voice-0')).toBeVisible();
  await page.mouse.click(4, 400);
  await expect(dialog()).toHaveCount(0);
  await expect(marker('H5-voice-0')).toBeFocused();
});

test('SM-9 A49 Previous and Next walk the person’s moments by year without closing', async () => {
  await zoomTo('Close');
  const d = await openMoment(page, 'Z3-lives-0');
  const prev = d.getByRole('button', { name: 'Previous' });
  const next = d.getByRole('button', { name: 'Next' });
  await expect(prev).toBeDisabled();
  await expect(next).toBeEnabled();
  await next.click();
  await expect(d).toHaveAttribute('data-id', 'Z3-lives-1');
  await expect(marker('Z3-lives-1')).toHaveAttribute('aria-current', 'true');
  await expect(marker('Z3-lives-0')).not.toHaveAttribute('aria-current', 'true');
  // At the last moment Next is off and the focus moves to Previous, still in the dialog.
  await expect(next).toBeDisabled();
  await expect(prev).toBeFocused();
  // The grid brings the shown moment's marker into view.
  const g = (await grid().boundingBox())!;
  const m = (await marker('Z3-lives-1').boundingBox())!;
  expect(m.x).toBeGreaterThanOrEqual(g.x);
  expect(m.x + m.width).toBeLessThanOrEqual(g.x + g.width);
  await prev.click();
  await expect(d).toHaveAttribute('data-id', 'Z3-lives-0');
  await expect(next).toBeFocused();
  // A field left open saves as Next takes the focus, and the next moment starts closed.
  await openEditable(cell('Z3-lives-0', 'title'));
  const was = String((await getMoment('Z3-lives-0')).title);
  await cell('Z3-lives-0', 'title').locator('input').fill('Born in Guangzhou');
  await next.click();
  await expect(d).toHaveAttribute('data-id', 'Z3-lives-1');
  await expect(d.locator('input')).toHaveCount(0);
  await expect.poll(async () => (await getMoment('Z3-lives-0')).title).toBe('Born in Guangzhou');
  await blurAndUndo();
  await expect.poll(async () => (await getMoment('Z3-lives-0')).title).toBe(was);
  // Someone with one moment: both are off.
  await closeMoment();
  await openMoment(page, 'H1-voice-0');
  await expect(dialog().getByRole('button', { name: 'Previous' })).toBeDisabled();
  await expect(dialog().getByRole('button', { name: 'Next' })).toBeDisabled();
  await closeMoment();
});

test('SM-9 ED-3 IP-1 a field edit in the dialog saves over IPC on Enter or blur, one undo step each, and Undo restores it', async () => {
  await openMoment(page, 'Z3-lives-1');
  await fillRich('Z3-lives-1', 'body', 'She misses the river smell and says so every spring.');
  await expect
    .poll(async () => (await getMoment('Z3-lives-1')).body)
    .toBe('She misses the river smell and says so every spring.');
  // Edit, blur, retype the original at once, blur: the original is what stays stored.
  const what = cell('Z3-lives-1', 'title');
  await fillEditable(what, 'Lives in Seattle', 'blur');
  await fillEditable(what, 'Lives in Portland, Oregon', 'blur');
  await expect
    .poll(async () => (await getMoment('Z3-lives-1')).title)
    .toBe('Lives in Portland, Oregon');
  await expect(cellText('Z3-lives-1', 'title')).toHaveText('Lives in Portland, Oregon');
  await blurAndUndo();
  await expect.poll(async () => (await getMoment('Z3-lives-1')).title).toBe('Lives in Seattle');
  await expect(dialog().getByRole('heading')).toHaveText('Lives in Seattle');
  await page.keyboard.press('Meta+z');
  await expect(cellText('Z3-lives-1', 'title')).toHaveText('Lives in Portland, Oregon');
  expect((await getMoment('Z3-lives-1')).title).toBe('Lives in Portland, Oregon');
  // The year saves on blur, and the age follows.
  const year = cell('Z3-lives-1', 'year');
  await fillEditable(year, '2029', 'blur');
  await expect.poll(async () => (await getMoment('Z3-lives-1')).year).toBe(2029);
  await expect(dialog().getByTestId('moment-age')).toHaveText('41');
  await expect(marker('Z3-lives-1')).toHaveAttribute('data-year', '2029');
  // A year that is not a number is refused in plain words at the field and writes nothing.
  await openEditable(year);
  await year.locator('input').fill('soon');
  await year.locator('input').press('Enter');
  await expect(momentDialog('Z3-lives-1').getByRole('alert')).toHaveText(
    'Not saved: soon is not a year. Write it as digits, for example 2045.',
  );
  await year.locator('input').press('Escape');
  await expect(year.locator('input')).toHaveCount(0);
  await expect(dialog()).toBeVisible();
  expect((await getMoment('Z3-lives-1')).year).toBe(2029);
  // To: the last year, blank for a single year; it saves like the other fields.
  const to = cell('Z3-lives-1', 'endYear');
  await fillEditable(to, '2033');
  await expect.poll(async () => (await getMoment('Z3-lives-1')).endYear).toBe(2033);
  await expect(marker('Z3-lives-1')).toHaveAttribute('data-end-year', '2033');
  await blurAndUndo();
  await expect(cellText('Z3-lives-1', 'endYear')).toHaveText('Same year');
  expect((await getMoment('Z3-lives-1')).endYear).toBeNull();
  await expect(marker('Z3-lives-1')).toHaveAttribute('data-end-year', '2029');
  await page.keyboard.press('Meta+z');
  await expect(cellText('Z3-lives-1', 'year')).toHaveText('2027');
  expect((await getMoment('Z3-lives-1')).year).toBe(2027);
  await page.keyboard.press('Meta+z');
  await expect(cellText('Z3-lives-1', 'body')).toHaveText('Add how they experience it');
  expect((await getMoment('Z3-lives-1')).body).toBe('');
  await closeMoment();
});

test('SM-9 A50 ED-1 ED-3 More in the dialog: Add new makes a status and picks it, a tag adds, one undo step each', async () => {
  const id = 'Z3-lives-1';
  const d = await openMoment(page, id);
  const more = d.getByRole('button', { name: 'More', exact: true });
  await expect(more).toHaveAttribute('aria-expanded', 'false');
  await more.click();
  const start = await getMoment(id);
  const statuses = async () =>
    (await invoke('lists.get', {})).lists
      .find((l) => l._id === 'statuses')!
      .items.map((i) => i.label);
  const st = cell(id, 'status');
  await openEditable(st);
  await st.locator('select').selectOption({ label: 'Add new...' });
  const name = st.getByRole('textbox');
  await name.fill('Rumoured');
  await name.press('Enter');
  await expect(cellText(id, 'status')).toHaveText('Rumoured');
  expect(await statuses()).toContain('Rumoured');
  const tags = d.locator('.ed-field[data-field="tags"]');
  await tags.locator('.add-row > input').fill('river');
  await tags.locator('.add-row > input').press('Enter');
  const withRiver = [...((start.tags as string[]) ?? []), 'river'];
  await expect.poll(async () => (await getMoment(id)).tags).toEqual(withRiver);
  await expect(tags.locator('.chip').last()).toContainText('river');
  await blurAndUndo();
  await expect.poll(async () => (await getMoment(id)).tags).toEqual(start.tags);
  // The status and the list item Add new made go back together.
  await page.keyboard.press('Meta+z');
  await expect.poll(async () => (await getMoment(id)).status).toBe(start.status);
  await expect.poll(statuses).not.toContain('Rumoured');
  await closeMoment();
});

test('SM-9 Add a moment in the head makes a moment at the story year and opens it with What happens open, and the grid shows its marker', async () => {
  await pickRow('Z3');
  const before = (await liveMoments()).length;
  const add = view().getByRole('button', { name: 'Add a moment' });
  await add.click();
  await expect.poll(async () => (await liveMoments()).length).toBe(before + 1);
  const made = (await liveMoments()).find((m) => !fixture.moments!.some((f) => f._id === m._id))!;
  expect([made.characterId, made.year, made.endYear, made.title]).toEqual(['Z3', 2040, null, '']);
  const id = String(made._id);
  await expect(dialog()).toHaveAttribute('data-id', id);
  await expect(dialog().getByRole('heading')).toHaveText('Untitled moment');
  await expect(cell(id, 'title').locator('input')).toBeFocused();
  await expect(dialog().getByTestId('moment-age')).toHaveText('52');
  await page.keyboard.type('Opens a noodle shop on Division Street');
  await page.keyboard.press('Enter');
  await expect
    .poll(async () => (await getMoment(id)).title)
    .toBe('Opens a noodle shop on Division Street');
  await expect(row('Z3').locator(`.bs-marker[data-id="${id}"]`)).toHaveAttribute(
    'data-year',
    '2040',
  );
  // Two steps back: the title, then the moment itself, which closes its dialog.
  await blurAndUndo();
  await expect(cellText(id, 'title')).toHaveText('Add what happens');
  await page.keyboard.press('Meta+z');
  await expect(marker(id)).toHaveCount(0);
  await expect(dialog()).toHaveCount(0);
  await expect(add).toBeFocused();
  expect((await getMoment(id)).deletedAt).toBeTruthy();
});

test('SM-9 a click on an empty spot in a row adds a moment for that person at that year and opens it', async () => {
  await zoomTo('Close');
  const at = await pointAt('H4', 2050);
  await page.mouse.click(at.x, at.y);
  await expect(label('H4')).toHaveAttribute('aria-pressed', 'true');
  await expect(picked()).toHaveText('Ruth Hale, 1990 to 2067');
  const made = (await liveMoments()).find((m) => m.characterId === 'H4')!;
  expect(made.year).toBe(2050);
  const id = String(made._id);
  await expect(dialog()).toHaveAttribute('data-id', id);
  await expect(cell(id, 'title').locator('input')).toBeFocused();
  await expect(dialog().getByTestId('moment-age')).toHaveText('60');
  await expect(row('H4').locator(`.bs-marker[data-id="${id}"]`)).toHaveAttribute(
    'data-year',
    '2050',
  );
  await blurAndUndo();
  await expect(marker(id)).toHaveCount(0);
  await expect(dialog()).toHaveCount(0);
  expect((await getMoment(id)).deletedAt).toBeTruthy();
  // A50: the same inside the person's timeline, which stays open on them.
  await openPerson('H4');
  await expect(personView()).toHaveCount(1);
  const inside = await pointAt('H4', 2052);
  await page.mouse.click(inside.x, inside.y);
  await expect
    .poll(async () => (await liveMoments()).some((m) => m.characterId === 'H4'))
    .toBe(true);
  const again = (await liveMoments()).find((m) => m.characterId === 'H4')!;
  expect(again.year).toBe(2052);
  const id2 = String(again._id);
  await expect(dialog()).toHaveAttribute('data-id', id2);
  await expect(cell(id2, 'title').locator('input')).toBeFocused();
  await expect(dialog().getByTestId('moment-age')).toHaveText('62');
  await page.keyboard.type('Moves to the coast');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await getMoment(id2)).title).toBe('Moves to the coast');
  await expect(personView()).toHaveCount(1);
  await expect(marker(id2)).toHaveAttribute('data-year', '2052');
  await expect(marker(id2).locator('.wg-mlabel')).toHaveText('Moves to the coast');
  await blurAndUndo();
  await page.keyboard.press('Meta+z');
  await expect(marker(id2)).toHaveCount(0);
  await expect(dialog()).toHaveCount(0);
  expect((await getMoment(id2)).deletedAt).toBeTruthy();
  await showEveryone().click();
  await expect(personView()).toHaveCount(0);
});

test('SM-9 IP-4 A50 on the grid a marker is a 10px dot in a 36px row, and a click just beside it opens the moment instead of adding one', async () => {
  await zoomTo('Close');
  await showRow('H1');
  await showYear(2028);
  const box = (await marker('H1-voice-0').boundingBox())!;
  expect(box.width).toBeCloseTo(10, 0);
  expect(box.height).toBeCloseTo(10, 0);
  expect((await row('H1').boundingBox())!.height).toBeCloseTo(36, 0);
  const before = (await liveMoments()).length;
  // 5px past the dot's right edge is still the marker's hit area, not the empty track.
  const at = { x: box.x + box.width + 5, y: box.y + box.height / 2 };
  expect(
    await marker('H1-voice-0').evaluate(
      (el, p) => el.contains(document.elementFromPoint(p.x, p.y)),
      at,
    ),
  ).toBe(true);
  await page.mouse.click(at.x, at.y);
  await expect(label('H1')).toHaveAttribute('aria-pressed', 'true');
  await expect(momentDialog('H1-voice-0')).toBeVisible();
  await expect(marker('H1-voice-0')).toHaveAttribute('aria-current', 'true');
  expect((await liveMoments()).length).toBe(before);
  await closeMoment();
  // A marker click picks its person and leaves the grid as it is.
  await expect(personView()).toHaveCount(0);
});

test('SM-9 IP-4 A50 in the person view a marker is a 14px dot in a row at least 48px tall, and a click just beside it opens the moment instead of adding one', async () => {
  await zoomTo('Close');
  await openPerson('H1');
  await expect(personView()).toHaveCount(1);
  await showYear(2028);
  const box = (await marker('H1-voice-0').boundingBox())!;
  expect(box.width).toBeCloseTo(14, 0);
  expect(box.height).toBeCloseTo(14, 0);
  expect((await row('H1').boundingBox())!.height).toBeGreaterThanOrEqual(48);
  const before = (await liveMoments()).length;
  const at = { x: box.x + box.width + 5, y: box.y + box.height / 2 };
  expect(
    await marker('H1-voice-0').evaluate(
      (el, p) => el.contains(document.elementFromPoint(p.x, p.y)),
      at,
    ),
  ).toBe(true);
  await page.mouse.click(at.x, at.y);
  await expect(momentDialog('H1-voice-0')).toBeVisible();
  await expect(marker('H1-voice-0')).toHaveAttribute('aria-current', 'true');
  expect((await liveMoments()).length).toBe(before);
  // Escape closes the dialog first; the person view stays until the next one.
  await page.keyboard.press('Escape');
  await expect(dialog()).toHaveCount(0);
  await expect(personView()).toHaveCount(1);
  await expect(marker('H1-voice-0')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(personView()).toHaveCount(0);
  await expect(label('H1')).toBeFocused();
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
  // Two quick presses add up: two years, two undo steps.
  await marker('H1-voice-0').focus();
  await marker('H1-voice-0').press('ArrowRight');
  await marker('H1-voice-0').press('ArrowRight');
  await expect.poll(async () => (await getMoment('H1-voice-0')).year).toBe(2030);
  await expect(marker('H1-voice-0')).toHaveAttribute('data-year', '2030');
  await blurAndUndo();
  await expect(marker('H1-voice-0')).toHaveAttribute('data-year', '2029');
  expect((await getMoment('H1-voice-0')).year).toBe(2029);
  await page.keyboard.press('Meta+z');
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

test('SM-9 ED-5 Delete in the dialog lists what links to the moment, then moves it to the trash as one undo step; the notice and Undo bring it back', async () => {
  // A world event links to the moment, so the confirm names it.
  const e2 = (await invoke('entry.get', { collection: 'worldEvents', id: 'E2' })).entry;
  const links0 = (e2.links ?? []) as { targetId: string; kind: string }[];
  await invoke('entry.update', {
    collection: 'worldEvents',
    id: 'E2',
    patch: { links: [...links0, { targetId: 'Z3-lives-1', kind: 'mentions' }] },
  });
  const d = await openMoment(page, 'Z3-lives-1');
  const del = d.getByRole('button', { name: 'Delete' });
  await del.click();
  const confirm = d.getByRole('dialog', { name: 'Move to trash' });
  await expect(confirm).toContainText('Move Lives in Portland, Oregon to the trash?');
  await expect(confirm.getByTestId('linked-count')).toHaveText(
    '1 entry links here. Its link is kept and works again if you restore this entry.',
  );
  await expect(confirm).toContainText('World event: Care robots licensed for home use in Oregon');
  // Keep it changes nothing; Escape in the confirm keeps it too, and the dialog stays.
  await expect(confirm.getByRole('button', { name: 'Keep it' })).toBeFocused();
  await confirm.getByRole('button', { name: 'Keep it' }).click();
  await expect(confirm).toHaveCount(0);
  await del.click();
  await expect(confirm.getByRole('button', { name: 'Keep it' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(confirm).toHaveCount(0);
  await expect(d).toBeVisible();
  expect((await getMoment('Z3-lives-1')).deletedAt).toBeUndefined();
  await del.click();
  await confirm.getByRole('button', { name: 'Move to trash' }).click();
  await expect(dialog()).toHaveCount(0);
  await expect(marker('Z3-lives-1')).toHaveCount(0);
  await expect.poll(async () => Boolean((await getMoment('Z3-lives-1')).deletedAt)).toBe(true);
  const notice = view().getByTestId('moment-trashed');
  await expect(notice).toContainText('Moved Lives in Portland, Oregon to the trash.');
  // Undo brings it back and opens it again where it was.
  await notice.getByRole('button', { name: 'Undo' }).click();
  await expect(marker('Z3-lives-1')).toHaveCount(1);
  await expect(momentDialog('Z3-lives-1')).toBeVisible();
  expect((await getMoment('Z3-lives-1')).deletedAt).toBeUndefined();
  await expect(notice).toHaveCount(0);
  // The same delete is one step of the app's undo history too.
  await invoke('entry.update', { collection: 'worldEvents', id: 'E2', patch: { links: links0 } });
  await del.click();
  await expect(confirm.getByText('Nothing links here.')).toBeVisible();
  await confirm.getByRole('button', { name: 'Move to trash' }).click();
  await expect(marker('Z3-lives-1')).toHaveCount(0);
  await blurAndUndo();
  await expect(marker('Z3-lives-1')).toHaveCount(1);
  expect((await getMoment('Z3-lives-1')).deletedAt).toBeUndefined();
  await expect(notice).toHaveCount(0);
  // A50: in the Trash a moment offers Restore and no Open, since only live moments open.
  await invoke('entry.delete', { collection: 'moments', id: 'Z3-lives-1' });
  await rail(page, 'Trash').click();
  const trashed = page.getByTestId('trash-list').locator('li[data-id="Z3-lives-1"]');
  await expect(trashed).toBeVisible();
  await expect(trashed.getByRole('button', { name: 'Open', exact: true })).toHaveCount(0);
  await trashed.getByRole('button', { name: 'Restore Lives in Portland, Oregon' }).click();
  await expect(trashed).toHaveCount(0);
  expect((await getMoment('Z3-lives-1')).deletedAt).toBeUndefined();
  await showBackstory();
  await expect(marker('Z3-lives-1')).toHaveCount(1);
});

test('SM-9 A33 IP-4 ED-9 Pick events in the dialog lists the events within the reach and inserts a mention with its link into Relevant world events', async () => {
  const d = await openMoment(page, 'H1-voice-0');
  const pickButton = d.getByRole('button', {
    name: 'Pick events from 2027 to 2029 for Voice',
  });
  await pickButton.click();
  const picker = d.getByTestId('event-picker');
  await expect(picker.locator('.bs-picker-item')).toHaveText([
    '2027 Care robots licensed for home use in Oregon',
  ]);
  // The list sits inside the dialog, nothing cut off.
  const db = (await d.boundingBox())!;
  const pb = (await picker.boundingBox())!;
  expect(pb.x).toBeGreaterThanOrEqual(db.x);
  expect(pb.x + pb.width).toBeLessThanOrEqual(db.x + db.width + 0.5);
  await expect(picker.locator('.bs-picker-item').first()).toBeFocused();
  await picker.locator('.bs-picker-item').first().click();
  await expect(picker).toHaveCount(0);
  await expect(pickButton).toBeFocused();
  // An @ mention (ED-9) and the link to the event, in one write.
  await expect
    .poll(async () => (await getMoment('H1-voice-0')).worldContext)
    .toBe('@Care robots licensed for home use in Oregon');
  expect((await getMoment('H1-voice-0')).links).toContainEqual({
    targetId: 'E2',
    kind: 'mention',
  });
  await expect(cellText('H1-voice-0', 'worldContext')).toHaveText(
    '@Care robots licensed for home use in Oregon',
  );
  // ED-9: the closed field shows the mention as a chip, as the open box does.
  await expect(cellText('H1-voice-0', 'worldContext').locator('.mention-chip')).toHaveText(
    '@Care robots licensed for home use in Oregon',
  );
  // Picking it again adds nothing; Escape closes the list and leaves the dialog open.
  await pickButton.click();
  await page.keyboard.press('Escape');
  await expect(picker).toHaveCount(0);
  await expect(d).toBeVisible();
  await blurAndUndo();
  await expect(cellText('H1-voice-0', 'worldContext')).toHaveText('Add the world events');
  const undone = await getMoment('H1-voice-0');
  expect(undone.worldContext).toBe('');
  expect(undone.links).not.toContainEqual({ targetId: 'E2', kind: 'mention' });
  // Text typed in the field and not yet saved is saved as the field closes; the mention goes after it.
  await fillRich('H1-voice-0', 'worldContext', 'Rents doubled that spring.', 'none');
  await pickButton.click();
  await picker.locator('.bs-picker-item').first().click();
  await expect
    .poll(async () => (await getMoment('H1-voice-0')).worldContext)
    .toBe('Rents doubled that spring.\n@Care robots licensed for home use in Oregon');
  await expect(cellText('H1-voice-0', 'worldContext')).toContainText('Rents doubled that spring.');
  await expect(cellText('H1-voice-0', 'worldContext')).toContainText(
    '@Care robots licensed for home use in Oregon',
  );
  await blurAndUndo();
  await expect(cellText('H1-voice-0', 'worldContext')).toHaveText('Rents doubled that spring.');
  await page.keyboard.press('Meta+z');
  await expect(cellText('H1-voice-0', 'worldContext')).toHaveText('Add the world events');
  expect((await getMoment('H1-voice-0')).worldContext).toBe('');
  await closeMoment();
  // Z3 in 1988: no events within a year.
  await openMoment(page, 'Z3-lives-0');
  await dialog()
    .getByRole('button', { name: /^Pick events/ })
    .click();
  await expect(dialog().getByTestId('event-picker')).toContainText(
    'No world events in these years.',
  );
  await page.keyboard.press('Escape');
  await expect(dialog().getByTestId('event-picker')).toHaveCount(0);
  await closeMoment();
  // IP-11: the reach is the bible's picker reach; three years takes in 2025 to 2031.
  await invoke('settings.set', { numbers: { pickerReach: 3 } });
  await openMoment(page, 'H1-voice-0');
  const wide = dialog().getByRole('button', {
    name: 'Pick events from 2025 to 2031 for Voice',
  });
  await wide.click();
  await expect(picker).toContainText('World events, 2025 to 2031');
  await page.keyboard.press('Escape');
  await invoke('settings.set', { numbers: { pickerReach: 1 } });
  await expect(pickButton).toBeVisible();
  await closeMoment();
});

test('SM-9 a family heading collapses its rows and their markers merge onto the heading line', async () => {
  const heading = grid().locator('.wg-group[data-group="FAM-ZHOU"] .wg-group-label');
  await expect(heading).toHaveAttribute('aria-expanded', 'true');
  await heading.click();
  await expect(heading).toHaveAttribute('aria-expanded', 'false');
  await expect(grid().locator('.bs-row[data-group="FAM-ZHOU"]')).toHaveCount(0);
  const merged = grid().locator('.wg-group[data-group="FAM-ZHOU"] .bs-marker');
  expect(await merged.evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.id))).toEqual([
    'Z3-lives-0',
    'Z3-lives-1',
  ]);
  await heading.click();
  await expect(heading).toHaveAttribute('aria-expanded', 'true');
  await expect(grid().locator('.bs-row[data-group="FAM-ZHOU"]')).toHaveCount(5);
  await expect(grid().locator('.wg-group[data-group="FAM-ZHOU"] .bs-marker')).toHaveCount(0);
});

test('SM-9 TM-3 the story year line and the writing band sit where the story time says, a non-primary strand included', async () => {
  await invoke('storyTime.set', {
    time: { year: 2045, chapterId: 'CH2', strandId: 'CH2-present' },
  });
  const line = grid().getByTestId('grid-story-year');
  const band = grid().getByTestId('grid-writing');
  await expect(line).toHaveAttribute('data-year', '2045');
  await expect(band).toHaveAttribute('data-from', '2045');
  await expect(band).toHaveAttribute('data-to', '2045');
  await expect(band).toHaveAttribute('title', /Chapter 2: Two Kitchens, present/);
  await zoomTo('Close');
  await showYear(2045);
  const { ppy, from } = await axis();
  const track = (await row('H1').locator('.wg-track').boundingBox())!;
  const bb = (await band.boundingBox())!;
  expect(Math.abs(bb.x - (track.x + (2045 - from) * ppy))).toBeLessThan(1.5);
  expect(bb.width).toBeCloseTo(ppy, 0);
  // The Writing picker on the backstory strand: the band follows that strand, not the primary.
  await invoke('storyTime.set', {
    time: { year: 2032, chapterId: 'CH2', strandId: 'CH2-backstory' },
  });
  await expect(band).toHaveAttribute('data-from', '2032');
  await expect(band).toHaveAttribute('data-to', '2032');
  await expect(band).toHaveAttribute('title', /Two Kitchens, backstory/);
  await expect(line).toHaveAttribute('data-year', '2032');
  // No chapter, no band.
  await invoke('storyTime.set', { time: { year: 2040 } });
  await expect(line).toHaveAttribute('data-year', '2040');
  await expect(band).toHaveCount(0);
});

test('SM-9 SM-10 A50 Backstory opens on a person given to it: that person’s timeline is open and the head shows them, every time it is asked', async () => {
  // From another screen, through openBackstory, which Relevant to Session's "Their backstory" calls.
  await rail(page, 'Family tree').click();
  await expect(view()).toHaveCount(0);
  await page.evaluate(openBackstory, 'H5');
  await expect(grid()).toBeVisible();
  await expect(rail(page, 'Backstory')).toHaveAttribute('aria-current', 'page');
  await expect(personView()).toHaveCount(1);
  await expect(grid().locator('.bs-row')).toHaveCount(1);
  await expect(label('H5')).toHaveAttribute('aria-pressed', 'true');
  await expect(picked()).toHaveText('Iris Hale-Zhou 晓曦, 2031');
  await expect(view().getByRole('button', { name: 'Add a moment' })).toBeVisible();
  await expect(showEveryone()).toBeVisible();
  // With the screen already open, another person.
  await page.evaluate(openBackstory, 'Z3');
  await expect(label('Z3')).toHaveAttribute('aria-pressed', 'true');
  await expect(grid().locator('.bs-row')).toHaveCount(1);
  await expect(row('H5')).toHaveCount(0);
  await expect(picked()).toHaveText('Zhou Lan 周兰, 1988');
  // The same person asked for again after another was opened in the grid opens again.
  await page.evaluate(openBackstory, 'H5');
  await expect(label('H5')).toHaveAttribute('aria-pressed', 'true');
  await showEveryone().click();
  await expect(personView()).toHaveCount(0);
  await openPerson('Z1');
  await expect(label('Z1')).toHaveAttribute('aria-pressed', 'true');
  await page.evaluate(openBackstory, 'H5');
  await expect(personView()).toHaveCount(1);
  await expect(label('H5')).toHaveAttribute('aria-pressed', 'true');
  await expect(row('Z1')).toHaveCount(0);
  await expect(picked()).toHaveText('Iris Hale-Zhou 晓曦, 2031');
  // And again after going back to everyone.
  await showEveryone().click();
  await expect(personView()).toHaveCount(0);
  await page.evaluate(openBackstory, 'H5');
  await expect(personView()).toHaveCount(1);
  await expect(grid().locator('.bs-row')).toHaveCount(1);
});

test('SM-9 A50 the rail’s Backstory button in a person’s timeline shows the grid with everyone, the pick kept', async () => {
  await page.evaluate(openBackstory, 'H5');
  await expect(personView()).toHaveCount(1);
  await rail(page, 'Backstory').click();
  await expect(personView()).toHaveCount(0);
  await expect(grid().locator('.bs-row')).toHaveCount(13);
  await expect(grid().locator('.wg-group')).not.toHaveCount(0);
  await expect(label('H5')).toHaveAttribute('aria-pressed', 'true');
  await expect(picked()).toHaveText('Iris Hale-Zhou 晓曦, 2031');
  // Asked for again, the person's timeline opens again.
  await page.evaluate(openBackstory, 'H5');
  await expect(personView()).toHaveCount(1);
  await rail(page, 'Backstory').click();
  await expect(personView()).toHaveCount(0);
});

test('SM-9 A50 a moment opened from search lands on Backstory in that person’s view with the dialog open; a moment not in the grid opens the plain screen', async () => {
  await page.locator('#rail-search').fill('Lives in Portland');
  const hit = page.getByTestId('search-results').locator('[data-hit="Z3-lives-1"]');
  await expect(hit).toBeVisible();
  await hit.click();
  await expect(rail(page, 'Backstory')).toHaveAttribute('aria-current', 'page');
  await expect(personView()).toHaveCount(1);
  await expect(grid().locator('.bs-row')).toHaveCount(1);
  await expect(label('Z3')).toHaveAttribute('aria-pressed', 'true');
  await expect(picked()).toHaveText('Zhou Lan 周兰, 1988');
  const d = momentDialog('Z3-lives-1');
  await expect(d.getByRole('heading')).toHaveText('Lives in Portland, Oregon');
  // The focus is where a marker click puts it: on What happens, closed.
  await expect(cellText('Z3-lives-1', 'title')).toBeFocused();
  await expect(marker('Z3-lives-1')).toHaveAttribute('aria-current', 'true');
  await page.keyboard.press('Escape');
  await expect(dialog()).toHaveCount(0);
  await expect(marker('Z3-lives-1')).toBeFocused();
  // A moment that is not in the grid opens Backstory with nobody picked, and no error.
  await page.evaluate(() =>
    window.dispatchEvent(
      new CustomEvent('nc:open-backstory', {
        detail: { momentId: 'no-such-moment', at: Date.now() },
      }),
    ),
  );
  await expect(personView()).toHaveCount(0);
  await expect(grid().locator('.bs-row')).toHaveCount(13);
  await expect(picked()).toHaveCount(0);
  await expect(dialog()).toHaveCount(0);
  await expect(view().getByRole('alert')).toHaveCount(0);
  // It says why, in the head, as a plain line.
  await expect(view().getByTestId('moment-missing')).toHaveText(
    'That moment is not on the grid. It may be in the trash.',
  );
  // The next request clears it.
  await page.evaluate(openBackstory, 'Z3');
  await expect(personView()).toHaveCount(1);
  await expect(view().getByTestId('moment-missing')).toHaveCount(0);
  await showEveryone().click();
});

test('SM-9 NF-2 the screen works from the keyboard and its labels use the primary text colour in both themes', async () => {
  await rail(page, 'Family tree').click();
  await showBackstory();
  // A row label opens the person's timeline with Enter (A50), and Escape goes back.
  await view().getByRole('button', { name: 'Change' }).focus();
  await tabTo(label('Z1'));
  await expect(label('Z1')).toHaveAccessibleName(
    'Zhou Meiling 周美玲, 1962 to 2050, show their moments',
  );
  await page.keyboard.press('Enter');
  await expect(personView()).toHaveCount(1);
  await expect(label('Z1')).toHaveAttribute('aria-pressed', 'true');
  await expect(label('Z1')).toBeFocused();
  await expect(label('Z1')).toHaveAccessibleName(
    'Zhou Meiling 周美玲, 1962 to 2050, show everyone',
  );
  await expect(picked()).toHaveText('Zhou Meiling 周美玲, 1962 to 2050');
  await page.keyboard.press('Escape');
  await expect(personView()).toHaveCount(0);
  await expect(label('Z1')).toBeFocused();
  await expect(label('Z1')).toHaveAttribute('aria-pressed', 'true');
  // Enter on the name cell in the timeline goes back too.
  await page.keyboard.press('Enter');
  await expect(personView()).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect(personView()).toHaveCount(0);
  await expect(label('Z1')).toBeFocused();
  // A family heading collapses with Enter.
  const heading = grid().locator('.wg-group[data-group="FAM-HALE"] .wg-group-label');
  await heading.focus();
  await page.keyboard.press('Enter');
  await expect(heading).toHaveAttribute('aria-expanded', 'false');
  await page.keyboard.press('Enter');
  await expect(heading).toHaveAttribute('aria-expanded', 'true');
  // The markers are one Tab stop: Home, End, Up and Down walk them; Enter opens one.
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
  await expect(momentDialog('H5-voice-0')).toBeVisible();
  await expect(marker('H5-voice-0')).toHaveAttribute('aria-current', 'true');
  // IP-1: in the dialog each field is one Tab stop that reads as text until Enter opens it.
  await expect(cellText('H5-voice-0', 'title')).toBeFocused();
  for (const f of ['body', 'worldContext']) {
    await page.keyboard.press('Tab');
    await expect(cellText('H5-voice-0', f)).toBeFocused();
  }
  await page.keyboard.press('Enter');
  await expect(cellBox('H5-voice-0', 'worldContext')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(cellText('H5-voice-0', 'worldContext')).toBeFocused();
  await expect(dialog()).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(dialog().getByRole('button', { name: /^Pick events/ })).toBeFocused();
  // A50: More, closed, then the foot.
  await page.keyboard.press('Tab');
  await expect(dialog().getByRole('button', { name: 'More', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(dialog().getByRole('button', { name: 'Delete' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(
    dialog().locator('.bs-dialog-foot').getByRole('button', { name: 'Close' }),
  ).toBeFocused();
  // NF-2: Tab stays in the dialog; past the foot it comes round to the head (Previous and
  // Next are off, Iris has one moment), then the fields in order.
  await page.keyboard.press('Tab');
  await expect(
    dialog().locator('.bs-dialog-head').getByRole('button', { name: 'Close' }),
  ).toBeFocused();
  for (const f of ['year', 'endYear', 'characterId', 'title']) {
    await page.keyboard.press('Tab');
    await expect(cellText('H5-voice-0', f)).toBeFocused();
  }
  await page.keyboard.press('Escape');
  await expect(dialog()).toHaveCount(0);
  await expect(marker('H5-voice-0')).toBeFocused();
  // Focus is visible on a marker.
  await marker('H5-voice-0').focus();
  expect(await marker('H5-voice-0').evaluate((el) => getComputedStyle(el).outlineStyle)).not.toBe(
    'none',
  );

  // Labels: the primary text colour, never a muted grey, and 4.5:1 on their background.
  const labels = [
    '.bs-row-label',
    '.bs-name-link',
    '.bs-zh',
    '.wg-group-label',
    '.wg-tick',
    '.wg-corner',
    '.wg-era',
    '.wg-toolbar-label',
    '[data-testid="picked-person"]',
    '.bs-field-title',
    '.bs-dialog-who',
    '.bs-age',
    '[data-testid="moment-age"]',
    '.legend',
  ];
  // The dialog's field titles and the age are labels too.
  await openMoment(page, 'H5-voice-0');
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
  await closeMoment();
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

const getCharacter = async (id: string) =>
  (await invoke('entry.get', { collection: 'characters', id })).entry as Record<string, unknown>;

/** Drag an element from its middle sideways by a number of pixels, in steps. */
async function dragBy(target: Locator, dx: number) {
  const box = (await target.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y, { steps: 4 });
  await page.mouse.move(x + dx, y, { steps: 4 });
}

test('IP-4 a lifespan end drags to set the birth as one step, shown live, and Undo restores it', async () => {
  await zoomTo('Close');
  await showRow('H1');
  await showYear(1958);
  const { ppy } = await axis();
  const handle = row('H1').getByTestId('life-handle-start');
  // The handles show while the pointer is over the row.
  await expect(handle).toHaveCSS('opacity', '0');
  await handle.hover({ force: true });
  await expect(handle).toHaveCSS('opacity', '1');
  expect((await handle.boundingBox())!.width).toBeCloseTo(8, 0);
  await dragBy(handle, -2 * ppy);
  await expect(grid().getByTestId('drag-year')).toHaveText('Birth 1956');
  await page.mouse.up();
  await expect(grid().getByTestId('drag-year')).toHaveCount(0);
  await expect(row('H1')).toHaveAttribute('data-birth', '1956');
  expect((await getCharacter('H1')).birth).toEqual({ year: 1956 });
  await blurAndUndo();
  await expect(row('H1')).toHaveAttribute('data-birth', '1958');
  expect((await getCharacter('H1')).birth).toEqual({ year: 1958 });
  // The right end sets the death the same way.
  await showYear(2041);
  await row('H1').getByTestId('life-handle-end').hover({ force: true });
  await dragBy(row('H1').getByTestId('life-handle-end'), 3 * ppy);
  await expect(grid().getByTestId('drag-year')).toHaveText('Death 2044');
  await page.mouse.up();
  await expect(row('H1')).toHaveAttribute('data-death', '2044');
  expect((await getCharacter('H1')).death).toEqual({ year: 2044 });
  await blurAndUndo();
  await expect(row('H1')).toHaveAttribute('data-death', '2041');
});

test('IP-4 NF-2 Shift with the arrows on the focused lifespan moves the birth, Shift and Alt the death, one step each', async () => {
  const life = row('H1').getByTestId('lifespan');
  // The lifespans are one Tab stop; the tooltip says which keys move which end.
  await expect(grid().locator('.bs-life[tabindex="0"]')).toHaveCount(1);
  await expect(life).toHaveAttribute(
    'title',
    /Shift with Left or Right moves the birth a year; Shift and Alt with Left or Right move the death/,
  );
  await life.focus();
  await page.keyboard.press('Shift+ArrowLeft');
  await expect(row('H1')).toHaveAttribute('data-birth', '1957');
  await expect(life).toBeFocused();
  await page.keyboard.press('Shift+Alt+ArrowRight');
  await expect(row('H1')).toHaveAttribute('data-death', '2042');
  expect([(await getCharacter('H1')).birth, (await getCharacter('H1')).death]).toEqual([
    { year: 1957 },
    { year: 2042 },
  ]);
  await blurAndUndo();
  await expect(row('H1')).toHaveAttribute('data-death', '2041');
  await page.keyboard.press('Meta+z');
  await expect(row('H1')).toHaveAttribute('data-birth', '1958');
  // Down walks to the next person's lifespan; a month and day on record stay with the year.
  await life.focus();
  await page.keyboard.press('ArrowDown');
  await expect(row('H2').getByTestId('lifespan')).toBeFocused();
  await row('H5').getByTestId('lifespan').focus();
  await page.keyboard.press('Shift+ArrowRight');
  await expect(row('H5')).toHaveAttribute('data-birth', '2032');
  expect((await getCharacter('H5')).birth).toEqual({ year: 2032, month: 3, day: 14 });
  await blurAndUndo();
  await expect(row('H5')).toHaveAttribute('data-birth', '2031');
});

test('IP-4 ED-10 a death dragged before the birth is refused with the reason and the bar snaps back', async () => {
  await zoomTo('Whole span');
  const { ppy } = await axis();
  await showRow('H1');
  await row('H1').getByTestId('life-handle-end').hover({ force: true });
  await dragBy(row('H1').getByTestId('life-handle-end'), -(2041 - 1956 + 4) * ppy);
  await expect(row('H1').getByTestId('lifespan')).toHaveClass(/refused/);
  await page.mouse.up();
  await expect(view().getByRole('alert')).toHaveText(
    'The death year 1956 is before the birth year 1958. Drag the death to 1958 or later.',
  );
  await expect(row('H1')).toHaveAttribute('data-death', '2041');
  await expect(row('H1').getByTestId('lifespan')).not.toHaveClass(/refused/);
  expect((await getCharacter('H1')).death).toEqual({ year: 2041 });
});

test('IP-4 A49 F2 on a moment marker renames its label in place as one step; Escape leaves it; a double-click opens the moment with What happens open', async () => {
  await marker('H5-voice-0').focus();
  await page.keyboard.press('F2');
  const field = grid().getByTestId('marker-rename').locator('input');
  await expect(field).toBeFocused();
  await expect(field).toHaveValue('Voice');
  await field.fill('Her voice');
  await field.press('Enter');
  await expect(field).toHaveCount(0);
  await expect.poll(async () => (await getMoment('H5-voice-0')).title).toBe('Her voice');
  await expect(marker('H5-voice-0')).toBeFocused();
  await expect(marker('H5-voice-0')).toHaveAccessibleName(/^Her voice, 2060/);
  await page.keyboard.press('F2');
  await field.fill('Something else');
  await field.press('Escape');
  await expect(field).toHaveCount(0);
  expect((await getMoment('H5-voice-0')).title).toBe('Her voice');
  await blurAndUndo();
  await expect.poll(async () => (await getMoment('H5-voice-0')).title).toBe('Voice');
  // A49: a double-click opens the moment with What happens open as a field, and makes nothing
  // where the presses land.
  const before = (await liveMoments()).length;
  await marker('H5-voice-0').dblclick();
  const d = momentDialog('H5-voice-0');
  await expect(d).toBeVisible();
  await expect(cell('H5-voice-0', 'title').locator('input')).toBeFocused();
  await expect(cell('H5-voice-0', 'title').locator('input')).toHaveValue('Voice');
  await expect(d.locator('input, [role="textbox"], select')).toHaveCount(1);
  await expect(field).toHaveCount(0);
  expect((await liveMoments()).length).toBe(before);
  await page.keyboard.press('Escape');
  await expect(cell('H5-voice-0', 'title').locator('input')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(dialog()).toHaveCount(0);
  await expect(marker('H5-voice-0')).toBeFocused();
  // The marker's own dblclick, when it reaches the marker, does the same.
  await marker('H5-voice-0').dispatchEvent('dblclick');
  await expect(cell('H5-voice-0', 'title').locator('input')).toBeFocused();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(dialog()).toHaveCount(0);
  expect((await liveMoments()).length).toBe(before);
});

test('IP-4 A50 the name opens the person’s page; a click elsewhere in the cell opens their timeline', async () => {
  await openPerson('Z1');
  await expect(personView()).toHaveCount(1);
  await expect(label('Z1')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('character-page')).toHaveCount(0);
  // In the timeline too the name is the link to the page.
  await expect(
    rowCell('Z1').getByRole('link', { name: 'Open the page of Zhou Meiling' }),
  ).toBeVisible();
  await showEveryone().click();
  await rowCell('H1').getByRole('link', { name: 'Open the page of Margaret Hale' }).click();
  await expect(page.getByTestId('character-page')).toBeVisible();
  await expect(page.getByTestId('character-page')).toContainText('Margaret Hale');
  await showBackstory();
  await expect(personView()).toHaveCount(0);
});

test('IP-4 A50 a moment moves to another person through Whose moment in the dialog as one step; the grid redraws, and in the person view the view follows the moment', async () => {
  const d = await openMoment(page, 'Z3-lives-1');
  const who = cell('Z3-lives-1', 'characterId');
  await openEditable(who);
  await who.locator('select').selectOption('H1');
  await expect.poll(async () => (await getMoment('Z3-lives-1')).characterId).toBe('H1');
  await expect(row('H1').locator('.bs-marker[data-id="Z3-lives-1"]')).toHaveCount(1);
  await expect(row('Z3').locator('.bs-marker[data-id="Z3-lives-1"]')).toHaveCount(0);
  // The dialog stays on the moment and names its new person.
  await expect(d).toHaveAttribute('data-person', 'H1');
  await expect(d.getByTestId('moment-who')).toHaveText('Margaret Hale, 2027, age 69');
  await blurAndUndo();
  await expect.poll(async () => (await getMoment('Z3-lives-1')).characterId).toBe('Z3');
  await expect(row('Z3').locator('.bs-marker[data-id="Z3-lives-1"]')).toHaveCount(1);
  await expect(d.getByTestId('moment-who')).toHaveText('Zhou Lan 周兰, 2027, age 39');
  await closeMoment();

  // A50: in Zhou Lan's timeline the move takes the view to Margaret Hale, and Previous walks hers.
  await openPerson('Z3');
  await expect(personView()).toHaveCount(1);
  const d2 = await openMoment(page, 'Z3-lives-1');
  await openEditable(cell('Z3-lives-1', 'characterId'));
  await cell('Z3-lives-1', 'characterId').locator('select').selectOption('H1');
  await expect.poll(async () => (await getMoment('Z3-lives-1')).characterId).toBe('H1');
  await expect(personView()).toHaveCount(1);
  await expect(grid().locator('.bs-row')).toHaveCount(1);
  await expect(row('H1')).toHaveCount(1);
  await expect(row('Z3')).toHaveCount(0);
  await expect(label('H1')).toHaveAttribute('aria-pressed', 'true');
  await expect(picked()).toHaveText(/^Margaret Hale/);
  await expect(row('H1').locator('.bs-marker[data-id="Z3-lives-1"]')).toHaveCount(1);
  // Margaret's moments by year: this one (2027), then her voice (2028).
  await d2.getByRole('button', { name: 'Next' }).click();
  await expect(d2).toHaveAttribute('data-id', 'H1-voice-0');
  await expect(row('H1').locator('.bs-marker[data-id="H1-voice-0"]')).toHaveCount(1);
  await d2.getByRole('button', { name: 'Previous' }).click();
  await expect(d2).toHaveAttribute('data-id', 'Z3-lives-1');
  // Undo moves it back, and the view follows it home.
  await blurAndUndo();
  await expect.poll(async () => (await getMoment('Z3-lives-1')).characterId).toBe('Z3');
  await expect(row('Z3')).toHaveCount(1);
  await expect(row('H1')).toHaveCount(0);
  await closeMoment();
  await showEveryone().click();
  await expect(personView()).toHaveCount(0);
});

test('IP-13 with nobody picked, New moment asks whose it is and the dialog opens on the new moment', async () => {
  await pickRow('Z3');
  await view().getByRole('button', { name: 'Clear pick' }).click();
  await expect(grid().locator('.bs-row-label[aria-pressed="true"]')).toHaveCount(0);
  await expect(picked()).toHaveCount(0);
  // New moment asks for the person, makes it at the story year, and picks them.
  const before = (await liveMoments()).length;
  await view().getByRole('button', { name: 'New moment' }).click();
  const whose = view().getByLabel('Whose moment', { exact: true });
  await expect(whose).toBeFocused();
  await whose.selectOption('X1');
  await expect.poll(async () => (await liveMoments()).length).toBe(before + 1);
  const made = (await liveMoments()).find((m) => m.characterId === 'X1')!;
  expect([made.year, made.title]).toEqual([2040, '']);
  const id = String(made._id);
  await expect(dialog()).toHaveAttribute('data-id', id);
  await expect(cell(id, 'title').locator('input')).toBeFocused();
  await expect(label('X1')).toHaveAttribute('aria-pressed', 'true');
  await expect(row('X1').locator(`.bs-marker[data-id="${id}"]`)).toHaveCount(1);
  // Escape closes the field, then the dialog.
  await page.keyboard.press('Escape');
  await expect(cell(id, 'title').locator('input')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(dialog()).toHaveCount(0);
  await blurAndUndo();
  await expect(marker(id)).toHaveCount(0);
  expect((await getMoment(id)).deletedAt).toBeTruthy();
  // Cancel puts New moment back and makes nothing.
  await view().getByRole('button', { name: 'Clear pick' }).click();
  await view().getByRole('button', { name: 'New moment' }).click();
  await view().getByRole('button', { name: 'Cancel' }).click();
  await expect(view().getByRole('button', { name: 'New moment' })).toBeVisible();
  expect((await liveMoments()).length).toBe(before);
});

test('IP-4 the era band on Backstory drags an edge and makes an era in the gap it leaves, one step each', async () => {
  const era = (id: string) => grid().getByTestId('era-band').locator(`.wg-era[data-id="${id}"]`);
  await zoomTo('Close');
  await showYear(2027);
  const { ppy } = await axis();
  // No gap inside the timeline span while the fixture's eras cover it.
  await expect(grid().locator('.wg-gap')).toHaveCount(0);
  await era('ERA-2025').hover();
  await dragBy(era('ERA-2025').getByTestId('era-handle-start'), 2 * ppy);
  await expect(grid().getByTestId('edge-year')).toHaveText('2027');
  await page.mouse.up();
  await expect(era('ERA-2025')).toHaveAttribute('data-from', '2027');
  await expect
    .poll(
      async () =>
        (await invoke('entry.get', { collection: 'eraStates', id: 'ERA-2025' })).entry.startYear,
    )
    .toBe(2027);
  // The drag left 2025 to 2026 bare: a double-click there makes an era, its name open.
  const gap = grid().locator('.wg-gap[data-from="2025"]');
  await expect(gap).toHaveAttribute('data-to', '2026');
  await gap.dblclick();
  const name = grid().getByTestId('era-rename').locator('input');
  await expect(name).toBeFocused();
  await name.fill('The first years');
  await name.press('Enter');
  const made = grid().locator('.wg-era[data-from="2025"]');
  await expect(made).toHaveText('The first years');
  // Three steps back: the name, the new era, the drag.
  await blurAndUndo();
  await expect(made).toHaveText('New era');
  await page.keyboard.press('Meta+z');
  await expect(made).toHaveCount(0);
  await page.keyboard.press('Meta+z');
  await expect(era('ERA-2025')).toHaveAttribute('data-from', '2025');
  await expect(grid().locator('.wg-gap')).toHaveCount(0);
});

test('IP-11 IP-4 the axis follows the bible’s timeline span', async () => {
  expect((await axis()).to).toBe(2100);
  await invoke('settings.set', { numbers: { timelineEnd: 2110 } });
  await expect(grid()).toHaveAttribute('data-to', '2110');
  // A life with no death runs to the end of the axis.
  await expect(row('H3').getByTestId('lifespan')).toHaveAttribute('data-kind', 'alive');
  const { ppy } = await axis();
  expect(
    Math.abs(
      (await row('H3').getByTestId('lifespan').boundingBox())!.width - (2110 - 1985 + 1) * ppy,
    ),
  ).toBeLessThan(1.5);
  await invoke('settings.set', { numbers: { timelineEnd: 2100 } });
  await expect(grid()).toHaveAttribute('data-to', '2100');
});

test("SM-9 ARCH-6 read-only: Add a moment, the dialog's fields, the picker, Delete, drags, keys and the trash notice's Undo are all off with the reason; Previous, Next and Close still work", async () => {
  test.setTimeout(240_000);
  // A server of its own, stopped mid-session so the snapshot opens read-only (as offline.spec.ts does).
  const own = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });
  try {
    const member = own.servers[0]!;
    const store = await connect(own.getUri());
    await loadFixture(store, 'ro');
    await store.close();
    await app.close();
    ({ app, page } = await launch(own.getUri()));
    invoke = invokeVia(page);
    await invoke('bible.open', { slug: 'ro' });
    await expect(page.getByTestId('workspace')).toBeVisible();
    await showBackstory();
    await pickRow('Z3');
    // A second live moment for Zhou Lan, so Previous and Next have somewhere to go.
    const { _id: _drop, ...lives } = strip(fixture.moments!.find((m) => m._id === 'Z3-lives-1')!);
    const { entry: later } = await invoke('entry.create', {
      collection: 'moments',
      data: { ...lives, title: 'Moves to Seattle', year: 2033, endYear: null, links: [] },
    });
    await expect(marker(later._id)).toHaveCount(1);
    const doomed = await openMoment(page, 'Z3-lives-1');
    await doomed.getByRole('button', { name: 'Delete' }).click();
    await doomed
      .getByRole('dialog', { name: 'Move to trash' })
      .getByRole('button', { name: 'Move to trash' })
      .click();
    await expect(dialog()).toHaveCount(0);
    const notice = view().getByTestId('moment-trashed');
    await expect(notice).toBeVisible();
    // The latest snapshot holds the moment in the trash, as the screen shows it.
    await invoke('snapshot.take', {});
    await member.stop({ doCleanup: false, force: true });

    // The lost connection shows on the next write; the snapshot opens read-only in place.
    await invoke('entry.update', {
      collection: 'moments',
      id: 'Z3-lives-0',
      patch: { title: 'Lives in Guangzhou, by the river' },
    }).catch(() => undefined);
    const banner = page.getByTestId('connection-banner');
    await expect(banner).toHaveAttribute('data-state', 'unavailable', { timeout: 60_000 });
    // IP-1: while the connection is gone a save fails at the field, which stays open with the
    // text typed in it and the reason under it, so nothing typed is lost.
    await openMoment(page, 'Z3-lives-0');
    const title = cell('Z3-lives-0', 'title');
    await openEditable(title);
    await title.locator('input').fill('Lives by the river');
    await title.locator('input').press('Enter');
    await expect(title.getByRole('alert')).toBeVisible({ timeout: 60_000 });
    await expect(title.locator('input')).toHaveValue('Lives by the river');
    await title.locator('input').press('Escape');
    await expect(title.locator('input')).toHaveCount(0);
    await closeMoment();
    await banner.getByTestId('open-snapshot').click();
    await expect(banner).toHaveAttribute('data-state', 'readOnly');
    await showBackstory();
    await pickRow('Z3');
    const d = await openMoment(page, 'Z3-lives-0');

    const off = async (l: Locator) => {
      await expect(l).toBeDisabled();
      await expect(l).toHaveAttribute('title', READ_ONLY_REASON);
      await expect(l).toHaveAttribute('aria-describedby', 'read-only-reason');
    };
    await off(view().getByRole('button', { name: 'Add a moment' }));
    // A50: the person's timeline opens and closes; nothing in it writes.
    await page.keyboard.press('Escape');
    await expect(dialog()).toHaveCount(0);
    await openPerson('Z3');
    await expect(personView()).toHaveCount(1);
    await expect(grid().locator('.wg-track.addable')).toHaveCount(0);
    await expect(grid().getByTestId('life-handle-start')).toHaveCount(0);
    await off(view().getByRole('button', { name: 'Add a moment' }));
    await expect(showEveryone()).toBeEnabled();
    await showEveryone().click();
    await expect(personView()).toHaveCount(0);
    await openMoment(page, 'Z3-lives-0');
    for (const f of ['year', 'endYear', 'characterId', 'title', 'body', 'worldContext']) {
      await off(cellText('Z3-lives-0', f));
    }
    await off(d.getByRole('button', { name: /^Pick events/ }));
    await off(d.getByRole('button', { name: 'Delete' }));
    // A50: More holds the rest of the moment; its fields are off too, and History still opens.
    await d.getByRole('button', { name: 'More', exact: true }).click();
    for (const f of ['status', 'provenance', 'sourceNote', 'sourceRef']) {
      await off(cellText('Z3-lives-0', f));
    }
    // Tags and Links sit in a fieldset that is off with the reason, as in the entry editor.
    const rest = d.locator('fieldset.bs-more-group');
    await expect(rest).toHaveAttribute('disabled', '');
    await expect(rest).toHaveAttribute('title', READ_ONLY_REASON);
    await expect(rest).toHaveAttribute('aria-describedby', 'read-only-reason');
    await expect(rest.locator('[data-field="tags"] .add-row > input')).toBeDisabled();
    await expect(rest.getByLabel('Link kind')).toBeDisabled();
    const history = d.getByRole('button', { name: 'History', exact: true });
    await history.click();
    await expect(page.getByTestId('history')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('history')).toHaveCount(0);
    await expect(d).toBeVisible();
    await expect(history).toBeFocused();
    // Reading still works: the age, and Previous and Next through the person's moments.
    await expect(d.getByTestId('moment-age')).toHaveText('0');
    await d.getByRole('button', { name: 'Next' }).click();
    await expect(d).toHaveAttribute('data-id', later._id);
    // More stays open from one moment to the next.
    await expect(d.getByTestId('moment-more')).toBeVisible();
    await expect(d.getByTestId('moment-age')).toHaveText('45');
    await d.getByRole('button', { name: 'Previous' }).click();
    await expect(d).toHaveAttribute('data-id', 'Z3-lives-0');
    await page.keyboard.press('Escape');
    await expect(dialog()).toHaveCount(0);
    // The trash notice from before the switch stays, and its Undo is off too.
    await off(notice.getByRole('button', { name: 'Undo' }));
    // Nothing on the grid writes: no addable rows, and a drag or an arrow leaves the marker be.
    await expect(grid().locator('.wg-track.addable')).toHaveCount(0);
    // IP-4: no grab handles on the lifespans or the eras, no gaps to fill.
    await expect(grid().getByTestId('life-handle-start')).toHaveCount(0);
    await expect(grid().getByTestId('era-handle-end')).toHaveCount(0);
    await expect(grid().locator('.wg-gap')).toHaveCount(0);
    await zoomTo('Close');
    await showRow('Z3');
    await showYear(1990);
    const { ppy } = await axis();
    const box = (await marker('Z3-lives-0').boundingBox())!;
    await page.mouse.move(box.x + 10, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 10 + 3 * ppy, box.y + box.height / 2, { steps: 4 });
    await expect(grid().getByTestId('drag-year')).toHaveCount(0);
    await page.mouse.up();
    await expect(marker('Z3-lives-0')).toHaveAttribute('data-year', '1988');
    // With no drag the press was a click, which opens the moment to read.
    await expect(momentDialog('Z3-lives-0')).toBeVisible();
    await closeMoment();
    await marker('Z3-lives-0').focus();
    await page.keyboard.press('ArrowRight');
    await expect(marker('Z3-lives-0')).toHaveAttribute('data-year', '1988');
    // A click still opens the moment to read, and Close closes it.
    await openMoment(page, 'Z3-lives-0');
    await closeMoment();
  } finally {
    await own.stop().catch(() => undefined);
  }
});
