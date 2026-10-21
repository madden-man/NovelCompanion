import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createBibleWithDefaults, openBibleSession } from '../../src/main/db/session';
import type { OpenBible } from '../../src/main/db/session';
import type { Store } from '../../src/main/db';
import { applyPlan, planDocumentImport, planSheet } from '../../src/main/import/run';
import { parseDocxFile } from '../../src/main/import/docx';
import { parseWorkbookFile } from '../../src/main/import/xlsx';
import { guessMapping } from '../../src/shared/domain/import';
import type { GridMapping, ParsedWorkbook, TableMapping } from '../../src/shared/domain/import';
import { freshSlug, localStore } from '../helpers/db';
import { FIXTURE_WORKBOOK } from '../helpers/importSim';
import { loadFixture } from '../helpers/loadFixture';
import { ipcFor } from '../helpers/ipc';

const DOCX = join(import.meta.dirname, '../../fixtures/files/chapter-03.docx');

let store: Store;
let root: string;

beforeAll(async () => {
  store = await localStore();
  root = await mkdtemp(join(tmpdir(), 'nc-import-'));
});
afterAll(async () => {
  await store.close();
});

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

async function emptyBible(label: string): Promise<OpenBible> {
  const open = await createBibleWithDefaults(store, freshSlug(label), label);
  const again = await openBibleSession(store, open.handle.id, { snapshotRoot: root });
  return again;
}

const earlier = (wb: ParsedWorkbook, iso: string): ParsedWorkbook => ({ ...wb, modifiedAt: iso });

describe('IM-1 IM-2 IM-6 a workbook imports into a real database through the write path', () => {
  test('IM-1 IM-2 IM-6 table rows import, the failing row is reported, and every entry records its source', async () => {
    const open = await emptyBible('im-table');
    const wb = await parseWorkbookFile(FIXTURE_WORKBOOK);
    const { set } = planSheet(open, wb.sheets[0]!, wb, people);
    const result = await applyPlan(open, set, wb, 'all');
    expect(result).toMatchObject({ created: 9, updated: 0 });
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.reason).toMatch(/not a year/);

    const people$ = open.repo.list('characters');
    expect(people$).toHaveLength(7);
    const lan = people$.find((p) => p.title === 'Zhou Lan')!;
    expect(lan).toMatchObject({
      names: { full: 'Zhou Lan', chinese: '周兰' },
      birth: { year: 1988 },
      death: null,
      status: 'canon',
      sourceRef: 'fixture-workbook.xlsx#People!B6',
    });
    expect(open.repo.list('families').map((f) => f.name)).toEqual(['Hale', 'Zhou']);
    const iris = people$.find((p) => p.title === 'Iris Hale-Zhou')!;
    expect(iris.familyIds).toHaveLength(2);
    expect(
      open.repo
        .list('families')
        .map((f) => f._id)
        .sort(),
    ).toEqual([...iris.familyIds].sort());
    // Written through the one write path: every entry has a revision that says where it came from.
    const revisions = await open.repo.revisions('characters', lan._id);
    expect(revisions.map((r) => [r.op, r.note])).toEqual([
      ['create', 'Imported from fixture-workbook.xlsx'],
    ]);
    // Fails fast on a bad import: nothing from the failed row exists.
    expect(open.repo.list('characters').some((c) => c.title === '')).toBe(false);
  });

  test('IM-1 IM-6 a grid sheet imports its cells as dated, categorized world events', async () => {
    const open = await emptyBible('im-grid');
    const wb = await parseWorkbookFile(FIXTURE_WORKBOOK);
    const { set } = planSheet(open, wb.sheets[1]!, wb, grid);
    await applyPlan(open, set, wb, 'all');
    const events = open.repo.list('worldEvents');
    expect(events).toHaveLength(7);
    const courier = events.find((e) => e.title === 'Robot couriers')!;
    expect(courier).toMatchObject({
      start: { year: 2045 },
      sourceRef: 'fixture-workbook.xlsx#High Level!E3',
    });
    const cats = open.repo.lists().find((l) => l._id === 'eventCategories')!.items;
    const robotics = cats.find((c) => c.label === 'Robotics')!;
    const technology = cats.find((c) => c.label === 'Technology')!;
    expect(robotics.parentId).toBe(technology.id);
    expect(courier.categoryId).toBe(robotics.id);
    expect(cats.find((c) => c.label === 'Floods')!.parentId).toBe(
      cats.find((c) => c.label === 'Climate')!.id,
    );
  });
});

