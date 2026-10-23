import { describe, expect, test } from 'vitest';
import {
  bareTitle,
  groupLabel,
  planTitleCleanup,
  splitNumberedTitle,
} from '../../src/shared/domain/numbering';
import { outlineGrid } from '../../src/shared/domain/outline';
import { structuralFindings } from '../../src/shared/domain/continuity/structural';

describe('PL-3 a structural number in a title is found and set aside', () => {
  test('PL-3 chapter and part numbers come off the front of a title, the name stays', () => {
    expect(splitNumberedTitle('chapter', 'Ch. 1: Mark Feels Free')).toEqual({
      number: 1,
      name: 'Mark Feels Free',
    });
    expect(splitNumberedTitle('chapter', 'Chapter 12 - Turn')).toEqual({
      number: 12,
      name: 'Turn',
    });
    expect(splitNumberedTitle('chapter', 'Ch 4 Mark Can’t Work')).toEqual({
      number: 4,
      name: 'Mark Can’t Work',
    });
    expect(splitNumberedTitle('chapter', 'Chapter Twelve: Turn')).toEqual({
      number: 12,
      name: 'Turn',
    });
    expect(splitNumberedTitle('chapter', 'Chapter IV. The Storm')).toEqual({
      number: 4,
      name: 'The Storm',
    });
    expect(splitNumberedTitle('chapter', '3: The Storm')).toEqual({ number: 3, name: 'The Storm' });
    expect(splitNumberedTitle('part', 'Part One: Sins of the Father')).toEqual({
      number: 1,
      name: 'Sins of the Father',
    });
    expect(splitNumberedTitle('part', 'Part One')).toEqual({ number: 1, name: '' });
  });

  test('PL-3 a title that only looks numbered keeps its name whole', () => {
    for (const t of [
      'Mark Meets Dawn',
      '1 Something else',
      '1984 Was Hot',
      'China: Oil',
      'Chapters with no part named',
      'Ch. I Am Here',
      'Introduction',
    ]) {
      expect(splitNumberedTitle('chapter', t)).toBeNull();
    }
    expect(splitNumberedTitle('part', 'Part Time Lover')).toBeNull();
    expect(bareTitle('part', 'Part One')).toBe('Part One');
    expect(bareTitle('chapter', 'Ch. 9: HaoYu and Family Break')).toBe('HaoYu and Family Break');
  });
});

describe('PL-3 the shown part and chapter numbers come from the number fields', () => {
  test('PL-3 a part label takes its number from the number field, never from the title', () => {
    expect(groupLabel('part', 2, 'Lost Spirits')).toBe('Part 2: Lost Spirits');
    expect(groupLabel('part', 2, 'Part Two: Lost Spirits')).toBe('Part 2: Lost Spirits');
    expect(groupLabel('part', 1, 'Part One')).toBe('Part 1');
    // A title that disagrees with the field is shown whole after the field's number.
    expect(groupLabel('part', 3, 'Part Two: Lost Spirits')).toBe('Part 3: Part Two: Lost Spirits');
    expect(groupLabel('part', null, 'Lost Spirits')).toBe('Part: Lost Spirits');
  });

  test('PL-3 the outline rows show part numbers from their fields after a reorder', () => {
    const base = { status: 'planned', createdAt: 'x', modifiedAt: 'x' };
    const docs: Record<string, Record<string, unknown>[]> = {
      parts: [
        { _id: 'P1', title: 'Roots', number: 2, ...base },
        { _id: 'P2', title: 'Part One: Branches', number: 1, ...base },
      ],
      chapters: [
        {
          _id: 'C1',
          title: 'Ch. 1: Ann',
          partId: 'P1',
          readingOrder: 7,
          strands: [{ id: 's1', label: 'present', startYear: 2000, primary: true }],
          ...base,
        },
        {
          _id: 'C2',
          title: 'Ben',
          partId: 'P2',
          readingOrder: 3,
          strands: [{ id: 's1', label: 'present', startYear: 2001, primary: true }],
          ...base,
        },
      ],
    };
    const g = outlineGrid({ all: (c: string) => docs[c] ?? [] }, { order: 'reading' });
    const labels = g.rows.map((r) => (r.kind === 'chapter' ? r.readingOrder : r.label));
    expect(labels).toEqual(['Part 1: Branches', 3, 'Part 2: Roots', 7]);
  });

  test('PL-3 a continuity finding names a chapter by its reading order, never by a number in its title', () => {
    const base = { status: 'planned', createdAt: 'x', modifiedAt: 'x', deletedAt: null };
    const docs: Record<string, Record<string, unknown>[]> = {
      characters: [
        {
          _id: 'H1',
          title: 'Ann',
          names: { full: 'Ann' },
          birth: { year: 2050 },
          ...base,
        },
      ],
      chapters: [
        {
          _id: 'C1',
          title: 'Ch. 9: Too Early',
          partId: 'P1',
          readingOrder: 4,
          strands: [
            {
              id: 's1',
              label: 'present',
              startYear: 2001,
              primary: true,
              povCharacterId: 'H1',
              characterIds: ['H1'],
            },
          ],
          ...base,
        },
      ],
    };
    const found = structuralFindings({ all: (c: string) => docs[c] ?? [] } as never);
    const text = JSON.stringify(found);
    expect(text).toContain('Chapter 4');
    expect(text).not.toContain('Chapter 9');
  });
});

describe('PL-3 the title cleanup of a bible renames only titles whose number agrees with where the entry is', () => {
  test('PL-3 numbers are checked against the place in the part (after an introduction), and a disagreement is listed, not renamed', () => {
    const ch = (id: string, title: string, partId: string, readingOrder: number) => ({
      _id: id,
      title,
      partId,
      readingOrder,
    });
    const docs: Record<string, Record<string, unknown>[]> = {
      parts: [
        { _id: 'P1', title: 'Part One: Sins of the Father', number: 1 },
        { _id: 'P2', title: 'Part Two: Lost Spirits', number: 2 },
        { _id: 'P3', title: 'Part Three: Claws', number: 4 },
        { _id: 'P4', title: 'Part Five', number: 5 },
      ],
      chapters: [
        ch('C0', 'Introduction', 'P1', 1),
        ch('C1', 'Mark Meets Dawn', 'P1', 2),
        ch('C2', 'Mark Feels Free', 'P1', 3),
        ch('C3', 'Ch. 3: Mark Gets Drunk', 'P1', 4),
        ch('C4', 'Ch. 1: Dawn is Shy', 'P2', 5),
        ch('C5', 'Ch. 9: Dawn is Slutty', 'P2', 6),
        { ...ch('C6', 'Ch. 2: In the trash', 'P2', 7), deletedAt: '2026-01-01T00:00:00.000Z' },
      ],
    };
    const plan = planTitleCleanup({ all: (c) => docs[c] ?? [] });
    expect(plan.renames.map((r) => [r.id, r.to])).toEqual([
      ['P1', 'Sins of the Father'],
      ['P2', 'Lost Spirits'],
      ['C3', 'Mark Gets Drunk'],
      ['C4', 'Dawn is Shy'],
    ]);
    expect(plan.numberOnly.map((r) => r.id)).toEqual(['P4']);
    expect(plan.disagreements).toEqual([
      {
        collection: 'parts',
        id: 'P3',
        title: 'Part Three: Claws',
        says: 3,
        is: 'part number 4',
      },
      {
        collection: 'chapters',
        id: 'C5',
        title: 'Ch. 9: Dawn is Slutty',
        says: 9,
        is: 'reading order 6, chapter 2 of its part',
      },
    ]);
  });
});
