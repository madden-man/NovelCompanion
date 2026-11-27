import { expect, test } from '@playwright/test';
import type { CDPSession, Locator, Page, TestInfo } from '@playwright/test';
import type { Store } from '../../src/main/db';
import { SLUG, connectTo, openFixture, seedFixtureNovel, startWebServer, webDb } from './server';
import type { WebDb, WebServer } from './server';

/**
 * A58 U3: the story year dial (PH-29, the year sheet), the year view page,
 * and the World screen with its grid held at the first column (PH-34), with
 * nothing behind hover (PH-35) and no instructions (PH-36). Layout and taps on
 * WebKit at iPhone 15 size (project `iphone`); the hold-to-lift drag and the
 * swipe that scrolls on Chromium with CDP touches (project `touch`).
 */
let db: WebDb;
let server: WebServer;
let store: Store;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  db = webDb();
  await seedFixtureNovel(db);
  store = await connectTo(db);
  server = await startWebServer(db);
});

test.afterAll(async () => {
  await server?.stop();
  await store?.close();
});

const onlyOn = (info: TestInfo, project: 'iphone' | 'touch') =>
  test.skip(info.project.name !== project, `runs on the ${project} project`);

const box = async (l: Locator) => {
  const b = await l.boundingBox();
  if (!b) throw new Error('The element has no box.');
  return b;
};

const storedYear = (page: Page) =>
  page.evaluate(async () => (await window.api.invoke('storyTime.get', {})).time?.year);

/** Set the story year through the sheet's typed box, as a person would. */
async function setYear(page: Page, year: number): Promise<void> {
  await page.getByTestId('phone-year').tap();
  const input = page.getByTestId('sheet-year');
  await input.fill(String(year));
  await input.press('Enter');
  await expect(page.getByTestId('phone-year')).toHaveText(String(year));
  await expect.poll(() => storedYear(page)).toBe(year);
  await page.goBack();
  await expect(page.getByTestId('year-sheet')).toHaveCount(0);
}

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

const INSTRUCTION =
  /(^|[.!?]\s+)(Click|Tap|Drag|Swipe|Press|Type|Pick|Choose|Use|Leave|Enter|Hold|Select)\b|to save\b|undo step|still saves|\bCmd\b|⌘|\bCtrl\b|double-click|right-click/i;

async function instructionLines(page: Page): Promise<string[]> {
  const text = await page.locator('body').innerText();
  const titles = await page
    .locator('[title]:visible')
    .evaluateAll((els) => els.map((e) => e.getAttribute('title') ?? ''));
  return [...text.split('\n'), ...titles]
    .map((l) => l.trim())
    .filter((l) => l && INSTRUCTION.test(l));
}

const noSideways = async (page: Page) =>
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  ).toBe(true);

async function openWorld(page: Page): Promise<Locator> {
  await page.getByTestId('tab-world').tap();
  const grid = page.getByTestId('world-grid');
  await expect(grid).toBeVisible();
  await expect(grid.locator('.wg-row').first()).toBeVisible();
  return grid;
}

const era = async (name: string) =>
  (await store.db.collection(`${SLUG}.eraStates`).findOne({ name })) as unknown as {
    _id: string;
    startYear: number;
    endYear: number;
  };

