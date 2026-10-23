import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  CAPTURE_SECTIONS,
  DEFAULT_THRESHOLDS,
  LEXICON,
  WRITING_STRAND,
  buildIndex,
  decide,
  parse,
  parseYears,
  resolve,
  routeCapture,
  splitSentences,
  labelParts,
  titleFrom,
} from '../../src/shared/domain/captureRouter';
import type {
  CaptureFact,
  RouteOptions,
  RouterIndex,
  RouterIndexInput,
} from '../../src/shared/domain/captureRouter';
import { entrySchemas } from '../../src/shared/schema';

const ROOT = join(import.meta.dirname, '../..');
const ROUTER_DIR = join(ROOT, 'src/shared/domain/captureRouter');

const MARK = '01M4MG30PDPAK8SJ5CQF1Y04RT';
const DAWN = '01M4MG379QE60CNG2GM5A7VQNB';
const SYDNEY = '01M4MG30PCH00CCJPNZT7M1H2Q';
const HUSBAND = '01M4PC5VFY7HMQXWY1470XTTP9';
const QIN = '01M4MG379QE60CNG2GM5A7VQMY';
const SIYUAN = '01M4MG379P82F2K84YPS1SWJCJ';

function sliceInput(): RouterIndexInput {
  return JSON.parse(
    readFileSync(join(ROOT, 'fixtures/capture/eastwinds-slice.json'), 'utf8'),
  ) as RouterIndexInput;
}
const INDEX: RouterIndex = buildIndex(sliceInput());
const OPTS: RouteOptions = { storyYear: 2066 };

const one = (text: string, options: Partial<RouteOptions> = {}): CaptureFact => {
  const facts = routeCapture(text, INDEX, { ...OPTS, ...options }).facts;
  expect(facts).toHaveLength(1);
  return facts[0]!;
};
const mainDraft = (f: CaptureFact) =>
  f.drafts.find((d) => d.op === 'create' && d.collection === f.section)?.data ?? {};
const ids = (f: CaptureFact, kind: string) =>
  f.candidates.filter((c) => c.kind === kind).map((c) => c.id);

