import { entrySchemas } from '../../src/shared/schema';
import type { EntryCollection } from '../../src/shared/schema';
import { generatedTree } from './generatedTree';

/**
 * NF-1 and T-6: the data volume the spec names, 5,000 entries and 100
 * chapters, with chapter text, strands, moments (SM-3: a "Lives in" for
 * every person and the beats that were), world events, era states, and places. Its 1,200 characters are the
 * 200-person, six-generation tree from `generatedTree` plus 1,000 people with
 * no known parents, all in the five families, so the tree redraw in
 * tests/e2e/perf.spec.ts is measured inside this bible with every one of
 * them drawn. Every document is parsed by its zod schema, so
 * what is loaded is exactly what the app would store. Deterministic: the
 * same call returns the same documents.
 */
type Doc = { _id: string } & Record<string, unknown>;

export const BIG = { entries: 5000, chapters: 100, treePeople: 200, characters: 1200 } as const;

const AT = '2026-01-15T09:00:00.000Z';
const WORDS = (
  'rain kitchen letter window harbor lantern ferry orchard mooncake candle river station ' +
  'garden stairs radio bridge thread paper salt winter morning cousin train clock door ' +
  'archive tide market ledger photograph courtyard balcony typhoon dumpling umbrella'
).split(' ');
const ZH = ['晓曦', '周美玲', '团圆', '外婆', '月饼', '广州', '上海', '饺子'];
const word = (i: number) => WORDS[i % WORDS.length]!;
const sentence = (i: number, n: number) =>
  Array.from({ length: n }, (_, k) => word(i * 7 + k * 3)).join(' ');
const CATEGORIES = [
  'geopolitics',
  'technology',
  'economy',
  'environment',
  'demographics',
  'culture',
];
const STATUSES = ['canon', 'planned', 'idea'] as const;

const base = (id: string, title: string, i: number) => ({
  _id: id,
  title,
  status: STATUSES[i % 3]!,
  createdAt: AT,
  modifiedAt: AT,
});

