import { describe, expect, test } from 'vitest';
import {
  conflictQuestion,
  mappingKey,
  parseYear,
  parseYearHeader,
} from '../../src/shared/domain/import';
import type { GridMapping, Mapping, TableMapping } from '../../src/shared/domain/import';
import { SimBible, fixtureWorkbook } from '../helpers/importSim';

const FILE = { fileName: 'fixture-workbook.xlsx', modifiedAt: '2026-01-15T09:00:00.000Z' };

const people: TableMapping = {
  shape: 'table',
  sheet: 'People',
  target: { collection: 'characters' },
  headerRow: 1,
  columns: [
    { header: 'Name', index: 1, field: 'title' },
    { header: 'Chinese name', index: 2, field: 'names.chinese' },
    { header: 'Born', index: 3, field: 'birth' },
    { header: 'Died', index: 4, field: 'death' },
    { header: 'Family', index: 5, field: 'familyIds' },
    { header: 'Notes', index: 6, field: 'sourceNote' },
  ],
  identity: ['title'],
  fixed: { status: 'canon', provenance: 'invented' },
  addMissingListItems: false,
  createMissing: true,
  matchIn: 'sheet',
  headings: [],
};

const grid: GridMapping = {
  shape: 'grid',
  sheet: 'High Level',
  target: { collection: 'worldEvents' },
  headerRow: null,
  labelColumn: 0,
  yearOffset: 0,
  categoryRoot: null,
  categoryList: 'eventCategories',
  fixed: { status: 'canon' },
  addMissingListItems: true,
  createMissing: false,
  matchIn: 'sheet',
};

describe('IM-1 the mapping engine reads table and grid sheets', () => {
  test('IM-1 a year such as 2055.0 reads as 2055 and other text is not a year', () => {
    expect(parseYear(2055)).toBe(2055);
    expect(parseYear('2055.0')).toBe(2055);
    expect(parseYear('2055')).toBe(2055);
    expect(parseYear('2031-04-02')).toBe(2031);
    expect(parseYear('not a year')).toBeNull();
    expect(parseYear(2055.5)).toBeNull();
    expect(parseYearHeader('2030s')).toEqual({ start: 2030, end: 2039 });
    expect(parseYearHeader('2030-2034')).toEqual({ start: 2030, end: 2034 });
    expect(parseYearHeader('Technology')).toBeNull();
  });

  test('IM-1 the fixture workbook has a table sheet and a grid sheet', async () => {
    const wb = await fixtureWorkbook();
    expect(wb.sheets.map((s) => s.name)).toEqual(['People', 'High Level']);
    expect(wb.sheets[1]!.cells[0]!.slice(0, 3)).toEqual(['', 2030, 2035]);
  });

  test('IM-1 a table sheet gives one entry per row with each column in its field', async () => {
    const wb = await fixtureWorkbook();
    const { rows } = SimBible.empty().plan(wb, people);
    const ok = rows.rows.filter((r) => r.ok);
    expect(ok.map((r) => r.data.title)).toEqual([
      'Margaret Hale',
      'Peter Hale',
      'Daniel Hale',
      'Zhou Meiling',
      'Zhou Lan',
      'Iris Hale-Zhou',
      'The Archivist',
    ]);
    const meiling = ok.find((r) => r.data.title === 'Zhou Meiling')!;
    expect(meiling.data).toMatchObject({
      names: { full: 'Zhou Meiling', chinese: '周美玲' },
      birth: { year: 1962 },
      death: { year: 2050 },
      status: 'canon',
      sourceNote: 'Partner of Zhou Wei',
    });
    expect(ok.find((r) => r.data.title === 'The Archivist')!.data.birth).toEqual({ unknown: true });
  });

  test('IM-1 a grid sheet gives one entry per non-empty cell, dated by column and filed by heading and row label', async () => {
    const wb = await fixtureWorkbook();
    const sim = SimBible.fromFixture();
    const { rows, set } = sim.plan(wb, grid);
    const events = rows.rows.filter((r) => r.ok);
    expect(events).toHaveLength(7);
    const robotics = events.filter(
      (r) => r.fields.title === 'Care robots common' || r.fields.title === 'Robot couriers',
    );
    expect(robotics.map((r) => (r.data.start as { year: number }).year)).toEqual([2030, 2045]);
    // Robotics already sits under Technology in the fixture, so only Floods and Trade are new categories.
    expect(set.listAdds.map((a) => [a.label, a.parentId])).toEqual([
      ['Floods', 'climate'],
      ['Trade', 'geopolitics'],
    ]);
    expect(events.every((r) => r.data.reality === 'invented')).toBe(true);
  });
});

