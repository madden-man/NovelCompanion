import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { configSchemas, entrySchemas, isEntryCollection } from '../../src/shared/schema';
import type { Chapter, Character, EraState, Moment, WorldEvent } from '../../src/shared/schema';
import ExcelJS from 'exceljs';
import { readFixture } from '../helpers/loadFixture';
import { readZipEntry } from '../helpers/zip';

const fixture = readFixture();
const ROOT = join(import.meta.dirname, '../..');
const readExpected = (f: string) =>
  JSON.parse(readFileSync(join(ROOT, 'fixtures/expected', f), 'utf8')) as Record<string, unknown>;

function parsed<T>(collection: string): T[] {
  const schema = isEntryCollection(collection)
    ? entrySchemas[collection]
    : configSchemas[collection as keyof typeof configSchemas];
  return (fixture[collection] ?? []).map((d) => schema.parse(d) as T);
}

const characters = parsed<Character>('characters');
const chapters = parsed<Chapter>('chapters');
const byId = <T extends { _id: string }>(xs: T[], id: string) => {
  const x = xs.find((d) => d._id === id);
  if (!x) throw new Error(`missing ${id}`);
  return x;
};

const PEOPLE: [string, string, number | null, number | null][] = [
  ['H1', 'Margaret Hale', 1958, 2041],
  ['H2', 'Peter Hale', 1956, 2030],
  ['H3', 'Daniel Hale', 1985, null],
  ['H4', 'Ruth Hale', 1990, 2067],
  ['H6', 'Sam Hale', 2012, null],
  ['Z1', 'Zhou Meiling', 1962, 2050],
  ['Z2', 'Zhou Wei', 1960, 2055],
  ['Z3', 'Zhou Lan', 1988, null],
  ['Z4', 'Zhou Jun', 1993, 2070],
  ['H5', 'Iris Hale-Zhou', 2031, null],
  ['X1', 'Tomas Reyes', 2030, null],
  ['Z5', 'Noor Zhou', 2058, null],
  ['U1', 'The Archivist', null, null],
];

