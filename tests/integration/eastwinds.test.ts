import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, inject, test } from 'vitest';
import ExcelJS from 'exceljs';
import { Document, HeadingLevel, Packer, Paragraph } from 'docx';
import { createBibleWithDefaults, openBibleSession } from '../../src/main/db/session';
import type { OpenBible } from '../../src/main/db/session';
import type { Store } from '../../src/main/db';
import { importEastWinds, partForManuscript } from '../../src/main/import/eastwinds';
import { parseWorkbookFile } from '../../src/main/import/xlsx';
import { bareTitle } from '../../src/shared/domain/numbering';
import { applyTitleCleanup } from '../../src/main/import/titleCleanup';
import { freshSlug, localStore } from '../helpers/db';

let store: Store;
let dir: string;
let root: string;

async function docxIn(where: string, file: string, children: Paragraph[]) {
  await writeFile(
    join(where, file),
    await Packer.toBuffer(new Document({ sections: [{ children }] })),
  );
}
const p = (text: string) => new Paragraph({ text });
const h1 = (text: string) => new Paragraph({ text, heading: HeadingLevel.HEADING_1 });

interface SourceOptions {
  /** A High Level chapter row, in Part Two, that the manuscript's chapter 1 should attach to. */
  chapterOne?: string;
  /** The year of the first Sullivan moment. */
  firstBeatYear?: number;
  /** Give the Book Two chapter rows of Plot v1 a "Ch. N: " prefix, numbered within their part. */
  numbered?: boolean;
}

/** A small invented stand-in with the same shapes as the real material: no real text. */
async function writeSources(where: string, opts: SourceOptions = {}) {
  const wb = new ExcelJS.Workbook();
  const grid = wb.addWorksheet('High Level');
  const bold = (row: number) => {
    grid.getRow(row).font = { bold: true };
  };
  const row = (cells: (string | number | null)[], isBold = false) => {
    const added = grid.addRow(cells);
    if (isBold) bold(added.number);
    return added.number;
  };
  // Years 9 to 12 stand for 2009 to 2012 (A12).
  row(['Invented world', 9, 10, 11, 12], true);
  // Book One's chapters (A29): a part row, then chapter rows whose strand labels sit under their years.
  row(['Part One: Roots'], true);
  row([
    'Ch. 1: A first chapter',
    'Backstory: Early days',
    'Backstory: Early days',
    'Ann: Arc',
    'Ann: Arc',
  ]);
  row(['Ch. 2: A second chapter', null, 'Backstory: School', 'Ann: Arc', 'Ann: Arc']);
  row(['Part Two: Branches'], true);
  if (opts.chapterOne) row([opts.chapterOne, 'Backstory: Before', null, 'Ben: Arc', null]);
  row(['Ch. 2: Branching', 'Old days', null, null, 'Forestory: Ben']);
  // The characters block: one moment per filled cell.
  row(['Characters'], true);
  row(['Sullivan Family'], true);
  row(['Ann', 'born']);
  row(['Foundational Drivers'], true);
  row(['Technology'], true);
  row(['Robots', 'First robots', null, 'Robots everywhere', null]);
  row(['Climate'], true);
  row(['Floods', null, 'The first flood', null, null]);
  const long = row(['Long project', null, 'A bridge begins', null, null]);
  grid.mergeCells(`C${long}:E${long}`);
  row(['Resources'], true);
  row(['US: Power', null, null, null, 'Blackouts']);
  const moments = (name: string, pov: string[]) => {
    const ws = wb.addWorksheet(name);
    ws.addRow([
      `Chronological: ${name} Family`,
      'POV',
      'Year',
      'POV Age',
      'Relevant World Events',
      'How the POV Character Experiences This',
    ]);
    pov.forEach((who, i) =>
      ws.addRow([
        `Event ${who} ${i}`,
        who,
        name === 'Sullivan' && i === 0 ? (opts.firstBeatYear ?? 2000) : 2000 + i,
        i,
        `World ${i}`,
        `Feels ${i}`,
      ]),
    );
  };
  moments('Sullivan', ['Ann', 'Ben']);
  moments('李', ['Wei']);
  const plot = wb.addWorksheet('Plot v1');
  plot.addRow([
    'Plot',
    'POV',
    'Year',
    'POV Age',
    'Relevant World Events',
    'How the POV Character Experiences It',
  ]);
  // Book One is planned by the High Level sheet: these rows make nothing (A29).
  plot.addRow(['Book One']);
  plot.addRow(['Part One: Roots', 'Deep dive on Ann']);
  plot.mergeCells('B3:F3');
  plot.addRow(['Ann goes to school', 'Ann', 2010, 8, 'A school', 'Nervous']);
  // Book Two keeps its Plot v1 rows as chapters.
  const ch = (n: number, t: string) => (opts.numbered ? `Ch. ${n}: ${t}` : t);
  plot.addRow(['Book Two']);
  plot.addRow(['Part One: Claws', 'Deep dive on Ben']);
  plot.mergeCells('B6:F6');
  plot.addRow([ch(1, 'Ann leaves'), 'Ann', 2020, 18, 'A train', 'Sad']);
  plot.addRow([ch(2, 'Ben follows'), 'Ben', 2021, 19, 'A ferry', 'Lost']);
  // A part whose merged banner is empty, then a chapter.
  plot.addRow(['Part Two: Fangs']);
  plot.mergeCells('B9:F9');
  plot.addRow([ch(1, 'Ann returns'), 'Ann', 2022, 20, 'A road', 'Proud']);
  // A part that is only its label.
  plot.addRow(['Part Three: Ties']);
  plot.addRow([ch(1, 'Ann ages'), 'Ann', 2025, 23, 'A letter', 'Wistful']);
  plot.addRow(['Ann misses year', 'Ann', 'later', 24, 'A bad row', 'Fails']);
  await wb.xlsx.writeFile(join(where, 'East_Winds_World.xlsx'));
  await docxIn(where, 'Dawns_Life.docx', [p('Dawn was born.'), p('Dawn grew.')]);
  await docxIn(where, 'Franks_Life.docx', [p('Frank was born.')]);
  await docxIn(where, 'Marks_Life.docx', [p('Mark was born.')]);
  await docxIn(where, 'East_Winds.docx', [
    h1('East Winds'),
    p('Title page.'),
    h1('Introduction'),
    p('Intro text.'),
    h1('1: Laid the Foundation'),
    p('Chapter one text.'),
    h1('Characters'),
    p('Character notes.'),
  ]);
  await docxIn(where, 'East_Winds_World_Development.docx', [
    p('THE PREMISE'),
    p('Between 2025 and 2100 it happens, and this paragraph is far too long to be a heading.'),
    p('2025–2038: THE FIRST DIVIDE'),
    p('It starts quietly in 2025 with a factory.'),
    p('2039: THE HINGE'),
    p('It breaks.'),
  ]);
}