describe('IM-2 rows that fail are reported with the reason and the rest import', () => {
  test('IM-2 a row with a non-numeric year fails with its reason, the others are kept, nothing is dropped silently', async () => {
    const wb = await fixtureWorkbook();
    const sim = SimBible.empty();
    const { set, rows } = sim.plan(wb, people);
    expect(rows.rows).toHaveLength(8);
    expect(set.items.filter((i) => i.collection === 'characters')).toHaveLength(7);
    // Hale and Zhou are not families in an empty bible, so the import makes them first.
    expect(set.items.filter((i) => i.collection === 'families').map((i) => i.title)).toEqual([
      'Hale',
      'Zhou',
    ]);
    expect(set.failed).toHaveLength(1);
    expect(set.failed[0]!.where).toBe('People row 9');
    expect(set.failed[0]!.reason).toMatch(
      /Birth.*"not a year" is not a year, a date, or "unknown"/,
    );
    expect(set.failed[0]!.ref).toBe('fixture-workbook.xlsx#People!R9');
  });

  test('IM-2 a grid cell outside any heading or label fails with a reason', async () => {
    const wb = await fixtureWorkbook();
    const sheet = structuredClone(wb.sheets[1]!);
    sheet.cells.push(['', 'Orphan', null, null, null, null]);
    const sim = SimBible.empty();
    const { rows } = sim.plan({ ...wb, sheets: [wb.sheets[0]!, sheet] }, grid);
    // The orphan sits under the last heading, so it still files; remove headings to see the failure.
    expect(rows.rows.filter((r) => !r.ok)).toEqual([]);
    const bare = { ...sheet, cells: [sheet.cells[0]!, ['', 'Lonely']] };
    const out = sim.plan({ ...wb, sheets: [wb.sheets[0]!, bare] }, grid);
    expect(out.set.failed[0]!.reason).toBe('There is no row label or heading to file this under');
  });
});

describe('IM-6 every imported entry records its source file and location', () => {
  test('IM-6 table rows record the row and grid cells record the cell', async () => {
    const wb = await fixtureWorkbook();
    const t = SimBible.empty()
      .plan(wb, people)
      .set.items.filter((i) => i.collection === 'characters');
    expect(t.map((i) => i.data!.sourceRef).slice(0, 2)).toEqual([
      'fixture-workbook.xlsx#People!R2',
      'fixture-workbook.xlsx#People!R3',
    ]);
    const g = SimBible.empty().plan(wb, grid).set.items;
    expect(g.map((i) => i.data!.sourceRef)).toContain('fixture-workbook.xlsx#High Level!B3');
    expect(g.map((i) => i.data!.sourceRef)).toContain('fixture-workbook.xlsx#High Level!E3');
  });
});

