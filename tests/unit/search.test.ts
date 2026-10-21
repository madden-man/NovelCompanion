import { describe, expect, test } from 'vitest';
import { tokenizeForIndex, tokenizeForQuery } from '../../src/main/search/tokenize';
import { SearchIndex } from '../../src/main/search';
import { ReadModel } from '../../src/main/readmodel';

const at = '2026-01-15T09:00:00.000Z';
const doc = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
  _id: id,
  title,
  body: '',
  status: 'canon',
  createdAt: at,
  modifiedAt: at,
  ...extra,
});

function indexOf(...entries: [string, ReturnType<typeof doc>][]): SearchIndex {
  const model = new ReadModel();
  for (const [c, d] of entries) model.put(c, d);
  const index = new SearchIndex();
  index.rebuild(model);
  return index;
}

describe('ARCH-2 search tokenizer', () => {
  test('ARCH-2 Latin text becomes lowercase words with tone marks removed', () => {
    expect(tokenizeForIndex('Margaret Hale, Xiǎoxī!')).toEqual(['margaret', 'hale', 'xiaoxi']);
  });

  test('ARCH-2 Chinese text is indexed as characters and bigrams', () => {
    expect(tokenizeForIndex('周美玲')).toEqual(['周', '美', '玲', '周美', '美玲']);
  });

  test('ARCH-2 a Chinese query uses bigrams, or the character for a one-character term', () => {
    expect(tokenizeForQuery('周美玲')).toEqual(['周美', '美玲']);
    expect(tokenizeForQuery('曦')).toEqual(['曦']);
  });

  test('ARCH-2 mixed text splits at script boundaries', () => {
    expect(tokenizeForIndex('Iris晓曦Hale')).toEqual(['iris', '晓', '曦', '晓曦', 'hale']);
    expect(tokenizeForQuery('Lan 周兰 2045')).toEqual(['lan', '周兰', '2045']);
  });
});

describe('ARCH-2 search index', () => {
  const index = indexOf(
    ['characters', doc('C1', '晓曦')],
    ['characters', doc('C2', 'Margaret Hale', { names: { full: 'Margaret Hale', chinese: '玛' } })],
    [
      'glossaryTerms',
      doc('G1', '团圆', {
        characters: '团圆',
        romanization: 'tuányuán',
        meaning: 'family reunion',
      }),
    ],
    ['characters', doc('C3', 'Trashed person', { deletedAt: at })],
  );
  const ids = (q: string) => index.search(q).map((h) => h.id);

  test('ARCH-2 a Chinese title "晓曦" is found by "晓曦" and by "曦"', () => {
    expect(ids('晓曦')).toContain('C1');
    expect(ids('曦')).toContain('C1');
  });

  test('ARCH-2 an English title is found by a word', () => {
    expect(ids('margaret')).toEqual(['C2']);
    expect(ids('Hale')).toEqual(['C2']);
    expect(ids('玛')).toEqual(['C2']);
  });

  test('ARCH-2 a glossary term is found by characters, romanization with or without tones, and meaning', () => {
    expect(ids('团圆')).toEqual(['G1']);
    expect(ids('tuányuán')).toEqual(['G1']);
    expect(ids('tuanyuan')).toEqual(['G1']);
    expect(ids('reunion')).toEqual(['G1']);
  });

  test('ARCH-2 entries in the trash are not indexed', () => {
    expect(ids('trashed')).toEqual([]);
  });
});
