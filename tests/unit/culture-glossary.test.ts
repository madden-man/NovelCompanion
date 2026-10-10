import { describe, expect, test } from 'vitest';
import {
  descriptionFor,
  entriesFor,
  placeOutline,
  placePath,
} from '../../src/shared/domain/culture';
import {
  checkRomanization,
  isJyutpingSyllable,
  isPinyinSyllable,
  systemFor,
  termProblem,
} from '../../src/shared/domain/romanization';
import { computeWarnings } from '../../src/shared/domain/warnings';
import { zhHint, zhPieces } from '../../src/shared/domain/zh';
import { glossaryTermFields } from '../../src/shared/schema';
import { tokenizeForIndex, tokenizeForQuery } from '../../src/main/search/tokenize';
import { SearchIndex } from '../../src/main/search';
import { ReadModel } from '../../src/main/readmodel';
import { readFixture } from '../helpers/loadFixture';

const fx = readFixture();
const at = '2026-01-15T09:00:00.000Z';

describe('CU-1 CU-2 cultural entries by community and year', () => {
  const cultural = fx.culturalEntries ?? [];

  test('CU-2 entriesFor returns the one mooncake entry that applies in each year', () => {
    expect(entriesFor(cultural, 'guangzhou', 2020).map((e) => e._id)).toEqual(['CU1']);
    expect(entriesFor(cultural, 'guangzhou', 2080).map((e) => e._id)).toEqual(['CU2']);
  });

  test('CU-1 the same tradition reads differently in 2030 and 2080', () => {
    const a = entriesFor(cultural, 'guangzhou', 2030)[0];
    const b = entriesFor(cultural, 'guangzhou', 2080)[0];
    expect(a?.title).toBe(b?.title);
    expect(a?.body).not.toBe(b?.body);
  });

  test('CU-2 the range ends are inclusive and other communities never match', () => {
    expect(entriesFor(cultural, 'portland', 2034).map((e) => e._id)).toEqual(['CU3']);
    expect(entriesFor(cultural, 'portland', 2035).map((e) => e._id)).toEqual(['CU4']);
    expect(entriesFor(cultural, 'portland', 1999)).toEqual([]);
    expect(entriesFor(cultural, 'nowhere', 2040)).toEqual([]);
  });

  test('CU-2 an open start or end applies on that side, and trashed entries are left out', () => {
    const rows = [
      { _id: 'a', title: 'a', communityId: 'c', startYear: null, endYear: 2000 },
      { _id: 'b', title: 'b', communityId: 'c', startYear: 2001, endYear: null },
      { _id: 'd', title: 'd', communityId: 'c', startYear: null, endYear: null, deletedAt: at },
    ];
    expect(entriesFor(rows, 'c', 1500).map((e) => e._id)).toEqual(['a']);
    expect(entriesFor(rows, 'c', 3000).map((e) => e._id)).toEqual(['b']);
  });
});

describe('PC-1 places nest and describe themselves by year', () => {
  const places = [
    { _id: 'city', title: 'Portland', parentId: null },
    { _id: 'dist', title: 'Pearl District', parentId: 'city' },
    { _id: 'bldg', title: 'The Archive', parentId: 'dist' },
    { _id: 'loop', title: 'Loop', parentId: 'loop' },
  ];

  test('PC-1 a building shows its city and district in its path', () => {
    expect(placePath(places, 'bldg')).toBe('Portland > Pearl District > The Archive');
    expect(placePath(places, 'loop')).toBe('Loop');
  });

  test('PC-1 the outline lists each parent before its children, indented by depth', () => {
    expect(placeOutline(places).map((n) => [n.title, n.depth])).toEqual([
      ['Portland', 0],
      ['Pearl District', 1],
      ['The Archive', 2],
      ['Loop', 0],
    ]);
  });

  test('PC-1 descriptionFor picks the description whose years cover the year', () => {
    const place = {
      descriptions: [
        { startYear: null, endYear: 2034, text: 'Riverside warehouses.' },
        { startYear: 2035, endYear: 2060, text: 'Flooded, then rebuilt on stilts.' },
        { startYear: 2050, endYear: null, text: 'A dry district behind the sea wall.' },
      ],
    };
    expect(descriptionFor(place, 2000)?.text).toBe('Riverside warehouses.');
    expect(descriptionFor(place, 2040)?.text).toBe('Flooded, then rebuilt on stilts.');
    expect(descriptionFor(place, 2055)?.text).toBe('A dry district behind the sea wall.');
    expect(descriptionFor(place, 2100)?.text).toBe('A dry district behind the sea wall.');
    expect(descriptionFor({ descriptions: [] }, 2000)).toBeNull();
    expect(
      descriptionFor({ descriptions: [{ startYear: 2000, endYear: 2001, text: 'x' }] }, 1999),
    ).toBeNull();
  });
});