beforeAll(async () => {
  store = await localStore();
  dir = await mkdtemp(join(tmpdir(), 'nc-ew-src-'));
  root = await mkdtemp(join(tmpdir(), 'nc-ew-snap-'));
  await writeSources(dir);
});
afterAll(async () => {
  await store.close();
});

async function bible(): Promise<OpenBible> {
  const made = await createBibleWithDefaults(store, freshSlug('ew'), 'East Winds');
  return openBibleSession(store, made.handle.id, { snapshotRoot: root });
}

const yearOf = (d: object | null) => (d && 'year' in d ? d.year : null);

describe('IM-1 IM-4 SM-12 A29 the East Winds import maps the workbook and documents to the simplified model', () => {
  test('IM-1 a dry run reports what would happen and writes nothing', async () => {
    const open = await bible();
    const report = await importEastWinds(open, dir, { dryRun: true });
    expect(report.dryRun).toBe(true);
    expect(report.snapshot).toBeNull();
    expect(open.repo.list('worldEvents')).toEqual([]);
    expect(open.repo.list('chapters')).toEqual([]);
    expect(open.repo.list('moments')).toEqual([]);
    expect(await open.snapshots!.list()).toEqual([]);
    const steps = Object.fromEntries(report.steps.map((s) => [s.step, s]));
    expect(steps['East_Winds_World.xlsx, sheet High Level, world events']).toMatchObject({
      created: 5,
      failed: [],
      touched: { worldEvents: { created: 5, updated: 0 } },
    });
    expect(steps['East_Winds_World.xlsx, sheet High Level, chapters']!.touched).toEqual({
      books: { created: 1, updated: 0 },
      parts: { created: 2, updated: 0 },
      chapters: { created: 3, updated: 0 },
    });
    // The manuscript would bring its own book and part on an empty bible: counted as such, once.
    expect(steps['East_Winds.docx, 1: Laid the Foundation']).toMatchObject({
      created: 3,
      touched: {
        books: { created: 1, updated: 0 },
        parts: { created: 1, updated: 0 },
        chapters: { created: 1, updated: 0 },
      },
    });
    expect(steps['East_Winds.docx, Introduction']).toMatchObject({
      created: 1,
      touched: { chapters: { created: 1, updated: 0 } },
    });
    expect(steps['East_Winds_World.xlsx, sheet Sullivan']!.touched.moments).toEqual({
      created: 2,
      updated: 0,
    });
  });

  test('IM-1 IM-2 IM-3 IM-4 IM-6 SM-12 A29 the full import takes a snapshot, writes chapters, moments, and world events, reports the failed row, and a second run changes nothing', async () => {
    const open = await bible();
    const report = await importEastWinds(open, dir);
    expect(report.snapshot).not.toBeNull();
    expect((await open.snapshots!.list()).map((s) => s.reason)).toEqual(['import']);

    // World events: header 9 to 12 stands for 2009 to 2012, merged cells last across years, headings give
    // categories, and a row label that names a region gives the region (A47: as a regions list item).
    const events = open.repo.list('worldEvents');
    expect(events.map((e) => [e.title, yearOf(e.start), yearOf(e.end), e.regions]).sort()).toEqual(
      [
        ['A bridge begins', 2010, 2012, []],
        ['Blackouts', 2012, null, ['united-states']],
        ['First robots', 2009, null, []],
        ['Robots everywhere', 2011, null, []],
        ['The first flood', 2010, null, []],
      ].sort(),
    );
    const cats = open.repo.lists().find((l) => l._id === 'eventCategories')!.items;
    const robots = cats.find((c) => c.label === 'Robots')!;
    expect(cats.find((c) => c.id === robots.parentId)!.label).toBe('Technology');
    expect(events.every((e) => e.sourceRef.startsWith('East_Winds_World.xlsx#High Level!'))).toBe(
      true,
    );

    // A29: Book One's chapters come from High Level, each with a present strand and a backstory strand.
    const books = open.repo.list('books').sort((a, b) => a.number - b.number);
    expect(books.map((b) => [b.title, b.number])).toEqual([
      ['Book One', 1],
      ['Book Two', 2],
    ]);
    const parts = open.repo.list('parts');
    const partOf = (title: string) => parts.find((x) => x.title === title)!;
    expect(
      parts
        .filter((x) => x.bookId === books[0]!._id)
        .map((x) => [x.title, x.number])
        .sort(),
    ).toEqual([
      ['Branches', 2],
      ['Roots', 1],
    ]);
    const byTitle = (t: string) => open.repo.list('chapters').find((c) => c.title === t)!;
    const strands = (t: string) =>
      byTitle(t).strands.map((x) => [x.label, x.startYear, x.endYear, x.primary]);
    expect(strands('A first chapter')).toEqual([
      ['Ann: Arc', 2011, 2012, true],
      ['Backstory: Early days', 2009, 2010, false],
    ]);
    expect(strands('A second chapter')).toEqual([
      ['Ann: Arc', 2011, 2012, true],
      ['Backstory: School', 2010, null, false],
    ]);
    // The later span is the present strand, its Forestory label kept; the earlier is labelled backstory (A29).
    expect(strands('Branching')).toEqual([
      ['Forestory: Ben', 2012, null, true],
      ['Backstory: Old days', 2009, null, false],
    ]);
    expect(byTitle('Branching').partId).toBe(partOf('Branches')._id);
    expect(byTitle('A second chapter').sourceRef).toBe('East_Winds_World.xlsx#High Level!A4');

    // SM-3: the Sullivan and 李 rows and the Characters block are moments; names that matched no one became characters.
    const moments = open.repo.list('moments');
    expect(moments.map((m) => [m.title, m.year]).sort()).toEqual(
      [
        ['Event Ann 0', 2000],
        ['Event Ben 1', 2001],
        ['Event Wei 0', 2000],
        ['born', 2009],
      ].sort(),
    );
    const first = moments.find((b) => b.title === 'Event Ann 0')!;
    expect(first).toMatchObject({
      year: 2000,
      worldContext: 'World 0',
      body: 'Feels 0',
      tags: ['Sullivan'],
      sourceRef: 'East_Winds_World.xlsx#Sullivan!A2',
    });
    const ann = open.repo.get('characters', first.characterId)!;
    expect(ann.title).toBe('Ann');
    expect(moments.find((m) => m.title === 'born')!.characterId).toBe(ann._id);
    expect(moments.find((b) => b.title === 'Event Wei 0')!.tags).toEqual(['李']);
    expect(open.repo.list('characters').filter((c) => c.title === 'Ann')).toHaveLength(1);

    // Plot v1: Book One's rows make nothing; Book Two's are chapters under their parts, after Book One in reading order.
    const plotStep = report.steps.find((s) => s.step.endsWith('sheet Plot v1'))!;
    expect(plotStep.notes.join(' ')).toMatch(/Left out 3 rows \(Plot v1 row 2 to Plot v1 row 4\)/);
    expect(open.repo.list('chapters').map((c) => c.title)).not.toContain('Ann goes to school');
    expect(partOf('Claws')).toMatchObject({ bookId: books[1]!._id, summary: 'Deep dive on Ben' });
    expect(byTitle('Ann leaves').partId).toBe(partOf('Claws')._id);
    expect(byTitle('Ann ages').partId).toBe(partOf('Ties')._id);
    expect(byTitle('Ann leaves').readingOrder).toBeGreaterThan(byTitle('Branching').readingOrder);
    expect(plotStep.failed).toHaveLength(1);
    expect(plotStep.failed[0]).toMatchObject({ where: 'Plot v1 row 13' });
    expect(plotStep.failed[0]!.reason).toMatch(/Story year.*"later" is not a whole number year/);
    // No mapping writes a dropped kind (SM-2): every step touched only kept sections.
    const touched = new Set(report.steps.flatMap((st) => Object.keys(st.touched)));
    expect([...touched].sort()).toEqual([
      'books',
      'chapters',
      'characters',
      'eraStates',
      'moments',
      'openQuestions',
      'parts',
      'worldEvents',
    ]);

    // The documents.
    expect(open.repo.list('characters').find((c) => c.title === 'Dawn')!.backstory).toBe(
      'Dawn was born.\n\nDawn grew.',
    );
    const manuscript = open.repo.list('chapters').filter((c) => c.sourceFile === 'East_Winds.docx');
    expect(manuscript.map((c) => c.title).sort()).toEqual(['A first chapter', 'Introduction']);
    const stepNotes = (name: string) => report.steps.find((st) => st.step.endsWith(name))!.notes;
    expect(stepNotes('East_Winds.docx, Introduction').join(' ')).toContain(
      'New chapter placed in the part of "A first chapter", just before it.',
    );
    const intro = manuscript.find((c) => c.title === 'Introduction')!;
    expect(intro.manuscriptText).toBe(
      '<h1>East Winds</h1><p>Title page.</p><h1>Introduction</h1><p>Intro text.</p>',
    );
    // A29: the Introduction is set in 2078.
    expect(intro.strands.map((x) => [x.startYear, x.primary])).toEqual([[2078, true]]);
    const note = open.repo
      .list('openQuestions')
      .find((e) => e.title.startsWith('East Winds: the rest'))!;
    expect(note.body).toBe('## Characters\n\nCharacter notes.');
    const eras = open.repo
      .list('eraStates')
      .filter((e) => e.sourceRef.startsWith('East_Winds_World_Development.docx'));
    expect(eras.map((e) => [e.name, e.startYear, e.endYear])).toEqual([
      ['2025–2038: THE FIRST DIVIDE', 2025, 2038],
      ['2039: THE HINGE', 2039, 2039],
    ]);

    // IM-3: running it again finds everything already there.
    const counts = () =>
      (['chapters', 'worldEvents', 'moments', 'characters', 'books', 'parts'] as const).map(
        (c) => open.repo.list(c).length,
      );
    const before = counts();
    const again = await importEastWinds(open, dir, { yes: true });
    expect(again.held).toBe(false);
    expect(again.steps.reduce((n, s) => n + s.created + s.updated, 0)).toBe(0);
    expect(again.steps.reduce((n, s) => n + s.unchanged, 0)).toBeGreaterThan(20);
    expect(counts()).toEqual(before);
    expect(open.repo.list('characters').filter((c) => c.title === 'Dawn')).toHaveLength(1);
  });
});

