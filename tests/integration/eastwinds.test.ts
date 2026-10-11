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
import { importEastWinds } from '../../src/main/import/eastwinds';
import { freshSlug, localStore } from '../helpers/db';

let store: Store;
let dir: string;
let root: string;

async function docx(file: string, children: Paragraph[]) {
  await writeFile(
    join(dir, file),
    await Packer.toBuffer(new Document({ sections: [{ children }] })),
  );
}
const p = (text: string) => new Paragraph({ text });
const h1 = (text: string) => new Paragraph({ text, heading: HeadingLevel.HEADING_1 });

/** A small invented stand-in with the same shapes as the real material: no real text. */
async function writeSources() {
  const wb = new ExcelJS.Workbook();
  const grid = wb.addWorksheet('High Level');
  grid.addRow(['Invented world', 9, 10, 11, 12]);
  grid.addRow(['Technology']);
  grid.addRow(['Robots', 'First robots', null, 'Robots everywhere', null]);
  grid.addRow(['Climate']);
  grid.addRow(['Floods', null, 'The first flood', null, null]);
  grid.addRow(['Long project', null, 'A bridge begins', null, null]);
  grid.mergeCells('C6:E6');
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
      ws.addRow([`Event ${who} ${i}`, who, 2000 + i, i, `World ${i}`, `Feels ${i}`]),
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
  plot.addRow(['Ann goes to school', 'Ann', 2010, 8, 'A school', 'Nervous']);
  plot.addRow(['Ann meets Ben', 'Ben', 2011, 9, 'A park', 'Happy']);
  plot.addRow(['Book Two']);
  plot.addRow(['Ann leaves', 'Ann', 2020, 18, 'A train', 'Sad']);
  plot.addRow(['Ann misses year', 'Ann', 'later', 19, 'A bad row', 'Fails']);
  await wb.xlsx.writeFile(join(dir, 'East_Winds_World.xlsx'));
  await docx('Dawns_Life.docx', [p('Dawn was born.'), p('Dawn grew.')]);
  await docx('Franks_Life.docx', [p('Frank was born.')]);
  await docx('Marks_Life.docx', [p('Mark was born.')]);
  await docx('East_Winds.docx', [
    h1('East Winds'),
    p('Title page.'),
    h1('Introduction'),
    p('Intro text.'),
    h1('1: Laid the Foundation'),
    p('Chapter one text.'),
    h1('Characters'),
    p('Character notes.'),
  ]);
  await docx('East_Winds_World_Development.docx', [
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
  await writeSources();
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

    // The beats: POV names became characters, with year, world context, and experience note.
    const beats = open.repo.list('plotBeats');
    expect(beats).toHaveLength(3);
    const first = beats.find((b) => b.title === 'Event Ann 0')!;
    expect(first).toMatchObject({
      year: 2000,
      worldContext: 'World 0',
      experienceNote: 'Feels 0',
      tags: ['Sullivan'],
    });
    expect(open.repo.get('characters', first.povCharacterId!)!.title).toBe('Ann');
    expect(beats.find((b) => b.title === 'Event Wei 0')!.tags).toEqual(['李']);

    // Plot v1: books and parts from heading rows, chapters under them, the bad year reported.
    const books = open.repo.list('books').sort((a, b) => a.number - b.number);
    expect(books.map((b) => [b.title, b.number])).toEqual([
      ['Book One', 1],
      ['Book Two', 2],
    ]);
    const parts = open.repo.list('parts');
    expect(parts.map((x) => x.title).sort()).toEqual([
      'Chapters with no part named',
      'Part One: Roots',
    ]);
    const roots = parts.find((x) => x.title === 'Part One: Roots')!;
    expect(roots).toMatchObject({ bookId: books[0]!._id, summary: 'Deep dive on Ann' });
    const chapters = open.repo.list('chapters').filter((c) => c.sourceFile === null);
    expect(chapters.map((c) => [c.title, c.partId === roots._id])).toEqual(
      expect.arrayContaining([
        ['Ann goes to school', true],
        ['Ann meets Ben', true],
        ['Ann leaves', false],
      ]),
    );
    const plotStep = report.steps.find((s) => s.step.endsWith('sheet Plot v1'))!;
    expect(plotStep.failed).toHaveLength(1);
    expect(plotStep.failed[0]).toMatchObject({ where: 'Plot v1 row 8' });
    expect(plotStep.failed[0]!.reason).toMatch(/Story year.*"later" is not a whole number year/);

    // The documents.
    expect(open.repo.list('characters').find((c) => c.title === 'Dawn')!.backstory).toBe(
      '<p>Dawn was born.</p><p>Dawn grew.</p>',
    );
    const manuscript = open.repo.list('chapters').filter((c) => c.sourceFile === 'East_Winds.docx');
    expect(manuscript.map((c) => c.title).sort()).toEqual([
      '1: Laid the Foundation',
      'Introduction',
    ]);
    expect(manuscript.find((c) => c.title === 'Introduction')!.manuscriptText).toBe(
      '<h1>East Winds</h1><p>Title page.</p><h1>Introduction</h1><p>Intro text.</p>',
    );
    const note = open.repo
      .list('customEntries')
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
    const again = await importEastWinds(open, dir);
    expect(again.steps.reduce((n, s) => n + s.created + s.updated, 0)).toBe(0);
    expect(again.steps.reduce((n, s) => n + s.unchanged, 0)).toBeGreaterThan(20);
    expect(open.repo.list('worldEvents')).toHaveLength(4);
    expect(open.repo.list('characters').filter((c) => c.title === 'Dawn')).toHaveLength(1);
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
    expect(real.stdout).toMatch(/failed: Plot v1 row 8: .*"later" is not a whole number year/);
    expect(real.stdout).toMatch(
      /Total: created \d+, updated \d+, unchanged 0, open questions 0, failed rows 1\./,
    );
    expect(real.stdout + real.stderr).not.toMatch(/mongodb(\+srv)?:\/\//);
    const open = await openBibleSession(store, bibleId);
    expect(open.repo.list('worldEvents')).toHaveLength(4);
    const second = await run(common);
    expect(second.stdout).toMatch(/Total: created 0, updated 0, unchanged \d+/);
  });

  test('IM-1 the script refuses an unknown option before it touches the database', async () => {
    await expect(run(['--nope'])).rejects.toMatchObject({
      stderr: expect.stringContaining('Unknown option --nope'),
    });
  });
});
