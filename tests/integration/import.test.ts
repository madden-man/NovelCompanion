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
      sourceRef: 'fixture-workbook.xlsx#People!R6',
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
      reality: 'invented',
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
      'fixture-workbook.xlsx#People!R2 (modified 2026-01-15) says 1958',
    );
    expect(questions[0]!.question).toContain(
      'fixture-workbook.xlsx#People!R2 (modified 2026-03-01) says 1959 [kept]',
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

describe('CS-2 custom entries import like built-in ones', () => {
  test('CS-2 a table sheet fills a custom section: choices, years, history, and source location', async () => {
    const open = await openBibleSession(
      store,
      (await loadFixture(store, freshSlug('im-custom'))).id,
      { snapshotRoot: root },
    );
    const wb: ParsedWorkbook = {
      fileName: 'recipes.xlsx',
      modifiedAt: '2026-04-01T09:00:00.000Z',
      sheets: [
        {
          name: 'Recipes',
          merges: [],
          cells: [
            ['Dish', 'Where from', 'First cooked', 'Occasion'],
            ['Tomato soup', 'Portland, Oregon', 1990.0, 'Everyday'],
            ['Funeral rice', 'Guangzhou', 'about 1950', 'Funeral'],
            ['Pancakes', 'Home', 2001, 'Brunch'],
          ],
        },
      ],
    };
    const mapping: TableMapping = {
      shape: 'table',
      sheet: 'Recipes',
      target: { collection: 'customEntries', sectionId: 'CS-RECIPES' },
      headerRow: 1,
      columns: [
        { header: 'Dish', index: 0, field: 'title' },
        { header: 'Where from', index: 1, field: 'values.origin' },
        { header: 'First cooked', index: 2, field: 'values.firstCooked' },
        { header: 'Occasion', index: 3, field: 'values.occasion' },
      ],
      identity: ['title'],
      fixed: { status: 'planned' },
      addMissingListItems: false,
      createMissing: false,
      matchIn: 'sheet',
      headings: [],
    };
    const { set } = planSheet(open, wb.sheets[0]!, wb, mapping);
    expect(set.failed.map((f) => [f.where, f.reason])).toEqual([
      ['Recipes row 3', 'First cooked: "about 1950" is not a whole number year'],
      ['Recipes row 4', 'Occasion: "Brunch" is not one of Everyday, Holiday, Funeral'],
    ]);
    await applyPlan(open, set, wb, 'all');
    const soup = open.repo.list('customEntries').find((e) => e.title === 'Tomato soup')!;
    expect(soup).toMatchObject({
      sectionId: 'CS-RECIPES',
      values: { origin: 'Portland, Oregon', firstCooked: 1990, occasion: 'Everyday' },
      sourceRef: 'recipes.xlsx#Recipes!R2',
      status: 'planned',
    });
    expect((await open.repo.revisions('customEntries', soup._id)).map((r) => r.op)).toEqual([
      'create',
    ]);
    // Search finds it, and a second import changes nothing.
    expect(open.search.search('Tomato soup').map((h) => h.id)).toContain(soup._id);
    expect(planSheet(open, wb.sheets[0]!, wb, mapping).set.items).toEqual([]);
    // Existing hand-made recipes were left alone.
    expect(open.repo.list('customEntries')).toHaveLength(3);
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
    expect(open.repo.get('characters', 'H1')!.backstory).toContain(
      '<h1>Chapter 3: Wedding Weather</h1>',
    );
    expect(open.repo.get('characters', 'H1')!.backstory).toContain('<em>lucky</em>');
    expect(open.repo.get('characters', 'H1')!.sourceRef).toBe('chapter-03.docx#p1-p4');

    const note = planDocumentImport(open, doc, {
      kind: 'note',
      sectionId: '',
      title: 'Wedding notes',
    });
    expect(note.createSection).toMatchObject({ name: 'Notes' });
    await applyPlan(open, note.set, note.file, 'all', note.createSection);
    const section = open.repo.list('customSections').find((s) => s.name === 'Notes')!;
    const entry = open.repo.list('customEntries').find((e) => e.title === 'Wedding notes')!;
    expect(entry).toMatchObject({ sectionId: section._id, sourceRef: 'chapter-03.docx#p1-p4' });
    expect(entry.body).toContain('<hr>');
    // The second import reuses the section and finds the note unchanged.
    const second = planDocumentImport(open, doc, {
      kind: 'note',
      sectionId: '',
      title: 'Wedding notes',
    });
    expect(second.createSection).toBeNull();
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