describe('IM-1 IM-2 IM-3 SM-3 SM-12 the whole fixture workbook into a fresh bible', () => {
  /** Plan and apply every sheet in order, as the import screen would one after another. */
  const runAll = async (open: OpenBible, wb: ParsedWorkbook) => {
    const hale = wb.sheets.find((x) => x.name === 'Hale and Zhou families')!;
    // The guessed mapping reads the long headers of a moment sheet (IM-1).
    const moments = guessMapping(hale, 'table', { collection: 'moments' }) as TableMapping;
    const mappings = [
      people,
      { ...grid, regionsFromLabels: true, addOnly: ['regions'] },
      moments,
      // A grid of people by year: each cell a moment of the person the row names (SM-12).
      { ...grid, sheet: 'Lives by year', target: { collection: 'moments' as const } },
    ];
    const out = [];
    for (const m of mappings) {
      const sheet = wb.sheets.find((x) => x.name === m.sheet)!;
      const { set } = planSheet(open, sheet, wb, m);
      out.push({ set, result: await applyPlan(open, set, wb, 'all'), mapping: m });
    }
    return out;
  };

  test('IM-1 IM-2 IM-3 SM-3 every sheet imports, the failing rows are reported, a second run changes nothing, and a changed year updates the moment in place', async () => {
    const open = await emptyBible('im-whole');
    const wb = await parseWorkbookFile(FIXTURE_WORKBOOK);
    const first = await runAll(open, wb);
    expect((first[2]!.mapping as TableMapping).columns.map((c) => [c.header, c.field])).toEqual([
      ['Chronological: Hale and Zhou Families', 'title'],
      ['POV', 'characterId'],
      ['Year', 'year'],
      ['Relevant World Events', 'worldContext'],
      ['How the POV Character Experiences This', 'body'],
    ]);
    // IM-2: the nameless person and the moment of someone the bible does not have are reported, the rest import.
    expect(first.flatMap((r) => r.result.failed.map((f) => [f.where, f.reason]))).toEqual([
      ['People row 9', expect.stringMatching(/not a year|no value for the title/)],
      ['Hale and Zhou families row 6', 'Character: No entry is called "Ghost"'],
    ]);
    expect(open.repo.list('worldEvents')).toHaveLength(7);
    const people$ = new Map(open.repo.list('characters').map((c) => [c.title, c._id]));
    const moments = open.repo.list('moments');
    expect(moments.map((m) => [m.title, m.characterId, m.year]).sort()).toEqual(
      [
        ['Margaret meets Peter at the harbour', people$.get('Margaret Hale'), 1980],
        ['Peter and Margaret marry', people$.get('Peter Hale'), 1982],
        ['Daniel is born', people$.get('Margaret Hale'), 1985],
        // A Chinese given name finds Zhou Meiling (周美玲).
        ['Meiling moves to Guangzhou', people$.get('Zhou Meiling'), 1990],
        ['Moves to Portland', people$.get('Margaret Hale'), 1980],
        ['Starts school in Guangzhou', people$.get('Zhou Lan'), 1990],
      ].sort(),
    );
    const marry = moments.find((m) => m.title === 'Peter and Margaret marry')!;
    expect(marry).toMatchObject({
      body: 'Nervous all day',
      worldContext: 'Rain all spring',
      sourceRef: 'fixture-workbook.xlsx#Hale and Zhou families!A3',
    });

    // IM-3: the same file again changes nothing.
    const again = await runAll(open, wb);
    expect(again.map((r) => r.set.items.length)).toEqual([0, 0, 0, 0]);
    expect(open.repo.list('moments')).toHaveLength(6);

    // A newer version of the file moves the wedding a year: the same moment changes, nothing is added.
    const sheet = wb.sheets.find((x) => x.name === 'Hale and Zhou families')!;
    const moved: ParsedWorkbook = {
      ...wb,
      modifiedAt: new Date(Date.parse(wb.modifiedAt) + 86_400_000).toISOString(),
      sheets: wb.sheets.map((x) =>
        x === sheet
          ? {
              ...x,
              cells: x.cells.map((r, i) => (i === 2 ? [r[0]!, r[1]!, 1983, ...r.slice(3)] : r)),
            }
          : x,
      ),
    };
    const third = await runAll(open, moved);
    expect(
      third[2]!.set.items.map((i) => [i.kind, i.entryId, i.deltas.map((d) => d.path)]),
    ).toEqual([['changed', marry._id, ['year']]]);
    expect(open.repo.list('moments')).toHaveLength(6);
    expect(open.repo.get('moments', marry._id)!.year).toBe(1983);
  });
});

