import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { Store } from '../../src/main/db';
import { openBibleSession } from '../../src/main/db/session';
import type { OpenBible } from '../../src/main/db/session';
import { bibleHandlers } from '../../src/main/ipc/bibleHandlers';
import { runHandler } from '../../src/main/ipc/validate';
import type { Channel, Request } from '../../src/shared/ipc';
import { BIG, countEntries, median } from '../helpers/bigBible';
import { loadBigBible } from '../helpers/loadBigBible';
import { freshSlug, localStore } from '../helpers/db';

/**
 * NF-1 and T-6 against a real local MongoDB holding 5,000 entries and 100
 * chapters. Every query goes through the same IPC layer the renderer uses
 * (`runHandler`: zod on the request and the response), so the time is what
 * the window waits for, not just the domain function.
 *
 * Timing and concurrency: other suites run on this machine at the same time,
 * so one sample can be slowed by a neighbour. Each measurement takes three
 * samples after a warm-up call and asserts the median, which one slow sample
 * cannot move.
 */
let store: Store;
let bible: OpenBible;
let slug: string;
const measured: Record<string, number> = {};

function timed(fn: () => unknown): number {
  const t = performance.now();
  fn();
  return performance.now() - t;
}

async function timedAsync(fn: () => Promise<unknown>): Promise<number> {
  const t = performance.now();
  await fn();
  return performance.now() - t;
}

/** Warm up once, then the median of three calls through the IPC layer. */
async function medianCall<C extends Channel>(label: string, channel: C, request: Request<C>) {
  const handlers = bibleHandlers(() => bible) as unknown as Record<
    string,
    Parameters<typeof runHandler>[1]
  >;
  const run = () => runHandler(channel, handlers[channel] as never, request);
  const result = await run();
  const samples: number[] = [];
  for (let i = 0; i < 3; i++) samples.push(await timedAsync(run));
  measured[label] = median(samples);
  return { ms: median(samples), result };
}

beforeAll(async () => {
  store = await localStore();
  slug = freshSlug('nf1');
  const { docs } = await loadBigBible(store, slug);
  expect(countEntries(docs)).toBe(BIG.entries);
  bible = await openBibleSession(store, slug);
  await bible.repo.setStoryTime({ year: 2061 });
}, 300_000);

afterAll(async () => {
  // The measured numbers, for PROGRESS.md.
  process.stdout.write(
    `NF-1 measured medians (ms): ${JSON.stringify(
      Object.fromEntries(Object.entries(measured).map(([k, v]) => [k, Number(v.toFixed(1))])),
      null,
      1,
    )}\n`,
  );
  await store?.close();
});

