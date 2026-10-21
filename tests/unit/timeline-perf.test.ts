import { performance } from 'node:perf_hooks';
import { describe, expect, test } from 'vitest';
import { ReadModel } from '../../src/main/readmodel';
import {
  eraFor,
  eventsUpTo,
  everyoneIn,
  filterChart,
  livedThrough,
  NO_FILTERS,
  timelineChart,
} from '../../src/shared/domain/timeline';

/** NF-1: 5,000 entries and 100 chapters in the read model. */
function bigModel(): ReadModel {
  const m = new ReadModel();
  let n = 0;
  const put = (c: string, d: Record<string, unknown> & { _id: string }) => {
    m.put(c, d);
    n += 1;
  };
  for (let i = 0; i < 2000; i++) {
    const born = 1900 + (i % 180);
    put('characters', {
      _id: `C${i}`,
      title: `Person ${i}`,
      status: 'canon',
      names: { full: `Person ${i}` },
      birth:
        i % 97 === 0 ? { unknown: true } : { year: born, month: 1 + (i % 12), day: 1 + (i % 28) },
      death: i % 3 === 0 ? { year: born + 60 + (i % 30) } : null,
      familyIds: [`F${i % 5}`],
    });
  }
  for (let i = 0; i < 2800; i++) {
    put('worldEvents', {
      _id: `E${i}`,
      title: `Event ${i}`,
      status: 'planned',
      start: { year: 1950 + (i % 150) },
      end: i % 4 === 0 ? { year: 1955 + (i % 150) } : null,
      categoryId: 'technology',
      regions: [],
      placeIds: [],
      characterIds: [`C${i % 2000}`],
      formative: i % 10 === 0,
    });
  }
  for (let i = 0; i < 100; i++) {
    put('chapters', {
      _id: `CH${i}`,
      title: `Chapter ${i}`,
      status: 'planned',
      readingOrder: i + 1,
      strands: [
        {
          id: `S${i}a`,
          label: 'present',
          startYear: 2025 + (i % 75),
          endYear: null,
          primary: true,
          characterIds: [`C${i}`],
          placeIds: [],
        },
        {
          id: `S${i}b`,
          label: 'backstory',
          startYear: 2000 + (i % 25),
          endYear: null,
          primary: false,
          characterIds: [],
          placeIds: [],
        },
      ],
    });
  }
  for (let i = 0; i < 100; i++) {
    put('eraStates', { _id: `ERA${i}`, name: `Era ${i}`, startYear: 2000 + i, endYear: 2000 + i });
  }
  expect(n).toBe(5000);
  return m;
}

function worst(fn: () => unknown): number {
  fn();
  let max = 0;
  for (let i = 0; i < 5; i++) {
    const t = performance.now();
    fn();
    max = Math.max(max, performance.now() - t);
  }
  return max;
}

describe('NF-1 timeline queries with 5,000 entries', () => {
  const model = bigModel();
  test('NF-1 everyoneIn completes under 100 ms', () => {
    expect(everyoneIn(model, 2050).rows).toHaveLength(2000);
    expect(worst(() => everyoneIn(model, 2050))).toBeLessThan(100);
    expect(worst(() => everyoneIn(model, { year: 2050, month: 6, day: 1 }))).toBeLessThan(100);
  });
  test('NF-1 livedThrough completes under 100 ms', () => {
    expect(livedThrough(model, 'C1', 2060)!.events.length).toBeGreaterThan(0);
    expect(worst(() => livedThrough(model, 'C1', 2060))).toBeLessThan(100);
  });
  test('NF-1 eventsUpTo completes under 100 ms', () => {
    expect(eventsUpTo(model, 2060).length).toBeGreaterThan(1000);
    expect(worst(() => eventsUpTo(model, 2060))).toBeLessThan(100);
    expect(worst(() => eventsUpTo(model, 2060, 10))).toBeLessThan(100);
  });
  test('NF-1 eraFor and the filtered timeline chart complete under 100 ms', () => {
    expect(worst(() => eraFor(model, 2050))).toBeLessThan(100);
    expect(
      worst(() => filterChart(timelineChart(model), { ...NO_FILTERS, familyId: 'F1' })),
    ).toBeLessThan(100);
  });
});
