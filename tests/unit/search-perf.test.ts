import { performance } from 'node:perf_hooks';
import { describe, expect, test } from 'vitest';
import { bibleHandlers } from '../../src/main/ipc/bibleHandlers';
import type { OpenBible } from '../../src/main/db/session';
import { ReadModel } from '../../src/main/readmodel';
import { SearchIndex } from '../../src/main/search';

const at = '2026-01-15T09:00:00.000Z';
const WORDS = (
  'rain kitchen letter window harbor lantern ferry orchard mooncake candle river station ' +
  'garden stairs radio bridge thread paper salt winter morning cousin train clock door'
).split(' ');
const word = (i: number) => WORDS[i % WORDS.length]!;
const sentence = (i: number, n: number) =>
  Array.from({ length: n }, (_, k) => word(i * 7 + k * 3)).join(' ');
const ZH = ['晓曦', '周美玲', '团圆', '外婆', '月饼', '广州', '上海', '饺子'];

/** SR-1: 5,000 entries, 100 of them chapters with a page of text each, in English and Chinese. */
function bigBible(): OpenBible {
  const model = new ReadModel();
  const base = (id: string, title: string) => ({
    _id: id,
    title,
    body: '',
    status: i3(id),
    provenance: 'invented',
    tags: [],
    createdAt: at,
    modifiedAt: at,
  });
  const i3 = (id: string) => ['canon', 'planned', 'idea'][id.length % 3]!;
  let n = 0;
  const put = (c: string, d: Record<string, unknown> & { _id: string }) => {
    model.put(c, d);
    n += 1;
  };
  for (let i = 0; i < 1900; i++) {
    put('characters', {
      ...base(`C${i}`, `Person ${i} ${ZH[i % ZH.length]}`),
      body: sentence(i, 12),
      names: { full: `Person ${i}`, chinese: ZH[i % ZH.length], nicknames: [word(i)] },
      birth: { year: 1900 + (i % 180) },
      death: i % 3 === 0 ? { year: 1960 + (i % 120) } : null,
      familyIds: [`F${i % 5}`],
      tags: i % 10 === 0 ? ['keeper'] : [],
    });
  }
  for (let i = 0; i < 1500; i++) {
    put('worldEvents', {
      ...base(`E${i}`, `Event ${i} ${word(i)}`),
      body: sentence(i, 20),
      start: { year: 1950 + (i % 150) },
      end: i % 4 === 0 ? { year: 1955 + (i % 150) } : null,
      reality: 'invented',
      categoryId: 'technology',
      regions: [],
      placeIds: [`P${i % 50}`],
      characterIds: [],
      formative: false,
    });
  }
  for (let i = 0; i < 100; i++) {
    put('chapters', {
      ...base(`CH${i}`, `Chapter ${i}`),
      readingOrder: i + 1,
      manuscriptText: `<p>${sentence(i, 400)} ${ZH[i % ZH.length]}</p>`,
      strands: [
        {
          id: `S${i}`,
          label: 'present',
          startYear: 2025 + (i % 75),
          endYear: null,
          primary: true,
          characterIds: [`C${i}`],
          placeIds: [`P${i % 50}`],
        },
      ],
    });
  }
  for (let i = 0; i < 300; i++) {
    put('glossaryTerms', {
      ...base(`G${i}`, `Term ${i}`),
      characters: `${ZH[i % ZH.length]}${ZH[(i + 1) % ZH.length]}`,
      romanization: `xiǎo${i % 9}xī`,
      language: 'mandarin',
      meaning: sentence(i, 4),
    });
  }
  for (let i = 0; i < 50; i++) {
    put('places', {
      ...base(`P${i}`, `Place ${i} ${word(i)}`),
      parentId: i % 5 ? `P${i - (i % 5)}` : null,
      descriptions: [],
    });
  }
  for (let i = 0; i < 100; i++) {
    put('briefs', {
      ...base(`B${i}`, `Brief ${i}`),
      storyYear: 2025 + (i % 70),
      content: sentence(i, 150),
    });
  }
  const sections = [
    ['customEntries', 'Recipe'],
    ['facts', 'Fact'],
    ['openQuestions', 'Question'],
    ['themes', 'Theme'],
  ] as const;
  for (let i = 0; n < 5000; i++) {
    const [c, label] = sections[i % sections.length]!;
    put(c, {
      ...base(`X${i}`, `${label} ${i} ${word(i)}`),
      body: sentence(i, 25),
      ...(c === 'customEntries' ? { sectionId: 'S', values: { note: sentence(i, 8) } } : {}),
    });
  }
  expect(n).toBe(5000);
  const search = new SearchIndex();
  search.rebuild(model);
  return { model, search } as unknown as OpenBible;
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

describe('SR-1 search with 5,000 entries', () => {
  const bible = bigBible();
  const search = bibleHandlers(() => bible)['search.query'];
  const query = (q: string, filters = {}) =>
    search({ query: q, filters, limit: 20 }) as { total: number };

  test('SR-1 a common word, a rare word, and a Chinese term each return under 200 ms', () => {
    expect(query('rain').total).toBeGreaterThan(500);
    expect(worst(() => query('rain'))).toBeLessThan(200);
    expect(query('Person 1234').total).toBeGreaterThan(0);
    expect(worst(() => query('Person 1234'))).toBeLessThan(200);
    expect(query('晓曦').total).toBeGreaterThan(100);
    expect(worst(() => query('晓曦'))).toBeLessThan(200);
    expect(worst(() => query('xiaoxi'))).toBeLessThan(200);
  });

  test('SR-1 a phrase that falls back to any word returns under 200 ms', () => {
    expect(worst(() => query('rain kitchen zzzunknown'))).toBeLessThan(200);
  });

  test('SR-2 every filter at once returns under 200 ms', () => {
    const filters = {
      sections: ['characters', 'chapters', 'worldEvents'] as never,
      status: ['canon', 'planned'] as never,
      provenance: ['invented'] as never,
      familyId: 'F1',
      placeId: 'P5',
      yearFrom: 1950,
      yearTo: 2100,
    };
    expect(worst(() => query('rain', filters))).toBeLessThan(200);
    expect(
      worst(() => query('person', { familyId: 'F2', yearFrom: 1990, yearTo: 2000 })),
    ).toBeLessThan(200);
    expect(worst(() => query('rain', { tag: 'keeper', placeId: 'P5' }))).toBeLessThan(200);
  });
});