describe('IM-3 re-importing updates entries and writes only approved changes', () => {
  test('IM-3 a second import creates no duplicates, and an edited cell changes one entry after approval', async () => {
    const open = await emptyBible('im-reimport');
    const wb = await parseWorkbookFile(FIXTURE_WORKBOOK);
    await applyPlan(open, planSheet(open, wb.sheets[0]!, wb, people).set, wb, 'all');
    const before = open.repo.list('characters').length;

    const same = planSheet(open, wb.sheets[0]!, wb, people).set;
    expect(same.items).toEqual([]);
    expect(same.unchanged).toBe(7);
    await applyPlan(open, same, wb, 'all');
    expect(open.repo.list('characters')).toHaveLength(before);

    const edited = structuredClone(wb);
    edited.modifiedAt = new Date(Date.parse(wb.modifiedAt) + 86_400_000).toISOString();
    edited.sheets[0]!.cells[1]![4] = 2042;
    edited.sheets[0]!.cells[2]![6] = 'Married to Margaret 1982 to 2030';
    const plan = planSheet(open, edited.sheets[0]!, edited, people).set;
    expect(plan.items.map((i) => i.title).sort()).toEqual(['Margaret Hale', 'Peter Hale']);
    const margaret = plan.items.find((i) => i.title === 'Margaret Hale')!;
    const peter = plan.items.find((i) => i.title === 'Peter Hale')!;
    // Only the approved change is written.
    const done = await applyPlan(open, plan, edited, new Set([margaret.id]));
    expect(done).toMatchObject({ created: 0, updated: 1 });
    const live = open.repo.list('characters');
    expect(live.find((c) => c.title === 'Margaret Hale')!.death).toEqual({ year: 2042 });
    expect(live.find((c) => c.title === 'Peter Hale')!.sourceNote).toBe('');
    expect(peter.deltas[0]).toMatchObject({
      path: 'sourceNote',
      before: '',
      after: 'Married to Margaret 1982 to 2030',
    });
    expect(live).toHaveLength(before);
    const history = await open.repo.revisions('characters', margaret.entryId);
    expect(history.map((r) => r.op)).toEqual(['create', 'update']);
  });

  test('IM-3 an entry edited after the comparison is refused instead of overwritten', async () => {
    const open = await emptyBible('im-stale');
    const wb = await parseWorkbookFile(FIXTURE_WORKBOOK);
    await applyPlan(open, planSheet(open, wb.sheets[0]!, wb, people).set, wb, 'all');
    const edited = structuredClone(wb);
    edited.sheets[0]!.cells[1]![4] = 2042;
    const plan = planSheet(open, edited.sheets[0]!, edited, people).set;
    const target = open.repo.list('characters').find((c) => c.title === 'Margaret Hale')!;
    await open.repo.update('characters', target._id, { tags: ['moved on'] });
    await expect(applyPlan(open, plan, edited, 'all')).rejects.toThrow(
      /changed after the import was compared/,
    );
    expect(open.repo.get('characters', target._id)!.death).toEqual({ year: 2041 });
  });

  test('IM-3 BK-1 an import takes a snapshot first', async () => {
    const open = await emptyBible('im-snapshot');
    const wb = await parseWorkbookFile(FIXTURE_WORKBOOK);
    expect(await open.snapshots!.list()).toHaveLength(0);
    await applyPlan(open, planSheet(open, wb.sheets[0]!, wb, people).set, wb, 'all');
    const taken = await open.snapshots!.list();
    expect(taken).toHaveLength(1);
    expect(taken[0]).toMatchObject({ reason: 'import', label: 'import' });
    expect(taken[0]!.counts.characters).toBe(0);
  });
});

