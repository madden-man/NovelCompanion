import { describe, expect, test } from 'vitest';
import {
  beatOrderIn,
  beatsOfArc,
  chapterPage,
  moveChapter,
  outlineGrid,
  reorder,
  reorderBeatsInArc,
} from '../../src/shared/domain/outline';
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
  arcs: [
    {
      _id: 'A1',
      title: 'Book',
      name: 'The whole book',
      scope: 'book',
      familyId: null,
      ownerCharacterId: null,
      startYear: 2030,
      endYear: 2080,
      ...base,
    },
    {
      _id: 'A2',
      title: 'Iris',
      name: 'Iris arc',
      scope: 'character',
      familyId: null,
      ownerCharacterId: 'C1',
      startYear: null,
      endYear: null,
      ...base,
    },
  ],
  chapters: [
    {
      _id: 'X3',
      title: 'Third',
      partId: 'P2',
      readingOrder: 3,
      strands: [strand('a', 2031)],
      arcIds: ['A1'],
      ...base,
    },
    {
      _id: 'X1',
      title: 'First',
      partId: 'P1',
      readingOrder: 1,
      strands: [strand('b', 2075), strand('c', 2040, false, 2042)],
      arcIds: ['A1', 'A2'],
      ...base,
    },
    {
      _id: 'X2',
      title: 'Second',
      partId: 'P1',
      readingOrder: 2,
      strands: [strand('d', 2050)],
      arcIds: [],
      ...base,
    },
  ],
};
const small = { all: (c: string) => extra[c] ?? [] };