async function sources(opts: SourceOptions): Promise<string> {
  const where = await mkdtemp(join(tmpdir(), 'nc-ew-more-'));
  await writeSources(where, opts);
  return where;
}

describe('IM-1 IM-2 IM-3 the East Winds default mapping, checked through the import code', () => {
  test('IM-1 Plot v1 heading rows match by label: a part with an empty merge or only its label is a part, not a book', async () => {
    const open = await bible();
    await importEastWinds(open, dir);
    expect(
      open.repo
        .list('books')
        .map((b) => b.title)
        .sort(),
    ).toEqual(['Book One', 'Book Two']);
    const two = open.repo.list('books').find((b) => b.title === 'Book Two')!;
    expect(
      open.repo
        .list('parts')
        .filter((x) => x.bookId === two._id)
        .map((x) => [x.title, x.number])
        .sort(),
    ).toEqual([
      ['Claws', 1],
      ['Fangs', 2],
      ['Ties', 3],
    ]);
  });

  test('IM-2 SM-12 High Level reads in three bands: chapter rows, the characters block, and the world tracker never mix', async () => {
    const open = await bible();
    const report = await importEastWinds(open, dir);
    const titles = open.repo.list('worldEvents').map((e) => e.title);
    for (const other of ['Backstory: Early days', 'Ann: Arc', 'born']) {
      expect(titles).not.toContain(other);
    }
    const cats = open.repo
      .lists()
      .find((l) => l._id === 'eventCategories')!
      .items.map((c) => c.label);
    for (const skipped of ['Part One: Roots', 'Ch. 1: A first chapter', 'Characters', 'Ann']) {
      expect(cats).not.toContain(skipped);
    }
    expect(open.repo.list('moments').map((m) => m.title)).not.toContain('First robots');
    expect(open.repo.list('chapters').map((c) => c.title)).not.toContain('Robots');
    const step = (band: string) =>
      report.steps.find((st) => st.step.endsWith(`sheet High Level, ${band}`))!;
    expect(step('world events').notes.join(' ')).toMatch(
      /Skipped 8 rows \(rows 2 to 9\) with 10 filled cells/,
    );
    expect(step('world events').notes.join(' ')).toContain('Ch. 1: A first chapter');
    expect(step('world events').created).toBe(5);
    // "Ch. 2: Branching" is the first chapter of its part: its place comes from the sheet and the report says so.
    expect(step('chapters').notes.join(' ')).toContain(
      '"Ch. 2: Branching" says chapter 2 but is chapter 1 of its part',
    );
    expect(step('moments').failed).toEqual([]);
  });

  test('IM-1 IM-6 manuscript chapter 1 attaches to the High Level chapter with the same number, and the introduction sits just before it', async () => {
    const where = await sources({ chapterOne: '1 Something else' });
    const open = await bible();
    const report = await importEastWinds(open, where);
    const chapters = open.repo.list('chapters');
    expect(
      chapters
        .filter((c) => c.sourceFile === 'East_Winds.docx')
        .map((c) => c.title)
        .sort(),
    ).toEqual(['1 Something else', 'Introduction']);
    // No second chapter 1.
    expect(chapters.filter((c) => /Laid the Foundation/.test(c.title))).toEqual([]);
    const one = chapters.find((c) => c.title === '1 Something else')!;
    expect(one.manuscriptText).toBe('<h1>1: Laid the Foundation</h1><p>Chapter one text.</p>');
    const intro = chapters.find((c) => c.title === 'Introduction')!;
    expect(open.repo.get('parts', one.partId)!.title).toBe('Branches');
    expect(intro.partId).toBe(one.partId);
    expect(intro.readingOrder).toBeLessThan(one.readingOrder);
    expect(
      chapters.filter(
        (c) => c.readingOrder > intro.readingOrder && c.readingOrder < one.readingOrder,
      ),
    ).toEqual([]);
    // The other chapters keep their order.
    const order = chapters.sort((a, b) => a.readingOrder - b.readingOrder).map((c) => c.title);
    expect(order.slice(0, 5)).toEqual([
      'A first chapter',
      'A second chapter',
      'Introduction',
      '1 Something else',
      'Branching',
    ]);
    const step = report.steps.find((st) =>
      st.step.endsWith('East_Winds.docx, 1: Laid the Foundation'),
    )!;
    expect(step.notes.join(' ')).toContain('existing chapter "1 Something else"');
    // Running it again changes nothing and makes no second chapter.
    const again = await importEastWinds(open, where, { yes: true });
    expect(again.steps.reduce((n, st) => n + st.created + st.updated, 0)).toBe(0);
    expect(open.repo.list('chapters')).toHaveLength(chapters.length);
  });

  test('IM-1 IM-6 manuscript chapter 1 also attaches by the title text after the number, ignoring case', async () => {
    const where = await sources({ chapterOne: 'LAID THE FOUNDATION' });
    const open = await bible();
    await importEastWinds(open, where);
    const chapters = open.repo.list('chapters');
    const one = chapters.find((c) => c.title === 'LAID THE FOUNDATION')!;
    expect(one.sourceFile).toBe('East_Winds.docx');
    expect(one.manuscriptText).toContain('Chapter one text.');
    expect(chapters.filter((c) => c.sourceFile === 'East_Winds.docx')).toHaveLength(2);
    expect(chapters.find((c) => c.title === 'Introduction')!.partId).toBe(one.partId);
  });

  test('IM-1 when no plan chapter title carries a number, chapter 1 attaches to the first chapter in reading order and says why', async () => {
    const open = await bible();
    const report = await importEastWinds(open, dir);
    const chapters = open.repo.list('chapters');
    const one = chapters.find((c) => c.title === 'A first chapter')!;
    expect(one.sourceFile).toBe('East_Winds.docx');
    expect(one.manuscriptText).toBe('<h1>1: Laid the Foundation</h1><p>Chapter one text.</p>');
    expect(one.written).toBe(true);
    expect(chapters.filter((c) => /Laid the Foundation/.test(c.title))).toEqual([]);
    const intro = chapters.find((c) => c.title === 'Introduction')!;
    expect(intro.partId).toBe(one.partId);
    expect(open.repo.get('parts', one.partId)!.title).toBe('Roots');
    expect(intro.readingOrder).toBeLessThan(one.readingOrder);
    expect(
      chapters.filter(
        (c) => c.readingOrder > intro.readingOrder && c.readingOrder < one.readingOrder,
      ),
    ).toEqual([]);
    const step = report.steps.find((st) =>
      st.step.endsWith('East_Winds.docx, 1: Laid the Foundation'),
    )!;
    expect(step.notes.join(' ')).toContain(
      'No plot chapter title carries a number, so chapter 1 was attached to the first chapter in reading order ("A first chapter")',
    );
    // A second run finds the same chapter again and makes nothing new.
    const again = await importEastWinds(open, dir, { yes: true });
    expect(again.steps.reduce((n, st) => n + st.created + st.updated, 0)).toBe(0);
    expect(open.repo.list('chapters')).toHaveLength(chapters.length);
  });

  test("IM-3 a re-run never counts the manuscript's own chapter as an existing plot chapter", async () => {
    const open = await bible();
    const book = await open.repo.create('books', {
      title: 'Earlier run',
      number: 1,
      status: 'planned',
    } as never);
    const part = await open.repo.create('parts', {
      title: 'Earlier part',
      bookId: book._id,
      number: 1,
      status: 'planned',
    } as never);
    // A chapter an earlier import made: only the importer may set its source file (IP-18).
    const own = await open.repo.create(
      'chapters',
      {
        title: '1: Laid the Foundation',
        partId: part._id,
        readingOrder: 1,
        status: 'planned',
        strands: [{ id: 'S1', label: 'present', startYear: 2000, primary: true }],
        sourceFile: 'East_Winds.docx',
        sourceRef: 'East_Winds.docx#p1',
      } as never,
      { importer: true },
    );
    const report = await importEastWinds(open, dir, { yes: true });
    const step = report.steps.find((st) =>
      st.step.endsWith('East_Winds.docx, 1: Laid the Foundation'),
    )!;
    expect(step.notes.join(' ')).not.toContain('existing chapter');
    expect(open.repo.get('chapters', own._id)!.manuscriptText).toContain('Chapter one text.');
    expect(
      open.repo.list('chapters').filter((c) => c.title === 'A first chapter')[0]!.sourceFile,
    ).toBe(null);
  });

  test('IM-1 the fallback part is in the lowest numbered book, not just the lowest part number', async () => {
    const open = await bible();
    const two = await open.repo.create('books', {
      title: 'Two',
      number: 2,
      status: 'planned',
    } as never);
    const twoPart = await open.repo.create('parts', {
      title: 'Two, Part One',
      bookId: two._id,
      number: 1,
      status: 'planned',
    } as never);
    const one = await open.repo.create('books', {
      title: 'One',
      number: 1,
      status: 'planned',
    } as never);
    const onePart = await open.repo.create('parts', {
      title: 'One, Part One',
      bookId: one._id,
      number: 1,
      status: 'planned',
    } as never);
    expect(twoPart._id).not.toBe(onePart._id);
    expect(await partForManuscript(open, false)).toBe(onePart._id);
  });

  test('IM-3 SM-3 a moment is the same moment when its sheet and title match, so a changed year updates it in place', async () => {
    const open = await bible();
    await importEastWinds(open, dir);
    const id = open.repo.list('moments').find((b) => b.title === 'Event Ann 0')!._id;
    const changed = await sources({ firstBeatYear: 2005 });
    const report = await importEastWinds(open, changed, { yes: true });
    const sullivan = report.steps.find((st) => st.step.endsWith('sheet Sullivan'))!;
    expect(sullivan).toMatchObject({ created: 0, updated: 1 });
    const moments = open.repo.list('moments');
    expect(moments).toHaveLength(4);
    expect(moments.filter((b) => b.title === 'Event Ann 0')).toEqual([
      expect.objectContaining({ _id: id, year: 2005 }),
    ]);
  });

  test('IM-3 A29 the Book One chapters already in the bible, made by hand without the number, are updated by part and title, never duplicated', async () => {
    // The workbook is saved before the writer's edits below, so those edits are the newer values.
    const where = await sources({ chapterOne: 'Deep roots' });
    const open = await bible();
    const book = await open.repo.create('books', {
      title: 'Book One',
      number: 1,
      status: 'canon',
    } as never);
    const roots = await open.repo.create('parts', {
      title: 'Roots',
      bookId: book._id,
      number: 1,
      status: 'canon',
    } as never);
    const ann = await open.repo.create('characters', {
      title: 'Ann',
      names: { full: 'Ann' },
      birth: { year: 1990 },
      status: 'canon',
    } as never);
    const made = await open.repo.create('chapters', {
      title: 'A first chapter',
      partId: roots._id,
      readingOrder: 3,
      status: 'canon',
      strands: [
        {
          id: 'S1',
          label: 'Ann: Arc',
          startYear: 2011,
          endYear: 2012,
          primary: true,
          povCharacterId: ann._id,
          characterIds: [ann._id],
        },
        {
          id: 'S2',
          label: 'Backstory: Early days',
          startYear: 2008,
          endYear: 2010,
          primary: false,
        },
      ],
    } as never);
    // The writer leaves the present strand open-ended after making the chapter (A13, IM-7).
    await open.repo.update('chapters', made._id, {
      strands: made.strands.map((x) => (x.id === 'S1' ? { ...x, endYear: null } : x)),
    } as never);
    // A chapter renamed by hand: the second chapter row of Roots finds it by its place.
    const renamed = await open.repo.create('chapters', {
      title: 'A renamed chapter',
      partId: roots._id,
      readingOrder: 4,
      status: 'canon',
      strands: [{ id: 'S5', label: 'Ann: Arc', startYear: 2011, endYear: 2012, primary: true }],
    } as never);
    // A chapter the writer moved into Roots from Branches, and one the writer put in the trash.
    const branching = await open.repo.create('chapters', {
      title: 'Branching',
      partId: roots._id,
      readingOrder: 2,
      status: 'canon',
      strands: [
        { id: 'S7', label: 'Forestory: Ben', startYear: 2012, primary: true },
        { id: 'S8', label: 'Backstory: Old days', startYear: 2009, primary: false },
      ],
    } as never);
    const deep = await open.repo.create('chapters', {
      title: 'Deep roots',
      partId: roots._id,
      readingOrder: 6,
      status: 'canon',
      sourceRef: 'East_Winds_World.xlsx#High Level!B6:D6',
      strands: [{ id: 'S9', label: 'Ben: Arc', startYear: 2011, primary: true }],
    } as never);
    await open.repo.softDelete('chapters', deep._id);
    const report = await importEastWinds(open, where, { yes: true });
    const step = report.steps.find((st) => st.step.endsWith('sheet High Level, chapters'))!;
    expect(step.failed).toEqual([]);
    expect(step.notes.join(' ')).toContain(
      '"A second chapter" matched chapter 2 of its part, "A renamed chapter", by its place',
    );
    expect(open.repo.list('chapters').filter((c) => c.title === 'A first chapter')).toHaveLength(1);
    expect(open.repo.list('books').filter((b) => b.title === 'Book One')).toHaveLength(1);
    expect(open.repo.list('parts').filter((x) => x.title === 'Roots')).toHaveLength(1);
    const after = open.repo.get('chapters', made._id)!;
    // IM-7: the chapter was edited after the workbook was saved, so its 2008 stays, and an open question
    // names both values. Point of view and characters are untouched.
    expect(after.strands.map((x) => [x.id, x.startYear, x.povCharacterId, x.characterIds])).toEqual(
      [
        ['S1', 2011, ann._id, [ann._id]],
        ['S2', 2008, null, []],
      ],
    );
    expect(after.status).toBe('canon');
    // The end year cleared by hand stays cleared: the sheet's 2012 is filed, not written.
    expect(after.strands.find((x) => x.id === 'S1')!.endYear).toBeNull();
    const questions = open.repo.list('openQuestions').map((q) => q.question);
    const aboutFirst = questions.filter((q) => q.includes('A first chapter')).join('\n');
    expect(aboutFirst).toMatch(/the bible \(edited by hand\).*says 2008 \[kept\].*says 2009/s);
    expect(aboutFirst).toMatch(/the bible \(edited by hand\).*says blank \[kept\].*says 2012/s);
    // The renamed chapter keeps its hand title, is not duplicated, and the title is filed as a disagreement.
    expect(open.repo.get('chapters', renamed._id)!.title).toBe('A renamed chapter');
    expect(open.repo.list('chapters').filter((c) => c.title === 'A second chapter')).toEqual([]);
    expect(questions.find((q) => q.includes('A renamed chapter'))).toContain(
      'says A second chapter',
    );
    // A second run has nothing new to say.
    // The moved chapter stays in Roots at its place, is not made again in Branches, and raises no question.
    expect(open.repo.get('chapters', branching._id)).toMatchObject({
      partId: roots._id,
      readingOrder: 2,
    });
    expect(open.repo.list('chapters').filter((c) => c.title === 'Branching')).toHaveLength(1);
    expect(questions.filter((q) => q.includes('Branching'))).toEqual([]);
    expect(step.notes.join(' ')).toContain(
      '"Branching" matched the chapter of that title in Roots',
    );
    // The trashed chapter is left in the trash and not made again.
    expect(step.notes.join(' ')).toContain(
      '"Deep roots" is "Deep roots", in the trash, left alone.',
    );
    expect(open.repo.list('chapters').filter((c) => c.title === 'Deep roots')).toEqual([]);
    expect(open.model.get('chapters', deep._id)!.deletedAt).toBeTruthy();
    const again = await importEastWinds(open, where, { yes: true });
    const second = again.steps.find((st) => st.step.endsWith('sheet High Level, chapters'))!;
    expect([second.created, second.updated, second.questions]).toEqual([0, 0, 0]);
  });

  test('IM-3 ED-7 a run on a bible that already holds imported entries reports the change set and writes nothing without --yes', async () => {
    const open = await bible();
    await importEastWinds(open, dir);
    const before = (await open.snapshots!.list()).length;
    const changed = await sources({ firstBeatYear: 2005 });
    const held = await importEastWinds(open, changed);
    expect(held.held).toBe(true);
    expect(held.snapshot).toBeNull();
    expect((await open.snapshots!.list()).length).toBe(before);
    expect(open.repo.list('moments').find((b) => b.title === 'Event Ann 0')!.year).toBe(2000);
    const sullivan = held.steps.find((st) => st.step.endsWith('sheet Sullivan'))!;
    expect(sullivan.updated).toBe(1);
    expect(sullivan.unchanged).toBe(1);
    expect(sullivan.changes!.changed).toHaveLength(1);
    expect(sullivan.changes!.changed[0]).toMatchObject({
      title: 'Event Ann 0',
      fields: [{ before: '2000', after: '2005', kept: false }],
    });
    expect(sullivan.changes!.created.count).toBe(0);
    // Telling it to apply writes the change.
    const applied = await importEastWinds(open, changed, { yes: true });
    expect(applied.held).toBe(false);
    expect(applied.snapshot).not.toBeNull();
    expect(open.repo.list('moments').find((b) => b.title === 'Event Ann 0')!.year).toBe(2005);
  });

  test('IM-3 a first import into a bible with no imported entries applies everything without --yes', async () => {
    const open = await bible();
    const first = await importEastWinds(open, dir);
    expect(first.held).toBe(false);
    expect(open.repo.list('worldEvents')).toHaveLength(5);
  });
});