describe('IM-7 the newest source wins and an open question lists every source', () => {
  test('IM-7 a newer file replaces the value and creates an open question with both sources and dates', async () => {
    const open = await emptyBible('im-conflict');
    const wb = earlier(await parseWorkbookFile(FIXTURE_WORKBOOK), '2026-01-15T09:00:00.000Z');
    await applyPlan(open, planSheet(open, wb.sheets[0]!, wb, people).set, wb, 'all');
    const newer = structuredClone(wb);
    newer.modifiedAt = '2026-03-01T09:00:00.000Z';
    newer.sheets[0]!.cells[1]![3] = 1959;
    const plan = planSheet(open, newer.sheets[0]!, newer, people).set;
    const done = await applyPlan(open, plan, newer, 'all');
    expect(done.questions).toBe(1);
    const margaret = open.repo.list('characters').find((c) => c.title === 'Margaret Hale')!;
    expect(margaret.birth).toEqual({ year: 1959 });
    const questions = open.repo.list('openQuestions');
    expect(questions).toHaveLength(1);
    expect(questions[0]).toMatchObject({
      state: 'open',
      links: [{ targetId: margaret._id, kind: 'conflict' }],
    });
    expect(questions[0]!.question).toContain(
      'fixture-workbook.xlsx#People!B2 (modified 2026-01-15) says 1958',
    );
    expect(questions[0]!.question).toContain(
      'fixture-workbook.xlsx#People!B2 (modified 2026-03-01) says 1959 [kept]',
    );
  });

  test('IM-7 an older file keeps the newer value but still records the disagreement', async () => {
    const open = await emptyBible('im-conflict-old');
    const wb = earlier(await parseWorkbookFile(FIXTURE_WORKBOOK), '2026-05-01T09:00:00.000Z');
    await applyPlan(open, planSheet(open, wb.sheets[0]!, wb, people).set, wb, 'all');
    const older = structuredClone(wb);
    older.modifiedAt = '2026-02-01T09:00:00.000Z';
    older.sheets[0]!.cells[1]![3] = 1900;
    const plan = planSheet(open, older.sheets[0]!, older, people).set;
    const done = await applyPlan(open, plan, older, 'all');
    expect(done).toMatchObject({ updated: 0, questions: 1 });
    const margaret = open.repo.list('characters').find((c) => c.title === 'Margaret Hale')!;
    expect(margaret.birth).toEqual({ year: 1958 });
    expect(open.repo.list('openQuestions')[0]!.question).toContain('says 1958 [kept]');
    // The record of sources now holds the older claim too.
    expect(
      open.repo.sourceRecords(margaret._id).find((r) => r.path === 'birth')!.others,
    ).toHaveLength(1);
  });
});

describe('IM-7 third versions and stale plans', () => {
  test('IM-7 a third version of a source updates the open question with the new claim instead of opening a second', async () => {
    const open = await emptyBible('im-conflict-third');
    const wb = earlier(await parseWorkbookFile(FIXTURE_WORKBOOK), '2026-01-15T09:00:00.000Z');
    await applyPlan(open, planSheet(open, wb.sheets[0]!, wb, people).set, wb, 'all');
    const second = structuredClone(wb);
    second.modifiedAt = '2026-03-01T09:00:00.000Z';
    second.sheets[0]!.cells[1]![3] = 1959;
    await applyPlan(open, planSheet(open, second.sheets[0]!, second, people).set, second, 'all');
    const third = structuredClone(wb);
    third.modifiedAt = '2026-05-01T09:00:00.000Z';
    third.sheets[0]!.cells[1]![3] = 1960;
    const done = await applyPlan(
      open,
      planSheet(open, third.sheets[0]!, third, people).set,
      third,
      'all',
    );
    expect(done.questions).toBe(0);
    const questions = open.repo.list('openQuestions');
    expect(questions).toHaveLength(1);
    const text = String(questions[0]!.question);
    expect(text).toContain('(modified 2026-01-15) says 1958');
    expect(text).toContain('(modified 2026-03-01) says 1959');
    expect(text).toContain('(modified 2026-05-01) says 1960 [kept]');
    expect(text).not.toContain('says 1959 [kept]');
  });

  test('IM-7 applying a stale plan twice does not append the same losing claim again', async () => {
    const open = await emptyBible('im-conflict-stale');
    const wb = earlier(await parseWorkbookFile(FIXTURE_WORKBOOK), '2026-05-01T09:00:00.000Z');
    await applyPlan(open, planSheet(open, wb.sheets[0]!, wb, people).set, wb, 'all');
    const older = structuredClone(wb);
    older.modifiedAt = '2026-02-01T09:00:00.000Z';
    older.sheets[0]!.cells[1]![3] = 1900;
    const stale = planSheet(open, older.sheets[0]!, older, people).set;
    await applyPlan(open, stale, older, 'all');
    await applyPlan(open, stale, older, 'all');
    const margaret = open.repo.list('characters').find((c) => c.title === 'Margaret Hale')!;
    expect(
      open.repo.sourceRecords(margaret._id).find((r) => r.path === 'birth')!.others,
    ).toHaveLength(1);
    expect(open.repo.list('openQuestions')).toHaveLength(1);
  });
});