test('PH-29 the year sheet sets the year by stepper and by typing; the top bar pill follows', async ({
  page,
}, info) => {
  onlyOn(info, 'iphone');
  await openFixture(page, server.url);
  await setYear(page, 2040);
  const pill = page.getByTestId('phone-year');
  await pill.tap();
  const sheet = page.getByTestId('year-sheet');
  await expect(sheet.getByTestId('sheet-era')).toHaveText('The forties');
  // Every control of the dial is a thumb target.
  for (const id of ['year-step--10', 'year-step--1', 'sheet-year', 'year-step-1', 'year-step-10']) {
    const b = await box(sheet.getByTestId(id));
    expect(b.height).toBeGreaterThanOrEqual(44);
    expect(b.width).toBeGreaterThanOrEqual(44);
  }
  // The year box is large and at least 16 px, so iOS does not zoom.
  expect(
    await sheet
      .getByTestId('sheet-year')
      .evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
  ).toBeGreaterThanOrEqual(16);

  await sheet.getByTestId('year-step-1').tap();
  await expect(pill).toHaveText('2041');
  await sheet.getByTestId('year-step-10').tap();
  await expect(pill).toHaveText('2051');
  await expect(sheet.getByTestId('sheet-era')).toHaveText('The fifties');
  await sheet.getByTestId('year-step--10').tap();
  await sheet.getByTestId('year-step--1').tap();
  await expect(pill).toHaveText('2040');
  await expect.poll(() => storedYear(page)).toBe(2040);

  // Typed: nothing moves until Enter, then the pill and the stored time follow.
  const input = sheet.getByTestId('sheet-year');
  await input.fill('2033');
  await expect(pill).toHaveText('2040');
  await input.press('Enter');
  await expect(pill).toHaveText('2033');
  await expect.poll(() => storedYear(page)).toBe(2033);

  // Month and day only when asked for.
  await expect(sheet.getByTestId('sheet-month')).toHaveCount(0);
  await sheet.getByTestId('sheet-add-month').tap();
  await sheet.getByTestId('sheet-month').fill('3');
  await expect
    .poll(() =>
      page.evaluate(async () => (await window.api.invoke('storyTime.get', {})).time?.month),
    )
    .toBe(3);
  await sheet.getByRole('button', { name: 'Year only' }).tap();
  await expect(sheet.getByTestId('sheet-month')).toHaveCount(0);

  // A person and an age move the year (TM-4): Margaret Hale, born 1958, is 30 in 1988.
  await sheet.getByTestId('sheet-person').selectOption({ label: 'Margaret Hale' });
  await sheet.getByTestId('sheet-age').fill('30');
  await expect(pill).toHaveText('1988');
  await noSideways(page);

  await input.fill('2040');
  await input.press('Enter');
  await expect(pill).toHaveText('2040');
  await expect.poll(() => storedYear(page)).toBe(2040);
});

test('PH-29 the year view lists the fixture people with their ages for the year, each opening its page', async ({
  page,
}, info) => {
  onlyOn(info, 'iphone');
  await openFixture(page, server.url);
  await setYear(page, 2040);
  await page.getByTestId('phone-year').tap();
  await page.getByTestId('sheet-open-year').tap();
  const view = page.getByTestId('year-page');
  await expect(view).toBeVisible();
  await expect(page.getByTestId('year-sheet')).toHaveCount(0);
  expect(page.url()).toMatch(/s:year$/);
  await expect(view.getByTestId('year-page-year')).toHaveText('2040');
  await expect(view.getByTestId('year-page-era')).toContainText('The forties');
  const row = (name: string) => view.getByTestId('year-person').filter({ hasText: name });
  await expect(row('Margaret Hale').getByTestId('year-age')).toHaveText('82');
  await expect(row('Zhou Wei').getByTestId('year-age')).toHaveText('80');
  await expect(row('Peter Hale').getByTestId('year-age')).toContainText('dead');
  await expect(row('Noor Zhou').getByTestId('year-age')).toContainText('not yet born');
  // One column: every row is the page's width, and the page does not scroll sideways.
  const rows = await view.getByTestId('year-person').all();
  const first = await box(rows[0]!);
  for (const r of rows) expect((await box(r)).x).toBeCloseTo(first.x, 0);
  await noSideways(page);

  // A step on the page moves the year and the ages with it.
  await view.getByTestId('year-page-next').tap();
  await expect(page.getByTestId('phone-year')).toHaveText('2041');
  await expect(row('Margaret Hale').getByTestId('year-age')).toHaveText('83');
  await view.getByTestId('year-page-prev').tap();
  await expect(row('Margaret Hale').getByTestId('year-age')).toHaveText('82');

  // A person opens as a page; back returns to the year view, and back again to People.
  await row('Margaret Hale').tap();
  await expect(page.getByTestId('character-page')).toBeVisible();
  await page.getByTestId('phone-back').tap();
  await expect(view).toBeVisible();
  // The era opens as its page too.
  await view.getByTestId('year-page-era').getByRole('button').tap();
  await expect(page.locator('[data-testid="editor"]:visible')).toContainText('The forties');
  await page.getByTestId('phone-back').tap();
  await expect(view).toBeVisible();
  await page.getByTestId('phone-back').tap();
  await expect(page.getByTestId('entry-list')).toBeVisible();
});

