import { describe, expect, test } from 'vitest';
import {
  DATAMUSE_URL,
  KINDS,
  WORD_KINDS,
  WORD_MAX,
  kindInfo,
  parseWords,
  posText,
  wordQuery,
  wordUrl,
} from '../../src/shared/domain/words';
import type { WordKind } from '../../src/shared/domain/words';
import {
  DATAMUSE_BUSY,
  DATAMUSE_DOWN,
  DATAMUSE_REFUSED,
  DATAMUSE_SLOW,
  DATAMUSE_UNREACHABLE,
  DATAMUSE_UNREADABLE,
  lookupWords,
} from '../../src/main/words/datamuse';
import { parseRequest, parseResponse } from '../../src/shared/ipc';

const PARAMS: Record<WordKind, string> = {
  synonyms: 'rel_syn',
  antonyms: 'rel_ant',
  meansLike: 'ml',
  rhymes: 'rel_rhy',
  nearRhymes: 'rel_nry',
  soundsLike: 'sl',
  spelledLike: 'sp',
  related: 'rel_trg',
  adjectivesFor: 'rel_jjb',
  nounsFor: 'rel_jja',
  homophones: 'rel_hom',
  definition: 'sp',
};

describe('WT-1 the Datamuse query for each lookup', () => {
  test('WT-1 every lookup has a label, a hint, and one Datamuse parameter, with parts of speech and syllables asked for', () => {
    expect(KINDS.map((k) => k.id)).toEqual([...WORD_KINDS]);
    for (const kind of WORD_KINDS) {
      const info = kindInfo(kind);
      expect(info.label).not.toBe('');
      expect(info.hint).not.toBe('');
      expect(`${info.label} ${info.hint}`).not.toMatch(/—|--/);
      const q = new Map(wordQuery(kind, '  ember '));
      expect(q.get(PARAMS[kind])).toBe('ember');
      if (kind === 'definition') {
        expect(q.get('md')).toBe('dp');
        expect(q.get('max')).toBe('1');
      } else {
        expect(q.get('md')).toBe('ps');
        expect(q.get('max')).toBe(String(WORD_MAX));
      }
    }
    expect(KINDS.filter((k) => k.syllables).map((k) => k.id)).toEqual([
      'rhymes',
      'nearRhymes',
      'soundsLike',
    ]);
  });

  test('WT-1 the URL points at Datamuse and keeps wildcards in a spelled-like lookup', () => {
    const u = new URL(wordUrl('spelledLike', 't?ngle*'));
    expect(`${u.origin}${u.pathname}`).toBe(DATAMUSE_URL);
    expect(u.searchParams.get('sp')).toBe('t?ngle*');
    expect(wordUrl('rhymes', 'rain')).toBe(
      'https://api.datamuse.com/words?rel_rhy=rain&md=ps&max=40',
    );
    expect(() => kindInfo('verbs' as WordKind)).toThrow('Unknown word lookup');
  });
});

describe('WT-1 reading what Datamuse sends back', () => {
  test('WT-1 rows become results with their parts of speech and syllable count; rows without a word are left out', () => {
    const rows = [
      { word: 'ember', score: 1200, numSyllables: 2, tags: ['n', 'pron:EH1 M B ER0 '] },
      { word: 'glow', score: 900, tags: ['n', 'v', 'syl:1'] },
      { word: 'spark', tags: ['syl:1', 'f:3.2'] },
      { word: '', score: 5 },
      { score: 3 },
      'not a row',
      null,
    ];
    expect(parseWords(rows)).toEqual([
      { word: 'ember', score: 1200, partsOfSpeech: ['n'], syllables: 2 },
      { word: 'glow', score: 900, partsOfSpeech: ['n', 'v'], syllables: 1 },
      { word: 'spark', score: 0, partsOfSpeech: [], syllables: 1 },
    ]);
    expect(parseWords({ word: 'ember' })).toEqual([]);
    expect(parseWords('ember')).toEqual([]);
  });

  test('WT-1 a definition row splits each "pos<tab>text" entry and names the parts of speech in words', () => {
    const [r] = parseWords([
      {
        word: 'ember',
        score: 10,
        tags: ['n', 'syl:2'],
        defs: [
          'n\ta hot fragment of wood or coal',
          'n\t  the last glow of a fire  ',
          'no tab here',
          '',
          7,
        ],
      },
    ]);
    expect(r).toEqual({
      word: 'ember',
      score: 10,
      partsOfSpeech: ['n'],
      syllables: 2,
      definitions: [
        { pos: 'n', text: 'a hot fragment of wood or coal' },
        { pos: 'n', text: 'the last glow of a fire' },
        { pos: '', text: 'no tab here' },
      ],
    });
    expect(posText('adj')).toBe('adjective');
    expect(posText('prop')).toBe('proper noun');
    expect(posText('xyz')).toBe('xyz');
  });

  test('WT-1 the words.lookup channel validates both sides', () => {
    expect(parseRequest('words.lookup', { kind: 'rhymes', word: '  rain ' })).toEqual({
      kind: 'rhymes',
      word: 'rain',
    });
    expect(() => parseRequest('words.lookup', { kind: 'rhymes', word: '   ' })).toThrow();
    expect(() => parseRequest('words.lookup', { kind: 'verbs', word: 'rain' })).toThrow();
    expect(() => parseRequest('words.lookup', { kind: 'rhymes', word: 'x'.repeat(81) })).toThrow();
    const ok = {
      kind: 'rhymes',
      word: 'rain',
      results: [{ word: 'again', score: 1, partsOfSpeech: ['adv'], syllables: 2 }],
    };
    expect(parseResponse('words.lookup', ok)).toEqual(ok);
    expect(() =>
      parseResponse('words.lookup', { ...ok, results: [{ word: 'again', score: 1 }] }),
    ).toThrow();
  });
});

