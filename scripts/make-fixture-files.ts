/**
 * Writes the fixture workbook and Word document into fixtures/files/.
 * Run with `npm run fixtures:files`. The outputs are committed; this script
 * exists so they can be rebuilt by hand, never during tests.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx';

const OUT = join(import.meta.dirname, '../fixtures/files');
const FIXED_DATE = new Date('2026-01-15T09:00:00.000Z');

async function workbook(): Promise<void> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Novel Companion fixture';
  wb.created = FIXED_DATE;
  wb.modified = FIXED_DATE;

  // A table sheet: one row per entry (IM-1).
  const people = wb.addWorksheet('People');
  people.addRow(['ID', 'Name', 'Chinese name', 'Born', 'Died', 'Family', 'Notes']);
  const rows: (string | number | null)[][] = [
    ['H1', 'Margaret Hale', null, 1958, 2041, 'Hale', 'Married to Peter 1982 to 2030'],
    ['H2', 'Peter Hale', null, 1956, 2030, 'Hale', null],
    ['H3', 'Daniel Hale', null, 1985, null, 'Hale', 'Married to Zhou Lan from 2029'],
    ['Z1', 'Zhou Meiling', '周美玲', 1962, 2050, 'Zhou', 'Partner of Zhou Wei'],
    ['Z3', 'Zhou Lan', '周兰', 1988, null, 'Zhou', 'Raised in Guangzhou'],
    ['H5', 'Iris Hale-Zhou', '晓曦', 2031, null, 'Hale; Zhou', 'In both families'],
    ['U1', 'The Archivist', null, 'unknown', null, null, 'No family'],
    ['BAD', null, null, 'not a year', null, null, 'This row has no name and should be reported'],
  ];
  rows.forEach((r) => people.addRow(r));
  people.getRow(1).font = { bold: true };

  // A grid sheet: row label by year column (A12). Heading rows have no cells.
  const grid = wb.addWorksheet('High Level');
  grid.addRow(['', 2030, 2035, 2040, 2045, 2050]);
  grid.addRow(['Technology']);
  grid.addRow(['Robotics', 'Care robots common', null, null, 'Robot couriers', null]);
  grid.addRow(['Energy', null, null, 'Grid batteries', null, 'Coal gone in Guangdong']);
  grid.addRow(['Climate']);
  grid.addRow(['Floods', null, 'King tide floods Portland', null, null, 'Delta seawall done']);
  grid.addRow(['Geopolitics']);
  grid.addRow(['Trade', null, 'Pacific Rim accord', null, null, null]);
  grid.getRow(1).font = { bold: true };
  [2, 5, 7].forEach((r) => {
    grid.getRow(r).font = { bold: true };
  });

  // A moments sheet shaped like the East Winds Sullivan and 李 sheets (SM-3, A39): one row per moment, the
  // character by a short name or a Chinese name, and one row that names no one.
  const moments = wb.addWorksheet('Hale and Zhou families');
  moments.addRow([
    'Chronological: Hale and Zhou Families',
    'POV',
    'Year',
    'POV Age',
    'Relevant World Events',
    'How the POV Character Experiences This',
  ]);
  const momentRows: (string | number | null)[][] = [
    [
      'Margaret meets Peter at the harbour',
      'Margaret',
      1980,
      22,
      'A cold decade',
      'Thinks he is too quiet',
    ],
    ['Peter and Margaret marry', 'Peter', 1982, 26, 'Rain all spring', 'Nervous all day'],
    ['Daniel is born', 'Margaret', 1985, 27, 'Satellite television arrives', 'Tired and proud'],
    [
      'Meiling moves to Guangzhou',
      '美玲',
      1990,
      28,
      'Guangdong opens to trade',
      'Lonely the first year',
    ],
    ['Nobody remembers the storm', 'Ghost', 2001, null, null, null],
  ];
  momentRows.forEach((r) => moments.addRow(r));
  moments.getRow(1).font = { bold: true };

  // A grid of people by year (SM-12): each filled cell is a moment of the person the row names.
  const lives = wb.addWorksheet('Lives by year');
  lives.addRow(['', 1980, 1985, 1990]);
  lives.addRow(['Hale family']);
  lives.addRow(['Margaret', 'Moves to Portland', null, null]);
  lives.addRow(['Zhou Lan', null, null, 'Starts school in Guangzhou']);
  lives.getRow(1).font = { bold: true };
  lives.getRow(2).font = { bold: true };

  await wb.xlsx.writeFile(join(OUT, 'fixture-workbook.xlsx'));
}

async function wordDocument(): Promise<void> {
  const doc = new Document({
    creator: 'Novel Companion fixture',
    title: 'Chapter 3: Wedding Weather',
    sections: [
      {
        children: [
          new Paragraph({ text: 'Chapter 3: Wedding Weather', heading: HeadingLevel.HEADING_1 }),
          new Paragraph({
            children: [
              new TextRun('It rained on the wedding, and Peter said that was '),
              new TextRun({ text: 'lucky', italics: true }),
              new TextRun('. Meiling said nothing at all.'),
            ],
          }),
          new Paragraph({ text: '* * *' }),
          new Paragraph({ text: 'Daniel found her later on the porch, watching the river rise.' }),
        ],
      },
    ],
  });
  const buf = await Packer.toBuffer(doc);
  writeFileSync(join(OUT, 'chapter-03.docx'), buf);
}

mkdirSync(OUT, { recursive: true });
await workbook();
await wordDocument();
console.log(`Wrote fixture files to ${OUT}`);