describe('Section 7 fixture novel', () => {
  test('Section 7 every fixture document passes its zod schema', () => {
    const collections = Object.keys(fixture);
    expect(collections.length).toBeGreaterThanOrEqual(14);
    for (const c of collections) {
      const schema = isEntryCollection(c)
        ? entrySchemas[c]
        : configSchemas[c as keyof typeof configSchemas];
      expect(schema, `no schema for ${c}`).toBeDefined();
      for (const doc of fixture[c]!) {
        const r = schema.safeParse(doc);
        expect(r.success, `${c}/${doc._id}: ${r.success ? '' : r.error.message}`).toBe(true);
      }
      const ids = fixture[c]!.map((d) => d._id);
      expect(new Set(ids).size, `duplicate IDs in ${c}`).toBe(ids.length);
    }
  });

  test('Section 7 the people table is in the fixture exactly as written', () => {
    expect(characters.map((c) => c._id).sort()).toEqual(PEOPLE.map((p) => p[0]).sort());
    for (const [id, name, born, died] of PEOPLE) {
      const c = byId(characters, id);
      expect(c.names.full).toBe(name);
      expect(c.birth).toEqual(
        born === null ? { unknown: true } : expect.objectContaining({ year: born }),
      );
      expect(c.death).toEqual(died === null ? null : { year: died });
    }
    expect(byId(characters, 'Z1').names.chinese).toBe('周美玲');
    expect(byId(characters, 'X1').familyIds).toEqual([]);
    expect(byId(characters, 'U1').familyIds).toEqual([]);
    expect(byId(characters, 'H5').familyIds.sort()).toEqual(['FAM-HALE', 'FAM-ZHOU']);
    expect(byId(parsed<Moment>('moments'), 'Z3-lives-0')).toMatchObject({
      characterId: 'Z3',
      title: 'Lives in Guangzhou',
    });
  });

  test('Section 7 unions and parent links match the people table', () => {
    const unions = parsed<{
      partnerIds: string[];
      type: string;
      startYear: number | null;
      endYear: number | null;
    }>('unions');
    const u = (a: string, b: string) =>
      unions.find((x) => x.partnerIds.includes(a) && x.partnerIds.includes(b));
    expect(u('H1', 'H2')).toMatchObject({ type: 'married', startYear: 1982, endYear: 2030 });
    expect(u('H3', 'Z3')).toMatchObject({ type: 'married', startYear: 2029, endYear: null });
    expect(u('Z1', 'Z2')).toMatchObject({ type: 'partnered' });
    expect(u('H5', 'X1')).toMatchObject({ startYear: 2056, endYear: 2064 });
    const links = parsed<{
      parentId: string;
      childId: string;
      type: string;
      startYear: number | null;
    }>('parentLinks');
    const parents = (child: string) =>
      links
        .filter((l) => l.childId === child)
        .map((l) => l.parentId)
        .sort();
    expect(parents('H3')).toEqual(['H1', 'H2']);
    expect(parents('H4')).toEqual(['H1', 'H2']);
    expect(parents('Z3')).toEqual(['Z1', 'Z2']);
    expect(parents('Z4')).toEqual(['Z1', 'Z2']);
    expect(parents('H5')).toEqual(['H3', 'Z3']);
    expect(parents('Z5')).toEqual(['H5', 'X1']);
    expect(links.filter((l) => l.childId === 'H6')).toEqual([
      expect.objectContaining({ parentId: 'H4', type: 'adoptive', startYear: 2015 }),
    ]);
    for (const none of ['H1', 'H2', 'Z1', 'Z2', 'X1', 'U1']) expect(parents(none)).toEqual([]);
  });

  test('Section 7 world events: at least 10, one dated 2090, at least three categories', () => {
    const evs = parsed<WorldEvent>('worldEvents');
    expect(evs.length).toBeGreaterThanOrEqual(10);
    expect(evs.filter((e) => 'year' in e.start && e.start.year === 2090)).toHaveLength(1);
    expect(new Set(evs.map((e) => e.categoryId)).size).toBeGreaterThanOrEqual(3);
    const cats = (fixture.lists ?? []).find((l) => l._id === 'eventCategories') as unknown as {
      items: { id: string; parentId: string | null }[];
    };
    const catIds = new Set(cats.items.map((i) => i.id));
    for (const e of evs) expect(catIds.has(e.categoryId)).toBe(true);
    expect(cats.items.some((i) => i.parentId !== null)).toBe(true);
  });

  test('Section 7 era states cover every decade from 2025 to 2100 with no gaps or overlaps', () => {
    const eras = parsed<EraState>('eraStates').sort((a, b) => a.startYear - b.startYear);
    expect(eras[0]?.startYear).toBe(2025);
    expect(eras.at(-1)?.endYear).toBe(2100);
    for (let i = 1; i < eras.length; i++) expect(eras[i]!.startYear).toBe(eras[i - 1]!.endYear + 1);
    for (let decade = 2030; decade <= 2090; decade += 10) {
      expect(eras.some((e) => e.startYear === decade)).toBe(true);
    }
  });

  test('Section 7 cultural entries for two communities with year ranges', () => {
    const entries = parsed<{
      communityId: string;
      startYear: number | null;
      endYear: number | null;
    }>('culturalEntries');
    expect(new Set(entries.map((e) => e.communityId)).size).toBe(2);
    for (const e of entries) {
      expect(e.startYear).not.toBeNull();
      expect(e.endYear).not.toBeNull();
    }
  });

  test('Section 7 five glossary terms with Chinese characters', () => {
    const terms = parsed<{ characters: string }>('glossaryTerms');
    expect(terms).toHaveLength(5);
    for (const t of terms) expect(t.characters).toMatch(/^\p{Script=Han}+$/u);
  });

  test('Section 7 SM-3 the old voice notes and places lived are moments, as migration 9 makes them', () => {
    const moments = parsed<Moment>('moments');
    expect(moments.map((m) => [m._id, m.characterId, m.year, m.endYear, m.title])).toEqual([
      ['H1-voice-0', 'H1', 2028, null, 'Voice'],
      ['H5-voice-0', 'H5', 2060, null, 'Voice'],
      ['Z3-lives-0', 'Z3', 1988, 2027, 'Lives in Guangzhou'],
      ['Z3-lives-1', 'Z3', 2027, null, 'Lives in Portland, Oregon'],
    ]);
    // Margaret's voice note was set at age 70; she is born in 1958.
    expect(byId(moments, 'H1-voice-0').body).toMatch(/short, dry sentences/);
    // SM-2: the dropped collections are gone from the fixture.
    for (const c of ['facts', 'knowledgeRecords', 'customSections', 'customEntries']) {
      expect(fixture[c], c).toBeUndefined();
    }
  });

  test('Section 7 eight chapters in two parts, out of chronological order, one with two strands', () => {
    expect(chapters).toHaveLength(8);
    expect(new Set(chapters.map((c) => c.partId)).size).toBe(2);
    const primaryYear = (c: Chapter) => c.strands.find((s) => s.primary)!.startYear;
    const inReading = [...chapters]
      .sort((a, b) => a.readingOrder - b.readingOrder)
      .map(primaryYear);
    expect(inReading).not.toEqual([...inReading].sort((a, b) => a - b));
    const twoStrand = chapters.filter((c) => c.strands.length === 2);
    expect(twoStrand).toHaveLength(1);
    const [ch] = twoStrand;
    expect(ch!.strands.find((s) => s.label === 'present')).toMatchObject({
      startYear: 2045,
      primary: true,
    });
    expect(ch!.strands.find((s) => s.label === 'backstory')).toMatchObject({
      startYear: 2032,
      primary: false,
    });
  });

  test('Section 7 planted structural errors S1 and S3 are present as data', () => {
    const ch = (n: number) => chapters.find((c) => c.readingOrder === n)!;
    const year = (c: Chapter) => c.strands.find((s) => s.primary)!.startYear;
    // S1
    expect(year(ch(4))).toBe(2032);
    expect(ch(4).strands[0]!.characterIds).toContain('H2');
    expect(byId(characters, 'H2').death).toEqual({ year: 2030 });
    // S3
    const ev = parsed<WorldEvent>('worldEvents').find(
      (e) => 'year' in e.start && e.start.year === 2090,
    )!;
    expect(ch(6).links).toContainEqual({ targetId: ev._id, kind: 'happened' });
  });

  test('Section 7 planted prose errors P1 and P2 are present in chapter text', () => {
    const ch = (n: number) => chapters.find((c) => c.readingOrder === n)!;
    expect(ch(5).strands[0]!.startYear).toBe(2040);
    expect(ch(5).manuscriptText).toMatch(/seventy/);
    expect(ch(7).manuscriptText).toMatch(/Lan had grown up in Shanghai/);
    expect(byId(characters, 'Z3').backstory).toMatch(/Guangzhou/);
  });

  test('Section 7 expected structural findings name real chapters and entries', () => {
    const exp = readExpected('structural-findings.json') as {
      $comment: string;
      findings: { id: string; chapterId: string; entryIds: string[] }[];
      cleanChapterIds: string[];
    };
    expect(exp.$comment).toMatch(/Hand-written.*never be generated/s);
    expect(exp.findings.map((f) => f.id)).toEqual(['S1', 'S3']);
    const all = new Set(
      Object.values(fixture)
        .flat()
        .map((d) => d._id),
    );
    for (const f of exp.findings) {
      expect(all.has(f.chapterId)).toBe(true);
      for (const id of f.entryIds) expect(all.has(id)).toBe(true);
    }
    const flagged = new Set(exp.findings.map((f) => f.chapterId));
    expect([...exp.cleanChapterIds, ...flagged].sort()).toEqual(chapters.map((c) => c._id).sort());
  });

  test('Section 7 expected TL-2 answers list every person in the people table exactly once per year', () => {
    const exp = readExpected('tl2.json') as {
      $comment: string;
      years: {
        year: number;
        alive: { id: string }[];
        dead: { id: string }[];
        unborn: string[];
        unknown: string[];
      }[];
    };
    expect(exp.$comment).toMatch(/Hand-written.*never be generated/s);
    expect(exp.years.map((y) => y.year)).toEqual([2040, 2041, 2075]);
    const people = PEOPLE.map((p) => p[0]).sort();
    for (const y of exp.years) {
      const listed = [
        ...y.alive.map((a) => a.id),
        ...y.dead.map((d) => d.id),
        ...y.unborn,
        ...y.unknown,
      ];
      expect(listed.sort(), `year ${y.year}`).toEqual(people);
    }
  });

  test('Section 7 expected TL-2 answers match the spec text', () => {
    const exp = readExpected('tl2.json') as {
      years: {
        year: number;
        alive: { id: string; age: number; dyingThisYear: boolean }[];
        dead: { id: string }[];
        unborn: string[];
        unknown: string[];
      }[];
    };
    const y = (n: number) => exp.years.find((e) => e.year === n)!;
    const ages = (n: number) => Object.fromEntries(y(n).alive.map((a) => [a.id, a.age]));
    expect(ages(2040)).toEqual({
      H1: 82,
      H3: 55,
      H4: 50,
      H5: 9,
      H6: 28,
      Z1: 78,
      Z2: 80,
      Z3: 52,
      Z4: 47,
      X1: 10,
    });
    expect(y(2040).dead.map((d) => d.id)).toEqual(['H2']);
    expect(y(2040).unborn).toEqual(['Z5']);
    expect(y(2041).alive.find((a) => a.id === 'H1')).toEqual({
      id: 'H1',
      age: 83,
      dyingThisYear: true,
    });
    expect(ages(2075)).toEqual({ H3: 90, H5: 44, H6: 63, Z3: 87, X1: 45, Z5: 17 });
    expect(
      y(2075)
        .dead.map((d) => d.id)
        .sort(),
    ).toEqual(['H1', 'H2', 'H4', 'Z1', 'Z2', 'Z4']);
    for (const n of [2040, 2041, 2075]) expect(y(n).unknown).toEqual(['U1']);
  });

  test('Section 7 fixture workbook has one table sheet and one grid sheet', async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(join(ROOT, 'fixtures/files/fixture-workbook.xlsx'));
    expect(wb.worksheets.map((w) => w.name)).toEqual([
      'People',
      'High Level',
      'Hale family',
      'Lives by year',
    ]);
    const table = wb.getWorksheet('People')!;
    expect(table.getRow(1).values).toEqual([
      undefined,
      'ID',
      'Name',
      'Chinese name',
      'Born',
      'Died',
      'Family',
      'Notes',
    ]);
    expect(table.rowCount).toBeGreaterThan(5);
    const grid = wb.getWorksheet('High Level')!;
    const header = (grid.getRow(1).values as unknown[]).slice(2);
    expect(header.every((v) => typeof v === 'number' && v >= 2025)).toBe(true);
    // A heading row has a label and no cells; a data row has a label and dated cells.
    expect(grid.getRow(2).cellCount).toBe(1);
    expect(grid.getRow(3).getCell(1).value).toBe('Robotics');
    expect(grid.getRow(3).getCell(2).value).toBe('Care robots common');
  });

  test('Section 7 fixture Word document has a heading and an italic run', () => {
    const docx = readFileSync(join(ROOT, 'fixtures/files/chapter-03.docx'));
    const xml = readZipEntry(docx, 'word/document.xml');
    expect(xml).toBeDefined();
    expect(xml).toMatch(/<w:pStyle w:val="Heading1"\/>/);
    expect(xml).toMatch(/<w:i\/>.*?<w:t[^>]*>lucky<\/w:t>/s);
  });
});