describe('GL-1 the romanization checker', () => {
  const pinyinOk = [
    'xiǎoxī',
    'Zhōu Měilíng',
    'tuányuán',
    'wàipó',
    'yuèbǐng',
    'ni3 hao3',
    'ni3hao3',
    'Zhong1guo2',
    'nǚ',
    'nü3',
    'lüè',
    'Xī’ān',
    'er2',
    'a',
    'jiu3',
    'qiong2',
    'shuang',
    'zhuāng',
    'ma5',
  ];
  const pinyinBad = [
    'xyz',
    'bqa',
    'fiao',
    'qv',
    'zhx',
    'hello',
    'gwong2',
    'ni6hao',
    'xiao33',
    'ji!',
  ];

  test('GL-1 valid Hanyu Pinyin passes, with tone marks, tone numbers, or none', () => {
    for (const s of pinyinOk)
      expect(checkRomanization('pinyin', s), s).toEqual({ ok: true, invalid: [] });
  });

  test('GL-1 invalid Hanyu Pinyin is reported word by word', () => {
    for (const s of pinyinBad) expect(checkRomanization('pinyin', s).ok, s).toBe(false);
    expect(checkRomanization('pinyin', 'Zhōu Qwerty').invalid).toEqual(['Qwerty']);
  });

  test('GL-1 single Pinyin syllables follow the initials and finals tables', () => {
    expect(
      ['zhi', 'chi', 'shi', 'ri', 'zi', 'ci', 'si', 'yi', 'wu', 'yu', 'ju', 'xue'].every(
        isPinyinSyllable,
      ),
    ).toBe(true);
    expect(['zhei1x', 'ju1', 'bou', 'fei2n', 'xa'].some(isPinyinSyllable)).toBe(false);
  });

  const jyutOk = [
    'gwong2dung1',
    'nei5 hou2',
    'gwong2 dung1 waa2',
    'sik6 faan6',
    'm4 goi1',
    'ng5',
    'zung1man4',
    'hoeng1gong2',
  ];
  const jyutBad = ['gwong', 'gwong7', 'nei5hou', 'xiao3', 'qwe2', 'gwong0', 'ngng5', 'gwongg2'];

  test('GL-1 valid Jyutping needs initials, finals, and a tone digit from 1 to 6', () => {
    for (const s of jyutOk)
      expect(checkRomanization('jyutping', s), s).toEqual({ ok: true, invalid: [] });
  });

  test('GL-1 invalid Jyutping is flagged: missing tone, tone out of range, unknown syllables', () => {
    for (const s of jyutBad) expect(checkRomanization('jyutping', s).ok, s).toBe(false);
    expect(isJyutpingSyllable('sik6')).toBe(true);
    expect(isJyutpingSyllable('sik')).toBe(false);
  });

  test('GL-1 an empty romanization claims nothing', () => {
    expect(checkRomanization('pinyin', '  ').ok).toBe(true);
  });

  const systems = {
    _id: 'romanizationSystems',
    label: 'Romanization systems',
    items: [
      { id: 'mandarin', label: 'Hanyu Pinyin', parentId: null },
      { id: 'cantonese', label: 'Jyutping', parentId: null },
    ],
  };

  test('GL-1 one system per language: the default follows the language, a setting overrides it', () => {
    expect(systemFor('mandarin', {}, systems)).toMatchObject({
      label: 'Hanyu Pinyin',
      kind: 'pinyin',
    });
    expect(systemFor('cantonese', {}, systems)).toMatchObject({ kind: 'jyutping' });
    expect(systemFor('english', {}, systems)).toBeNull();
    expect(systemFor('mandarin', { mandarin: '' }, systems)).toBeNull();
    expect(systemFor('mandarin', { mandarin: 'cantonese' }, systems)?.kind).toBe('jyutping');
  });

  test('GL-1 every fixture glossary term follows Hanyu Pinyin', () => {
    for (const t of fx.glossaryTerms ?? []) {
      expect(
        termProblem(
          { language: String(t.language), romanization: String(t.romanization) },
          {},
          systems,
        ),
        String(t.characters),
      ).toBeNull();
    }
  });

  test('GL-1 a term that breaks its language system gets a warning on the romanization field, never a block', () => {
    const doc = { _id: 'g', language: 'mandarin', romanization: 'xyz', characters: '好' };
    const ctx = {
      get: (c: string) => (c === 'meta' ? undefined : undefined),
      find: () => undefined,
      list: (id: string) => (id === 'romanizationSystems' ? systems : undefined),
    };
    const w = computeWarnings('glossaryTerms', glossaryTermFields, doc, ctx);
    expect(w.filter((x) => x.code === 'romanization-system')).toEqual([
      expect.objectContaining({ path: 'romanization' }),
    ]);
    const cantonese = computeWarnings(
      'glossaryTerms',
      glossaryTermFields,
      { ...doc, language: 'cantonese', romanization: 'hou2' },
      ctx,
    );
    expect(cantonese.some((x) => x.code === 'romanization-system')).toBe(false);
  });
});

