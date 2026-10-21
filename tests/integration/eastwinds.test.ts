import { execFile } from 'node:child_process';
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
  /** The title of a Plot v1 chapter the manuscript's chapter 1 should attach to, in its own part. */
  chapterOne?: string;
  /** The year of the first Sullivan beat. */
  firstBeatYear?: number;
  /** Give the Plot v1 chapter rows a "Ch. N: " prefix, numbered within their part. */
  numbered?: boolean;
}

/** A small invented stand-in with the same shapes as the real material: no real text. */
async function writeSources(where: string, opts: SourceOptions = {}) {
  const wb = new ExcelJS.Workbook();
  const grid = wb.addWorksheet('High Level');
  const bold = (row: number) => {
    grid.getRow(row).font = { bold: true };
  };
  grid.addRow(['Invented world', 9, 10, 11, 12]);
  // Rows above the Foundational Drivers heading are chapters, parts, and characters, not world events.
  grid.addRow(['Part One: Roots']);
  bold(2);
  grid.addRow(['Ch. 1: A first chapter', 'x', 'y', null, null]);
  grid.addRow(['Characters']);
  bold(4);
  grid.addRow(['Ann', 'born']);
  grid.addRow(['Foundational Drivers']);
  bold(6);
  grid.addRow(['Technology']);
  bold(7);
  grid.addRow(['Robots', 'First robots', null, 'Robots everywhere', null]);
  grid.addRow(['Climate']);
  bold(9);
  grid.addRow(['Floods', null, 'The first flood', null, null]);
  grid.addRow(['Long project', null, 'A bridge begins', null, null]);
  grid.mergeCells('C11:E11');
  const beats = (name: string, pov: string[]) => {
    const ws = wb.addWorksheet(name);
    ws.addRow([
      'Chronological',
      'POV',
      'Year',
      'POV Age',
      'Relevant World Events',
      'How the POV Character Experiences It',
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
  beats('Sullivan', ['Ann', 'Ben']);
  beats('李', ['Wei']);
  const plot = wb.addWorksheet('Plot v1');
  plot.addRow([
    'Plot',
    'POV',
    'Year',
    'POV Age',
    'Relevant World Events',
    'How the POV Character Experiences It',
  ]);
  plot.addRow(['Book One']);
  plot.addRow(['Part One: Roots', 'Deep dive on Ann']);
  plot.mergeCells('B3:F3');
  const ch = (n: number, t: string) => (opts.numbered ? `Ch. ${n}: ${t}` : t);
  plot.addRow([ch(1, 'Ann goes to school'), 'Ann', 2010, 8, 'A school', 'Nervous']);
  plot.addRow([ch(2, 'Ann meets Ben'), 'Ben', 2011, 9, 'A park', 'Happy']);
  // A part whose merged banner is empty, then chapters.
  plot.addRow(['Part Two: Branches']);
  plot.mergeCells('B6:F6');
  if (opts.chapterOne) plot.addRow([opts.chapterOne, 'Ann', 2012, 10, 'A tree', 'Calm']);
  plot.addRow([ch(opts.chapterOne ? 2 : 1, 'Ann grows up'), 'Ann', 2015, 13, 'A road', 'Proud']);
  // A part that is only its label.
  plot.addRow(['Part Three: Leaves']);
  plot.addRow([ch(1, 'Ann ages'), 'Ann', 2018, 16, 'A letter', 'Wistful']);
  plot.addRow(['Book Two']);
  plot.addRow([ch(1, 'Ann leaves'), 'Ann', 2020, 18, 'A train', 'Sad']);
  plot.addRow(['Ann misses year', 'Ann', 'later', 19, 'A bad row', 'Fails']);
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

describe('IM-1 IM-4 the East Winds import maps the workbook and documents with sensible defaults', () => {
  test('IM-1 a dry run reports what would happen and writes nothing', async () => {
    const open = await bible();
    const report = await importEastWinds(open, dir, { dryRun: true });
    expect(report.dryRun).toBe(true);
    expect(report.snapshot).toBeNull();
    expect(open.repo.list('worldEvents')).toEqual([]);
    expect(await open.snapshots!.list()).toEqual([]);
    const steps = Object.fromEntries(report.steps.map((s) => [s.step, s]));
    expect(steps['East_Winds_World.xlsx, sheet High Level']).toMatchObject({
      created: 4,
      failed: [],
    });
  });

  test('IM-1 IM-2 IM-3 IM-4 IM-6 the full import takes a snapshot, reports the failed row, and a second run changes nothing', async () => {
    const open = await bible();
    const report = await importEastWinds(open, dir);
    expect(report.snapshot).not.toBeNull();
    expect((await open.snapshots!.list()).map((s) => s.reason)).toEqual(['import']);

    // The grid: header 9 to 12 stands for 2009 to 2012, merged cells last across years, headings give categories.
    const events = open.repo.list('worldEvents');
    const yearOf = (d: object | null) => (d && 'year' in d ? d.year : null);
    expect(events.map((e) => [e.title, yearOf(e.start), yearOf(e.end)]).sort()).toEqual(
      [
        ['A bridge begins', 2010, 2012],
        ['First robots', 2009, null],
        ['Robots everywhere', 2011, null],
        ['The first flood', 2010, null],
      ].sort(),
    );
    const cats = open.repo.lists().find((l) => l._id === 'eventCategories')!.items;
    const robots = cats.find((c) => c.label === 'Robots')!;
    expect(cats.find((c) => c.id === robots.parentId)!.label).toBe('Technology');
    expect(events.every((e) => e.sourceRef.startsWith('East_Winds_World.xlsx#High Level!'))).toBe(
      true,
    );

    // SM-3: the beats are moments: POV names became characters, with year, world context, and experience.
    const beats = open.repo.list('moments');
    expect(beats).toHaveLength(3);
    const first = beats.find((b) => b.title === 'Event Ann 0')!;
    expect(first).toMatchObject({
      year: 2000,
      worldContext: 'World 0',
      body: 'Feels 0',
      tags: ['Sullivan'],
    });
    expect(open.repo.get('characters', first.characterId)!.title).toBe('Ann');
    expect(beats.find((b) => b.title === 'Event Wei 0')!.tags).toEqual(['李']);

    // Plot v1: books and parts from heading rows, chapters under them, the bad year reported.
    const books = open.repo.list('books').sort((a, b) => a.number - b.number);
    expect(books.map((b) => [b.title, b.number])).toEqual([
      ['Book One', 1],
      ['Book Two', 2],
    ]);
    const parts = open.repo.list('parts');
    // Part Two has an empty merged banner and Part Three only its label: both are parts, not books.
    // "Part One: Roots" is part 1 named "Roots": the number is in the number field (PL-3).
    expect(parts.map((x) => [x.title, x.number]).sort()).toEqual([
      ['Branches', 2],
      ['Chapters with no part named', 1],
      ['Leaves', 3],
      ['Roots', 1],
    ]);
    const partOf = (title: string) => parts.find((x) => x.title === title)!;
    expect(partOf('Branches').bookId).toBe(books[0]!._id);
    expect(partOf('Leaves').bookId).toBe(books[0]!._id);
    const byTitle = (t: string) => open.repo.list('chapters').find((c) => c.title === t)!;
    expect(byTitle('Ann grows up').partId).toBe(partOf('Branches')._id);
    expect(byTitle('Ann ages').partId).toBe(partOf('Leaves')._id);
    const roots = parts.find((x) => x.title === 'Roots')!;
    expect(roots).toMatchObject({ bookId: books[0]!._id, summary: 'Deep dive on Ann' });
    // Chapter 1 of the manuscript attaches to the first plot chapter, so that one now names the manuscript file too.
    const chapters = open.repo.list('chapters').filter((c) => c.title !== 'Introduction');
    expect(chapters.map((c) => [c.title, c.partId === roots._id])).toEqual(
      expect.arrayContaining([
        ['Ann goes to school', true],
        ['Ann meets Ben', true],
        ['Ann leaves', false],
      ]),
    );
    const plotStep = report.steps.find((s) => s.step.endsWith('sheet Plot v1'))!;
    expect(plotStep.failed).toHaveLength(1);
    expect(plotStep.failed[0]).toMatchObject({ where: 'Plot v1 row 12' });
    expect(plotStep.failed[0]!.reason).toMatch(/Story year.*"later" is not a whole number year/);

    // The documents.
    expect(open.repo.list('characters').find((c) => c.title === 'Dawn')!.backstory).toBe(
      '<p>Dawn was born.</p><p>Dawn grew.</p>',
    );
    const manuscript = open.repo.list('chapters').filter((c) => c.sourceFile === 'East_Winds.docx');
    expect(manuscript.map((c) => c.title).sort()).toEqual(['Ann goes to school', 'Introduction']);
    const stepNotes = (name: string) => report.steps.find((st) => st.step.endsWith(name))!.notes;
    expect(stepNotes('East_Winds.docx, Introduction').join(' ')).toContain(
      'New chapter placed in the part of "Ann goes to school", just before it.',
    );
    expect(manuscript.find((c) => c.title === 'Introduction')!.manuscriptText).toBe(
      '<h1>East Winds</h1><p>Title page.</p><h1>Introduction</h1><p>Intro text.</p>',
    );
    const note = open.repo
      .list('openQuestions')
      .find((e) => e.title.startsWith('East Winds: the rest'))!;
    expect(note.body).toBe('<h1>Characters</h1><p>Character notes.</p>');
    const eras = open.repo
      .list('eraStates')
      .filter((e) => e.sourceRef.startsWith('East_Winds_World_Development.docx'));
    expect(eras.map((e) => [e.name, e.startYear, e.endYear])).toEqual([
      ['2025–2038: THE FIRST DIVIDE', 2025, 2038],
      ['2039: THE HINGE', 2039, 2039],
    ]);

    // Running it again finds everything already there.
    const again = await importEastWinds(open, dir, { yes: true });
    expect(again.held).toBe(false);
    expect(again.steps.reduce((n, s) => n + s.created + s.updated, 0)).toBe(0);
    expect(again.steps.reduce((n, s) => n + s.unchanged, 0)).toBeGreaterThan(20);
    expect(open.repo.list('worldEvents')).toHaveLength(4);
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
    expect(
      open.repo
        .list('parts')
        .filter((x) => x.title !== 'Chapters with no part named')
        .map((x) => [x.title, x.number])
        .sort(),
    ).toEqual([
      ['Branches', 2],
      ['Leaves', 3],
      ['Roots', 1],
    ]);
  });

  test('IM-2 High Level only imports the world events: chapter rows, parts, and the characters block are skipped and reported', async () => {
    const open = await bible();
    const report = await importEastWinds(open, dir);
    const titles = open.repo.list('worldEvents').map((e) => e.title);
    expect(titles).not.toContain('x');
    expect(titles).not.toContain('born');
    const cats = open.repo
      .lists()
      .find((l) => l._id === 'eventCategories')!
      .items.map((c) => c.label);
    for (const skipped of ['Part One: Roots', 'Ch. 1: A first chapter', 'Characters', 'Ann']) {
      expect(cats).not.toContain(skipped);
    }
    const high = report.steps.find((st) => st.step.endsWith('sheet High Level'))!;
    expect(high.notes.join(' ')).toMatch(/Skipped 4 rows \(rows 2 to 5\) with 3 filled cells/);
    expect(high.notes.join(' ')).toContain('Ch. 1: A first chapter');
    expect(high.created).toBe(4);
  });

  test('IM-1 IM-6 manuscript chapter 1 attaches to the Plot v1 chapter with the same number, and the introduction sits just before it', async () => {
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
      'Ann goes to school',
      'Ann meets Ben',
      'Introduction',
      '1 Something else',
      'Ann grows up',
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

  test('IM-1 when no plot chapter title carries a number, chapter 1 attaches to the first chapter in reading order and says why', async () => {
    const open = await bible();
    const report = await importEastWinds(open, dir);
    const chapters = open.repo.list('chapters');
    const one = chapters.find((c) => c.title === 'Ann goes to school')!;
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
      'No plot chapter title carries a number, so chapter 1 was attached to the first chapter in reading order ("Ann goes to school")',
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
    const own = await open.repo.create('chapters', {
      title: '1: Laid the Foundation',
      partId: part._id,
      readingOrder: 1,
      status: 'planned',
      strands: [{ id: 'S1', label: 'present', startYear: 2000, primary: true }],
      sourceFile: 'East_Winds.docx',
      sourceRef: 'East_Winds.docx#p1',
    } as never);
    const report = await importEastWinds(open, dir, { yes: true });
    const step = report.steps.find((st) =>
      st.step.endsWith('East_Winds.docx, 1: Laid the Foundation'),
    )!;
    expect(step.notes.join(' ')).not.toContain('existing chapter');
    expect(open.repo.get('chapters', own._id)!.manuscriptText).toContain('Chapter one text.');
    expect(
      open.repo.list('chapters').filter((c) => c.title === 'Ann goes to school')[0]!.sourceFile,
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

  test('IM-3 SM-3 a beat moment is the same moment when its sheet and title match, so a changed year is an update, not a duplicate', async () => {
    const open = await bible();
    await importEastWinds(open, dir);
    const changed = await sources({ firstBeatYear: 2005 });
    const report = await importEastWinds(open, changed, { yes: true });
    const sullivan = report.steps.find((st) => st.step.endsWith('sheet Sullivan'))!;
    expect(sullivan).toMatchObject({ created: 0, updated: 1 });
    const beats = open.repo.list('moments');
    expect(beats).toHaveLength(3);
    expect(beats.filter((b) => b.title === 'Event Ann 0')).toHaveLength(1);
    expect(beats.find((b) => b.title === 'Event Ann 0')!.year).toBe(2005);
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
    expect(open.repo.list('worldEvents')).toHaveLength(4);
  });
});

describe('IM-1 the import:eastwinds script', () => {
  const run = (args: string[]) =>
    promisify(execFile)('node', ['scripts/import-eastwinds.ts', ...args], {
      cwd: join(import.meta.dirname, '../..'),
      env: { ...process.env, NOVEL_COMPANION_TEST_MONGODB_URI: inject('mongoUri') },
      timeout: 120_000,
    });

  test('IM-1 IM-2 the script imports a folder into a named bible, prints counts and failed rows, and takes a snapshot first', async () => {
    const bibleId = freshSlug('ew-script');
    const common = ['--dir', dir, '--bible', bibleId, '--snapshots', root];
    const dry = await run([...common, '--dry-run']);
    expect(dry.stdout).toContain('Dry run (nothing is written)');
    expect(dry.stdout).toContain('Total: created');
    expect(dry.stdout).not.toContain('Snapshot before the import');
    const real = await run(common);
    expect(real.stdout).toMatch(/Snapshot taken: \d{4}-/);
    expect(real.stdout).toContain('East_Winds_World.xlsx, sheet Plot v1');
    expect(real.stdout).toMatch(/failed: Plot v1 row 12: .*"later" is not a whole number year/);
    expect(real.stdout).toMatch(
      /Total: created \d+, updated \d+, unchanged 0, open questions 0, failed rows 1\./,
    );
    expect(real.stdout + real.stderr).not.toMatch(/mongodb(\+srv)?:\/\//);
    const open = await openBibleSession(store, bibleId);
    expect(open.repo.list('worldEvents')).toHaveLength(4);
    // The bible now holds imported entries: without --yes the run only reports.
    const second = await run(common);
    expect(second.stdout).toContain('already holds imported entries');
    expect(second.stdout).toContain('run again with --yes');
    expect(second.stdout).not.toContain('Snapshot taken');
    expect(second.stdout).toMatch(/Total: created 0, updated 0, unchanged \d+/);
    const third = await run([...common, '--yes']);
    expect(third.stdout).not.toContain('already holds imported entries');
    expect(third.stdout).toContain('Snapshot taken');
    expect(third.stdout).toMatch(/Total: created 0, updated 0, unchanged \d+/);
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
      run(['--dir', dir, '--bible', bibleId, '--snapshots', root, '--dry-run']),
    ).rejects.toMatchObject({ stderr: expect.stringMatching(/migrations pending/) });
    expect((await registry.findOne({ _id: bibleId }))!.schemaVersion).toBe(0);
    // A normal open still migrates it.
    await openBibleSession(store, bibleId);
    expect((await registry.findOne({ _id: bibleId }))!.schemaVersion).toBeGreaterThan(0);
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
      expect.arrayContaining(['Ann goes to school', 'Ann meets Ben', 'Ann grows up', 'Ann leaves']),
    );
    expect(chapters.filter((t) => /^Ch\./.test(t))).toEqual([]);
    const counts = () =>
      (['books', 'parts', 'chapters'] as const).map((c) => open.repo.list(c).length);
    const before = counts();

    // A bible imported before this change holds the numbered titles; its entries are still found.
    const numbered: Record<string, string> = {
      Roots: 'Part One: Roots',
      Branches: 'Part Two: Branches',
      'Ann goes to school': 'Ch. 1: Ann goes to school',
      'Ann meets Ben': 'Ch. 2: Ann meets Ben',
      'Ann ages': 'Ch. 1: Ann ages',
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
    const renamed = open.repo.list('chapters').find((c) => c.title === 'Ann ages')!;
    expect((await open.repo.history('chapters', renamed._id))[0]).toMatchObject({
      note: 'Title cleanup (test)',
    });

    const again = await importEastWinds(open, where, { yes: true });
    expect(again.steps.reduce((n, st) => n + st.created + st.updated, 0)).toBe(0);
    expect(counts()).toEqual(before);
    expect(titles('chapters')).toEqual(chapters);
  });
});