describe('CR-1 routing is local and pure', () => {
  test('CR-1 the router imports no Electron, MongoDB, React or main-process code', () => {
    for (const file of readdirSync(ROUTER_DIR)) {
      const src = readFileSync(join(ROUTER_DIR, file), 'utf8');
      const imports = [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
      for (const i of imports) {
        expect(i, `${file} imports ${i}`).not.toMatch(/electron|mongodb|react|\/main\//);
      }
    }
  });

  test('CR-1 the same text and index give the same routing every time', () => {
    const text =
      "In 2063 the second crash hits. Qin's drone factory loses its export license. Xuan takes a Party job in Beijing.";
    const a = routeCapture(text, buildIndex(sliceInput()), OPTS);
    const b = routeCapture(text, buildIndex(sliceInput()), OPTS);
    expect(a).toEqual(b);
    expect(a.text).toBe(text);
    expect(a.storyYear).toBe(2066);
    expect(a.facts.map((f) => f.index)).toEqual([0, 1, 2]);
  });

  test('CR-1 CR-3 buildIndex gives characters their full, first, Chinese and lexicon names', () => {
    const qin = INDEX.characters.find((c) => c.id === QIN)!;
    expect(qin.aliases).toEqual(expect.arrayContaining(['li qin', 'qin', '李勤']));
    const siyuan = INDEX.characters.find((c) => c.id === SIYUAN)!;
    expect(siyuan.aliases).toEqual(
      expect.arrayContaining(['li siyuan', 'siyuan', '李思源', '思源']),
    );
    const dawn = INDEX.characters.find((c) => c.id === DAWN)!;
    expect(dawn.aliases).toEqual(expect.arrayContaining(['dawn li', 'dawn', '李晓曦', '晓曦']));
    expect(dawn.aliases).not.toContain('li');
    const wangan = INDEX.characters.find((c) => c.name === "Wang'an")!;
    expect(wangan.aliases).toEqual(expect.arrayContaining(["wang'an", 'wangan', '望安']));
    const husband = INDEX.characters.find((c) => c.id === HUSBAND)!;
    expect(husband.aliases).toEqual(expect.arrayContaining(["sydney's husband"]));
    expect(husband.aliases).not.toContain("sydney's");
  });

  test('CR-1 CR-3 buildIndex carries places with their community, and lists with lexicon words', () => {
    const jinan = INDEX.places.find((p) => p.name === 'Jinan')!;
    expect(jinan.communityId).toBe('jinan-shandong');
    expect(INDEX.places.find((p) => p.name === 'Shandong province')!.aliases).toContain('shandong');
    const china = INDEX.communities.find((c) => c.id === 'china-national')!;
    expect(china.aliases).toEqual(expect.arrayContaining(['china (national)', 'china', 'beijing']));
    expect(china.demonyms).toEqual(['chinese']);
    expect(INDEX.categories.find((c) => c.id === 'economy')!.cues).toContain('crash');
    expect(INDEX.ageGroups.map((a) => a.id)).not.toContain('all');
    expect(INDEX.ageGroups.find((a) => a.id === '0-18')!.words).toContain('teenagers');
    expect(INDEX.culturalLines).toHaveLength(13);
    expect(INDEX.moments.map((m) => m.characterId)).toContain(MARK);
    expect(INDEX.glossary.map((g) => g.characters)).toContain('思源');
    expect(INDEX.timelineEnd).toBe(2100);
  });

  test('CR-1 CR-3 buildIndex leaves out trashed entries, and an item the lexicon lacks matches by label', () => {
    const input = sliceInput();
    const chars = input.entries.characters!;
    chars[0] = { ...chars[0], deletedAt: '2026-10-22T00:00:00.000Z' };
    input.lists
      .find((l) => l._id === 'communities')!
      .items.push({ id: 'portland', label: 'Portland, Oregon', parentId: null });
    const index = buildIndex(input);
    expect(index.characters.find((c) => c.name === 'Frank Sullivan')).toBeUndefined();
    const portland = index.communities.find((c) => c.id === 'portland')!;
    expect(portland.aliases).toEqual(['portland, oregon', 'portland', 'oregon']);
    expect(portland.demonyms).toEqual([]);
    const f = routeCapture('Families in Portland, Oregon start composting in 2070', index, OPTS)
      .facts[0]!;
    // The place Oregon comes first (a place's community leads), then the label match.
    expect(f.communities).toEqual([
      { id: 'pacific-states-ca-or-wa', why: 'the place Oregon' },
      { id: 'portland', why: 'named as "portland, oregon"' },
    ]);
  });

  test('CR-1 routing a capture on a bible of a few hundred entries is fast', () => {
    const input = sliceInput();
    const chars = input.entries.characters!;
    const places = input.entries.places!;
    for (let i = 0; i < 300; i++) {
      chars.push({ ...chars[0], _id: `c${i}`, names: { full: `Person${i} Example${i}` } });
      places.push({ ...places[0], _id: `p${i}`, title: `Placename ${i}` });
    }
    const t0 = performance.now();
    const index = buildIndex(input);
    for (let i = 0; i < 20; i++) {
      routeCapture(
        "In 2063 the second crash hits. Qin's drone factory loses its export license. Chinese people in San Francisco begin to say yee haw ironically starting around 2065",
        index,
        OPTS,
      );
    }
    const per = (performance.now() - t0) / 20;
    expect(per).toBeLessThan(50);
  });
});

describe('CR-2 facts and years', () => {
  test('CR-2 a capture splits into sentences on . ! ? before a capital or a Chinese character, and on a line break', () => {
    expect(
      splitSentences('In 2063 the crash hits. Qin loses his job! Is Xuan next? 望安 leaves.'),
    ).toEqual(['In 2063 the crash hits.', 'Qin loses his job!', 'Is Xuan next?', '望安 leaves.']);
    expect(splitSentences('Mark moves\nDawn stays')).toEqual(['Mark moves', 'Dawn stays']);
    expect(splitSentences('Mr. Li moves to Jinan. it rains. Then J. Smith arrives.')).toEqual([
      'Mr. Li moves to Jinan. it rains.',
      'Then J. Smith arrives.',
    ]);
    expect(splitSentences('   ')).toEqual([]);
  });

  test('CR-2 "starting around", "from", "after", "in" and a bare year set the start and leave the end open', () => {
    for (const t of [
      'starting around 2065',
      'from 2065',
      'after 2065',
      'in 2065',
      'around 2065 or so',
      'yes 2065',
    ]) {
      expect(parseYears(`people do it ${t}`), t).toMatchObject({ start: 2065, end: null });
    }
    expect(parseYears('nothing here')).toBeNull();
  });

  test('CR-2 "by 2070" and "by the 2070s" set the start and leave the end open', () => {
    expect(parseYears('they joke about it by 2070')).toMatchObject({ start: 2070, end: null });
    expect(parseYears('they joke about it by the 2070s')).toMatchObject({ start: 2070, end: null });
  });

  test('CR-2 "until", "through" and "to" set the end', () => {
    expect(parseYears('they do it from 2060 until 2070')).toMatchObject({ start: 2060, end: 2070 });
    expect(parseYears('they do it until 2070')).toMatchObject({ start: null, end: 2070 });
    expect(parseYears('in 2061, and it lasts through 2064')).toMatchObject({
      start: 2061,
      end: 2064,
    });
    const [s] = parse('They wear red until 2070', 2066);
    expect(s!.years).toEqual({
      start: 2066,
      end: 2070,
      source: 'an end year in the text; the start is the story year',
    });
  });

  test('CR-2 "the 2060s" is 2060 to 2069 and "2063 to 2066" is a span', () => {
    expect(parseYears('in the 2060s kids say it')).toMatchObject({ start: 2060, end: 2069 });
    expect(parseYears('2063 to 2066')).toMatchObject({ start: 2063, end: 2066 });
    expect(parseYears('2063-2066')).toMatchObject({ start: 2063, end: 2066 });
    const f = one('Teenagers in Jinan say it in the 2060s');
    expect(mainDraft(f)).toMatchObject({ startYear: 2060, endYear: 2069 });
  });

  test('CR-2 a fact with no year takes the year of the fact before it, else the story year', () => {
    const facts = routeCapture(
      "In 2063 the second crash hits. Qin's drone factory loses its export license.",
      INDEX,
      OPTS,
    ).facts;
    expect(facts[0]!.years).toEqual({ start: 2063, end: null, source: 'a year in the text' });
    expect(facts[1]!.years).toEqual({
      start: 2063,
      end: null,
      source: 'the year of the sentence before',
    });
    expect(one('Dawn and Mark argue').years).toEqual({
      start: 2066,
      end: null,
      source: 'the story year',
    });
  });

  test('CR-2 a cultural line with an open end stores the timeline end; a moment stores a null end', () => {
    const line = one(
      'Chinese people in San Francisco begin to say yee haw ironically starting around 2065',
    );
    expect(line.years.end).toBeNull();
    expect(mainDraft(line)).toMatchObject({ startYear: 2065, endYear: 2100 });
    const moment = one('Mark moves to Seattle in 2061');
    expect(mainDraft(moment)).toMatchObject({ year: 2061, endYear: null });
  });

  test('CR-2 a cultural title drops the year phrase, is capitalised and cut at 90 characters', () => {
    expect(titleFrom('chinese people begin to say yee haw ironically starting around 2065')).toBe(
      'Chinese people begin to say yee haw ironically',
    );
    expect(titleFrom('In 2063 the second crash hits.')).toBe('The second crash hits');
    expect(titleFrom("Should Frank's church split over the Compact in 2075?")).toBe(
      "Should Frank's church split over the Compact?",
    );
    const long = titleFrom(`${'very '.repeat(30)}long`);
    expect(long.length).toBeLessThanOrEqual(90);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('CR-3 names resolve against the bible', () => {
  test('CR-3 names match whole words, and a match may end at an apostrophe', () => {
    expect(resolve("Mark's dog barks", INDEX).characters.map((c) => c.id)).toEqual([MARK]);
    expect(resolve('The Marked man and Markus wait', INDEX).characters).toEqual([]);
    expect(resolve('Sydney’s car', INDEX).characters.map((c) => c.id)).toEqual([SYDNEY]);
  });

  test('CR-3 characters resolve by full name, first name and Chinese name, preferring the longest alias', () => {
    expect(resolve('Li Qin smiles', INDEX).characters[0]).toMatchObject({
      id: QIN,
      matched: 'li qin',
    });
    expect(resolve('Qin smiles', INDEX).characters[0]).toMatchObject({ id: QIN, matched: 'qin' });
    expect(resolve('李思源笑了', INDEX).characters[0]).toMatchObject({
      id: SIYUAN,
      matched: '李思源',
    });
  });

  test('CR-3 a name inside a longer name is not the subject', () => {
    const husband = resolve("Sydney's husband is a Nevada state trooper", INDEX);
    expect(husband.characters.map((c) => c.id)).toEqual([HUSBAND]);
    const temple = resolve("Siyuan's temple starts hosting dinners", INDEX);
    expect(temple.characters).toEqual([]);
    expect(temple.places.map((p) => p.label)).toEqual(["Siyuan's temple"]);
    // A cue word inside a place name is not a cue: "drone" in "Qin's drone factory".
    const factory = resolve("Qin's drone factory loses its export license", INDEX);
    expect(factory.characters).toEqual([]);
    expect(factory.categories.map((c) => c.id)).toEqual(['economy']);
  });

  test('CR-3 a capitalised word mid-sentence that matches nothing is an unknown name', () => {
    const r = resolve('The Mission district becomes mostly Compact bureaucrats by 2080', INDEX);
    expect(r.unknown.map((u) => u.label)).toEqual(['Mission district']);
    expect(r.unknown[0]!.placeTail).toBe(true);
    expect(resolve('Mark meets Rosa Delgado at USC', INDEX).unknown.map((u) => u.label)).toEqual([
      'Rosa Delgado',
    ]);
    // The first word, stop words, demonyms, quoted words and known names are not unknown.
    expect(resolve('Xuan takes a Party job in Beijing', INDEX).unknown).toEqual([]);
    expect(resolve('Teenagers in Jinan admire American cars on Monday', INDEX).unknown).toEqual([]);
    expect(resolve("望安 goes by 'Wanda' at school", INDEX).unknown).toEqual([]);
  });

  test('CR-3 a demonym plus a place prefers the place community, then the diaspora, then the demonym', () => {
    const f = one(
      'Chinese people in San Francisco begin to say yee haw ironically starting around 2065',
    );
    expect(f.communities.map((c) => c.id)).toEqual([
      'san-francisco',
      'chinese-diaspora-in-california',
      'china-national',
    ]);
    expect(mainDraft(f).communityId).toBe('san-francisco');
    // The demonym stays in the title.
    expect(mainDraft(f).title).toMatch(/^Chinese people in San Francisco/);
  });

  test('CR-3 a demonym alone maps to its national community', () => {
    const f = one('Chinese parents stop sending kids abroad after 2068');
    expect(f.communities.map((c) => c.id)).toEqual(['china-national']);
    expect(ids(f, 'demonym')).toEqual(['china-national']);
  });

  test('CR-3 with nothing resolved the community is asked for, the writing strand first', () => {
    const f = one('Everyone starts wearing paper hats in 2070', {
      povCommunityId: 'san-francisco',
    });
    expect(f.section).toBe('culturalEntries');
    expect(f.communities).toEqual([{ id: 'san-francisco', why: WRITING_STRAND }]);
    expect(f.missing).toEqual(['communityId']);
    expect(f.asks).toEqual(['Community']);
    expect(mainDraft(f).communityId).toBeUndefined();
    // Asked with a chip, so it can still file from the box.
    expect(f.route).toBe('local');
    // A resolved community comes before the strand.
    const g = one('Teenagers in Jinan start wearing paper hats in 2070', {
      povCommunityId: 'san-francisco',
    });
    expect(g.communities.map((c) => c.id)).toEqual(['jinan-shandong', 'san-francisco']);
  });

  test('CR-3 communities, categories, age groups and glossary terms resolve by labels and lexicon words', () => {
    const r = resolve(
      'Pure Land kids in the Bay Area feel the recession, say I take refuge and write 叶落',
      INDEX,
    );
    expect(r.communities.map((c) => c.id)).toEqual(['pure-land-buddhism', 'san-francisco']);
    expect(r.categories.map((c) => c.id)).toEqual(['economy']);
    expect(r.ageGroups.map((a) => a.id)).toEqual(['0-18']);
    expect(r.glossary.map((g) => g.label)).toEqual(['I take refuge']);
    expect(r.cjk).toEqual(['叶落']);
    // A glossary term that is also a character's given name resolves as both.
    const s = resolve('思源 smiles', INDEX);
    expect(s.characters.map((c) => c.id)).toEqual([SIYUAN]);
    expect(s.glossary.map((g) => g.label)).toEqual(['思源']);
    expect(s.cjk).toEqual([]);
  });
});

describe('CR-4 sections score by weighted cues', () => {
  test('CR-4 the lexicon lists every cue with a section, a weight and a plain label', () => {
    expect(LEXICON.cues.length).toBeGreaterThan(20);
    for (const c of LEXICON.cues) {
      expect(CAPTURE_SECTIONS).toContain(c.section);
      expect(c.weight).toBeGreaterThan(0);
      expect(c.label.length).toBeGreaterThan(5);
      expect(!!c.words || !!c.pattern || !!c.signal, c.id).toBe(true);
    }
    for (const s of CAPTURE_SECTIONS) {
      expect(
        LEXICON.cues.some((c) => c.section === s),
        s,
      ).toBe(true);
    }
    const all = JSON.stringify(LEXICON);
    expect(all).not.toMatch(/\u2014|--/);
  });

  test('CR-4 the cues that scored are recorded per section with their labels', () => {
    const f = one(
      'Chinese people in San Francisco begin to say yee haw ironically starting around 2065',
    );
    expect(f.cues.culturalEntries).toEqual([
      'a group starts to say or do something',
      'custom or expectation words',
      'people of a country plus a place',
      'people of a country are named',
      'a community or its alias is named',
    ]);
    expect(f.scores.culturalEntries).toBe(30 + 22 + 28 + 18 + 16);
    expect(f.ranked[0]).toEqual(['culturalEntries', 114]);
    expect(f.share).toBeCloseTo(114 / 124);
    expect(f.margin).toBe(104);
  });

  test('CR-4 a question mark cuts every other section to a quarter', () => {
    const plain = one("Frank's church splits over the Compact in 2075");
    const asked = one("Should Frank's church split over the Compact in 2075?");
    expect(asked.section).toBe('openQuestions');
    expect(asked.scores.worldEvents).toBe(Math.round(plain.scores.worldEvents! * 0.25));
    expect(asked.cues.worldEvents).toContain('a question mark cuts the rest to a quarter');
  });

  test('CR-4 a character as subject halves the world event reading; no character cuts the moment reading', () => {
    const f = one('Mark moves to Seattle in 2061 for a job at a Compact logistics firm');
    expect(f.scores.worldEvents).toBe(8);
    expect(f.cues.worldEvents).toContain('a character named halves the world event');
    const g = one(
      "Siyuan's temple starts hosting Compact officials for merit-making dinners in 2070",
    );
    expect(g.scores.moments).toBe(Math.round(22 * 0.4));
  });

  test('CR-4 a group as subject halves the moment reading', () => {
    const f = one('Mark and the kids get bikes');
    const g = one('Mark gets a bike');
    expect(f.scores.moments).toBe(Math.round(g.scores.moments! * 0.5));
  });

  test('CR-4 a place as subject is a cultural cue, and nothing matched waits as a question', () => {
    const f = one(
      "Siyuan's temple starts hosting Compact officials for merit-making dinners in 2070",
    );
    expect(f.cues.culturalEntries).toContain('the line starts with a place or community');
    const g = one('blue green');
    expect(g.section).toBe('openQuestions');
    expect(g.cues.openQuestions).toEqual(['nothing matched, so it waits as a question']);
  });

  test('CR-4 Chinese characters that are a name in the bible are not a glossary cue', () => {
    expect(one("望安 goes by 'Wanda' at school").scores.glossaryTerms).toBe(10);
    const g = one('叶落归根 means returning to your roots');
    expect(g.section).toBe('glossaryTerms');
    expect(g.cues.glossaryTerms).toEqual([
      'Chinese characters that are not a name',
      'a word is explained',
    ]);
  });
});

describe('CR-5 three routes', () => {
  const base = { share: 0.6, margin: 25, reasons: [] as string[], missing: [] as string[] };

  test('CR-5 Route A needs 55% of the points, a lead of 20, no judgment flag and askable fields', () => {
    expect(decide(base)).toBe('local');
    expect(decide({ ...base, share: 0.55, margin: 20 })).toBe('local');
    expect(decide({ ...base, share: 0.54 })).toBe('fast');
    expect(decide({ ...base, margin: 19 })).toBe('fast');
    expect(decide({ ...base, reasons: ['unknown name "Rosa"'] })).toBe('fast');
    expect(decide({ ...base, missing: ['communityId', 'characterId'] })).toBe('local');
    expect(decide({ ...base, missing: ['categoryId'] })).toBe('fast');
  });

  test('CR-5 Route B needs 40%; below it is Route C, and the writer can force any route', () => {
    expect(decide({ ...base, share: 0.4, margin: 0 })).toBe('fast');
    expect(decide({ ...base, share: 0.39 })).toBe('full');
    expect(decide({ ...base, forcedRoute: 'full' })).toBe('full');
    expect(decide({ ...base, share: 0.2, forcedSection: true })).toBe('local');
    expect(decide({ ...base, share: 0.2, forcedSection: true, reasons: ['x'] })).toBe('fast');
  });

  test('CR-5 the thresholds are constants and a caller may pass others', () => {
    expect(DEFAULT_THRESHOLDS).toEqual({ localShare: 0.55, localMargin: 20, fastShare: 0.4 });
    const text = 'Mark moves to Seattle in 2061 for a job at a Compact logistics firm';
    expect(one(text).route).toBe('local');
    expect(
      one(text, { thresholds: { localShare: 0.9, localMargin: 20, fastShare: 0.4 } }).route,
    ).toBe('fast');
    expect(
      one(text, { thresholds: { localShare: 0.9, localMargin: 20, fastShare: 0.8 } }).route,
    ).toBe('full');
  });

  test('CR-5 judgment flags: an unknown name, several characters, a quoted nickname, a category, a role', () => {
    expect(one('Mark meets Rosa Delgado at USC in 2062').reasons).toContain(
      'unknown name "Rosa Delgado"',
    );
    expect(one('Dawn and Mark argue about whether to raise LiNa bilingual').reasons).toEqual([
      'a moment for each of 2 characters',
      'LiNa Sullivan is named too',
    ]);
    expect(one("望安 goes by 'Wanda' at school").reasons).toEqual([
      '"Wanda" may also be a glossary term',
    ]);
    expect(one('The Compact bans gas cars on coastal highways in 2068').reasons).toEqual([
      'category to choose: Pacific States Compact or Transportation',
    ]);
    expect(one("Sydney's husband is a Nevada state trooper").reasons).toEqual([
      'might be a role on the character rather than a moment',
    ]);
    expect(
      one('Xuan takes a Party job in Beijing, and the Li family apartment is sold').reasons,
    ).toEqual(['a second clause names Li family apartment, probably another fact']);
  });

  test('CR-5 a section under the local share or lead, with nothing else flagged, says how sure it is', () => {
    const f = one('The church opens a school in 2070');
    expect(f.share).toBeLessThan(0.55);
    expect(f.reasons).toEqual([`section only ${Math.round(f.share * 100)}% sure`]);
    expect(f.route).toBe('fast');
    const g = one("Qin's drone factory loses its export license");
    expect(g.share).toBeGreaterThanOrEqual(0.55);
    expect(g.reasons).toEqual([`section leads the next by only ${g.margin} points`]);
    expect(g.route).toBe('fast');
    // An unknown name is a flag of its own, so the share is not added.
    expect(one('Mark meets Rosa Delgado at USC in 2062').reasons).toEqual([
      'unknown name "Rosa Delgado"',
    ]);
  });

  test('CR-5 missing and asks: community and character are asked; a category is a judgment', () => {
    const moment = one('Someone learns to drive in 2070', {
      hints: [{ fact: 0, section: 'moments' }],
    });
    expect(moment.missing).toEqual(['characterId']);
    expect(moment.asks).toEqual(['Character']);
    const event = one('The war ends in 2070');
    expect(event.section).toBe('worldEvents');
    expect(event.missing).toEqual(['categoryId']);
    expect(event.asks).toEqual([]);
    expect(event.route).not.toBe('local');
  });

  test('CR-5 hints replace the section, the resolved values and the route before deciding', () => {
    const text = 'The Compact bans gas cars on coastal highways in 2068';
    const picked = one(text, { hints: [{ fact: 0, categoryId: 'transportation' }] });
    expect(picked.missing).toEqual([]);
    expect(picked.reasons).toEqual([]);
    expect(mainDraft(picked).categoryId).toBe('transportation');
    expect(picked.route).toBe('local');

    const forced = one(text, { hints: [{ fact: 0, route: 'full' }] });
    expect(forced.route).toBe('full');

    const asLine = one(text, {
      hints: [
        { fact: 0, section: 'culturalEntries', communityId: 'san-francisco', demographic: '18-30' },
        { fact: 0, startYear: 2069, endYear: 2075 },
      ],
    });
    expect(asLine.section).toBe('culturalEntries');
    expect(asLine.communities[0]).toEqual({ id: 'san-francisco', why: 'chosen by the writer' });
    expect(mainDraft(asLine)).toMatchObject({
      communityId: 'san-francisco',
      demographic: '18-30',
      startYear: 2069,
      endYear: 2075,
    });
    expect(asLine.years.source).toBe('chosen by the writer');

    const who = one('Someone learns to drive in 2070', {
      hints: [{ fact: 0, section: 'moments', characterId: MARK }],
    });
    expect(who.missing).toEqual([]);
    expect(mainDraft(who).characterId).toBe(MARK);

    // A hint for another fact changes nothing here, and a hinted start year is inherited.
    const two = routeCapture('In 2063 the crash hits. Mark moves to Seattle.', INDEX, {
      ...OPTS,
      hints: [{ fact: 0, startYear: 2064 }],
    }).facts;
    expect(two[1]!.years.start).toBe(2064);
  });

  test('CR-5 a section the writer chose skips the thresholds: A with nothing flagged, else B', () => {
    expect(one('blue green').route).toBe('full');
    const f = one('blue green', {
      hints: [{ fact: 0, section: 'culturalEntries', communityId: 'san-francisco' }],
    });
    expect(f.section).toBe('culturalEntries');
    expect(f.share).toBe(0);
    expect(f.reasons).toEqual([]);
    expect(f.route).toBe('local');
    const yee =
      'Chinese people in San Francisco begin to say yee haw ironically starting around 2065';
    const asEvent = one(yee, { hints: [{ fact: 0, section: 'worldEvents' }] });
    expect(asEvent.share).toBeLessThan(0.4);
    expect(asEvent.reasons).toEqual(['category to choose from the event categories']);
    expect(asEvent.route).toBe('fast');
    const picked = one(yee, {
      hints: [{ fact: 0, section: 'worldEvents', categoryId: 'culture' }],
    });
    expect(picked.reasons).toEqual([]);
    expect(picked.route).toBe('local');
    expect(one(yee, { hints: [{ fact: 0, section: 'worldEvents', route: 'full' }] }).route).toBe(
      'full',
    );
    expect(decide({ share: 0, margin: 0, reasons: [], missing: [], forcedSection: true })).toBe(
      'local',
    );
    expect(decide({ share: 0, margin: 0, reasons: ['x'], missing: [], forcedSection: true })).toBe(
      'fast',
    );
  });
});

describe('CR-5 CR-6 drafts in the shape of a proposal', () => {
  const SYSTEM = {
    _id: '01TESTDRAFT0000000000000000',
    createdAt: '2026-10-22T00:00:00.000Z',
    modifiedAt: '2026-10-22T00:00:00.000Z',
  };
  const valid = (f: CaptureFact) => {
    for (const d of f.drafts) {
      if (d.op !== 'create') continue;
      const r = entrySchemas[d.collection!].safeParse({ ...SYSTEM, ...d.data });
      expect(r.success, `${d.collection}: ${r.error?.message ?? ''}`).toBe(true);
    }
  };

  test('CR-5 cultural data drafts carry title, community, age group, years, body and status idea', () => {
    const f = one('Teenagers in Jinan treat an American college degree as a joke by the 2070s');
    expect(f.drafts).toEqual([
      {
        op: 'create',
        collection: 'culturalEntries',
        data: {
          title: 'Teenagers in Jinan treat an American college degree as a joke',
          communityId: 'jinan-shandong',
          demographic: '0-18',
          startYear: 2070,
          endYear: 2100,
          body: 'Teenagers in Jinan treat an American college degree as a joke by the 2070s',
          status: 'idea',
        },
      },
    ]);
    valid(f);
  });

  test('CR-5 a moment is one per character, titled "Lives in" for a move', () => {
    const f = one('Mark moves to Seattle in 2061 for a job at a Compact logistics firm');
    expect(f.drafts).toHaveLength(1);
    expect(f.drafts[0]!.data).toMatchObject({
      characterId: MARK,
      year: 2061,
      endYear: null,
      title: 'Lives in Seattle',
      status: 'idea',
    });
    valid(f);
    const g = one('Dawn and Mark argue about whether to raise LiNa bilingual');
    expect(g.drafts.map((d) => d.data?.characterId)).toEqual([DAWN, MARK]);
    expect(ids(g, 'character')).toHaveLength(3);
    const h = one("望安 goes by 'Wanda' at school");
    expect(h.drafts.map((d) => d.collection)).toEqual(['moments', 'glossaryTerms']);
    expect(h.drafts[1]!.data).toMatchObject({ characters: 'Wanda', language: 'english' });
    valid(h);
  });

  test('CR-5 SM-3 A51 a move drafts its Lives in moment with the kind move, when the bible has that kind', () => {
    const input = sliceInput();
    input.lists.push({
      _id: 'momentKinds',
      items: [
        { id: 'move', label: 'Moves' },
        { id: 'life', label: 'Life event' },
      ],
    });
    const withKinds = buildIndex(input);
    const text = 'Mark moves to Seattle in 2061 for a job at a Compact logistics firm';
    const [f] = routeCapture(text, withKinds, OPTS).facts;
    expect(f!.drafts[0]!.data).toMatchObject({ title: 'Lives in Seattle', kind: 'move' });
    valid(f!);
    // Not a move: no kind.
    const [g] = routeCapture(
      'Dawn and Mark argue about whether to raise LiNa bilingual',
      withKinds,
      OPTS,
    ).facts;
    expect(g!.drafts.every((d) => d.data?.kind === undefined)).toBe(true);
    // A bible with no Moves kind drafts the move with no kind.
    expect(one(text).drafts[0]!.data?.kind).toBeUndefined();
  });

  test('CR-5 a world event has start, end, the one category cued, and regions as item IDs or new items', () => {
    const f = one('In 2063 the second crash hits');
    expect(f.drafts[0]!.data).toMatchObject({
      title: 'The second crash hits',
      start: { year: 2063 },
      end: null,
      categoryId: 'economy',
      regions: [],
    });
    valid(f);
    const g = one('A recession hits Jinan and Taiwan from 2063 to 2065');
    const event = g.drafts.find((d) => d.collection === 'worldEvents')!;
    expect(event.data).toMatchObject({ start: { year: 2063 }, end: { year: 2065 } });
    // Jinan has no region item, so it takes China's; Taiwan has its own.
    expect(event.data?.regions).toEqual(['china', 'taiwan']);
    const h = one('A recession hits Japan in 2063');
    expect(h.drafts[0]).toEqual({
      op: 'listAdd',
      listId: 'regions',
      label: 'Japan',
      parentId: null,
      ref: 'new:japan',
    });
    expect(h.drafts[1]!.data?.regions).toEqual(['new:japan']);
    valid(h);
  });

  test('CR-5 a place takes the new name, the larger place it names, and a community', () => {
    const f = one('The Mission district in San Francisco is a neighborhood of murals');
    expect(f.section).toBe('places');
    expect(f.drafts[0]!.data).toMatchObject({
      title: 'Mission district',
      parentId: 'pl-san-francisco',
      communityId: 'san-francisco',
    });
    valid(f);
  });

  test('CR-5 a glossary term, an open question and a character draft as their schemas want', () => {
    const g = one('叶落归根 means returning to your roots');
    expect(g.drafts[0]!.data).toMatchObject({ characters: '叶落归根', language: 'mandarin' });
    valid(g);
    const q = one("Should Frank's church split over the Compact in 2075?");
    expect(q.drafts[0]!.data).toMatchObject({
      title: "Should Frank's church split over the Compact?",
      question: "Should Frank's church split over the Compact in 2075?",
      tags: ['capture'],
      status: 'idea',
    });
    valid(q);
    const c = one('New character: a woman named Rosa Delgado runs the bakery');
    expect(c.section).toBe('characters');
    expect(c.drafts[0]!.data).toMatchObject({
      title: 'Rosa Delgado',
      names: { full: 'Rosa Delgado' },
    });
    valid(c);
  });

  test('CR-5 every draft of the twelve lines passes its entry schema once the system fields are added', () => {
    const lines = (
      JSON.parse(readFileSync(join(ROOT, 'fixtures/capture/examples.json'), 'utf8')) as {
        lines: { text: string }[];
      }
    ).lines;
    for (const { text } of lines) {
      for (const f of routeCapture(text, INDEX, OPTS).facts) {
        if (f.missing.length) continue;
        valid(f);
      }
    }
  });
});

describe('A48 review fixes', () => {
  test('CR-2 "before 2070" ends the year before and takes the start it inherits', () => {
    expect(parseYears('before 2070')).toMatchObject({ start: null, end: 2069 });
    expect(parseYears('before the 2070s')).toMatchObject({ start: null, end: 2069 });
    const f = one('Kids in Jinan stop wearing masks before 2070');
    expect(mainDraft(f)).toMatchObject({ startYear: 2066, endYear: 2069 });
    expect(f.years.source).toBe(
      '"before" a year in the text, taken as the end the year before; the start is the story year',
    );
  });

  test('CR-2 an inherited start is named in the source when the sentence gives only an end', () => {
    const facts = routeCapture(
      'In 2060 the crash hits. Kids in Jinan wear masks until 2064.',
      INDEX,
      OPTS,
    ).facts;
    expect(facts[1]!.years).toEqual({
      start: 2060,
      end: 2064,
      source: 'an end year in the text; the start is the year of the sentence before',
    });
  });

  test('CR-2 "early", "mid" and "late" before a decade leave a clean title and the whole decade', () => {
    const f = one('Kids in Jinan wear masks in the late 2060s');
    expect(mainDraft(f)).toMatchObject({
      title: 'Kids in Jinan wear masks',
      startYear: 2060,
      endYear: 2069,
    });
    expect(titleFrom('Kids wear masks by the mid-2070s')).toBe('Kids wear masks');
  });

  test('CR-5 a range that runs backwards or a year past the timeline goes to Route B', () => {
    const until = one('Kids in Jinan wear masks until 2060');
    expect(until.years).toMatchObject({ start: 2066, end: 2060 });
    expect(until.reasons).toContain('the end year comes before the start');
    expect(until.route).toBe('fast');
    const back = one('Kids in Jinan wear masks from 2070 to 2065');
    expect(back.reasons).toContain('the end year comes before the start');
    expect(back.route).toBe('fast');
    const late = one('Kids in Jinan wear masks in 2150');
    expect(late.reasons).toContain("the year is after the timeline's end");
    expect(late.route).toBe('fast');
    const hinted = one('Kids in Jinan wear masks in 2070', {
      hints: [{ fact: 0, startYear: 2080, endYear: 2070 }],
    });
    expect(hinted.reasons).toContain('the end year comes before the start');
    expect(hinted.route).toBe('fast');
    expect(one('Kids in Jinan wear masks in 2070').route).toBe('local');
  });

  test('CR-5 a second person a moment would leave out is flagged', () => {
    const wed = one('Dawn Li marries Mark Sullivan in 2060');
    expect(wed.drafts.map((d) => d.data?.characterId)).toEqual([DAWN]);
    expect(wed.reasons).toEqual(['Mark Sullivan is named too']);
    expect(wed.route).toBe('fast');
    const moves = one('In the 2060s, Mark moves to Seattle and Dawn moves to Jinan');
    expect(moves.reasons).toEqual([
      'Dawn Li is named too',
      'a second clause names Dawn Li, probably another fact',
    ]);
    expect(moves.route).toBe('fast');
    // "and" between two subjects before the verb is not a second clause.
    expect(one("Frank and Frank's father argue in 2062").reasons).toEqual([
      'a moment for each of 2 characters',
    ]);
  });

  test('CR-3 CR-5 a capitalised first word the bible lacks, before a life verb, is an unknown name', () => {
    const f = one('Rosa meets Mark in 2062');
    expect(f.section).toBe('moments');
    expect(f.reasons).toEqual(['unknown name "Rosa"']);
    expect(f.route).toBe('fast');
    expect(f.candidates).toContainEqual({
      kind: 'unknown',
      id: null,
      label: 'Rosa',
      matched: 'rosa',
    });
    expect(one('Rosa and Mark argue in 2062').reasons).toContain('unknown name "Rosa"');
    const teens = one('Teenagers in Jinan treat an American college degree as a joke by the 2070s');
    expect(teens.reasons).toEqual([]);
    expect(teens.route).toBe('local');
    expect(one('Mark gets a bike in 2062').route).toBe('local');
  });

  test('CR-3 a place with no community takes the community of its nearest larger place', () => {
    const f = one('Chinese people in Seattle start bowing in 2070');
    expect(f.communities.map((c) => c.id)).toEqual([
      'pacific-states-ca-or-wa',
      'chinese-diaspora-in-california',
      'china-national',
    ]);
    expect(f.communities[0]!.why).toBe('the place Seattle, in Washington State');
    expect(mainDraft(f).communityId).toBe('pacific-states-ca-or-wa');
  });

  test('CR-5 a hinted ID the index lacks is ignored and said', () => {
    const f = one('Kids in Jinan wear masks in 2070', {
      hints: [{ fact: 0, communityId: 'atlantis', demographic: 'toddlers' }],
    });
    expect(mainDraft(f)).toMatchObject({ communityId: 'jinan-shandong', demographic: '0-18' });
    expect(f.communities.map((c) => c.id)).not.toContain('atlantis');
    expect(f.reasons).toEqual([
      'the community picked is not in the list',
      'the age group picked is not in the list',
    ]);
    const g = one('The war ends in 2070', { hints: [{ fact: 0, categoryId: 'nope' }] });
    expect(mainDraft(g).categoryId).toBeUndefined();
    expect(g.reasons).toContain('the category picked is not in the list');
    const h = one('Someone learns to drive in 2070', {
      hints: [{ fact: 0, section: 'moments', characterId: 'nobody' }],
    });
    expect(mainDraft(h).characterId).toBeUndefined();
    expect(h.reasons).toContain('the character picked is not in the bible');
  });

  test('CR-3 a first name that is an English word matches only with a capital', () => {
    const mark = INDEX.characters.find((c) => c.id === MARK)!;
    expect(mark.capitalOnly).toEqual(['mark']);
    expect(INDEX.characters.find((c) => c.id === DAWN)!.capitalOnly).toEqual(['dawn']);
    expect(INDEX.characters.find((c) => c.id === QIN)!.capitalOnly).toEqual([]);
    expect(resolve('They mark the holiday with lanterns in 2070', INDEX).characters).toEqual([]);
    expect(resolve('mark moves to seattle', INDEX).characters).toEqual([]);
    expect(resolve('mark sullivan moves to seattle', INDEX).characters.map((c) => c.id)).toEqual([
      MARK,
    ]);
    expect(resolve('Mark moves to Seattle', INDEX).characters.map((c) => c.id)).toEqual([MARK]);
  });

  test('CR-3 "U.S." is not two unknown names', () => {
    const f = one('The U.S. bans cars in 2070.');
    expect(f.candidates.filter((c) => c.kind === 'unknown')).toEqual([]);
    expect(f.section).toBe('worldEvents');
  });

  test('CR-4 cue labels fit a chip and say "people of a country", not "demonym"', () => {
    const labels = [
      ...LEXICON.cues.map((c) => c.label),
      ...LEXICON.adjustments.map((a) => a.label),
      LEXICON.fallback.label,
    ];
    for (const l of labels) {
      expect(l.length, l).toBeLessThan(50);
      expect(l, l).not.toMatch(/demonym/i);
    }
    const f = one('Chinese parents stop sending kids abroad after 2068');
    expect(JSON.stringify([f.communities, f.reasons])).not.toMatch(/demonym/i);
  });

  test('CR-5 A44 ED-2 bodies are the sentence as typed in Markdown, and a question stores it once', () => {
    const f = one('Kids in Jinan say <b>ok</b> & more in 2070');
    expect(mainDraft(f).body).toBe('Kids in Jinan say <b>ok</b> & more in 2070');
    const q = one("Should Frank's church split over the Compact in 2075?");
    expect(mainDraft(q)).toMatchObject({
      question: "Should Frank's church split over the Compact in 2075?",
      body: '',
    });
  });
});

describe('A48 box fixes', () => {
  const withPortland = () => {
    const input = sliceInput();
    const chars = input.entries.characters!;
    const places = input.entries.places!;
    chars.push({ ...chars[0], _id: 'zhou-lan', title: 'Zhou Lan', names: { full: 'Zhou Lan' } });
    places.push({
      ...places[0],
      _id: 'pl-portland',
      title: 'Portland, Oregon',
      communityId: null,
      parentId: 'pl-oregon',
    });
    return buildIndex(input);
  };

  test('CR-5 a move lives in the place after the move verb, not the first place named', () => {
    const index = withPortland();
    const f = routeCapture(
      'Zhou Lan moved to Seattle when Portland started rationing water.',
      index,
      OPTS,
    ).facts[0]!;
    expect(f.section).toBe('moments');
    expect(f.drafts[0]!.data).toMatchObject({ characterId: 'zhou-lan', title: 'Lives in Seattle' });
    // With no place after the verb, the first place named.
    const g = routeCapture('In Portland, Zhou Lan moves house in 2062', index, OPTS).facts[0]!;
    expect(g.drafts[0]!.data?.title).toBe('Lives in Portland, Oregon');
    const h = routeCapture('Zhou Lan settles in Jinan in 2062', index, OPTS).facts[0]!;
    expect(h.drafts[0]!.data?.title).toBe('Lives in Jinan');
  });

  test('CR-3 a qualified label also matches its short names', () => {
    expect(labelParts('Portland, Oregon')).toEqual(['Portland', 'Oregon']);
    expect(labelParts('Jinan / Shandong')).toEqual(['Jinan', 'Shandong']);
    expect(labelParts('Pacific States (CA / OR / WA)')).toEqual([]);
    expect(labelParts('Shops, old and new')).toEqual(['Shops']);
    const index = withPortland();
    const portland = index.places.find((p) => p.id === 'pl-portland')!;
    expect(portland.aliases).toEqual(expect.arrayContaining(['portland', 'oregon']));
    expect(INDEX.communities.find((c) => c.id === 'jinan-shandong')!.aliases).toEqual(
      expect.arrayContaining(['jinan', 'shandong']),
    );
    expect(resolve('Portland rations water', index).places.map((p) => p.id)).toEqual([
      'pl-portland',
    ]);
  });
});