describe('GL-2 search finds a term by characters, romanization, or meaning', () => {
  const model = new ReadModel();
  for (const t of fx.glossaryTerms ?? []) model.put('glossaryTerms', t);
  const index = new SearchIndex();
  index.rebuild(model);
  const ids = (q: string) => index.search(q).map((h) => h.id);

  test('GL-2 by characters, whole or partial', () => {
    expect(ids('晓曦')[0]).toBe('GL1');
    expect(ids('饼')).toContain('GL5');
    expect(ids('美玲')).toContain('GL2');
  });

  test('GL-2 by romanization with tone marks, without them, or with tone numbers', () => {
    expect(ids('xiǎoxī')[0]).toBe('GL1');
    expect(ids('xiaoxi')[0]).toBe('GL1');
    expect(ids('xiao3xi1')[0]).toBe('GL1');
    expect(ids('wàipó')[0]).toBe('GL4');
    expect(ids('waipo')[0]).toBe('GL4');
    expect(ids('Zhōu Měilíng')[0]).toBe('GL2');
    expect(ids('yuebing')[0]).toBe('GL5');
  });

  test('GL-2 by meaning', () => {
    expect(ids('mooncake')[0]).toBe('GL5');
    expect(ids('family reunion')[0]).toBe('GL3');
    expect(ids('maternal grandmother')[0]).toBe('GL4');
  });

  test('GL-2 the tokenizer drops tone numbers on romanization and keeps ordinary numbers', () => {
    expect(tokenizeForIndex('gwong2dung1')).toEqual(['gwongdung']);
    expect(tokenizeForQuery('Měilíng')).toEqual(['meiling']);
    expect(tokenizeForIndex('year 2060')).toEqual(['year', '2060']);
  });
});

describe('GL-3 characters are matched to glossary terms', () => {
  const terms = (fx.glossaryTerms ?? []).map((t) => ({
    id: String(t._id),
    characters: String(t.characters),
    romanization: String(t.romanization),
    meaning: String(t.meaning),
  }));

  test('GL-3 an exact term is matched first, then the longest term the run starts with', () => {
    const extra = [...terms, { id: 'X', characters: '周', romanization: 'zhōu', meaning: 'Zhou' }];
    const exact = zhPieces('周美玲', extra);
    expect(exact).toEqual([
      { kind: 'zh', text: '周美玲', term: extra.find((t) => t.id === 'GL2') },
    ]);
    const prefix = zhPieces('周美玲的外婆', extra);
    expect(prefix.map((p) => p.kind === 'zh' && [p.text, p.term?.id ?? null])).toEqual([
      ['周美玲', 'GL2'],
      ['的', null],
      ['外婆', 'GL4'],
    ]);
    const short = zhPieces('周静', extra);
    expect(short.map((p) => p.kind === 'zh' && [p.text, p.term?.id ?? null])).toEqual([
      ['周', 'X'],
      ['静', null],
    ]);
  });

  test('GL-3 a run with no term has a null term, which is where the add to glossary action shows', () => {
    const pieces = zhPieces('他说 月饼 好', terms);
    const runs = pieces.filter((p) => p.kind === 'zh');
    expect(runs.map((p) => p.kind === 'zh' && [p.text, p.term?.id ?? null])).toEqual([
      ['他说', null],
      ['月饼', 'GL5'],
      ['好', null],
    ]);
  });

  test('GL-3 a tree node gets one line of glossary detail for its Chinese name', () => {
    expect(zhHint('晓曦', terms)).toBe('晓曦 xiǎoxī: dawn light');
    expect(zhHint('月饼 月饼 外婆', terms)).toBe(
      '月饼 yuèbǐng: mooncake; 外婆 wàipó: maternal grandmother',
    );
    expect(zhHint('无', terms)).toBe('');
    expect(zhHint('Iris', terms)).toBe('');
  });

  test('GL-3 Latin text around characters stays text', () => {
    const pieces = zhPieces('Iris (晓曦) smiled', terms);
    expect(pieces.map((p) => p.kind)).toEqual(['text', 'zh', 'text']);
  });
});
