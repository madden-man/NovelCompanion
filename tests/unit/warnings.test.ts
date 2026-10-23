import { describe, expect, test } from 'vitest';
import { manifests } from '../../src/shared/schema';
import type { EntryCollection, FieldSpec, ListDoc } from '../../src/shared/schema';
import { computeWarnings, warningsAt } from '../../src/shared/domain/warnings';
import type { WarningContext } from '../../src/shared/domain/warnings';

type Doc = Record<string, unknown> & { _id: string };

function context(docs: Record<string, Doc[]>, lists: ListDoc[] = []): WarningContext {
  return {
    get: (c, id) => docs[c]?.find((d) => d._id === id),
    find: (id) => {
      for (const [collection, list] of Object.entries(docs)) {
        const doc = list.find((d) => d._id === id);
        if (doc) return { collection, doc };
      }
      return undefined;
    },
    list: (id) => lists.find((l) => l._id === id),
  };
}

const person = (id: string, birth: unknown, death: unknown = null, title = id): Doc => ({
  _id: id,
  title,
  names: { full: title },
  birth,
  death,
  familyIds: [],
});

const warn = (c: EntryCollection, doc: Doc, ctx = context({})) =>
  computeWarnings(c, manifests[c], doc, ctx);
const codes = (c: EntryCollection, doc: Doc, ctx = context({})) =>
  warn(c, doc, ctx).map((w) => `${w.path}:${w.code}`);

