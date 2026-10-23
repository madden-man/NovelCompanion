import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { BIG, countEntries, median } from '../helpers/bigBible';
import { loadBigBible } from '../helpers/loadBigBible';
import { connectTo, fileDb, invokeVia, launch, rail } from './helpers';
import type { TestDb } from './helpers';

/**
 * NF-1 in the built app over the 5,000-entry bible, on the screens that list
 * many rows since the Entries screen left (SM-6, SM-11): a query typed into
 * the rail's search box answers in the results within NF-1's 200 ms search
 * budget, and Questions draws its open questions within 500 ms, NF-1's redraw
 * budget. As in perf.spec.ts, each limit is asserted on the median of three
 * samples, since other suites share the machine.
 */
const SLUG = 'nf1-search';
const SEARCH_MS = 200;
const OPEN_MS = 500;

let db: TestDb;
let app: ElectronApplication;
let page: Page;
let questions = 0;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.setTimeout(300_000);
  db = fileDb();
  const store = await connectTo(db);
  try {
    const { docs } = await loadBigBible(store, SLUG);
    expect(countEntries(docs)).toBeGreaterThanOrEqual(BIG.entries);
    questions = docs.openQuestions?.length ?? 0;
    expect(questions).toBeGreaterThan(50);
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

/**
 * Type a whole query into the rail's search box as one input event and time
 * it until the results answer that query and are painted (two frames).
 */
function typeQuery(q: string) {
  return page.evaluate(
    (q) =>
      new Promise<number>((resolve) => {
        const input = document.querySelector<HTMLInputElement>('#rail-search')!;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
        const start = performance.now();
        setter.call(input, q);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        const check = () => {
          const region = document.querySelector('[data-testid="search-region"]');
          const key = region?.getAttribute('data-query-key') ?? '';
          const answered =
            region?.getAttribute('aria-busy') === 'false' &&
            (JSON.parse(key || '{}') as { query?: string }).query === q.trim();
          if (answered) {
            requestAnimationFrame(() =>
              requestAnimationFrame(() => resolve(performance.now() - start)),
            );
          } else requestAnimationFrame(check);
        };
        check();
      }),
    q,
  );
}

/** Open Questions from the rail and time it until every question row is painted. */
function openQuestions(rows: number) {
  return page.evaluate(
    ({ rows }) =>
      new Promise<number>((resolve) => {
        const button = [
          ...document.querySelectorAll<HTMLButtonElement>('nav[aria-label="Sections"] button'),
        ].find((b) => b.textContent === 'Questions')!;
        const start = performance.now();
        button.click();
        const check = () => {
          const n = document.querySelectorAll('[data-testid="questions-list"] .entry-row').length;
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

test('NF-1 SM-6 SR-1 a query in the rail search box answers over the 5,000-entry bible within 200 ms', async () => {
  test.setTimeout(120_000);
  await rail(page, 'Search and filters').click();
  const results: Record<string, number> = {};
  // Three different queries of each shape, each typed once, so no sample reuses an answer.
  const shapes: Record<string, string[]> = {
    'one letter': ['r', 'e', 'a'],
    'one word': ['harbor', 'lantern', 'ferry'],
    'two words': ['lantern ferry', 'rain kitchen', 'window harbor'],
    Chinese: ['团圆', '外婆', '月饼'],
    romanization: ['xiaoxi', 'xiǎoxī', 'xiao xi'],
  };
  for (const [shape, queries] of Object.entries(shapes)) {
    const samples: number[] = [];
    for (const q of queries) samples.push(await typeQuery(q));
    results[shape] = median(samples);
  }
  process.stdout.write(`NF-1 search query medians (ms): ${JSON.stringify(results)}\n`);
  test.info().annotations.push({
    type: 'NF-1 search query medians (ms)',
    description: JSON.stringify(results),
  });
  // The answers are real lists of hits, capped at one page.
  await typeQuery('harbor');
  const hits = page.getByTestId('search-results').locator('[data-hit]');
  await expect(hits.first()).toBeVisible();
  expect(await hits.count()).toBeGreaterThan(10);
  await expect(page.getByTestId('search-count')).toContainText('matches');
  for (const ms of Object.values(results)) expect(ms).toBeLessThan(SEARCH_MS);
});

test('NF-1 SM-11 OQ-1 Questions draws every open question of the 5,000-entry bible within 500 ms', async () => {
  test.setTimeout(120_000);
  // The first open loads the questions; it must still draw within the budget.
  const samples: number[] = [];
  for (let i = 0; i < 3; i++) {
    await rail(page, 'Characters').click();
    await expect(page.getByRole('heading', { name: 'Characters', level: 2 })).toBeVisible();
    samples.push(await openQuestions(questions));
  }
  process.stdout.write(
    `NF-1 Questions open (ms): ${samples.map((s) => s.toFixed(0)).join(', ')}\n`,
  );
  test.info().annotations.push({
    type: 'NF-1 Questions open (ms)',
    description: samples.map((s) => s.toFixed(0)).join(', '),
  });
  await expect(page.getByLabel('Show questions').locator('option').first()).toHaveText(
    `All (${questions})`,
  );
  expect(median(samples)).toBeLessThan(OPEN_MS);
});