describe('PL-1 arcs, chapters, and beats', () => {
  test('PL-1 a chapter can belong to several arcs and each arc is drawn as its own span', () => {
    const g = outlineGrid(small, { order: 'reading' });
    const first = g.rows.find((r) => r.kind === 'chapter' && r.id === 'X1');
    expect(first?.kind === 'chapter' && first.arcSpans.map((s) => s.arcId)).toEqual(['A1', 'A2']);
  });

  test('PL-1 the fixture grid has one chapter row per chapter, grouped under the book and part', () => {
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
      { id: 'b', label: 'b', primary: true, startYear: 2075, endYear: 2075 },
      { id: 'c', label: 'c', primary: false, startYear: 2040, endYear: 2042 },
    ]);
    expect(g.years[0]).toBe(2030);
    expect(g.years.at(-1)).toBe(2090);
    expect(g.cursorYear).toBe(2090);
  });

  test('PL-2 an arc span uses its own years, else the chapter strands, in the owner family color', () => {
    const g = outlineGrid(small, { order: 'reading' });
    const first = g.rows.find((r) => r.kind === 'chapter' && r.id === 'X1');
    if (first?.kind !== 'chapter') throw new Error('missing');
    expect(first.arcSpans).toEqual([
      {
        arcId: 'A1',
        name: 'The whole book',
        scope: 'book',
        color: 'series-4',
        from: 2030,
        to: 2080,
      },
      {
        arcId: 'A2',
        name: 'Iris arc',
        scope: 'character',
        color: 'series-3',
        from: 2040,
        to: 2075,
      },
    ]);
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

  test('PL-3 beats are numbered 1 to n and an unmoved item is not returned', () => {
    const beats = [
      { id: 'a', value: 1 },
      { id: 'b', value: 2 },
      { id: 'c', value: 3 },
    ];
    expect(reorder(beats, 'a', 1, 'sequence')).toEqual([
      { id: 'b', value: 1 },
      { id: 'a', value: 2 },
    ]);
    expect(reorder(beats, 'b', 1, 'sequence')).toEqual([]);
    expect(reorder(beats, 'missing', 0, 'sequence')).toEqual([]);
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

describe('PL-3 beat order is stored per arc', () => {
  const beat = (id: string, arcOrders: { arcId: string; order: number }[]) => ({
    _id: id,
    title: id,
    arcIds: arcOrders.map((o) => o.arcId),
    arcOrders,
    ...base,
  });
  const beats = [
    beat('b1', [{ arcId: 'A1', order: 1 }]),
    beat('b2', [
      { arcId: 'A1', order: 2 },
      { arcId: 'A2', order: 1 },
    ]),
    beat('b3', [
      { arcId: 'A1', order: 3 },
      { arcId: 'A2', order: 2 },
    ]),
  ];

  test('PL-3 a beat in two arcs has a position in each', () => {
    expect(beatOrderIn(beats[1]!, 'A1')).toBe(2);
    expect(beatOrderIn(beats[1]!, 'A2')).toBe(1);
    expect(beatsOfArc(beats, 'A2').map((b) => b._id)).toEqual(['b2', 'b3']);
  });

  test('PL-3 reordering in one arc renumbers only that arc and keeps the position in the other', () => {
    const patches = reorderBeatsInArc(beats, 'A1', 'b3', 0);
    expect(patches).toEqual([
      {
        id: 'b3',
        arcOrders: [
          { arcId: 'A2', order: 2 },
          { arcId: 'A1', order: 1 },
        ],
      },
      { id: 'b1', arcOrders: [{ arcId: 'A1', order: 2 }] },
      {
        id: 'b2',
        arcOrders: [
          { arcId: 'A2', order: 1 },
          { arcId: 'A1', order: 3 },
        ],
      },
    ]);
    // Applying it leaves A2 exactly as it was.
    const applied = beats.map((b) => {
      const p = patches.find((x) => x.id === b._id);
      return p ? { ...b, arcOrders: p.arcOrders } : b;
    });
    expect(beatsOfArc(applied, 'A1').map((b) => b._id)).toEqual(['b3', 'b1', 'b2']);
    expect(beatsOfArc(applied, 'A2').map((b) => [b._id, beatOrderIn(b, 'A2')])).toEqual([
      ['b2', 1],
      ['b3', 2],
    ]);
  });

  test('PL-3 a beat with no position in an arc yet is added to the numbering', () => {
    const loose = [...beats, { _id: 'b4', title: 'b4', arcIds: ['A2'], arcOrders: [], ...base }];
    const patches = reorderBeatsInArc(loose, 'A2', 'b4', 0);
    expect(patches.find((p) => p.id === 'b4')?.arcOrders).toEqual([{ arcId: 'A2', order: 1 }]);
    expect(patches.find((p) => p.id === 'b2')?.arcOrders).toContainEqual({ arcId: 'A1', order: 2 });
  });

  test('PL-4 the chapter page orders beats by the first of the chapter arcs they belong to', () => {
    const d = {
      all: (c: string) =>
        ({ ...extra, plotBeats: beats.map((b) => ({ ...b, chapterId: 'X1' })) })[c] ?? [],
    };
    // X1 lists A1 first, so A1 positions rule: b1, b2, b3.
    expect(chapterPage(d, 'X1')?.beats.map((b) => b.id)).toEqual(['b1', 'b2', 'b3']);
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
  });

  test('PL-4 Wedding Weather lists the fact in play with who acts on it', () => {
    const page = chapterPage(data, 'CH3');
    expect(page?.factsInPlay).toEqual([
      {
        factId: 'F1',
        fact: 'Meiling was engaged before Wei',
        characterId: 'Z3',
        character: expect.any(String),
        note: "Lan hides her mother's old letters from Daniel.",
      },
    ]);
  });

  test('PL-4 beats come in order with their arcs, and themes come only from the theme appearances', () => {
    const d = {
      all: (c: string) =>
        ({
          ...extra,
          plotBeats: [
            {
              _id: 'T2',
              title: 'Later',
              chapterId: 'X1',
              arcIds: ['A2'],
              arcOrders: [{ arcId: 'A2', order: 2 }],
              year: 2075,
              description: 'd',
              ...base,
            },
            {
              _id: 'T1',
              title: 'Earlier',
              chapterId: 'X1',
              arcIds: ['A1', 'A2'],
              arcOrders: [
                { arcId: 'A1', order: 1 },
                { arcId: 'A2', order: 1 },
              ],
              year: null,
              description: '',
              ...base,
            },
            { _id: 'T3', title: 'Elsewhere', chapterId: 'X2', arcIds: [], arcOrders: [], ...base },
          ],
          themes: [
            {
              _id: 'H1',
              title: 'Water',
              appearances: [{ chapterId: 'X1', note: 'Rain' }],
              ...base,
            },
          ],
        })[c] ?? [],
    };
    const page = chapterPage(d, 'X1');
    expect(page?.beats.map((b) => [b.title, b.arcs])).toEqual([
      ['Earlier', ['The whole book', 'Iris arc']],
      ['Later', ['Iris arc']],
    ]);
    expect(page?.themes).toEqual([{ id: 'H1', title: 'Water', note: 'Rain' }]);
    expect(chapterPage(d, 'nope')).toBeNull();
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