describe('ED-10 field warnings', () => {
  test('ED-10 a death date before the birth date is flagged at the death field with a plain message', () => {
    const w = warn('characters', person('A', { year: 2000 }, { year: 1990 }, 'Ada'));
    expect(w).toEqual([
      {
        path: 'death',
        code: 'death-before-birth',
        message: 'The death date 1990 is before the birth date 2000. It still saves.',
      },
    ]);
  });

  test('ED-10 full dates compare by month and day; same-year year-only dates do not warn', () => {
    expect(
      codes(
        'characters',
        person('A', { year: 2000, month: 5, day: 2 }, { year: 2000, month: 5, day: 1 }),
      ),
    ).toEqual(['death:death-before-birth']);
    expect(codes('characters', person('A', { year: 2000, month: 5 }, { year: 2000 }))).toEqual([]);
    expect(codes('characters', person('A', { unknown: true }, { year: 1900 }))).toEqual([]);
  });

  test('ED-10 a day that does not exist in its month is flagged', () => {
    expect(codes('characters', person('A', { year: 2001, month: 2, day: 29 }))).toEqual([
      'birth:impossible-date',
    ]);
    expect(codes('characters', person('A', { year: 2000, month: 2, day: 29 }))).toEqual([]);
  });

  test('ED-10 a range that ends before it starts is flagged at its end, at any depth', () => {
    expect(codes('eraStates', { _id: 'E', name: 'x', startYear: 2050, endYear: 2040 })).toEqual([
      'endYear:range-end-before-start',
    ]);
    expect(
      codes(
        'unions',
        {
          _id: 'U',
          partnerIds: ['A', 'B'],
          type: 'married',
          startYear: 2000,
          endYear: 1999,
        },
        context({ characters: [person('A', { year: 1970 }), person('B', { year: 1970 })] }),
      ),
    ).toEqual(['endYear:range-end-before-start']);
    const chapter: Doc = {
      _id: 'C',
      strands: [
        {
          id: 's1',
          label: 'present',
          startYear: 2060,
          endYear: 2055,
          primary: true,
          characterIds: [],
          placeIds: [],
        },
      ],
    };
    expect(codes('chapters', chapter)).toEqual(['strands.0.endYear:range-end-before-start']);
  });

  test('ED-10 SM-3 a moment outside its character lifetime is flagged on its year, never blocked', () => {
    const ctx = context({ characters: [person('A', { year: 1950 }, { year: 2000 }, 'Ada')] });
    const moment = (year: number, endYear: number | null = null): Doc => ({
      _id: 'M',
      characterId: 'A',
      year,
      endYear,
    });
    expect(warn('moments', moment(1940), ctx)).toEqual([
      { path: 'year', code: 'outside-lifetime', message: '1940 is before Ada is born in 1950.' },
    ]);
    expect(warn('moments', moment(2010), ctx)).toEqual([
      { path: 'year', code: 'outside-lifetime', message: '2010 is after Ada dies in 2000.' },
    ]);
    expect(codes('moments', moment(1990, 2005), ctx)).toEqual(['endYear:outside-lifetime']);
    expect(codes('moments', moment(1950, 2000), ctx)).toEqual([]);
    // A moment for a character with an unknown birth is never flagged.
    const unknown = context({ characters: [person('A', { unknown: true })] });
    expect(codes('moments', moment(1800), unknown)).toEqual([]);
  });

  test('ED-10 FT-6 a parent under 12 or over 60 at the child birth is flagged; 12 and 60 are not', () => {
    const link = (parentBirth: number): [Doc, WarningContext] => [
      { _id: 'P', parentId: 'M', childId: 'K', type: 'biological', startYear: null },
      context({
        characters: [
          person('M', { year: parentBirth }, null, 'Mother'),
          person('K', { year: 2000 }, null, 'Kid'),
        ],
      }),
    ];
    expect(warn('parentLinks', ...link(1989))).toEqual([
      {
        path: 'parentId',
        code: 'parent-age',
        message: 'Mother would be 11 when Kid is born, under 12.',
      },
    ]);
    expect(codes('parentLinks', ...link(1988))).toEqual([]);
    expect(codes('parentLinks', ...link(1940))).toEqual([]);
    expect(codes('parentLinks', ...link(1939))).toEqual(['parentId:parent-age']);
  });

  test('ED-10 FT-6 a child born more than a year after a parent died is flagged', () => {
    const ctx = (death: unknown, birth: unknown) =>
      context({
        characters: [person('M', { year: 1960 }, death, 'Father'), person('K', birth, null, 'Kid')],
      });
    const link: Doc = {
      _id: 'P',
      parentId: 'M',
      childId: 'K',
      type: 'biological',
      startYear: null,
    };
    expect(codes('parentLinks', link, ctx({ year: 1998 }, { year: 1999 }))).toEqual([]);
    expect(codes('parentLinks', link, ctx({ year: 1998 }, { year: 2000 }))).toEqual([
      'childId:born-after-parent-death',
    ]);
    expect(
      codes(
        'parentLinks',
        link,
        ctx({ year: 1998, month: 3, day: 1 }, { year: 1999, month: 2, day: 20 }),
      ),
    ).toEqual([]);
    expect(
      codes(
        'parentLinks',
        link,
        ctx({ year: 1998, month: 3, day: 1 }, { year: 1999, month: 3, day: 5 }),
      ),
    ).toEqual(['childId:born-after-parent-death']);
  });

  test('ED-10 a union that starts before a partner is born is flagged', () => {
    const ctx = context({
      characters: [
        person('A', { year: 1980 }, null, 'Ann'),
        person('B', { year: 1990 }, null, 'Bo'),
      ],
    });
    expect(
      warn(
        'unions',
        {
          _id: 'U',
          partnerIds: ['A', 'B'],
          type: 'married',
          startYear: 1985,
          endYear: null,
        },
        ctx,
      ),
    ).toEqual([
      {
        path: 'startYear',
        code: 'union-before-birth',
        message: 'This union starts in 1985, before Bo is born in 1990.',
      },
    ]);
  });

  test('ED-10 references to missing or trashed entries, and the same partner twice, are flagged', () => {
    const ctx = context({
      characters: [
        person('A', { year: 1980 }),
        { ...person('T', { year: 1980 }, null, 'Tess'), deletedAt: '2026-01-01T00:00:00.000Z' },
      ],
    });
    expect(
      warn(
        'unions',
        {
          _id: 'U',
          links: [{ targetId: 'GONE', kind: 'see' }],
          partnerIds: ['A', 'A'],
          type: 'married',
          startYear: null,
          endYear: null,
        },
        ctx,
      ).map((w) => [w.path, w.code]),
    ).toEqual([
      ['partnerIds', 'same-twice'],
      ['links', 'missing-target'],
    ]);
    expect(
      warn(
        'unions',
        {
          _id: 'U',
          partnerIds: ['A', 'T'],
          type: 'married',
          startYear: null,
          endYear: null,
        },
        ctx,
      ),
    ).toEqual([
      {
        path: 'partnerIds.1',
        code: 'missing-target',
        message: 'Tess is in the trash. Restore it or pick another.',
      },
    ]);
  });

  test('ED-10 a list value that is not in its list is flagged', () => {
    const lists: ListDoc[] = [
      {
        _id: 'unionTypes',
        label: 'Union types',
        items: [{ id: 'married', label: 'Married', parentId: null }],
      },
    ];
    const ctx = context(
      { characters: [person('A', { year: 1980 }), person('B', { year: 1980 })] },
      lists,
    );
    expect(
      codes(
        'unions',
        {
          _id: 'U',
          partnerIds: ['A', 'B'],
          type: 'eloped',
          startYear: null,
          endYear: null,
        },
        ctx,
      ),
    ).toEqual(['type:unknown-list-item']);
  });

  test('ED-10 a chapter with no primary strand or two is flagged; one is not', () => {
    const strand = (id: string, primary: boolean) => ({
      id,
      label: id,
      startYear: 2050,
      endYear: null,
      primary,
      characterIds: [],
      placeIds: [],
    });
    const ch = (...strands: unknown[]): Doc => ({ _id: 'C', strands });
    expect(codes('chapters', ch(strand('a', false)))).toEqual(['strands:primary-strand-count']);
    expect(codes('chapters', ch(strand('a', true), strand('b', true)))).toEqual([
      'strands:primary-strand-count',
    ]);
    expect(codes('chapters', ch(strand('a', true), strand('b', false)))).toEqual([]);
  });

  test('ED-10 world events that end before they start, places inside themselves, and decided questions with no decision are flagged', () => {
    expect(codes('worldEvents', { _id: 'W', start: { year: 2040 }, end: { year: 2039 } })).toEqual([
      'end:range-end-before-start',
    ]);
    const ctx = context({ places: [{ _id: 'PL', parentId: 'PL' }] });
    expect(codes('places', { _id: 'PL', parentId: 'PL', descriptions: [] }, ctx)).toEqual([
      'parentId:self-reference',
    ]);
    expect(codes('openQuestions', { _id: 'Q', state: 'decided', decision: ' ' })).toEqual([
      'decision:decided-without-decision',
    ]);
  });

  test('ED-10 every warning is declared on the field it lands on in the manifest', () => {
    const specAt = (specs: readonly FieldSpec[], path: string): FieldSpec | undefined => {
      const [head, ...rest] = path.split('.').filter((p) => !/^\d+$/.test(p));
      const s = specs.find((x) => x.name === head);
      if (!s || rest.length === 0 || !s.fields) return s;
      return specAt(s.fields, rest.join('.'));
    };
    const samples: [EntryCollection, Doc, WarningContext][] = [
      ['characters', person('A', { year: 2000, month: 2, day: 30 }, { year: 1990 }), context({})],
      [
        'moments',
        { _id: 'M', characterId: 'Z', year: 1, endYear: 0 },
        context({ characters: [person('Z', { year: 2000 }, { year: 2001 })] }),
      ],
      [
        'parentLinks',
        { _id: 'P', parentId: 'M', childId: 'K', type: 'x' },
        context(
          {
            characters: [person('M', { year: 1999 }, { year: 1990 }), person('K', { year: 2000 })],
          },
          [{ _id: 'parentLinkTypes', label: 'L', items: [] }],
        ),
      ],
      [
        'unions',
        { _id: 'U', partnerIds: ['A', 'A'], type: 'x', startYear: 1, endYear: 0 },
        context({ characters: [person('A', { year: 2000 })] }),
      ],
    ];
    for (const [c, doc, ctx] of samples) {
      const ws = computeWarnings(c, manifests[c], doc, ctx);
      expect(ws.length, c).toBeGreaterThan(0);
      for (const w of ws) {
        expect(specAt(manifests[c], w.path)?.warnings, `${c} ${w.path} ${w.code}`).toContain(
          w.code,
        );
        expect(w.message).not.toMatch(/\u2014|--/);
      }
    }
  });

  test('ED-10 warningsAt returns a field warnings and those under it', () => {
    const ws = [
      { path: 'strands', code: 'a', message: '' },
      { path: 'strands.0.endYear', code: 'b', message: '' },
      { path: 'strandsX', code: 'c', message: '' },
    ];
    expect(warningsAt(ws, 'strands').map((w) => w.code)).toEqual(['a', 'b']);
  });
});
