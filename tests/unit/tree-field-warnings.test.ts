import { describe, expect, test } from 'vitest';
import { manifests } from '../../src/shared/schema';
import { computeWarnings } from '../../src/shared/domain/warnings';
import type { WarningContext } from '../../src/shared/domain/warnings';

type Doc = Record<string, unknown> & { _id: string };

const person = (id: string, born: number): Doc => ({
  _id: id,
  title: id,
  createdAt: '2026-01-01T00:00:00.000Z',
  names: { full: id },
  birth: { year: born },
  death: null,
});

function context(docs: Record<string, Doc[]>): WarningContext {
  return {
    get: (c, id) => docs[c]?.find((d) => d._id === id),
    find: () => undefined,
    list: () => undefined,
    all: (c) => docs[c] ?? [],
  };
}

describe('FT-6 tree warnings at the field (ED-10)', () => {
  const people = [person('Ann', 1960), person('Bo', 1960), person('Cy', 1960), person('Kid', 1984)];
  const u1: Doc = {
    _id: 'U1',
    createdAt: '2026-01-01T00:00:01.000Z',
    partnerIds: ['Ann', 'Bo'],
    type: 'married',
    startYear: 1985,
    endYear: 2000,
  };
  const u2: Doc = { ...u1, _id: 'U2', partnerIds: ['Ann', 'Cy'], startYear: 1995, endYear: null };
  const links: Doc[] = [
    { _id: 'L1', parentId: 'Ann', childId: 'Kid', type: 'biological', startYear: null },
    { _id: 'L2', parentId: 'Bo', childId: 'Kid', type: 'biological', startYear: null },
  ];
  const ctx = context({ characters: people, unions: [u1, u2], parentLinks: links });

  test('FT-6 an overlapping union is flagged on its start year and still saves', () => {
    const w = computeWarnings('unions', manifests.unions, u2, ctx);
    expect(w).toEqual([
      {
        path: 'startYear',
        code: 'overlapping-unions',
        message: 'Ann has overlapping unions: with Cy (from 1995) and with Bo (1985 to 2000).',
      },
    ]);
  });

  test('FT-6 a child born before the union is flagged on the union start year', () => {
    const codes = computeWarnings('unions', manifests.unions, u1, ctx).map((w) => w.code);
    expect(codes).toEqual(['overlapping-unions', 'born-before-union']);
  });

  test('FT-6 an adoptive link raises no age warning; a biological one does', () => {
    const c = context({ characters: [person('Mum', 1930), person('Kid', 2000)] });
    const link = (type: string): Doc => ({
      _id: 'L',
      parentId: 'Mum',
      childId: 'Kid',
      type,
      startYear: null,
    });
    expect(computeWarnings('parentLinks', manifests.parentLinks, link('adoptive'), c)).toEqual([]);
    expect(
      computeWarnings('parentLinks', manifests.parentLinks, link('biological'), c).map(
        (w) => w.code,
      ),
    ).toEqual(['parent-age']);
  });
});