describe('IM-4 a Word document imports as a backstory, a chapter, or a note, keeping its formatting', () => {
  async function fixtureSession(label: string): Promise<OpenBible> {
    return openBibleSession(store, (await loadFixture(store, freshSlug(label))).id, {
      snapshotRoot: root,
    });
  }

  test('IM-4 as a chapter: headings, italics, and the scene break are kept, and the source file is linked', async () => {
    const open = await fixtureSession('im-doc-chapter');
    const doc = await parseDocxFile(DOCX);
    const plan = planDocumentImport(open, doc, {
      kind: 'chapter',
      chapterId: null,
      title: 'Wedding Weather, imported',
      partId: 'PT1',
      year: 2029,
    });
    expect(plan.set.failed).toEqual([]);
    await applyPlan(open, plan.set, plan.file, 'all');
    const chapter = open.repo
      .list('chapters')
      .find((c) => c.title === 'Wedding Weather, imported')!;
    expect(chapter.manuscriptText).toBe(
      '<h1>Chapter 3: Wedding Weather</h1><p>It rained on the wedding, and Peter said that was <em>lucky</em>. Meiling said nothing at all.</p><hr><p>Daniel found her later on the porch, watching the river rise.</p>',
    );
    expect(chapter).toMatchObject({
      sourceFile: 'chapter-03.docx',
      sourceRef: 'chapter-03.docx#p1-p4',
      written: true,
    });
    expect(chapter.strands[0]).toMatchObject({ startYear: 2029, primary: true });
    // Re-import: unchanged. A changed document: one change with the old and new text.
    expect(
      planDocumentImport(open, doc, { kind: 'chapter', chapterId: chapter._id }).set.unchanged,
    ).toBe(1);
    const changed = {
      ...doc,
      modifiedAt: '2099-01-01T00:00:00.000Z',
      blocks: doc.blocks.map((b) =>
        b.kind === 'heading' ? { ...b, text: 'Retitled', inner: 'Retitled' } : b,
      ),
    };
    const again = planDocumentImport(open, changed, { kind: 'chapter', chapterId: chapter._id });
    expect(again.set.items[0]!.deltas.map((d) => d.path)).toEqual(['manuscriptText']);
  });

  test('IM-4 as a character backstory and as a general note', async () => {
    const open = await fixtureSession('im-doc-other');
    const doc = await parseDocxFile(DOCX);
    const back = planDocumentImport(open, doc, { kind: 'backstory', characterId: 'H1' });
    await applyPlan(open, back.set, back.file, 'all');
    // A44: an editable field stores Markdown; the top heading lands on the upper level.
    expect(open.repo.get('characters', 'H1')!.backstory).toContain('## Chapter 3: Wedding Weather');
    expect(open.repo.get('characters', 'H1')!.backstory).toContain('*lucky*');
    expect(open.repo.get('characters', 'H1')!.sourceRef).toBe('chapter-03.docx#p1-p4');

    // A39: a general note is an open question, where the capture box files loose notes too.
    const note = planDocumentImport(open, doc, { kind: 'note', title: 'Wedding notes' });
    await applyPlan(open, note.set, note.file, 'all');
    const entry = open.repo.list('openQuestions').find((e) => e.title === 'Wedding notes')!;
    expect(entry).toMatchObject({ sourceRef: 'chapter-03.docx#p1-p4', state: 'open' });
    expect(entry.body).toContain('\n\n---\n\n');
    // The second import finds the note unchanged.
    const second = planDocumentImport(open, doc, { kind: 'note', title: 'Wedding notes' });
    expect(second.set.unchanged).toBe(1);
  });
});

describe('IM-1 the IPC channels preview, compare, and apply through the contract', () => {
  test('IM-1 IM-2 IM-3 pick a file, preview its rows, compare, and apply with the saved mapping', async () => {
    const open = await emptyBible('im-ipc');
    const invoke = ipcFor(() => open, { pickFile: async () => FIXTURE_WORKBOOK });
    const { file } = await invoke('import.pickFile', { kind: 'workbook' });
    expect(file).toMatchObject({ name: 'fixture-workbook.xlsx', kind: 'workbook' });
    const info = await invoke('import.workbook', { fileId: file!.id });
    expect(info.sheets.map((s) => [s.name, s.shape, s.headerRow])).toEqual([
      ['People', 'table', 1],
      ['High Level', 'grid', 1],
      ['Hale and Zhou families', 'table', 1],
      ['Lives by year', 'grid', 1],
    ]);
    expect(info.saved).toEqual([]);

    const guess = await invoke('import.guess', {
      fileId: file!.id,
      sheet: 'People',
      shape: 'table',
      collection: 'characters',
    });
    expect(guess.mapping).toMatchObject({ shape: 'table', headerRow: 1 });
    const fields = (guess.mapping as TableMapping).columns.map((c) => [c.header, c.field]);
    expect(fields).toEqual(
      expect.arrayContaining([
        ['Name', 'title'],
        ['Born', 'birth'],
        ['Died', 'death'],
        ['Family', 'familyIds'],
      ]),
    );

    const preview = await invoke('import.preview', {
      fileId: file!.id,
      mapping: people,
      limit: 20,
    });
    expect(preview).toMatchObject({ total: 8, ok: 7, failed: 1 });
    expect(preview.rows.find((r) => !r.ok)!.reason).toMatch(/not a year/);
    expect(preview.rows[0]).toMatchObject({ ok: true, title: 'Margaret Hale' });

    const plan = await invoke('import.plan', { fileId: file!.id, mapping: people });
    expect(plan).toMatchObject({ created: 9, changed: 0, unchanged: 0 });
    const applied = await invoke('import.apply', {
      planId: plan.planId,
      approved: plan.items.map((i) => i.id),
      saveMapping: true,
    });
    expect(applied).toMatchObject({ created: 9, updated: 0 });
    expect(applied.failed).toHaveLength(1);
    expect(applied.snapshot).not.toBeNull();

    // The mapping was saved per file and sheet in the bible's meta, and comes back with the workbook.
    const again = await invoke('import.workbook', { fileId: file!.id });
    expect(again.saved).toHaveLength(1);
    expect(again.saved[0]!.sheet).toBe('People');
    expect(open.model.get('meta', 'importMappings')).toBeDefined();
    const replan = await invoke('import.plan', {
      fileId: file!.id,
      mapping: again.saved[0]!.mapping,
    });
    expect(replan).toMatchObject({ created: 0, changed: 0, unchanged: 7 });
    await expect(
      invoke('import.apply', { planId: plan.planId, approved: [], saveMapping: false }),
    ).rejects.toThrow(/out of date/);
  });
});

