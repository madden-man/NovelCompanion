import { describe, expect, test } from 'vitest';
import { chapterPage, moveChapter, outlineGrid, reorder } from '../../src/shared/domain/outline';
import { reorderCommand } from '../../src/shared/domain/undoRunner';
import { readFixture } from '../helpers/loadFixture';

const fx = readFixture();
const data = { all: (c: string) => (fx[c] ?? []) as Record<string, unknown>[] };

const at = '2026-01-15T09:00:00.000Z';
const base = { status: 'planned', createdAt: at, modifiedAt: at };
const strand = (id: string, year: number, primary = true, end: number | null = null) => ({
  id,
  label: id,
  startYear: year,
  endYear: end,
  primary,
  povCharacterId: null,
  characterIds: [],
  placeIds: [],
});

const extra: Record<string, Record<string, unknown>[]> = {
  families: [
    { _id: 'FA', title: 'Hale', name: 'Hale', color: 'series-1', ...base },
    { _id: 'FB', title: 'Zhou', name: 'Zhou', color: 'series-3', ...base },
  ],
  characters: [{ _id: 'C1', title: 'Iris', familyIds: ['FB'], ...base }],
  books: [{ _id: 'B1', title: 'Tide Lines', number: 1, ...base }],
  parts: [
    { _id: 'P2', title: 'Part Two', bookId: 'B1', number: 2, ...base },
    { _id: 'P1', title: 'Part One', bookId: 'B1', number: 1, ...base },
  ],
  chapters: [
    {
      _id: 'X3',
      title: 'Third',
      partId: 'P2',
      readingOrder: 3,
      strands: [strand('a', 2031)],
      ...base,
    },
    {
      _id: 'X1',
      title: 'First',
      partId: 'P1',
      readingOrder: 1,
      strands: [strand('b', 2075), strand('c', 2040, false, 2042)],
      ...base,
    },
    {
      _id: 'X2',
      title: 'Second',
      partId: 'P1',
      readingOrder: 2,
      strands: [strand('d', 2050)],
      ...base,
    },
  ],
};
const small = { all: (c: string) => extra[c] ?? [] };

describe('PL-2 the fixture outline', () => {
  test('PL-2 the fixture grid has one chapter row per chapter, grouped under the book and part', () => {
    const g = outlineGrid(data, { order: 'reading' });
    const chapters = g.rows.filter((r) => r.kind === 'chapter');
    expect(chapters).toHaveLength(fx.chapters?.length ?? -1);
    expect(g.rows[0]).toMatchObject({ kind: 'book', title: 'Tide Lines' });
    expect(g.rows[1]).toMatchObject({ kind: 'part' });
  });
});

describe('PL-2 the chapter-by-year outline grid', () => {
  test('PL-2 rows follow book, part, then reading order, with a header row per book and part', () => {
    const g = outlineGrid(small, { order: 'reading' });
    expect(g.rows.map((r) => (r.kind === 'chapter' ? r.id : r.kind))).toEqual([
      'book',
      'part',
      'X1',
      'X2',
      'part',
      'X3',
    ]);
  });

  test('PL-2 story-year order sorts by the primary strand year and drops the headers', () => {
    const g = outlineGrid(small, { order: 'story' });
    expect(g.rows.map((r) => r.kind === 'chapter' && r.id)).toEqual(['X3', 'X2', 'X1']);
  });

  test('PL-2 strands carry their years and primary flag; the years axis covers every mark', () => {
    const g = outlineGrid(small, { order: 'reading', cursorYear: 2090 });
    const first = g.rows.find((r) => r.kind === 'chapter' && r.id === 'X1');
    expect(first?.kind === 'chapter' && first.strands).toEqual([
      {
        id: 'b',
        label: 'b',
        primary: true,
        startYear: 2075,
        endYear: 2075,
        pov: null,
        present: [],
      },
      {
        id: 'c',
        label: 'c',
        primary: false,
        startYear: 2040,
        endYear: 2042,
        pov: null,
        present: [],
      },
    ]);
    // The axis runs from the earliest strand (arcs no longer stretch it, A39).
    expect(g.years[0]).toBe(2031);
    expect(g.years.at(-1)).toBe(2090);
    expect(g.cursorYear).toBe(2090);
  });
});

describe('PL-3 reorder keeps reading order and story year apart', () => {
  const items = [
    { id: 'a', value: 4 },
    { id: 'b', value: 5 },
    { id: 'c', value: 9 },
  ];

  test('PL-3 moving a chapter reuses the numbers of its part, so other parts keep theirs', () => {
    expect(reorder(items, 'c', 0, 'reuse')).toEqual([
      { id: 'c', value: 4 },
      { id: 'a', value: 5 },
      { id: 'b', value: 9 },
    ]);
  });

  test('PL-3 a sequence is numbered 1 to n and an unmoved item is not returned', () => {
    const seq = [
      { id: 'a', value: 1 },
      { id: 'b', value: 2 },
      { id: 'c', value: 3 },
    ];
    expect(reorder(seq, 'a', 1, 'sequence')).toEqual([
      { id: 'b', value: 1 },
      { id: 'a', value: 2 },
    ]);
    expect(reorder(seq, 'b', 1, 'sequence')).toEqual([]);
    expect(reorder(seq, 'missing', 0, 'sequence')).toEqual([]);
  });

  test('PL-3 the story-year order does not change when reading order changes', () => {
    const moved = {
      all: (c: string) =>
        (extra[c] ?? []).map((d) =>
          c === 'chapters' ? { ...d, readingOrder: 4 - Number(d.readingOrder) } : d,
        ),
    };
    const story = (d: typeof small) =>
      outlineGrid(d, { order: 'story' }).rows.map((r) => r.kind === 'chapter' && r.id);
    expect(story(moved)).toEqual(story(small));
  });
});