describe('NF-1 T-6 with 5,000 entries and 100 chapters in MongoDB', () => {
  test('T-6 the generated volume is in the database: 5,000 entries, 100 chapters with text, moments, events, places', () => {
    const m = bible.model;
    const entries = [
      'characters',
      'families',
      'unions',
      'parentLinks',
      'parts',
      'chapters',
      'moments',
      'worldEvents',
      'eraStates',
      'places',
      'glossaryTerms',
      'openQuestions',
    ].reduce((n, c) => n + m.size(c), 0);
    expect(entries).toBe(BIG.entries);
    expect(m.size('chapters')).toBe(100);
    expect(m.all('chapters').every((c) => String(c.manuscriptText).length > 2000)).toBe(true);
    for (const c of ['moments', 'worldEvents', 'places']) {
      expect(m.size(c), c).toBeGreaterThanOrEqual(60);
    }
  });

  test('NF-1 opening the bible (read model and search index from the database) takes well under the 3 second launch', async () => {
    const samples: number[] = [];
    for (let i = 0; i < 3; i++) {
      samples.push(await timedAsync(() => openBibleSession(store, slug)));
    }
    measured['open bible: read model + index'] = median(samples);
    // The rest of the 3 s launch is Electron and the first render, measured in e2e.
    expect(median(samples)).toBeLessThan(2000);
  });

  test('NF-1 SR-1 search returns under 200 ms: a common word, a name, Chinese, and every filter', async () => {
    const common = await medianCall('search: common word', 'search.query', {
      query: 'rain',
      limit: 20,
    });
    expect((common.result as { total: number }).total).toBeGreaterThan(500);
    expect(common.ms).toBeLessThan(200);
    for (const [label, req] of [
      ['search: a name', { query: 'Person 123', limit: 20 }],
      ['search: Chinese', { query: '晓曦', limit: 20 }],
      ['search: chapter text', { query: 'typhoon dumpling', limit: 20 }],
      [
        'search: every filter',
        {
          query: 'river',
          limit: 20,
          filters: {
            sections: ['characters', 'chapters', 'worldEvents'],
            status: ['canon', 'planned'],
            familyId: 'FAM1',
            placeId: 'PLC6',
            yearFrom: 1950,
            yearTo: 2100,
          },
        },
      ],
    ] as const) {
      const { ms } = await medianCall(label, 'search.query', req as Request<'search.query'>);
      expect(ms, label).toBeLessThan(200);
    }
  });

  test('NF-1 TM-2 the Story Time dialog and the year view load under 100 ms for a year and a full date', async () => {
    for (const [label, at] of [
      ['timeline.year: 2061 (Story Time dialog)', { year: 2061 }],
      ['timeline.year: a full date', { year: 2050, month: 6, day: 15 }],
      ['timeline.year: story time', undefined],
    ] as const) {
      const { ms, result } = await medianCall(label, 'timeline.year', at ? { at } : {});
      const r = result as { alive: unknown[]; events: unknown[]; strands: unknown[] };
      expect(r.alive.length, label).toBeGreaterThan(100);
      expect(ms, label).toBeLessThan(100);
    }
    const anchor = await medianCall('storyTime.anchorAge', 'storyTime.anchorAge', {
      characterId: 'C1',
      age: 40,
    });
    expect(anchor.ms).toBeLessThan(100);
    const preview = await medianCall('storyTime.promotePreview', 'storyTime.promotePreview', {
      chapterId: 'CH5',
      strandId: 'CH5-present',
    });
    expect(preview.ms).toBeLessThan(100);
    const get = await medianCall('storyTime.get', 'storyTime.get', {});
    expect(get.ms).toBeLessThan(100);
  });

  test('NF-1 TL-5 TL-7 lived-through and compare run under 100 ms over the whole range', async () => {
    const lived = await medianCall('timeline.livedThrough', 'timeline.livedThrough', {
      characterId: 'C2',
      year: 2100,
    });
    expect((lived.result as { events: unknown[] }).events.length).toBeGreaterThan(10);
    expect(lived.ms).toBeLessThan(100);
    for (const step of [1, 5] as const) {
      const cmp = await medianCall(
        `timeline.compare: 1900 to 2100, step ${step}`,
        'timeline.compare',
        {
          a: 'C1',
          b: 'P050',
          from: 1900,
          to: 2100,
          step,
        },
      );
      expect((cmp.result as { rows: unknown[] }).rows.length).toBeGreaterThan(30);
      expect(cmp.ms).toBeLessThan(100);
    }
  });

  test('NF-1 TL-6 the timeline chart, unfiltered and by family, place, status, and category, runs under 100 ms; strandsIn and era coverage too', async () => {
    const all = await medianCall('timeline.chart: no filter', 'timeline.chart', {});
    const chart = all.result as { events: unknown[]; lifespans: unknown[]; strands: unknown[] };
    expect(chart.events.length).toBeGreaterThan(1000);
    expect(chart.lifespans.length).toBeGreaterThan(1000);
    expect(all.ms).toBeLessThan(100);
    const filters = {
      familyId: null,
      placeId: null,
      status: null,
      categoryId: null,
    };
    for (const [label, f] of [
      ['timeline.chart: family', { ...filters, familyId: 'FAM2' }],
      ['timeline.chart: place (with places inside it)', { ...filters, placeId: 'PLC6' }],
      ['timeline.chart: status', { ...filters, status: 'canon' }],
      ['timeline.chart: category', { ...filters, categoryId: 'technology' }],
      [
        'timeline.chart: every filter',
        { familyId: 'FAM1', placeId: 'PLC0', status: 'planned', categoryId: 'culture' },
      ],
    ] as const) {
      const { ms } = await medianCall(label, 'timeline.chart', { filters: f });
      expect(ms, label).toBeLessThan(100);
    }
    const place = await medianCall('timeline.chart: place', 'timeline.chart', {
      filters: { ...filters, placeId: 'PLC6' },
    });
    expect((place.result as { events: unknown[] }).events.length).toBeGreaterThan(0);
    const coverage = await medianCall('timeline.eraCoverage', 'timeline.eraCoverage', {});
    expect(coverage.ms).toBeLessThan(100);
    // strandsIn is part of timeline.year above; here alone, through the domain function.
    const { strandsIn } = await import('../../src/shared/domain/timeline');
    expect(strandsIn(bible.model, 2050).length).toBeGreaterThan(0);
    const samples = [0, 1, 2].map(() => timed(() => strandsIn(bible.model, 2050)));
    measured['strandsIn'] = median(samples);
    expect(median(samples)).toBeLessThan(100);
  });

  test('NF-1 FT-8 the tree data for the 200-person tree inside the 5,000 entries is ready in under 100 ms', async () => {
    const { ms, result } = await medianCall('tree.get', 'tree.get', {});
    expect((result as { people: unknown[] }).people.length).toBe(1200);
    // The redraw itself (under 500 ms) is measured in the renderer by the e2e tests.
    expect(ms).toBeLessThan(100);
  });
});
