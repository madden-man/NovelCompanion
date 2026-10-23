import { describe, expect, test } from 'vitest';
import {
  moveNumbered,
  newChapterPlace,
  nextNumber,
  outlineGrid,
} from '../../src/shared/domain/outline';

const at = '2026-01-15T09:00:00.000Z';
const base = { createdAt: at, modifiedAt: at };
const strand = (id: string, year: number, extra: Record<string, unknown> = {}) => ({
  id,
  label: id,
  startYear: year,
  endYear: null,
  primary: true,
  povCharacterId: null,
  characterIds: [],
  placeIds: [],
  ...extra,
});

const parts = [
  { _id: 'P4', title: 'Four', number: 4, ...base },
  { _id: 'P1', title: 'One', number: 1, ...base },
  { _id: 'P2', title: 'Two', number: 2, ...base },
  { _id: 'P3', title: 'Empty', number: 3, ...base },
];
const chapters = [
  { _id: 'C1', title: 'c1', partId: 'P1', readingOrder: 1, strands: [strand('s1', 2040)], ...base },
  { _id: 'C2', title: 'c2', partId: 'P1', readingOrder: 2, strands: [strand('s2', 2041)], ...base },
  { _id: 'C3', title: 'c3', partId: 'P2', readingOrder: 3, strands: [strand('s3', 2042)], ...base },
  { _id: 'C4', title: 'c4', partId: 'P4', readingOrder: 4, strands: [strand('s4', 2043)], ...base },
];
const characters = [
  { _id: 'H1', title: 'Ruth', names: { full: 'Ruth Hale' }, ...base },
  { _id: 'H2', title: 'Iris', names: { full: 'Iris Hale' }, ...base },
];
const data = (more: Record<string, Record<string, unknown>[]> = {}) => ({
  all: (c: string) =>
    (({ parts, chapters, characters, ...more }) as Record<string, Record<string, unknown>[]>)[c] ??
    [],
});

describe('KB-3 one outline holds every part', () => {
  test('KB-3 parts sort by number and an empty part still gets a heading, with the counts', () => {
    const g = outlineGrid(data(), { order: 'reading' });
    expect(g.rows.map((r) => (r.kind === 'chapter' ? r.id : `${r.kind}:${r.id}`))).toEqual([
      'part:P1',
      'C1',
      'C2',
      'part:P2',
      'C3',
      'part:P3',
      'part:P4',
      'C4',
    ]);
    const counts = g.rows.flatMap((r) => (r.kind === 'part' ? [[r.id, r.chapterCount]] : []));
    expect(counts).toEqual([
      ['P1', 2],
      ['P2', 1],
      ['P3', 0],
      ['P4', 1],
    ]);
    expect(g.rows.find((r) => r.kind === 'part' && r.id === 'P2')).toMatchObject({
      label: 'Part 2: Two',
      missing: false,
    });
  });

  test('KB-3 a chapter whose part is in the trash sits under a No part heading marked missing', () => {
    const trashed = parts.map((p) => (p._id === 'P2' ? { ...p, deletedAt: at } : p));
    const g = outlineGrid(
      { all: (c: string) => (c === 'parts' ? trashed : data().all(c)) },
      { order: 'reading' },
    );
    const missing = g.rows.find((r) => r.kind === 'part' && r.id === 'P2');
    expect(missing).toMatchObject({ kind: 'part', missing: true, chapterCount: 1 });
    expect(g.rows[0]).toBe(missing);
    expect(g.rows.filter((r) => r.kind === 'chapter')).toHaveLength(4);
    expect(missing).toMatchObject({ label: 'No part' });
  });

  test('KB-3 each strand carries its point of view and the characters present, by name', () => {
    const c = {
      ...chapters[0],
      strands: [strand('s1', 2040, { povCharacterId: 'H2', characterIds: ['H2', 'H1'] })],
    };
    const g = outlineGrid(
      { all: (k: string) => (k === 'chapters' ? [c] : data().all(k)) },
      { order: 'reading' },
    );
    const row = g.rows.find((r) => r.kind === 'chapter');
    expect(row?.kind === 'chapter' && row.strands[0]).toMatchObject({
      pov: 'Iris Hale',
      present: ['Iris Hale', 'Ruth Hale'],
    });
  });
});