describe('IM-3 re-import updates instead of duplicating and shows the change set', () => {
  test('IM-3 a second import of the same sheet finds every entry unchanged', async () => {
    const wb = await fixtureWorkbook();
    const sim = SimBible.empty();
    const first = sim.plan(wb, people).set;
    sim.apply(first);
    expect(sim.entries('characters')).toHaveLength(7);
    const again = sim.plan(wb, people).set;
    expect(again.items).toEqual([]);
    expect(again.unchanged).toBe(7);
    expect(again.failed).toHaveLength(1);
  });

  test('IM-3 a changed cell shows as one change with the old and new value, and nothing else', async () => {
    const wb = await fixtureWorkbook();
    const sim = SimBible.empty();
    sim.apply(sim.plan(wb, people).set);
    const edited = structuredClone(wb);
    edited.sheets[0]!.cells[1]![4] = 2042; // Margaret's death year
    const { set } = sim.plan(edited, people, { ...FILE, modifiedAt: '2026-02-01T00:00:00.000Z' });
    expect(set.unchanged).toBe(6);
    expect(set.items).toHaveLength(1);
    expect(set.items[0]).toMatchObject({
      kind: 'changed',
      title: 'Margaret Hale',
      deltas: [{ path: 'death', before: { year: 2041 }, after: { year: 2042 }, outcome: 'apply' }],
    });
    expect(set.items[0]!.patch).toEqual({
      death: { year: 2042 },
      sourceRef: 'fixture-workbook.xlsx#People!R2',
    });
  });

  test('IM-3 a grid re-import with a moved row still matches by category and year', async () => {
    const wb = await fixtureWorkbook();
    const sim = SimBible.fromFixture();
    sim.apply(sim.plan(wb, grid).set);
    expect(sim.entries('worldEvents')).toHaveLength(7);
    const moved = structuredClone(wb);
    // An empty row inserted at the top shifts every cell down one row.
    moved.sheets[1]!.cells.splice(1, 0, ['', null, null, null, null, null]);
    const { set } = sim.plan(moved, grid);
    expect(set.items).toEqual([]);
    expect(set.unchanged).toBe(7);
  });

  test('IM-3 only the approved changes are written', async () => {
    const wb = await fixtureWorkbook();
    const sim = SimBible.empty();
    const { set } = sim.plan(wb, people);
    const first = set.items.find((i) => i.collection === 'characters')!;
    sim.apply(set, [first.id]);
    expect(sim.entries('characters')).toHaveLength(1);
  });

  test('IM-3 ED-7 a value the person edited after the import is not reverted when the file has not changed', async () => {
    const wb = await fixtureWorkbook();
    const sim = SimBible.empty();
    sim.apply(sim.plan(wb, people).set);
    sim.entries('characters')[0]!.death = { year: 2099 };
    const { set } = sim.plan(wb, people);
    expect(set.items).toEqual([]);
    expect(set.unchanged).toBe(7);
    expect(sim.entries('characters')[0]!.death).toEqual({ year: 2099 });
  });

  test('IM-3 a blank cell on re-import leaves the existing value alone', async () => {
    const wb = await fixtureWorkbook();
    const sim = SimBible.empty();
    sim.apply(sim.plan(wb, people).set);
    const blank = structuredClone(wb);
    blank.sheets[0]!.cells[1]![4] = null;
    const { set } = sim.plan(blank, people);
    expect(set.items).toEqual([]);
  });
});