test('PH-34 the World grid scrolls sideways while its first column stays at the left edge; the document does not', async ({
  page,
}, info) => {
  onlyOn(info, 'iphone');
  await openFixture(page, server.url);
  await setYear(page, 2040);
  const grid = await openWorld(page);
  // No story time header repeating the top bar; the controls are one thumb row.
  await expect(page.getByTestId('timeline-time')).toHaveCount(0);
  const bar = page.getByTestId('world-bar');
  const controls = await bar.getByRole('button').all();
  expect(controls.length).toBe(4);
  const y0 = (await box(controls[0]!)).y;
  for (const c of controls) {
    const b = await box(c);
    expect(b.y).toBeCloseTo(y0, 0);
    expect(b.height).toBeGreaterThanOrEqual(44);
  }
  // The five-year strip shows every year whole.
  const strip = page.getByTestId('world-around-strip');
  const s = await box(strip);
  for (const col of await strip.locator('.we-col').all()) {
    const c = await box(col);
    expect(c.x + c.width).toBeLessThanOrEqual(s.x + s.width + 1);
  }
  await expect(strip.locator('.we-col')).toHaveCount(5);

  // The grid opens on the story year, in a box narrower than its years.
  const g = await box(grid);
  const sizes = await grid.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }));
  expect(sizes.sw).toBeGreaterThan(sizes.cw);
  await expect(grid.getByTestId('grid-story-year')).toBeInViewport();
  const label = grid.locator('.wg-row-label').first();
  const before = await box(label);
  for (const dx of [200, 600, 10_000]) {
    await grid.evaluate((el, x) => {
      el.scrollLeft = x;
    }, dx);
    await expect.poll(async () => (await box(label)).x).toBeCloseTo(before.x, 0);
    expect((await box(label)).x).toBeGreaterThanOrEqual(g.x);
    expect(await grid.locator('.wg-corner').evaluate((el) => el.getBoundingClientRect().x)).toBe(
      before.x,
    );
  }
  expect(await grid.evaluate((el) => el.scrollLeft)).toBeGreaterThan(500);
  // The last year is reachable, and the page itself never scrolled sideways.
  expect(await page.evaluate(() => window.scrollX)).toBe(0);
  await noSideways(page);
});

test('PH-34 an event added by a tap in a cell is saved through /rpc and opens as its page', async ({
  page,
}, info) => {
  onlyOn(info, 'iphone');
  await openFixture(page, server.url);
  await setYear(page, 2040);
  const grid = await openWorld(page);
  const channels = rpcChannels(page);
  const add = grid.getByTestId('cell-add').first();
  await expect(add).toBeVisible();
  await add.tap();
  const form = page.getByTestId('grid-add');
  await expect(form).toBeVisible();
  await expect(form).toBeInViewport();
  await form.getByLabel('Title').fill('Tide barrier opens');
  await expect(form.getByLabel('Year', { exact: true })).toHaveValue('2040');
  await form.getByRole('button', { name: 'Save' }).tap();
  await expect
    .poll(
      async () =>
        (await store.db
          .collection(`${SLUG}.worldEvents`)
          .findOne({ title: 'Tide barrier opens' })) as unknown as {
          start?: { year?: number };
        } | null,
    )
    .toMatchObject({ start: { year: 2040 } });
  expect(channels).toContain('entry.create');
  // It opens as its page, with back to the grid.
  await expect(page.locator('[data-testid="editor"]:visible')).toContainText('Tide barrier opens');
  await page.getByTestId('phone-back').tap();
  await expect(grid).toBeVisible();
  await expect(grid.locator('.wg-marker[aria-label^="Tide barrier opens"]')).toHaveCount(1);
  // A tap on the event opens its page again.
  await grid.locator('.wg-marker[aria-label^="Tide barrier opens"]').tap();
  await expect(page.locator('[data-testid="editor"]:visible')).toContainText('Tide barrier opens');
});