describe('KB-3 parts move by number', () => {
  test('KB-3 moving a part hands the parts the same numbers in the new order', () => {
    const three = parts.filter((p) => p._id !== 'P4');
    expect(moveNumbered(three, 'P3', 0)).toEqual([
      { id: 'P3', number: 1 },
      { id: 'P1', number: 2 },
      { id: 'P2', number: 3 },
    ]);
    expect(moveNumbered(three, 'P1', 1)).toEqual([
      { id: 'P2', number: 1 },
      { id: 'P1', number: 2 },
    ]);
  });

  test('KB-3 parts numbered from above 1 keep their range', () => {
    const later = [
      { _id: 'Q1', title: 'a', number: 4, ...base },
      { _id: 'Q2', title: 'b', number: 5, ...base },
    ];
    expect(moveNumbered(later, 'Q2', 0)).toEqual([
      { id: 'Q2', number: 4 },
      { id: 'Q1', number: 5 },
    ]);
  });

  test('KB-3 two parts that share a number are numbered from the lowest up', () => {
    const clash = [
      { _id: 'R1', title: 'a', number: 1, ...base },
      { _id: 'R2', title: 'b', number: 1, ...base },
      { _id: 'R3', title: 'c', number: 2, ...base },
    ];
    expect(moveNumbered(clash, 'R3', 0)).toEqual([
      { id: 'R3', number: 1 },
      { id: 'R1', number: 2 },
      { id: 'R2', number: 3 },
    ]);
  });

  test('KB-3 a new part takes the number after the highest, and 1 when there is none', () => {
    expect(nextNumber(parts)).toBe(5);
    expect(nextNumber([])).toBe(1);
    expect(nextNumber([{ _id: 'x', number: 7, deletedAt: at }])).toBe(1);
  });
});

describe('KB-3 a new chapter goes last in its part', () => {
  test('KB-3 at the end of an early part it takes the next number and later chapters move up', () => {
    expect(newChapterPlace(chapters, parts, 'P1')).toEqual({
      readingOrder: 3,
      shifts: [
        { id: 'C3', readingOrder: 4, partId: 'P2' },
        { id: 'C4', readingOrder: 5, partId: 'P4' },
      ],
    });
  });

  test('KB-3 at the end of the last part nothing else moves', () => {
    expect(newChapterPlace(chapters, parts, 'P4')).toEqual({ readingOrder: 5, shifts: [] });
  });

  test('KB-3 in an empty part it follows the chapters of the parts before it', () => {
    expect(newChapterPlace(chapters, parts, 'P3')).toEqual({
      readingOrder: 4,
      shifts: [{ id: 'C4', readingOrder: 5, partId: 'P4' }],
    });
  });

  test('A37 made from the scene outline it goes right after the named chapter of the part', () => {
    expect(newChapterPlace(chapters, parts, 'P1', 'C1')).toEqual({
      readingOrder: 2,
      shifts: [
        { id: 'C2', readingOrder: 3, partId: 'P1' },
        { id: 'C3', readingOrder: 4, partId: 'P2' },
        { id: 'C4', readingOrder: 5, partId: 'P4' },
      ],
    });
    // A chapter of another part is ignored: it goes last in the part asked for.
    expect(newChapterPlace(chapters, parts, 'P1', 'C3').readingOrder).toBe(3);
  });

  test('KB-3 a gap in the reading order absorbs the shift', () => {
    const gappy = chapters.map((c) => (c._id === 'C4' ? { ...c, readingOrder: 10 } : c));
    expect(newChapterPlace(gappy, parts, 'P1')).toEqual({
      readingOrder: 3,
      shifts: [{ id: 'C3', readingOrder: 4, partId: 'P2' }],
    });
  });

  test('KB-3 the first chapter of an empty outline is number 1', () => {
    expect(newChapterPlace([], parts, 'P1')).toEqual({ readingOrder: 1, shifts: [] });
  });
});