/** Every collection of the generated bible, parsed by its schema. */
export function bigBibleDocs(): Record<EntryCollection, Doc[]> {
  const out = {} as Record<EntryCollection, Doc[]>;
  const put = (c: EntryCollection, d: Doc) => {
    (out[c] ??= []).push(entrySchemas[c].parse(d) as Doc);
  };

  for (let i = 0; i < 5; i++) {
    put('families', {
      ...base(`FAM${i}`, `Family ${i}`, i),
      name: `Family ${i}`,
      color: ['#2a78d6', '#eb6834', '#1baf7a', '#4a3aa7'][i % 4],
    });
  }
  for (let i = 0; i < 4; i++) {
    put('parts', { ...base(`PT${i}`, `Part ${i + 1}`, i), number: i + 1 });
  }
  for (let i = 0; i < 60; i++) {
    put('places', {
      ...base(`PLC${i}`, `Place ${i} ${word(i)}`, i),
      parentId: i % 6 ? `PLC${i - (i % 6)}` : null,
      descriptions: [{ startYear: null, endYear: null, text: sentence(i, 12) }],
    });
  }

  // The FT-8 tree: 200 people across six generations, in the five families.
  const tree = generatedTree(BIG.treePeople, 6);
  tree.characters.forEach((c, i) =>
    put('characters', { ...c, modifiedAt: AT, familyIds: [`FAM${i % 5}`] }),
  );
  for (const u of tree.unions) put('unions', { ...u, modifiedAt: AT });
  for (const l of tree.parentLinks) {
    put('parentLinks', { ...l, modifiedAt: AT });
  }
  for (let i = 0; i < 1000; i++) {
    const born = 1900 + (i % 180);
    put('characters', {
      ...base(`C${i}`, `Person ${i} ${ZH[i % ZH.length]}`, i),
      body: sentence(i, 15),
      names: { full: `Person ${i}` },
      birth:
        i % 97 === 0 ? { unknown: true } : { year: born, month: 1 + (i % 12), day: 1 + (i % 28) },
      death: i % 3 === 0 ? { year: born + 60 + (i % 30) } : null,
      familyIds: [`FAM${i % 5}`],
      tags: i % 10 === 0 ? ['keeper'] : [],
    });
  }
  const people = out.characters.map((c) => c._id);
  // SM-3: where each person lives, as a "Lives in" moment.
  for (let i = 0; i < 1000; i++) {
    put('moments', {
      ...base(`LV${i}`, `Lives in Place ${i % 60} ${word(i % 60)}`, i),
      characterId: people[i]!,
      year: 1900 + (i % 180),
      endYear: null,
    });
  }

  for (let i = 0; i < BIG.chapters; i++) {
    put('chapters', {
      ...base(`CH${i}`, `Chapter ${i + 1}`, i),
      partId: `PT${i % 4}`,
      readingOrder: i + 1,
      written: i < 40,
      manuscriptText: Array.from(
        { length: 8 },
        (_, p) => `<p>${sentence(i * 8 + p, 75)} ${ZH[(i + p) % ZH.length]}</p>`,
      ).join(''),
      summary: sentence(i, 30),
      strands: [
        {
          id: `CH${i}-present`,
          label: 'present',
          startYear: 2025 + (i % 75),
          endYear: null,
          primary: true,
          povCharacterId: people[(i * 3) % people.length]!,
          characterIds: [0, 1, 2, 3].map((k) => people[(i * 11 + k) % people.length]!),
          placeIds: [`PLC${i % 60}`],
        },
        {
          id: `CH${i}-past`,
          label: 'backstory',
          startYear: 1990 + (i % 30),
          endYear: 1991 + (i % 30),
          primary: false,
          characterIds: [people[(i * 5) % people.length]!],
          placeIds: [`PLC${(i + 7) % 60}`],
        },
      ],
    });
  }
  // SM-3: the moments of the characters' lives, as the plot beats were.
  for (let i = 0; i < 400; i++) {
    put('moments', {
      ...base(`BT${i}`, `Beat ${i} ${word(i)}`, i),
      characterId: people[(i * 13) % people.length]!,
      year: 2025 + (i % 75),
      endYear: null,
      body: sentence(i, 18),
      worldContext: sentence(i + 3, 8),
    });
  }
  for (let i = 0; i < 16; i++) {
    put('eraStates', {
      ...base(`ERA${i}`, `Era ${2025 + i * 5}`, i),
      name: `Era ${2025 + i * 5}`,
      startYear: 2025 + i * 5,
      endYear: 2029 + i * 5,
      body: `${sentence(i, 10)} ${sentence(i + 1, 10)}`,
    });
  }
  for (let i = 0; i < 150; i++) {
    put('glossaryTerms', {
      ...base(`GL${i}`, `${ZH[i % ZH.length]}${i}`, i),
      characters: `${ZH[i % ZH.length]}${ZH[(i + 1) % ZH.length]}`,
      romanization: 'xiǎoxī',
      language: 'mandarin',
      meaning: sentence(i, 4),
    });
  }
  for (let i = 0; i < 60; i++) {
    put('openQuestions', {
      ...base(`Q${i}`, `Question ${i}`, i),
      question: `${sentence(i, 10)}?`,
      state: i % 3 ? 'open' : 'decided',
      decision: i % 3 ? '' : sentence(i, 6),
    });
  }
  // World events fill the rest, so the total is exactly 5,000.
  const sofar = Object.values(out).reduce((n, docs) => n + docs.length, 0);
  for (let i = 0; i < BIG.entries - sofar; i++) {
    const year = 1900 + (i % 200);
    put('worldEvents', {
      ...base(`E${i}`, `Event ${i} ${word(i)}`, i),
      body: sentence(i, 20),
      start: i % 5 === 0 ? { year, month: 1 + (i % 12), day: 1 + (i % 28) } : { year },
      end: i % 4 === 0 ? { year: year + 1 + (i % 6) } : null,
      categoryId: CATEGORIES[i % CATEGORIES.length]!,
      regions: [],
      characterIds: [people[i % people.length]!],
      formative: i % 10 === 0,
    });
  }
  return out;
}

/** The total count, for asserting the volume really is the spec's. */
export function countEntries(docs: Record<string, Doc[]>): number {
  return Object.values(docs).reduce((n, d) => n + d.length, 0);
}

/** Median of the samples. */
export function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}
