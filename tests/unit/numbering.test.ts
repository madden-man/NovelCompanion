import { describe, expect, test } from 'vitest';
import {
  bareTitle,
  groupLabel,
  planTitleCleanup,
  splitNumberedTitle,
} from '../../src/shared/domain/numbering';
import { outlineGrid } from '../../src/shared/domain/outline';
import { structuralFindings } from '../../src/shared/domain/continuity/structural';
import type { ParsedWorkbook, TableMapping } from '../../src/shared/domain/import';
import { SimBible } from '../helpers/importSim';

describe('PL-3 a structural number in a title is found and set aside', () => {
  test('PL-3 chapter, part, and book numbers come off the front of a title, the name stays', () => {
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
    expect(splitNumberedTitle('book', 'Book One')).toEqual({ number: 1, name: '' });
    expect(splitNumberedTitle('book', 'Book Two: I Take Refuge in You')).toEqual({
      number: 2,
      name: 'I Take Refuge in You',
    });
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
    expect(splitNumberedTitle('book', 'Book of Ruth')).toBeNull();
    expect(bareTitle('book', 'Book One')).toBe('Book One');
    expect(bareTitle('chapter', 'Ch. 9: HaoYu and Family Break')).toBe('HaoYu and Family Break');
  });
});

describe('PL-3 the shown book, part, and chapter numbers come from the number fields', () => {
  test('PL-3 a part label takes its number from the number field, never from the title', () => {
    expect(groupLabel('part', 2, 'Lost Spirits')).toBe('Part 2: Lost Spirits');
    expect(groupLabel('part', 2, 'Part Two: Lost Spirits')).toBe('Part 2: Lost Spirits');
    expect(groupLabel('book', 1, 'Book One')).toBe('Book 1');
    // A title that disagrees with the field is shown whole after the field's number.
    expect(groupLabel('part', 3, 'Part Two: Lost Spirits')).toBe('Part 3: Part Two: Lost Spirits');
    expect(groupLabel('part', null, 'Lost Spirits')).toBe('Part: Lost Spirits');
  });

  test('PL-3 the outline rows show book and part numbers from their fields after a reorder', () => {
    const base = { status: 'planned', createdAt: 'x', modifiedAt: 'x' };
    const docs: Record<string, Record<string, unknown>[]> = {
      books: [{ _id: 'B1', title: 'Book One', number: 1, ...base }],
      parts: [
        { _id: 'P1', title: 'Roots', bookId: 'B1', number: 2, ...base },
        { _id: 'P2', title: 'Part One: Branches', bookId: 'B1', number: 1, ...base },
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
    expect(labels).toEqual(['Book 1', 'Part 1: Branches', 3, 'Part 2: Roots', 7]);
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

describe('IM-1 IM-3 the import keeps a structural number in the number field, not the title', () => {
  const sheet = (rows: (string | number | null)[][]): ParsedWorkbook => ({
    fileName: 'plan.xlsx',
    modifiedAt: '2026-01-15T09:00:00.000Z',
    sheets: [{ name: 'Plan', cells: rows, merges: [] }],
  });
  const mapping: TableMapping = {
    shape: 'table',
    sheet: 'Plan',
    target: { collection: 'chapters' },
    headerRow: 1,
    columns: [
      { header: 'Chapter', index: 0, field: 'title' },
      { header: 'Year', index: 1, field: 'strand.startYear' },
    ],
    identity: ['title'],
    fixed: { status: 'planned' },
    addMissingListItems: false,
    createMissing: false,
    matchIn: 'sheet',
    headings: [
      {
        collection: 'books',
        match: 'single',
        labelPattern: '^Book\\b',
        linkField: 'bookId',
        numberField: 'number',
        fixed: {},
      },
      {
        collection: 'parts',
        match: 'single',
        labelPattern: '^Part\\b',
        linkField: 'partId',
        parentLinkField: 'bookId',
        numberField: 'number',
        fixed: {},
      },
    ],
  };
  const rows = [
    ['Chapter', 'Year'],
    ['Book One: Roots and Branches', null],
    ['Part One: Sins of the Father', null],
    ['Ch. 1: Mark Feels Free', 2055],
    ['Ch. 2: Mark Meets Dawn', 2055],
    ['Part Two: Lost Spirits', null],
    ['Ch. 1: Dawn is Shy', 2051],
    ['Ch. 7: Dawn is Slutty', 2051],
    ['Part Four: Circulation', null],
    ['Attachments', 2080],
  ];

  test('IM-1 PL-3 chapter, part, and book titles keep the name; numbers go to the number field and reading order', () => {
    const sim = SimBible.empty();
    const { rows: out, set } = sim.plan(sheet(rows), mapping);
    expect(set.failed).toEqual([]);
    const of = (c: string) => out.rows.filter((r) => r.ok && r.collection === c);
    expect(of('books').map((r) => [r.data.title, r.data.number])).toEqual([
      ['Roots and Branches', 1],
    ]);
    expect(of('parts').map((r) => r.data.title)).toEqual([
      'Sins of the Father',
      'Lost Spirits',
      'Part Four: Circulation',
    ]);
    expect(of('chapters').map((r) => [r.data.title, r.data.readingOrder])).toEqual([
      ['Mark Feels Free', 1],
      ['Mark Meets Dawn', 2],
      ['Dawn is Shy', 3],
      ['Ch. 7: Dawn is Slutty', 4],
      ['Attachments', 5],
    ]);
    // A number that disagrees with the place is not guessed at: the title stays whole and the report says why.
    expect(out.notes.join(' ')).toContain(
      '"Ch. 7: Dawn is Slutty" says chapter 7 but is chapter 2 of its part and chapter 4 of the sheet',
    );
    expect(out.notes.join(' ')).toContain(
      '"Part Four: Circulation" says part 4 but is part 3 here',
    );
  });

  test('IM-3 PL-3 a re-import finds entries whether their titles still carry the number or not', () => {
    const sim = SimBible.empty();
    sim.apply(sim.plan(sheet(rows), mapping).set);
    const count = () => ['books', 'parts', 'chapters'].map((c) => sim.entries(c as never).length);
    const before = count();
    // A bible imported before this change still holds the numbered titles.
    const numbered: Record<string, string> = {
      'Roots and Branches': 'Book One: Roots and Branches',
      'Sins of the Father': 'Part One: Sins of the Father',
      'Mark Feels Free': 'Ch. 1: Mark Feels Free',
    };
    for (const c of ['books', 'parts', 'chapters']) {
      for (const d of sim.entries(c as never)) {
        const old = numbered[String(d.title)];
        if (old) d.title = old;
      }
    }
    const again = sim.plan(sheet(rows), mapping).set;
    expect(again.items.filter((i) => i.kind === 'new')).toEqual([]);
    expect(again.failed).toEqual([]);
    sim.apply(again);
    expect(count()).toEqual(before);
    // And once the titles are cleaned, a re-import reports no change at all.
    for (const c of ['books', 'parts', 'chapters']) {
      for (const d of sim.entries(c as never)) {
        const n = Object.entries(numbered).find(([, v]) => v === d.title)?.[0];
        if (n) d.title = n;
      }
    }
    const clean = sim.plan(sheet(rows), mapping).set;
    expect(clean.items).toEqual([]);
  });
});

describe('IM-1 a Word chapter is named without its heading number', () => {
  test('IM-1 PL-3 "Chapter 3: The Storm" becomes a chapter named "The Storm", placed by reading order', async () => {
    const { planDocument } = await import('../../src/shared/domain/import');
    let n = 0;
    const set = planDocument({
      file: { fileName: 'storm.docx', modifiedAt: '2026-01-15T09:00:00.000Z' },
      body: '<p>Rain.</p>',
      span: { first: 1, last: 2 },
      target: {
        kind: 'chapter',
        chapterId: null,
        title: 'Chapter 3: The Storm',
        partId: 'P1',
        year: 2040,
      },
      entries: () => [],
      sources: () => [],
      newId: () => `N${++n}`,
    });
    expect(set.failed).toEqual([]);
    const item = set.items[0]!;
    expect(item.title).toBe('The Storm');
    expect(item.data).toMatchObject({ title: 'The Storm', readingOrder: 1 });
    expect(set.notes.join(' ')).toContain('says chapter 3');
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
      books: [
        { _id: 'B1', title: 'Book One', number: 1 },
        { _id: 'B2', title: 'Book Two: I Take Refuge in You', number: 2 },
      ],
      parts: [
        { _id: 'P1', title: 'Part One: Sins of the Father', bookId: 'B1', number: 1 },
        { _id: 'P2', title: 'Part Two: Lost Spirits', bookId: 'B1', number: 2 },
        { _id: 'P3', title: 'Part Three: Claws', bookId: 'B2', number: 1 },
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
      ['B2', 'I Take Refuge in You'],
      ['P1', 'Sins of the Father'],
      ['P2', 'Lost Spirits'],
      ['C3', 'Mark Gets Drunk'],
      ['C4', 'Dawn is Shy'],
    ]);
    expect(plan.numberOnly.map((r) => r.id)).toEqual(['B1']);
    expect(plan.disagreements).toEqual([
      {
        collection: 'parts',
        id: 'P3',
        title: 'Part Three: Claws',
        says: 3,
        is: 'part number 1',
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