test('PH-35 no hover-only control on the World screen: the adds, the era ends and the filters show without a pointer', async ({
  page,
}, info) => {
  onlyOn(info, 'iphone');
  await openFixture(page, server.url);
  await setYear(page, 2040);
  const grid = await openWorld(page);
  // Each row's add shows in its cell and on its label, without a hover.
  const adds = grid.getByTestId('cell-add');
  expect(await adds.count()).toBe(await grid.locator('.wg-row').count());
  for (const a of (await adds.all()).slice(0, 3)) {
    const target = await a.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const b = getComputedStyle(el, '::before');
      return { w: r.width - 2 * parseFloat(b.left), h: r.height - 2 * parseFloat(b.top) };
    });
    expect(target.w).toBeGreaterThanOrEqual(44);
    expect(target.h).toBeGreaterThanOrEqual(44);
  }
  await expect(grid.locator('.wg-row-label .wg-plus').first()).toBeVisible();
  // Rows, headings and eras are thumb tall.
  for (const l of (await grid.locator('.wg-label').all()).slice(0, 4))
    expect((await box(l)).height).toBeGreaterThanOrEqual(43);
  const forties = grid.locator('.wg-era', { hasText: 'The forties' });
  expect((await box(forties)).height).toBeGreaterThanOrEqual(44);
  // A tap selects the era and shows both its ends; no hover is needed.
  await expect(forties.getByTestId('era-handle-end')).toHaveCount(0);
  await forties.tap();
  await expect(forties).toHaveAttribute('aria-pressed', 'true');
  for (const id of ['era-handle-start', 'era-handle-end']) {
    const h = forties.getByTestId(id);
    await expect(h).toHaveCount(1);
    expect(await h.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
  }
  // A second tap opens the era as its page.
  await forties.tap();
  await expect(page.locator('[data-testid="editor"]:visible')).toContainText('The forties');
  await page.getByTestId('phone-back').tap();

  // The filters live in a sheet; Filter counts what is on.
  await page.getByTestId('world-filter').tap();
  const sheet = page.getByTestId('world-filters');
  await expect(sheet).toBeVisible();
  await expect(sheet.getByLabel('Category')).toBeVisible();
  await sheet.getByRole('button', { name: 'China' }).tap();
  await page.goBack();
  await expect(page.getByTestId('world-filter-count')).toHaveText('1');
  await page.getByTestId('world-filter').tap();
  await sheet.getByRole('button', { name: 'All regions' }).tap();
  await page.goBack();
  await expect(page.getByTestId('world-filter-count')).toHaveCount(0);
  await noSideways(page);
});

test('PH-36 the year sheet, the year view, the World screen and its filters carry no instruction text', async ({
  page,
}, info) => {
  onlyOn(info, 'iphone');
  await openFixture(page, server.url);
  const seen: string[] = [];
  await page.getByTestId('phone-year').tap();
  await page.getByTestId('sheet-add-month').tap();
  seen.push(...(await instructionLines(page)));
  await page.getByTestId('sheet-open-year').tap();
  await expect(page.getByTestId('year-page')).toBeVisible();
  seen.push(...(await instructionLines(page)));
  await noSideways(page);
  await page.getByTestId('phone-back').tap();
  await openWorld(page);
  seen.push(...(await instructionLines(page)));
  await page.getByTestId('world-filter').tap();
  seen.push(...(await instructionLines(page)));
  await page.goBack();
  await page.getByTestId('cell-add').first().tap();
  seen.push(...(await instructionLines(page)));
  expect(seen).toEqual([]);
});

// ---------- Chromium with real touch events ----------

async function touch(
  cdp: CDPSession,
  type: 'touchStart' | 'touchMove' | 'touchEnd',
  x: number,
  y: number,
) {
  await cdp.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }],
  });
}

