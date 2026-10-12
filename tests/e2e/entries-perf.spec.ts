import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { ENTRIES_COLLECTIONS, ENTRIES_PAGE } from '../../src/shared/domain/entries';
import { BIG, countEntries, median } from '../helpers/bigBible';
import { loadBigBible } from '../helpers/loadBigBible';
import { connectTo, fileDb, invokeVia, launch, rail } from './helpers';
import type { TestDb } from './helpers';

/**
 * NF-1 and KB-5 in the built app: the Entries screen over the 5,000-entry
 * bible opens, and a typed query settles, within the NF-1 budgets. As in
 * perf.spec.ts, each limit is asserted on the median of three samples, since
 * other suites share the machine.
 *
 * Budgets: a typed query answers in the list within NF-1's 200 ms search
 * budget. The search channel (SR-1) is asked once typing pauses for 150 ms,
 * so the list has also taken in its hits within 150 ms plus that budget.
 * Opening the screen draws the list within 500 ms, NF-1's redraw budget.
 */
const SLUG = 'nf1-entries';
const SEARCH_MS = 200;
const PAUSE_MS = 150;
const OPEN_MS = 500;

let db: TestDb;
let app: ElectronApplication;
let page: Page;
let listed = 0;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.setTimeout(300_000);
  db = fileDb();
  const store = await connectTo(db);
  try {
    const { docs } = await loadBigBible(store, SLUG);
    expect(countEntries(docs)).toBeGreaterThanOrEqual(BIG.entries);
    listed = ENTRIES_COLLECTIONS.reduce((n, c) => n + (docs[c]?.length ?? 0), 0);
    expect(listed).toBeGreaterThan(ENTRIES_PAGE);
  } finally {
    await store.close();
  }
  ({ app, page } = await launch(db));
  await invokeVia(page)('bible.open', { slug: SLUG });
  await expect(page.getByTestId('workspace')).toBeVisible({ timeout: 30_000 });
});

test.afterAll(async () => {
  await app?.close();
});

/** Click Entries in the rail and time it until the first page of rows is painted. */
function openEntries(rows: number) {
  return page.evaluate(
    ({ rows }) =>
      new Promise<number>((resolve) => {
        const button = [
          ...document.querySelectorAll<HTMLButtonElement>('nav[aria-label="Sections"] button'),
        ].find((b) => b.textContent === 'Entries')!;
        const start = performance.now();
        button.click();
        const check = () => {
          const n = document.querySelectorAll('[data-testid="entries-list"] .entries-row').length;
          if (n === rows) {
            requestAnimationFrame(() =>
              requestAnimationFrame(() => resolve(performance.now() - start)),
            );
          } else requestAnimationFrame(check);
        };
        check();
      }),
    { rows },
  );
}

/**
 * Type a whole query into the search box as one input event and time two
 * moments: the list answering it, and the list settled with the search
 * channel's hits too. Both wait for two painted frames.
 */
function typeQuery(q: string) {
  return page.evaluate(
    (q) =>
      new Promise<{ listed: number; settled: number }>((resolve) => {
        const input = document.querySelector<HTMLInputElement>(
          '[data-testid="entries-view"] input[type="search"]',
        )!;
        const count = () => document.querySelector('[data-testid="entries-count"]');
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
        const start = performance.now();
        let listed: number | null = null;
        setter.call(input, q);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        const frames = (then: (ms: number) => void) =>
          requestAnimationFrame(() => requestAnimationFrame(() => then(performance.now() - start)));
        const check = () => {
          const el = count();
          if (listed === null && el?.getAttribute('data-query') === q.trim()) {
            listed = -1;
            frames((ms) => (listed = ms));
          }
          if (
            el?.getAttribute('data-query') === q.trim() &&
            el.getAttribute('data-settled') === 'true'
          ) {
            frames((ms) => {
              const done = () =>
                listed !== null && listed >= 0
                  ? resolve({ listed, settled: ms })
                  : requestAnimationFrame(done);
              done();
            });
          } else requestAnimationFrame(check);
        };
        check();
      }),
    q,
  );
}

test('NF-1 KB-5 the Entries screen opens over the 5,000-entry bible within 500 ms, one page of rows drawn', async () => {
  test.setTimeout(120_000);
  // The first open loads the seven collections; it must still draw within the budget.
  const samples: number[] = [await openEntries(ENTRIES_PAGE)];
  for (let i = 0; i < 2; i++) {
    await rail(page, 'Dashboard').click();
    await expect(page.getByTestId('dashboard')).toBeVisible();
    samples.push(await openEntries(ENTRIES_PAGE));
  }
  process.stdout.write(`NF-1 Entries open (ms): ${samples.map((s) => s.toFixed(0)).join(', ')}\n`);
  test.info().annotations.push({
    type: 'NF-1 Entries open (ms)',
    description: samples.map((s) => s.toFixed(0)).join(', '),
  });
  const count = page.getByTestId('entries-count');
  await expect(count).toContainText(`${listed} entries, showing the newest ${ENTRIES_PAGE}`);
  await expect(page.getByRole('button', { name: `Show ${ENTRIES_PAGE} more` })).toBeVisible();
  expect(median(samples)).toBeLessThan(OPEN_MS);
});

test('NF-1 KB-5 a typed query answers in the list within 200 ms and settles with the search channel within the pause plus 200 ms', async () => {
  test.setTimeout(120_000);
  const results: Record<string, { listed: number; settled: number }> = {};
  // Three different queries of each shape, each typed once, so no sample reuses the search
  // channel's answer to an earlier one and every sample waits out the pause.
  const shapes: Record<string, string[]> = {
    'one letter': ['r', 'e', 'a'],
    'one word': ['harbor', 'lantern', 'ferry'],
    'two words': ['lantern ferry', 'rain kitchen', 'window harbor'],
    Chinese: ['团圆', '外婆', '月饼'],
    'title and number': ['fact 12', 'fact 13', 'fact 14'],
  };
  for (const [shape, queries] of Object.entries(shapes)) {
    const samples: { listed: number; settled: number }[] = [];
    for (const q of queries) {
      await typeQuery('');
      samples.push(await typeQuery(q));
    }
    results[shape] = {
      listed: median(samples.map((s) => s.listed)),
      settled: median(samples.map((s) => s.settled)),
    };
    // Never more than one page of rows, however many match.
    expect(
      await page.getByTestId('entries-list').locator('.entries-row').count(),
    ).toBeLessThanOrEqual(ENTRIES_PAGE);
  }
  process.stdout.write(`NF-1 Entries query medians (ms): ${JSON.stringify(results)}\n`);
  test.info().annotations.push({
    type: 'NF-1 Entries query medians (ms)',
    description: JSON.stringify(results),
  });
  for (const r of Object.values(results)) {
    expect(r.listed).toBeLessThan(SEARCH_MS);
    expect(r.settled).toBeLessThan(PAUSE_MS + SEARCH_MS);
  }
  // Show more draws the next page.
  await typeQuery('r');
  const before = await page.getByTestId('entries-list').locator('.entries-row').count();
  expect(before).toBe(ENTRIES_PAGE);
  await page.getByRole('button', { name: /^Show \d+ more$/ }).click();
  await expect(page.getByTestId('entries-list').locator('.entries-row')).not.toHaveCount(before);
});