describe('PL-3 a chapter can move into another part', () => {
  const parts = (extra.parts ?? []) as Record<string, unknown>[];
  const books = (extra.books ?? []) as Record<string, unknown>[];
  const chapters = [
    { _id: 'c1', title: 'c1', partId: 'P1', readingOrder: 1, ...base },
    { _id: 'c2', title: 'c2', partId: 'P1', readingOrder: 2, ...base },
    { _id: 'c3', title: 'c3', partId: 'P2', readingOrder: 3, ...base },
    { _id: 'c4', title: 'c4', partId: 'P2', readingOrder: 4, ...base },
  ];

  test('PL-3 moving into the middle of the next part takes its place and part, and renumbers both parts', () => {
    expect(moveChapter(chapters, parts, books, 'c1', 'P2', 1)).toEqual([
      { id: 'c2', readingOrder: 1, partId: 'P1' },
      { id: 'c3', readingOrder: 2, partId: 'P2' },
      { id: 'c1', readingOrder: 3, partId: 'P2' },
    ]);
  });

  test('PL-3 moving up into the earlier part at its start', () => {
    expect(moveChapter(chapters, parts, books, 'c4', 'P1', 0)).toEqual([
      { id: 'c4', readingOrder: 1, partId: 'P1' },
      { id: 'c1', readingOrder: 2, partId: 'P1' },
      { id: 'c2', readingOrder: 3, partId: 'P1' },
      { id: 'c3', readingOrder: 4, partId: 'P2' },
    ]);
  });

  test('PL-3 an index past the end puts the chapter last in the target part', () => {
    const r = moveChapter(chapters, parts, books, 'c1', 'P2', 99);
    expect(r.find((p) => p.id === 'c1')).toEqual({ id: 'c1', readingOrder: 4, partId: 'P2' });
  });

  test('PL-3 a move inside one part reuses that part numbers and leaves the other part alone', () => {
    expect(moveChapter(chapters, parts, books, 'c2', 'P1', 0)).toEqual([
      { id: 'c2', readingOrder: 1, partId: 'P1' },
      { id: 'c1', readingOrder: 2, partId: 'P1' },
    ]);
  });

  test('PL-3 moving the only chapter out of a part leaves that part empty and the numbers unique', () => {
    const lone = [chapters[0]!, chapters[2]!, chapters[3]!].map((c, i) => ({
      ...c,
      readingOrder: i + 1,
    }));
    const r = moveChapter(lone, parts, books, 'c1', 'P2', 0);
    const finalPart = new Map(lone.map((c) => [c._id, c.partId]));
    const finalOrder = new Map(lone.map((c) => [c._id, c.readingOrder]));
    for (const p of r) {
      finalPart.set(p.id, p.partId);
      finalOrder.set(p.id, p.readingOrder);
    }
    expect([...finalPart.values()]).toEqual(['P2', 'P2', 'P2']);
    expect(new Set(finalOrder.values()).size).toBe(3);
  });
});

describe('PL-4 the chapter page', () => {
  test('PL-4 Two Kitchens shows each strand with ages in that strand year', () => {
    const page = chapterPage(data, 'CH2');
    expect(page?.title).toBe('Two Kitchens');
    const present = page?.strands.find((s) => s.primary);
    expect(present?.startYear).toBe(2045);
    const iris = present?.characters.find((c) => c.id === 'H5');
    expect(iris?.state).toEqual({ state: 'alive', age: 14, dyingThisYear: false });
    const back = page?.strands.find((s) => !s.primary);
    expect(back?.characters.find((c) => c.id === 'H5')?.state).toEqual({
      state: 'alive',
      age: 1,
      dyingThisYear: false,
    });
  });

  test('PL-4 the chapter page lists places per strand, with their parent places', () => {
    const kitchens = chapterPage(data, 'CH2');
    expect(kitchens?.strands.find((s) => s.primary)?.places).toEqual([
      { id: 'PLC2', name: 'Portland > The Hale house' },
    ]);
    expect(kitchens?.strands.find((s) => !s.primary)?.places).toEqual([
      { id: 'PLC3', name: 'Guangzhou' },
    ]);
    expect(chapterPage(data, 'CH7')?.strands[0]?.places.map((p) => p.name)).toEqual(['Guangzhou']);
    expect(chapterPage(data, 'CH4')?.strands[0]?.places).toEqual([]);
    expect(chapterPage(data, 'nope')).toBeNull();
  });
});

describe('PL-3 undo for a reorder', () => {
  test('PL-3 one command puts every old number back, and redo applies the new ones', () => {
    const cmd = reorderCommand('Moved Second', 'chapters', [
      {
        id: 'a',
        before: { readingOrder: 2, partId: 'P2' },
        after: { readingOrder: 1, partId: 'P1' },
      },
      {
        id: 'b',
        before: { readingOrder: 1, partId: 'P1' },
        after: { readingOrder: 2, partId: 'P1' },
      },
    ]);
    expect(cmd.undo.map((o) => o.kind === 'update' && [o.id, o.patch, o.expect])).toEqual([
      ['a', { readingOrder: 2, partId: 'P2' }, { readingOrder: 1, partId: 'P1' }],
      ['b', { readingOrder: 1, partId: 'P1' }, { readingOrder: 2, partId: 'P1' }],
    ]);
    expect(cmd.redo.map((o) => o.kind === 'update' && [o.id, o.patch])).toEqual([
      ['a', { readingOrder: 1, partId: 'P1' }],
      ['b', { readingOrder: 2, partId: 'P1' }],
    ]);
  });
});