describe('IM-7 IM-3 review fixes in the write path', () => {
  test('IM-7 IM-3 an older source imported twice makes one open question, then nothing at all', async () => {
    const open = await emptyBible('im-twice');
    const wb = earlier(await parseWorkbookFile(FIXTURE_WORKBOOK), '2026-05-01T09:00:00.000Z');
    await applyPlan(open, planSheet(open, wb.sheets[0]!, wb, people).set, wb, 'all');
    const older = structuredClone(wb);
    older.modifiedAt = '2026-02-01T09:00:00.000Z';
    older.sheets[0]!.cells[1]![3] = 1900;
    const first = await applyPlan(
      open,
      planSheet(open, older.sheets[0]!, older, people).set,
      older,
      'all',
    );
    expect(first.questions).toBe(1);
    expect(open.repo.list('openQuestions')).toHaveLength(1);

    const again = planSheet(open, older.sheets[0]!, older, people).set;
    expect(again.items).toEqual([]);
    const second = await applyPlan(open, again, older, 'all');
    expect(second).toMatchObject({ created: 0, updated: 0, questions: 0 });
    expect(open.repo.list('openQuestions')).toHaveLength(1);
    const margaret = open.repo.list('characters').find((c) => c.title === 'Margaret Hale')!;
    expect(margaret.birth).toEqual({ year: 1958 });
  });

  test('IM-7 an open question that already lists the same claims is not asked again by the write path', async () => {
    const open = await emptyBible('im-ask-once');
    const wb = earlier(await parseWorkbookFile(FIXTURE_WORKBOOK), '2026-05-01T09:00:00.000Z');
    await applyPlan(open, planSheet(open, wb.sheets[0]!, wb, people).set, wb, 'all');
    const older = structuredClone(wb);
    older.modifiedAt = '2026-02-01T09:00:00.000Z';
    older.sheets[0]!.cells[1]![3] = 1900;
    const plan = planSheet(open, older.sheets[0]!, older, people).set;
    await applyPlan(open, plan, older, 'all');
    // The same plan, applied again from a stale comparison, must not add a second question.
    const stale = structuredClone(plan);
    for (const item of stale.items) delete item.baseModifiedAt;
    const done = await applyPlan(open, stale, older, 'all');
    expect(done.questions).toBe(0);
    expect(open.repo.list('openQuestions')).toHaveLength(1);
  });

  test('IM-3 after a hand rename of the identity field, a re-import still finds the entry', async () => {
    const open = await emptyBible('im-rename');
    const wb = await parseWorkbookFile(FIXTURE_WORKBOOK);
    await applyPlan(open, planSheet(open, wb.sheets[0]!, wb, people).set, wb, 'all');
    const margaret = open.repo.list('characters').find((c) => c.title === 'Margaret Hale')!;
    await open.repo.update('characters', margaret._id, { title: 'Maggie Hale' });
    const edited = structuredClone(wb);
    edited.modifiedAt = new Date(Date.parse(wb.modifiedAt) + 86_400_000).toISOString();
    edited.sheets[0]!.cells[1]![6] = 'Married to Peter 1982 to 2031';
    const plan = planSheet(open, edited.sheets[0]!, edited, people).set;
    expect(plan.items.filter((i) => i.kind === 'new')).toEqual([]);
    expect(plan.items.filter((i) => i.kind === 'changed')).toHaveLength(1);
    const done = await applyPlan(open, plan, edited, 'all');
    expect(done).toMatchObject({ created: 0, updated: 1 });
    const live = open.repo.list('characters');
    expect(live).toHaveLength(7);
    expect(live.filter((c) => c.title === 'Margaret Hale')).toEqual([]);
    const renamed = live.find((c) => c._id === margaret._id)!;
    expect(renamed.title).toBe('Maggie Hale');
    expect(renamed.sourceNote).toBe('Married to Peter 1982 to 2031');
  });

  test('IM-6 IM-7 a field from a second source: the entry points at the latest source and both are recorded', async () => {
    const open = await emptyBible('im-two-sources');
    const wb = earlier(await parseWorkbookFile(FIXTURE_WORKBOOK), '2026-01-15T09:00:00.000Z');
    await applyPlan(open, planSheet(open, wb.sheets[0]!, wb, people).set, wb, 'all');
    const other = structuredClone(wb);
    other.fileName = 'other-notes.xlsx';
    other.modifiedAt = '2026-04-01T09:00:00.000Z';
    other.sheets[0]!.cells[1]![4] = 2043;
    const across: TableMapping = { ...people, matchIn: 'section' };
    await applyPlan(open, planSheet(open, other.sheets[0]!, other, across).set, other, 'all');
    const margaret = open.repo.list('characters').find((c) => c.title === 'Margaret Hale')!;
    expect(margaret.death).toEqual({ year: 2043 });
    expect(margaret.sourceRef).toBe('other-notes.xlsx#People!B2');
    const death = open.repo.sourceRecords(margaret._id).find((r) => r.path === 'death')!;
    expect([death.ref, ...death.others.map((o) => o.ref)]).toEqual([
      'other-notes.xlsx#People!B2',
      'fixture-workbook.xlsx#People!B2',
    ]);
    // The first source's other fields are still recorded against it.
    expect(open.repo.sourceRecords(margaret._id).find((r) => r.path === 'birth')!.ref).toBe(
      'fixture-workbook.xlsx#People!B2',
    );
    // The first file still finds its entry even though the entry now points at the second.
    const back = planSheet(open, wb.sheets[0]!, wb, people).set;
    expect(back.items.filter((i) => i.kind === 'new' && i.title === 'Margaret Hale')).toEqual([]);
  });
});

