import { performance } from 'node:perf_hooks';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { createBible } from '../../src/main/db';
import { BIG, median } from '../helpers/bigBible';
import { generatedTree } from '../helpers/generatedTree';
import { loadBigBible } from '../helpers/loadBigBible';
import { connectTo, fileDb, launch, rail } from './helpers';
import type { TestDb } from './helpers';

/**
 * NF-1 and T-6 in the built app: launch to the rail with 5,000 entries
 * and 100 chapters, and the tree redraw both inside that bible (1,200
 * characters) and on the 200-person, six-generation tree alone (FT-8).
 *
 * Timing and concurrency: other suites and builds run on this machine at the
 * same time, so a single sample can be slowed by a neighbour. Each limit is
 * asserted on the median of three samples, which one slow sample cannot move.
 */
const BIG_SLUG = 'nf1-big';
const BIG_NAME = 'Five thousand entries';
const TREE_SLUG = 'nf1-tree';

let db: TestDb;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.setTimeout(300_000);
  db = fileDb();
  const store = await connectTo(db);
  try {
    const { docs } = await loadBigBible(store, BIG_SLUG, BIG_NAME);
    expect(docs.characters).toHaveLength(BIG.characters);
    const tree = await createBible(store, TREE_SLUG, 'Two hundred people');
    const { characters, unions, parentLinks } = generatedTree(BIG.treePeople, 6);
    const stamp = { modifiedAt: '2026-01-15T09:00:00.000Z' };
    await tree
      .collection('characters')
      .insertMany(characters.map((d) => ({ ...d, ...stamp })) as never[]);
    await tree.collection('unions').insertMany(unions.map((d) => ({ ...d, ...stamp })) as never[]);
    await tree
      .collection('parentLinks')
      .insertMany(parentLinks.map((d) => ({ ...d, ...stamp })) as never[]);
  } finally {
    await store.close();
  }
});

test.afterAll(async () => {});

/**
 * One launch: from starting Electron to the rail drawn beside the character
 * list the app opens on, including connecting to MongoDB, opening the bible, loading the read model
 * and the search index, and the first render. The bible is opened from the
 * list with the keyboard, as a person would, unless the app opened it itself.
 */
async function launchToRail(): Promise<{ app: ElectronApplication; page: Page; ms: number }> {
  const start = performance.now();
  const { app, page } = await launch(db);
  const railNav = page.getByTestId('rail');
  const openButton = page.getByRole('button', { name: `Open ${BIG_NAME}`, exact: true });
  await expect(railNav.or(openButton)).toBeVisible({ timeout: 30_000 });
  if (!(await railNav.isVisible())) {
    await openButton.focus();
    await page.keyboard.press('Enter');
  }
  await expect(railNav).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('entry-list')).toBeVisible();
  // Two frames: the browser has laid out and painted the rail and the list.
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))),
  );
  return { app, page, ms: performance.now() - start };
}

test('NF-1 T-6 launch to the rail with 5,000 entries and 100 chapters takes under 3 seconds', async () => {
  test.setTimeout(300_000);
  const samples: number[] = [];
  for (let i = 0; i < 3; i++) {
    const { app, page, ms } = await launchToRail();
    samples.push(ms);
    await expect(page.getByTestId('current-bible')).toHaveText(BIG_NAME);
    // The character list shows the generated characters, so the read model is loaded.
    await expect(page.getByTestId('entry-list').locator('li').first()).toBeVisible();
    await app.close();
  }
  test.info().annotations.push({
    type: 'NF-1 launch to rail (ms)',
    description: samples.map((s) => s.toFixed(0)).join(', '),
  });
  process.stdout.write(
    `NF-1 launch to rail samples (ms): ${samples.map((s) => s.toFixed(0)).join(', ')}\n`,
  );
  expect(median(samples)).toBeLessThan(3000);
});

/**
 * Redraw the open tree at a year: set the top bar's year box as a person typing
 * would and time it until the SVG shows that year and two frames are painted.
 */
function redrawer(page: Page) {
  return (year: number) =>
    page.evaluate(
      (y) =>
        new Promise<number>((resolve) => {
          const input = document.querySelector<HTMLInputElement>('[data-testid="top-year"]')!;
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
          const start = performance.now();
          setter.call(input, String(y));
          input.dispatchEvent(new Event('input', { bubbles: true }));
          // A45 took the tree's own year box away; the top bar year box commits on Enter (TM-3).
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
          const check = () => {
            const svg = document.querySelector('[data-testid="tree-svg"]')!;
            if (svg.getAttribute('data-year') === String(y)) {
              requestAnimationFrame(() =>
                requestAnimationFrame(() => resolve(performance.now() - start)),
              );
            } else requestAnimationFrame(check);
          };
          check();
        }),
      year,
    );
}

/** The median of three redraws to each year, each from a different year first. */
async function redrawMedians(page: Page): Promise<Record<number, number>> {
  const redraw = redrawer(page);
  const medians: Record<number, number> = {};
  for (const year of [1950, 2000, 2030, 2060, 2080]) {
    const samples: number[] = [];
    for (let i = 0; i < 3; i++) {
      await redraw(year - 7 - i);
      samples.push(await redraw(year));
    }
    medians[year] = median(samples);
  }
  return medians;
}

async function openTree(page: Page, slug: string): Promise<void> {
  await page.evaluate((s) => window.api.invoke('bible.open', { slug: s }), slug);
  await expect(page.getByTestId('workspace')).toBeVisible();
  await rail(page, 'Family tree').click();
  await expect(page.getByTestId('tree-view')).toBeVisible();
}

test('NF-1 FT-8 the 200-person, six-generation tree redraws in under 500 ms', async () => {
  test.setTimeout(300_000);
  const { app, page } = await launch(db);
  try {
    await openTree(page, TREE_SLUG);
    await expect(page.locator('g.tnode')).toHaveCount(BIG.treePeople);
    const medians = await redrawMedians(page);
    process.stdout.write(`NF-1 tree redraw medians (ms): ${JSON.stringify(medians)}\n`);
    const states = await page
      .locator('g.tnode')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-state')));
    expect(states.filter((s) => s === 'alive').length).toBeGreaterThan(0);
    for (const ms of Object.values(medians)) expect(ms).toBeLessThan(500);
  } finally {
    await app.close();
  }
});

test('NF-1 T-6 the tree redraws in under 500 ms inside the 5,000-entry bible, with all 1,200 characters', async () => {
  test.setTimeout(300_000);
  const { app, page } = await launch(db);
  try {
    await openTree(page, BIG_SLUG);
    // Every character of the big bible is a person on the tree: the 200 in the generated
    // families and the 1,000 others, each in a family (FT-4, people with no known parents).
    await expect(page.locator('g.tnode')).toHaveCount(BIG.characters, { timeout: 60_000 });
    const medians = await redrawMedians(page);
    test.info().annotations.push({
      type: 'NF-1 big bible tree redraw medians (ms)',
      description: JSON.stringify(medians),
    });
    process.stdout.write(`NF-1 big bible tree redraw medians (ms): ${JSON.stringify(medians)}\n`);
    for (const ms of Object.values(medians)) expect(ms).toBeLessThan(500);
  } finally {
    await app.close();
  }
});