describe('IM-1 the import:eastwinds script', () => {
  const run = (args: string[]) =>
    promisify(execFile)('node', ['scripts/import-eastwinds.ts', ...args], {
      cwd: join(import.meta.dirname, '../..'),
      env: { ...process.env, NOVEL_COMPANION_TEST_MONGODB_URI: inject('mongoUri') },
      timeout: 120_000,
    });

  test('IM-1 IM-2 the script is a dry run unless told --yes; with it, it snapshots, writes, and prints counts per section and the failed rows', async () => {
    const bibleId = freshSlug('ew-script');
    const common = ['--dir', dir, '--bible', bibleId, '--snapshots', root];
    const dry = await run(common);
    expect(dry.stdout).toContain('Dry run (nothing is written)');
    expect(dry.stdout).toContain('Total: created');
    // A dry run cannot see what earlier steps would make, so the manuscript would get a part of its own.
    expect(dry.stdout).toMatch(/Chapters: 9 new, 0 changed/);
    // The manuscript's own book and part are counted as a book and a part, not as chapters.
    expect(dry.stdout).toMatch(/Books: 3 new, 0 changed/);
    expect(dry.stdout).toMatch(/Parts: 6 new, 0 changed/);
    expect(dry.stdout).toContain(
      'Would make the chapter, and a book and a part to hold the manuscript chapters.',
    );
    expect(dry.stdout).toMatch(/World events: 5 new, 0 changed/);
    expect(dry.stdout).toContain('Run again with --yes to apply it.');
    expect(dry.stdout).not.toContain('Snapshot taken');
    expect((await openBibleSession(store, bibleId)).repo.list('worldEvents')).toEqual([]);
    // --dry-run still says the same.
    expect((await run([...common, '--dry-run'])).stdout).toContain('Dry run (nothing is written)');
    const real = await run([...common, '--yes']);
    expect(real.stdout).toMatch(/Snapshot taken: \d{4}-/);
    expect(real.stdout).toContain('East_Winds_World.xlsx, sheet Plot v1');
    expect(real.stdout).toMatch(/failed: Plot v1 row 13: .*"later" is not a whole number year/);
    expect(real.stdout).toMatch(
      /Total: created \d+, updated \d+, unchanged 0, open questions 0, failed rows 1\./,
    );
    expect(real.stdout).toMatch(/Entries that were made or changed, by section:/);
    expect(real.stdout).toMatch(/Chapters: 8 new/);
    expect(real.stdout).toMatch(/World events: 5 new, 0 changed/);
    expect(real.stdout).toMatch(/Moments: 4 new, 0 changed/);
    expect(real.stdout).toMatch(/Characters: 6 new/);
    expect(real.stdout + real.stderr).not.toMatch(/mongodb(\+srv)?:\/\//);
    const open = await openBibleSession(store, bibleId);
    expect(open.repo.list('worldEvents')).toHaveLength(5);
    expect(open.repo.list('moments')).toHaveLength(4);
    // IM-3: applying again changes nothing.
    const again = await run([...common, '--yes']);
    expect(again.stdout).toContain('Snapshot taken');
    expect(again.stdout).toMatch(/Total: created 0, updated 0, unchanged \d+/);
  });

  test('IM-1 a dry run never migrates the cluster: it stops with a plain message when migrations are pending', async () => {
    const bibleId = freshSlug('ew-old');
    const registry = store.db.collection<{ _id: string; schemaVersion: number }>('bibles');
    await registry.insertOne({
      _id: bibleId,
      name: 'Old',
      createdAt: new Date().toISOString(),
      schemaVersion: 0,
    } as never);
    await expect(openBibleSession(store, bibleId, { readOnly: true })).rejects.toThrow(
      /migrations pending.*never migrates/,
    );
    await expect(
      run(['--dir', dir, '--bible', bibleId, '--snapshots', root]),
    ).rejects.toMatchObject({ stderr: expect.stringMatching(/migrations pending/) });
    expect((await registry.findOne({ _id: bibleId }))!.schemaVersion).toBe(0);
    // A normal open still migrates it.
    await openBibleSession(store, bibleId);
    expect((await registry.findOne({ _id: bibleId }))!.schemaVersion).toBeGreaterThan(0);
  });

  test('IM-1 --dry-run always wins: with --yes as well, nothing is written and no snapshot is taken', async () => {
    const bibleId = freshSlug('ew-both');
    const both = await run([
      '--dir',
      dir,
      '--bible',
      bibleId,
      '--snapshots',
      root,
      '--yes',
      '--dry-run',
    ]);
    expect(both.stdout).toContain('Dry run (nothing is written)');
    expect(both.stdout).not.toContain('Snapshot taken');
    expect(both.stdout).toContain('a name that is new in several sheets is counted once per sheet');
    const open = await openBibleSession(store, bibleId);
    expect(open.repo.list('worldEvents')).toEqual([]);
    expect(open.repo.list('chapters')).toEqual([]);
    expect(existsSync(join(root, bibleId))).toBe(false);
  });

  test('IM-1 the script refuses an unknown option before it touches the database', async () => {
    await expect(run(['--nope'])).rejects.toMatchObject({
      stderr: expect.stringContaining('Unknown option --nope'),
    });
  });
});

describe('IM-3 PL-3 a re-import after the title cleanup finds the same entries', () => {
  test('IM-3 PL-3 numbered titles import as bare names, and a re-import after the cleanup reports no duplicates and no title change', async () => {
    const where = await sources({ numbered: true });
    const open = await bible();
    await importEastWinds(open, where);
    const titles = (c: 'books' | 'parts' | 'chapters') =>
      open.repo
        .list(c)
        .map((d) => d.title)
        .sort();
    const chapters = titles('chapters');
    expect(chapters).toEqual(
      expect.arrayContaining(['A first chapter', 'Branching', 'Ann leaves', 'Ben follows']),
    );
    expect(chapters.filter((t) => /^Ch\./.test(t))).toEqual([]);
    const counts = () =>
      (['books', 'parts', 'chapters'] as const).map((c) => open.repo.list(c).length);
    const before = counts();

    // A bible imported before this change holds the numbered titles; its entries are still found.
    const numbered: Record<string, string> = {
      Roots: 'Part One: Roots',
      Claws: 'Part One: Claws',
      'A second chapter': 'Ch. 2: A second chapter',
      'Ann leaves': 'Ch. 1: Ann leaves',
      'Ben follows': 'Ch. 2: Ben follows',
    };
    for (const c of ['parts', 'chapters'] as const) {
      for (const d of open.repo.list(c)) {
        const old = numbered[d.title];
        if (old) await open.repo.update(c, d._id, { title: old });
      }
    }
    const held = await importEastWinds(open, where, { yes: true });
    expect(held.steps.reduce((n, st) => n + st.created, 0)).toBe(0);
    expect(counts()).toEqual(before);

    // The cleanup renames them back through the write path, with a revision note on each.
    const result = await applyTitleCleanup(open, {
      note: 'Title cleanup (test)',
      questionTags: ['Audit 2026-10-11 PM', 'chapters'],
    });
    expect(result.renamed).toEqual({ books: 0, parts: 2, chapters: 3 });
    expect(result.questions).toBe(0);
    for (const t of Object.values(numbered))
      expect(titles('chapters').concat(titles('parts'))).not.toContain(t);
    const renamed = open.repo.list('chapters').find((c) => c.title === 'Ann leaves')!;
    expect((await open.repo.history('chapters', renamed._id))[0]).toMatchObject({
      note: 'Title cleanup (test)',
    });

    const again = await importEastWinds(open, where, { yes: true });
    expect(again.steps.reduce((n, st) => n + st.created + st.updated, 0)).toBe(0);
    expect(counts()).toEqual(before);
    expect(titles('chapters')).toEqual(chapters);
  });
});

describe('A29 the real High Level sheet plans Book One', () => {
  test('A29 IM-1 the real workbook makes one Book One with 4 parts of 12 chapters in sheet order, each with a primary strand and a second one, the Introduction in 2078, and in Part Four a Forestory present strand with Siyuan as backstory', async () => {
    const real = join(import.meta.dirname, '../../source-material');
    const open = await bible();
    await importEastWinds(open, real, { yes: true });
    const books = open.repo.list('books').filter((b) => b.title === 'Book One');
    expect(books).toHaveLength(1);
    const parts = open.repo
      .list('parts')
      .filter((x) => x.bookId === books[0]!._id)
      .sort((a, b) => a.number - b.number);
    expect(parts.map((x) => [x.number, x.title])).toEqual([
      [1, 'Sins of the Father'],
      [2, 'Lost Spirits'],
      [3, 'Inheritance'],
      [4, 'Circulation'],
    ]);
    // The sheet's own chapter rows, part by part, with the number taken off (PL-3).
    const wb = await parseWorkbookFile(join(real, 'East_Winds_World.xlsx'));
    const sheet = wb.sheets.find((x) => x.name === 'High Level')!;
    const planned: string[][] = [];
    for (const row of sheet.cells) {
      const label = typeof row[0] === 'string' ? row[0].trim() : '';
      if (/^characters$/i.test(label)) break;
      if (/^part\b/i.test(label)) planned.push([]);
      else if (/^ch\.?\s*\d+/i.test(label)) planned.at(-1)!.push(bareTitle('chapter', label));
    }
    expect(planned.map((p) => p.length)).toEqual([12, 12, 12, 12]);
    const chapters = open.repo.list('chapters');
    const inPart = (partId: string) =>
      chapters
        .filter((c) => c.partId === partId && c.title !== 'Introduction')
        .sort((a, b) => a.readingOrder - b.readingOrder);
    expect(parts.map((x) => inPart(x._id).map((c) => c.title))).toEqual(planned);
    for (const c of parts.flatMap((x) => inPart(x._id))) {
      expect(c.strands, c.title).toHaveLength(2);
      expect(
        c.strands.filter((st) => st.primary),
        c.title,
      ).toHaveLength(1);
    }
    const intro = chapters.find((c) => c.title === 'Introduction')!;
    expect(intro.partId).toBe(parts[0]!._id);
    expect(intro.strands.find((st) => st.primary)!.startYear).toBe(2078);
    // Part Four: the later Forestory span is the present strand and Siyuan's earlier span is backstory (A29),
    // as the chapters were made by hand on 2026-10-11.
    for (const c of inPart(parts[3]!._id)) {
      const primary = c.strands.find((st) => st.primary)!;
      const other = c.strands.find((st) => !st.primary)!;
      expect([c.title, primary.label.startsWith('Forestory:')]).toEqual([c.title, true]);
      expect([c.title, other.label.startsWith('Backstory: Siyuan:')]).toEqual([c.title, true]);
    }
    const death = inPart(parts[3]!._id).find((c) => c.title === 'O Death')!;
    expect(death.strands.map((st) => [st.label, st.startYear, st.primary])).toEqual([
      ['Forestory: John', 2096, true],
      ['Backstory: Siyuan: Lost Years', 2074, false],
    ]);
  }, 120_000);
});
