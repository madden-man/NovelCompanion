import { performance } from 'node:perf_hooks';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { connect, createBible } from '../../src/main/db';
import { BIG, median } from '../helpers/bigBible';
import { generatedTree } from '../helpers/generatedTree';
import { loadBigBible } from '../helpers/loadBigBible';
import { launch, rail } from './helpers';

/**
 * NF-1 and T-6 in the built app: launch to the dashboard with 5,000 entries
 * and 100 chapters, and the tree redraw with the 200-person tree.
 *
 * Timing and concurrency: other suites and builds run on this machine at the
 * same time, so a single sample can be slowed by a neighbour. Each limit is
 * asserted on the median of three samples, which one slow sample cannot move.
 */
const BIG_SLUG = 'nf1-big';
const BIG_NAME = 'Five thousand entries';
const TREE_SLUG = 'nf1-tree';

let server: MongoMemoryReplSet;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.setTimeout(300_000);
  server = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  const store = await connect(server.getUri());
  try {
    await loadBigBible(store, BIG_SLUG, BIG_NAME);
    const tree = await createBible(store, TREE_SLUG, 'Two hundred people');
    const { characters, unions, parentLinks } = generatedTree(BIG.treePeople, 6);
    const stamp = { provenance: 'invented', modifiedAt: '2026-01-15T09:00:00.000Z' };
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

test.afterAll(async () => {
  await server?.stop();
});

/**
 * One launch: from starting Electron to the dashboard drawn with its tiles,
 * including connecting to MongoDB, opening the bible, loading the read model
 * and the search index, and the first render. The bible is opened from the
 * list with the keyboard, as a person would, unless the app opened it itself.
 */
async function launchToDashboard(): Promise<{ app: ElectronApplication; page: Page; ms: number }> {
  const start = performance.now();
  const { app, page } = await launch(server.getUri());
  const dashboard = page.getByTestId('dashboard');
  const openButton = page.getByRole('button', { name: `Open ${BIG_NAME}`, exact: true });
  await expect(dashboard.or(openButton)).toBeVisible({ timeout: 30_000 });
  if (!(await dashboard.isVisible())) {
    await openButton.focus();
    await page.keyboard.press('Enter');
  }
  await expect(dashboard).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('dash-questions')).toBeVisible();
  // Two frames: the browser has laid out and painted the dashboard.
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))),
  );
  return { app, page, ms: performance.now() - start };
}

test('NF-1 T-6 launch to the dashboard with 5,000 entries and 100 chapters takes under 3 seconds', async () => {
  test.setTimeout(300_000);
  const samples: number[] = [];
  for (let i = 0; i < 3; i++) {
    const { app, page, ms } = await launchToDashboard();
    samples.push(ms);
    await expect(page.getByTestId('current-bible')).toHaveText(BIG_NAME);
    // The open questions tile counts the generated questions, so the read model is loaded.
    await expect(page.getByTestId('dash-questions')).toContainText(/\d/);
    await app.close();
  }
  test.info().annotations.push({
    type: 'NF-1 launch to dashboard (ms)',
    description: samples.map((s) => s.toFixed(0)).join(', '),
  });
  process.stdout.write(
    `NF-1 launch to dashboard samples (ms): ${samples.map((s) => s.toFixed(0)).join(', ')}\n`,
  );
  expect(median(samples)).toBeLessThan(3000);
});

test('NF-1 FT-8 the 200-person, six-generation tree redraws in under 500 ms', async () => {
  test.setTimeout(300_000);
  const { app, page } = await launch(server.getUri());
  try {
    await page.evaluate((slug) => window.api.invoke('bible.open', { slug }), TREE_SLUG);
    await expect(page.getByTestId('workspace')).toBeVisible();
    await rail(page, 'Family tree').click();
    await expect(page.getByTestId('tree-view')).toBeVisible();
    await expect(page.locator('g.tnode')).toHaveCount(BIG.treePeople);
    const redraw = (year: number) =>
      page.evaluate(
        (y) =>
          new Promise<number>((resolve) => {
            const input = document.querySelector<HTMLInputElement>('[data-testid="tree-year"]')!;
            const setter = Object.getOwnPropertyDescriptor(
              HTMLInputElement.prototype,
              'value',
            )!.set!;
            const start = performance.now();
            setter.call(input, String(y));
            input.dispatchEvent(new Event('input', { bubbles: true }));
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
    const medians: Record<number, number> = {};
    for (const year of [1950, 2000, 2030, 2060, 2080]) {
      const samples: number[] = [];
      // Three redraws to this year, each from a different year first.
      for (let i = 0; i < 3; i++) {
        await redraw(year - 7 - i);
        samples.push(await redraw(year));
      }
      medians[year] = median(samples);
    }
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