describe('IM-7 the most recently modified source wins and every source is listed', () => {
  async function seeded() {
    const wb = await fixtureWorkbook();
    const sim = SimBible.empty();
    sim.apply(sim.plan(wb, people).set);
    return { wb, sim };
  }

  test('IM-7 a newer version of the file wins, and the disagreement lists both sources with their values and dates', async () => {
    const { wb, sim } = await seeded();
    const newer = structuredClone(wb);
    newer.sheets[0]!.cells[1]![3] = 1959;
    const { set } = sim.plan(newer, people, { ...FILE, modifiedAt: '2026-03-01T00:00:00.000Z' });
    const item = set.items[0]!;
    expect(item.deltas[0]).toMatchObject({ path: 'birth', outcome: 'apply' });
    const conflict = item.deltas[0]!.conflict!;
    expect(conflict.winner).toBe('incoming');
    expect(conflict.claims.map((c) => [c.at.slice(0, 10), c.kept])).toEqual([
      ['2026-01-15', false],
      ['2026-03-01', true],
    ]);
    const q = conflictQuestion(item.title, [conflict]);
    expect(q.question).toContain('modified 2026-01-15');
    expect(q.question).toContain('says 1958');
    expect(q.question).toContain('modified 2026-03-01');
    expect(q.question).toContain('says 1959 [kept]');
  });

  test('IM-7 an older file does not overwrite a value from a newer one, but the disagreement is still recorded', async () => {
    const { wb, sim } = await seeded();
    const older = structuredClone(wb);
    older.sheets[0]!.cells[1]![3] = 1900;
    const { set } = sim.plan(older, people, { ...FILE, modifiedAt: '2025-06-01T00:00:00.000Z' });
    const item = set.items[0]!;
    expect(item.deltas[0]).toMatchObject({ path: 'birth', outcome: 'keep' });
    expect(item.deltas[0]!.conflict!.winner).toBe('existing');
    expect(item.patch).toEqual({});
    sim.apply(set);
    expect(sim.entries('characters')[0]!.birth).toEqual({ year: 1958 });
  });

  test('IM-7 a value edited by hand after the import is a plain change, not a source conflict', async () => {
    const { wb, sim } = await seeded();
    sim.entries('characters')[0]!.birth = { year: 1957 };
    const newer = structuredClone(wb);
    newer.sheets[0]!.cells[1]![3] = 1959;
    const { set } = sim.plan(newer, people, { ...FILE, modifiedAt: '2026-03-01T00:00:00.000Z' });
    expect(set.items[0]!.deltas[0]!.conflict).toBeUndefined();
    expect(set.items[0]!.deltas[0]).toMatchObject({
      before: { year: 1957 },
      after: { year: 1959 },
    });
  });

  test('IM-7 a second file that fills the same entries is matched across sources when the mapping says so', async () => {
    const { wb, sim } = await seeded();
    const other = structuredClone(wb);
    other.fileName = 'other-notes.xlsx';
    other.sheets[0]!.cells[1]![4] = 2043;
    const across: Mapping = { ...people, matchIn: 'section' };
    const { set } = sim.plan(other, across, {
      fileName: 'other-notes.xlsx',
      modifiedAt: '2026-04-01T00:00:00.000Z',
    });
    const death = set.items.find((i) => i.title === 'Margaret Hale')!.deltas[0]!;
    expect(death.conflict!.claims.map((c) => c.ref.split('#')[0])).toEqual([
      'fixture-workbook.xlsx',
      'other-notes.xlsx',
    ]);
  });

  test('IM-1 a saved mapping is keyed by file name and sheet', () => {
    expect(mappingKey('East_Winds_World.xlsx', 'High Level')).toBe(
      'East_Winds_World.xlsx#High Level',
    );
  });
});