describe('IM-3 ED-7 approving an item brings along the new items it points at', () => {
  const plot: TableMapping = {
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
        match: 'banner',
        labelPattern: '^Part\\b',
        linkField: 'partId',
        parentLinkField: 'bookId',
        numberField: 'number',
        fixed: {},
      },
    ],
  };
  const book: ParsedWorkbook = {
    fileName: 'plot.xlsx',
    modifiedAt: '2026-01-15T09:00:00.000Z',
    sheets: [
      {
        name: 'Plot',
        merges: [],
        cells: [
          ['Scene', 'Year'],
          ['Book One', null],
          ['Part One', null],
          ['Opening scene', 2010],
          ['Closing scene', 2011],
        ],
      },
    ],
  };

  test('IM-3 ED-7 approving only a chapter also creates its part and book, so no partId dangles', async () => {
    const open = await emptyBible('im-deps');
    const { set } = planSheet(open, book.sheets[0]!, book, plot);
    const chapter = set.items.find((i) => i.title === 'Opening scene')!;
    expect(set.items.map((i) => i.collection).sort()).toEqual([
      'books',
      'chapters',
      'chapters',
      'parts',
    ]);
    const done = await applyPlan(open, set, book, new Set([chapter.id]));
    expect(done.created).toBe(3);
    const written = open.repo.list('chapters');
    expect(written.map((c) => c.title)).toEqual(['Opening scene']);
    const part = open.repo.get('parts', written[0]!.partId);
    expect(part?.title).toBe('Part One');
    expect(open.repo.get('books', part!.bookId)?.title).toBe('Book One');
    // The other chapter was not approved and was not written.
    expect(open.repo.list('chapters')).toHaveLength(1);
  });

  test('IM-3 ED-7 SM-3 approving a moment also creates the character stub it names', async () => {
    const open = await emptyBible('im-deps-pov');
    const beats: TableMapping = {
      shape: 'table',
      sheet: 'Beats',
      target: { collection: 'moments' },
      headerRow: 1,
      columns: [
        { header: 'Beat', index: 0, field: 'title' },
        { header: 'POV', index: 1, field: 'characterId' },
        { header: 'Year', index: 2, field: 'year' },
      ],
      identity: ['title'],
      fixed: { status: 'planned' },
      addMissingListItems: false,
      createMissing: true,
      matchIn: 'sheet',
      headings: [],
    };
    const wb: ParsedWorkbook = {
      fileName: 'beats.xlsx',
      modifiedAt: '2026-01-15T09:00:00.000Z',
      sheets: [
        {
          name: 'Beats',
          merges: [],
          cells: [
            ['Beat', 'POV', 'Year'],
            ['Ann leaves', 'Ann', 2020],
          ],
        },
      ],
    };
    const { set } = planSheet(open, wb.sheets[0]!, wb, beats);
    const beat = set.items.find((i) => i.collection === 'moments')!;
    await applyPlan(open, set, wb, new Set([beat.id]));
    const written = open.repo.list('moments')[0]!;
    expect(open.repo.get('characters', written.characterId)?.title).toBe('Ann');
  });
});