type Fetch = typeof fetch;

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

describe('WT-1 lookupWords in main, with every failure in plain words', () => {
  test('WT-1 a lookup fetches the Datamuse URL with a timeout and returns the parsed results', async () => {
    const seen: { url: string; init: RequestInit | undefined }[] = [];
    const fake: Fetch = async (url, init) => {
      seen.push({ url: String(url), init });
      return jsonResponse([{ word: 'again', score: 1, tags: ['adv', 'syl:2'] }]);
    };
    const r = await lookupWords({ kind: 'rhymes', word: ' rain ' }, fake);
    expect(r).toEqual({
      kind: 'rhymes',
      word: 'rain',
      results: [{ word: 'again', score: 1, partsOfSpeech: ['adv'], syllables: 2 }],
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe('https://api.datamuse.com/words?rel_rhy=rain&md=ps&max=40');
    expect(seen[0]!.init?.signal).toBeInstanceOf(AbortSignal);
  });

  test('WT-1 no network: the app could not reach Datamuse, with the cause kept off the message', async () => {
    const fake: Fetch = async () => {
      throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } });
    };
    await expect(lookupWords({ kind: 'synonyms', word: 'rain' }, fake)).rejects.toThrow(
      DATAMUSE_UNREACHABLE,
    );
  });

  test('WT-1 a timeout says Datamuse took too long, and the signal really aborts a slow server', async () => {
    const abortError = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    const fake: Fetch = async () => {
      throw abortError;
    };
    await expect(lookupWords({ kind: 'synonyms', word: 'rain' }, fake)).rejects.toThrow(
      DATAMUSE_SLOW,
    );
    // A server that never answers: the signal fires and the lookup gives up.
    const slow: Fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
      });
    await expect(lookupWords({ kind: 'synonyms', word: 'rain' }, slow, 20)).rejects.toThrow(
      DATAMUSE_SLOW,
    );
  });

  test('WT-1 a failed status becomes plain words: busy on 429, down on 5xx, refused otherwise, never the code', async () => {
    const at =
      (status: number): Fetch =>
      async () =>
        jsonResponse({ error: 'x' }, status);
    await expect(lookupWords({ kind: 'synonyms', word: 'rain' }, at(500))).rejects.toThrow(
      DATAMUSE_DOWN,
    );
    await expect(lookupWords({ kind: 'synonyms', word: 'rain' }, at(429))).rejects.toThrow(
      DATAMUSE_BUSY,
    );
    await expect(lookupWords({ kind: 'synonyms', word: 'rain' }, at(400))).rejects.toThrow(
      DATAMUSE_REFUSED,
    );
    for (const status of [400, 429, 500]) {
      const e = await lookupWords({ kind: 'synonyms', word: 'rain' }, at(status)).catch(
        (x: unknown) => x as Error,
      );
      expect((e as Error).message).not.toContain(String(status));
    }
  });

  test('WT-1 a body that is not JSON, or not a list, cannot be read', async () => {
    const html: Fetch = async () =>
      new Response('<html>down</html>', { status: 200, headers: { 'Content-Type': 'text/html' } });
    await expect(lookupWords({ kind: 'synonyms', word: 'rain' }, html)).rejects.toThrow(
      DATAMUSE_UNREADABLE,
    );
    const object: Fetch = async () => jsonResponse({ words: [] });
    await expect(lookupWords({ kind: 'synonyms', word: 'rain' }, object)).rejects.toThrow(
      DATAMUSE_UNREADABLE,
    );
  });
});