async function drag(
  page: Page,
  cdp: CDPSession,
  from: { x: number; y: number },
  dx: number,
  holdMs: number,
) {
  await touch(cdp, 'touchStart', from.x, from.y);
  if (holdMs) await page.waitForTimeout(holdMs);
  const steps = 12;
  for (let i = 1; i <= steps; i++) {
    await touch(cdp, 'touchMove', from.x + (dx * i) / steps, from.y);
    if (holdMs) await page.waitForTimeout(16);
  }
  await touch(cdp, 'touchEnd', from.x + dx, from.y);
}

test('PH-35 an era end resizes by hold-to-lift, and a plain swipe from it scrolls without resizing', async ({
  page,
}, info) => {
  onlyOn(info, 'touch');
  await openFixture(page, server.url);
  await setYear(page, 2040);
  const grid = await openWorld(page);
  const cdp = await page.context().newCDPSession(page);
  const before = await era('The forties');
  const next = await era('The fifties');
  const forties = grid.locator('.wg-era', { hasText: 'The forties' });
  await forties.tap();
  const end = forties.getByTestId('era-handle-end');
  await expect(end).toHaveCount(1);
  await end.scrollIntoViewIfNeeded();
  await grid.evaluate((el) => {
    el.scrollLeft += 60;
  });
  const h = await box(end);
  const at = { x: h.x + h.width / 2, y: h.y + h.height / 2 };

  // A plain swipe: the grid scrolls, the era stays as it was.
  const left0 = await grid.evaluate((el) => el.scrollLeft);
  await drag(page, cdp, at, -150, 0);
  await expect.poll(() => grid.evaluate((el) => el.scrollLeft)).toBeGreaterThan(left0 + 40);
  await page.waitForTimeout(600);
  expect((await era('The forties')).endYear).toBe(before.endYear);
  expect(await page.evaluate(() => window.scrollX)).toBe(0);

  // Hold, then drag three years to the right: the end and the shared edge move, one undo step.
  await grid.evaluate((el, x) => {
    el.scrollLeft = x;
  }, left0);
  const h2 = await box(end);
  const ppy = Number(await grid.getAttribute('data-ppy'));
  const left1 = await grid.evaluate((el) => el.scrollLeft);
  await drag(page, cdp, { x: h2.x + h2.width / 2, y: h2.y + h2.height / 2 }, ppy * 3, 600);
  await expect.poll(async () => (await era('The forties')).endYear).toBe(before.endYear + 3);
  expect((await era('The fifties')).startYear).toBe(next.startYear + 3);
  // The held drag did not scroll the grid or the page.
  expect(Math.abs((await grid.evaluate((el) => el.scrollLeft)) - left1)).toBeLessThan(2);
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThanOrEqual(0);
  // The release opened nothing.
  await expect(page.locator('[data-testid="editor"]:visible')).toHaveCount(0);

  await page.getByTestId('phone-undo').tap();
  await expect.poll(async () => (await era('The forties')).endYear).toBe(before.endYear);
  expect((await era('The fifties')).startYear).toBe(next.startYear);
});

test('PH-35 a marker lifts only after a hold; a swipe that starts on it scrolls the grid', async ({
  page,
}, info) => {
  onlyOn(info, 'touch');
  await openFixture(page, server.url);
  await setYear(page, 2040);
  const grid = await openWorld(page);
  const cdp = await page.context().newCDPSession(page);
  const marker = grid.locator('.wg-marker').first();
  await marker.scrollIntoViewIfNeeded();
  const id = await marker.getAttribute('data-id');
  const year0 = Number(await marker.getAttribute('data-year'));
  const m = await box(marker);
  const at = { x: m.x + m.width / 2, y: m.y + m.height / 2 };
  const left0 = await grid.evaluate((el) => el.scrollLeft);
  await drag(page, cdp, at, left0 > 200 ? 150 : -150, 0);
  await expect
    .poll(async () => Math.abs((await grid.evaluate((el) => el.scrollLeft)) - left0))
    .toBeGreaterThan(40);
  await page.waitForTimeout(600);
  const stored = (await store.db
    .collection(`${SLUG}.worldEvents`)
    .findOne({ _id: id as never })) as unknown as { start: { year: number } };
  expect(stored.start.year).toBe(year0);
});