describe('IM-1 IM-3 list choices follow the approved items that point at them', () => {
  test('IM-1 IM-3 a list choice an approved change points at is written even when no new entry is approved', async () => {
    const open = await openBibleSession(
      store,
      (await loadFixture(store, freshSlug('im-listadds'))).id,
      { snapshotRoot: root },
    );
    const events: TableMapping = {
      shape: 'table',
      sheet: 'Events',
      target: { collection: 'worldEvents' },
      headerRow: 1,
      columns: [
        { header: 'Event', index: 0, field: 'title' },
        { header: 'Year', index: 1, field: 'start' },
        { header: 'Category', index: 2, field: 'categoryId' },
      ],
      identity: ['title'],
      fixed: { status: 'planned' },
      addMissingListItems: true,
      createMissing: false,
      matchIn: 'sheet',
      headings: [],
    };
    const wb = (category: string, at: string): ParsedWorkbook => ({
      fileName: 'events.xlsx',
      modifiedAt: at,
      sheets: [
        {
          name: 'Events',
          merges: [],
          cells: [
            ['Event', 'Year', 'Category'],
            ['The accord', 2040, category],
          ],
        },
      ],
    });
    const first = wb('Technology', '2026-01-15T09:00:00.000Z');
    await applyPlan(open, planSheet(open, first.sheets[0]!, first, events).set, first, 'all');
    const second = wb('Diplomacy', '2026-02-15T09:00:00.000Z');
    const plan = planSheet(open, second.sheets[0]!, second, events).set;
    expect(plan.items.map((i) => i.kind)).toEqual(['changed']);
    expect(plan.listAdds.map((a) => a.label)).toEqual(['Diplomacy']);
    await applyPlan(open, plan, second, new Set([plan.items[0]!.id]));
    const list = open.repo.lists().find((l) => l._id === 'eventCategories')!;
    const event = open.repo.list('worldEvents').find((e) => e.title === 'The accord')!;
    expect(list.items.find((i) => i.id === event.categoryId)?.label).toBe('Diplomacy');
  });
});

describe('IM-4 BK-1 a general note is written inside the import, after the snapshot', () => {
  async function planNote(label: string, options: Parameters<typeof openBibleSession>[2]) {
    const handle = await createBibleWithDefaults(store, freshSlug(label), label);
    const open = await openBibleSession(store, handle.handle.id, options);
    const doc = await parseDocxFile(DOCX);
    const plan = planDocumentImport(open, doc, { kind: 'note', title: 'A note' });
    return { open, plan };
  }
  const notes = (open: OpenBible) =>
    open.repo.list('openQuestions').filter((q) => q.title === 'A note');

  test('IM-4 a failed snapshot leaves no note', async () => {
    const { open, plan } = await planNote('im-note-snap', { snapshotRoot: root });
    open.repo.beforeBulk = async () => {
      throw new Error('The disk is full');
    };
    await expect(applyPlan(open, plan.set, plan.file, 'all')).rejects.toThrow(/disk is full/);
    expect(notes(open)).toEqual([]);
  });

  test('IM-4 a write that fails part way leaves no note either', async () => {
    const { open, plan } = await planNote('im-note-tx', {
      snapshotRoot: root,
      repository: {
        midTransaction: async () => {
          throw new Error('The connection dropped');
        },
      },
    });
    await expect(applyPlan(open, plan.set, plan.file, 'all')).rejects.toThrow(/connection dropped/);
    expect(notes(open)).toEqual([]);
    const fresh = await openBibleSession(store, open.handle.id);
    expect(fresh.repo.list('openQuestions')).toEqual([]);
  });

  test('IM-4 a good import writes the note as an open question', async () => {
    const { open, plan } = await planNote('im-note-ok', { snapshotRoot: root });
    const done = await applyPlan(open, plan.set, plan.file, 'all');
    expect(done.created).toBe(1);
    expect(notes(open)).toHaveLength(1);
    expect(notes(open)[0]!.state).toBe('open');
  });
});