describe('IM-1 heading rows, merged cells, and year headers', () => {
  const sheetOf = (
    cells: (string | number | null)[][],
    merges = [] as { top: number; left: number; bottom: number; right: number }[],
  ) => ({
    name: 'Plot',
    cells,
    merges,
  });
  const wb = (
    cells: (string | number | null)[][],
    merges?: { top: number; left: number; bottom: number; right: number }[],
  ) => ({
    fileName: 'plot.xlsx',
    modifiedAt: '2026-01-15T09:00:00.000Z',
    sheets: [sheetOf(cells, merges)],
  });
  const chapters = (headings: TableMapping['headings']): TableMapping => ({
    shape: 'table',
    sheet: 'Plot',
    target: { collection: 'chapters' },
    headerRow: 1,
    columns: [
      { header: 'Scene', index: 0, field: 'title' },
      { header: 'Year', index: 1, field: 'strand.startYear' },
    ],
    identity: ['title'],
    fixed: { status: 'planned' },
    addMissingListItems: false,
    createMissing: false,
    matchIn: 'sheet',
    headings,
  });
  const rules: TableMapping['headings'] = [
    { collection: 'books', match: 'single', linkField: 'bookId', numberField: 'number', fixed: {} },
    {
      collection: 'parts',
      match: 'banner',
      linkField: 'partId',
      parentLinkField: 'bookId',
      textField: 'summary',
      numberField: 'number',
      implicitTitle: 'No part',
      fixed: {},
    },
  ];
  const cells = [
    ['Scene', 'Year', null, null],
    ['Book One', null, null, null],
    ['Part One', 'About the roots', 'About the roots', 'About the roots'],
    ['A scene', 2010, null, null],
    ['Another scene', 2011, null, null],
    ['Book Two', null, null, null],
    ['Straight under the book', 2020, null, null],
  ];
  const merges = [{ top: 3, left: 2, bottom: 3, right: 4 }];

  test('IM-1 single-cell rows make books, a label with a wide merged cell makes a part, and scenes belong to the part above', () => {
    const sim = SimBible.empty();
    const { rows, set } = sim.plan(wb(cells, merges), chapters(rules));
    expect(set.failed).toEqual([]);
    const byTitle = (c: string) => rows.rows.filter((r) => r.ok && r.collection === c);
    expect(byTitle('books').map((r) => [r.data.title, r.data.number])).toEqual([
      ['Book One', 1],
      ['Book Two', 2],
    ]);
    const part = byTitle('parts')[0]!;
    expect(part.data).toMatchObject({
      title: 'Part One',
      summary: 'About the roots',
      number: 1,
      bookId: byTitle('books')[0]!.newId,
    });
    const scenes = byTitle('chapters');
    expect(
      scenes.map((r) => [r.data.title, r.data.partId === part.newId, r.data.readingOrder]),
    ).toEqual([
      ['A scene', true, 1],
      ['Another scene', true, 2],
      ['Straight under the book', false, 3],
    ]);
    // The scene under Book Two with no part named gets an implicit part in that book.
    const implicit = byTitle('parts')[1]!;
    expect(implicit.data).toMatchObject({
      title: 'No part',
      number: 1,
      bookId: byTitle('books')[1]!.newId,
    });
    expect(scenes[2]!.data.partId).toBe(implicit.newId);
  });

  test('IM-3 headings match their existing entries on re-import, so scenes keep pointing at the same part', () => {
    const sim = SimBible.empty();
    sim.apply(sim.plan(wb(cells, merges), chapters(rules)).set);
    const partId = sim.entries('parts').find((p) => p.title === 'Part One')!._id;
    const again = sim.plan(wb(cells, merges), chapters(rules)).set;
    expect(again.items).toEqual([]);
    const moved = structuredClone(cells);
    moved[3]![1] = 2012;
    const changed = sim.plan(wb(moved, merges), chapters(rules)).set;
    expect(changed.items).toHaveLength(1);
    expect(changed.items[0]!.deltas[0]).toMatchObject({
      path: 'strand.startYear',
      before: 2010,
      after: 2012,
    });
    expect(sim.entries('chapters').find((c) => c.title === 'A scene')!.partId).toBe(partId);
  });

  test('IM-1 year headers that are small numbers can be offset, and a cell merged across years lasts until the last of them', () => {
    const grid: GridMapping = { ...gridBase, yearOffset: 2000 };
    const book = wb(
      [
        ['World', 9, 10, 11, 12],
        ['Tech'],
        ['Robots', 'Born', null, 'Everywhere', null],
        ['Long', null, 'Bridge', null, null],
      ],
      [{ top: 4, left: 3, bottom: 4, right: 5 }],
    );
    const { rows } = SimBible.empty().plan(book, grid);
    const events = rows.rows
      .filter((r) => r.ok)
      .map((r) => [
        r.data.title,
        (r.data.start as { year: number }).year,
        (r.data.end as { year: number } | null)?.year ?? null,
      ]);
    expect(events).toEqual([
      ['Born', 2009, null],
      ['Everywhere', 2011, null],
      ['Bridge', 2010, 2012],
    ]);
  });

  test('IM-1 the cells of a vertical merge are one entry, not one per row', () => {
    const book = wb(
      [
        ['World', 2030, 2035],
        ['Tech'],
        ['Robots', 'One long note', null],
        ['Robots too', 'One long note', null],
      ],
      [{ top: 3, left: 2, bottom: 4, right: 2 }],
    );
    const { rows } = SimBible.empty().plan(book, gridBase);
    expect(rows.rows.filter((r) => r.ok)).toHaveLength(1);
  });

  test('IM-2 a name that matches two entries fails the row with a reason, and a name that matches none fails unless stubs are allowed', () => {
    const sim = SimBible.empty();
    sim.docs.set('characters', [
      { _id: 'A', title: 'Sam', names: { full: 'Sam' } },
      { _id: 'B', title: 'Sam', names: { full: 'Sam Zhou' } },
      { _id: 'C', title: 'Ruth', names: { full: 'Ruth' } },
    ]);
    const beats: TableMapping = {
      shape: 'table',
      sheet: 'Beats',
      target: { collection: 'plotBeats' },
      headerRow: 1,
      columns: [
        { header: 'Event', index: 0, field: 'title' },
        { header: 'POV', index: 1, field: 'povCharacterId' },
      ],
      identity: [],
      fixed: {},
      addMissingListItems: false,
      createMissing: false,
      matchIn: 'sheet',
      headings: [],
    };
    const book = {
      fileName: 'b.xlsx',
      modifiedAt: '2026-01-15T09:00:00.000Z',
      sheets: [
        {
          name: 'Beats',
          merges: [],
          cells: [
            ['Event', 'POV'],
            ['One', 'Ruth'],
            ['Two', 'Sam'],
            ['Three', 'Nobody'],
          ],
        },
      ],
    };
    const strict = sim.plan(book, beats).set;
    expect(
      strict.items.map((i) => [i.title, (i.data as { povCharacterId: string }).povCharacterId]),
    ).toEqual([['One', 'C']]);
    expect(strict.failed.map((f) => f.reason)).toEqual([
      'Point of view: More than one entry is called "Sam"',
      'Point of view: No entry is called "Nobody"',
    ]);
    const lenient = sim.plan(book, { ...beats, createMissing: true }).set;
    const stub = lenient.items.find((i) => i.collection === 'characters')!;
    expect(stub).toMatchObject({
      title: 'Nobody',
      note: expect.stringContaining('no entry has that name'),
    });
    // A stub is made only for a row that imports, and once per name.
    const twice = structuredClone(book);
    twice.sheets[0]!.cells.push(['Four', 'Nobody'], ['Five', '']);
    const items = sim.plan(twice, { ...beats, createMissing: true }).set.items;
    expect(items.filter((i) => i.collection === 'characters')).toHaveLength(1);
  });

  test('IM-1 a list choice that is missing fails the row unless the mapping adds it', () => {
    const sim = SimBible.empty();
    const m: TableMapping = {
      shape: 'table',
      sheet: 'Events',
      target: { collection: 'worldEvents' },
      headerRow: 1,
      columns: [
        { header: 'What', index: 0, field: 'title' },
        { header: 'When', index: 1, field: 'start' },
        { header: 'Kind', index: 2, field: 'categoryId' },
      ],
      identity: [],
      fixed: { reality: 'real' },
      addMissingListItems: false,
      createMissing: false,
      matchIn: 'sheet',
      headings: [],
    };
    const book = {
      fileName: 'e.xlsx',
      modifiedAt: '2026-01-15T09:00:00.000Z',
      sheets: [
        {
          name: 'Events',
          merges: [],
          cells: [
            ['What', 'When', 'Kind'],
            ['A treaty', '2031-05-04', 'Diplomacy'],
          ],
        },
      ],
    };
    expect(sim.plan(book, m).set.failed[0]!.reason).toBe(
      'Category: "Diplomacy" is not in the Category list',
    );
    const { set } = sim.plan(book, { ...m, addMissingListItems: true });
    expect(set.listAdds).toEqual([
      { listId: 'eventCategories', id: 'diplomacy', label: 'Diplomacy', parentId: null },
    ]);
    expect(set.items[0]!.data).toMatchObject({
      start: { year: 2031, month: 5, day: 4 },
      categoryId: 'diplomacy',
    });
  });
});

const gridBase: GridMapping = {
  shape: 'grid',
  sheet: 'Plot',
  target: { collection: 'worldEvents' },
  headerRow: null,
  labelColumn: 0,
  yearOffset: 0,
  categoryRoot: null,
  categoryList: 'eventCategories',
  fixed: {},
  addMissingListItems: true,
  createMissing: false,
  matchIn: 'sheet',
};
