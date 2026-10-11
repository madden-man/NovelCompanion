import { copyFileSync, mkdtempSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import ExcelJS from 'exceljs';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { Invoke } from '../helpers/t5';
import { invokeVia, launch, rail } from './helpers';

const FIXTURES = join(import.meta.dirname, '../../fixtures/files');
const dir = mkdtempSync(join(tmpdir(), 'nc-e2e-import-'));
const WORKBOOK = join(dir, 'fixture-workbook.xlsx');
const DOCUMENT = join(dir, 'chapter-03.docx');

let server: MongoMemoryReplSet;
let app: ElectronApplication;
let page: Page;
let invoke: Invoke;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  copyFileSync(join(FIXTURES, 'fixture-workbook.xlsx'), WORKBOOK);
  copyFileSync(join(FIXTURES, 'chapter-03.docx'), DOCUMENT);
  server = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  ({ app, page } = await launch(server.getUri(), {
    NOVEL_COMPANION_TEST_PICK_FILE: WORKBOOK,
    NOVEL_COMPANION_TEST_PICK_DOCUMENT: DOCUMENT,
    NOVEL_COMPANION_TEST_SAVE_PATH: join(dir, 'export.json'),
  }));
  invoke = invokeVia(page);
  await invoke('bible.create', { slug: 'import-fixture', name: 'Import fixture' });
  await invoke('bible.open', { slug: 'import-fixture' });
  await expect(page.getByTestId('workspace')).toBeVisible();
});

test.afterAll(async () => {
  await app?.close();
  await server?.stop();
});

const view = () => page.getByTestId('import-view');

async function chooseWorkbook() {
  await rail(page, 'Import').click();
  await view().getByTestId('import-pick-workbook').click();
  await expect(view().getByTestId('import-workbook')).toBeVisible();
}

test('IM-1 IM-2 a workbook is mapped sheet by sheet with a live preview that reports the failing row', async () => {
  await chooseWorkbook();
  await expect(view().getByTestId('import-sheet')).toHaveValue('People');
  // The columns were matched to fields by their headers.
  const columns = view().getByTestId('import-columns');
  await expect(columns.getByLabel('Field for column Name')).toHaveValue('title');
  await expect(columns.getByLabel('Field for column Born')).toHaveValue('birth');
  await expect(columns.getByLabel('Field for column Family')).toHaveValue('familyIds');
  await expect(columns.getByLabel('Field for column ID')).toHaveValue('');
  // Family names that match no entry fail until the mapping says to make them.
  await expect(view().getByTestId('import-preview-counts')).toContainText(
    '8 rows: 1 ready, 7 will fail',
  );
  await view()
    .getByLabel(/Make a new entry for a name that matches no entry/)
    .check();
  await expect(view().getByTestId('import-preview-counts')).toContainText(
    '8 rows: 7 ready, 1 will fail',
  );
  const failing = view().locator('[data-testid="import-preview-row"][data-ok="false"]');
  await expect(failing).toHaveCount(1);
  await expect(failing).toContainText('People row 9');
  await expect(failing).toContainText('"not a year" is not a year, a date, or "unknown"');
  // Changing a column changes the preview.
  await columns.getByLabel('Field for column Born').selectOption('');
  await expect(view().getByTestId('import-preview-counts')).toContainText('8 rows: 7 ready');
  await columns.getByLabel('Field for column Born').selectOption('birth');
});

test('IM-2 IM-3 the compare step shows the change set, and the import writes what was approved and reports the failed row', async () => {
  await view().getByTestId('import-compare').click();
  await expect(view().getByTestId('import-summary')).toContainText(
    '9 new, 0 changed, 0 unchanged, 1 failed',
  );
  await expect(view().getByTestId('import-failed')).toContainText('People row 9');
  await view().getByTestId('import-apply').click();
  await expect(view().getByTestId('import-result-counts')).toContainText('Created 9, updated 0');
  await expect(view().getByTestId('import-result')).toContainText('Snapshot taken first');
  await expect(view().getByTestId('import-result')).toContainText('People row 9');
  const people = await invoke('entry.list', { collection: 'characters', trash: 'exclude' });
  expect(people.entries.map((e) => e.entry.title).sort()).toEqual([
    'Daniel Hale',
    'Iris Hale-Zhou',
    'Margaret Hale',
    'Peter Hale',
    'The Archivist',
    'Zhou Lan',
    'Zhou Meiling',
  ]);
  // IM-6: each entry carries where it came from.
  const lan = people.entries.find((e) => e.entry.title === 'Zhou Lan')!.entry;
  expect(lan.sourceRef).toBe('fixture-workbook.xlsx#People!R6');
});

test('IM-1 a grid sheet imports its cells as world events under the categories the rows and headings give', async () => {
  await rail(page, 'Import').click();
  await view().getByTestId('import-pick-workbook').click();
  await view().getByTestId('import-sheet').selectOption('High Level');
  await expect(view().getByTestId('import-grid-options')).toBeVisible();
  await expect(view().getByTestId('import-preview-counts')).toContainText(
    '7 rows: 7 ready, 0 will fail',
  );
  await view().getByTestId('import-compare').click();
  await expect(view().getByTestId('import-summary')).toContainText('7 new');
  await view().getByTestId('import-apply').click();
  await expect(view().getByTestId('import-result-counts')).toContainText('Created 7');
  const events = await invoke('entry.list', { collection: 'worldEvents', trash: 'exclude' });
  expect(events.entries.map((e) => e.entry.sourceRef)).toContain(
    'fixture-workbook.xlsx#High Level!E3',
  );
});

test('IM-1 IM-3 IM-7 re-importing a changed file reuses the saved mapping, lists the change with checkboxes, and records the disagreement', async () => {
  // The same file with Margaret's death year changed, saved later than the first.
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(WORKBOOK);
  wb.getWorksheet('People')!.getCell('E2').value = 2042;
  await wb.xlsx.writeFile(WORKBOOK);
  const later = new Date(Date.now() + 3600_000);
  utimesSync(WORKBOOK, later, later);

  await chooseWorkbook();
  await expect(view().getByTestId('import-saved-note')).toBeVisible();
  await expect(
    view().getByTestId('import-columns').getByLabel('Field for column Died'),
  ).toHaveValue('death');
  await view().getByTestId('import-compare').click();
  await expect(view().getByTestId('import-summary')).toContainText(
    '0 new, 1 changed, 6 unchanged, 1 failed',
  );
  const change = view().getByTestId('import-change');
  await expect(change).toHaveCount(1);
  await expect(change).toHaveAttribute('data-title', 'Margaret Hale');
  await expect(change.locator('del')).toHaveText('2041');
  await expect(change.locator('ins')).toHaveText('2042');
  await expect(view().getByTestId('import-conflict')).toContainText('Sources disagree about Death');
  await expect(view().getByTestId('import-conflict')).toContainText(
    'fixture-workbook.xlsx#People!R2',
  );

  // Unchecked, nothing is written.
  const box = change.getByRole('checkbox');
  await box.uncheck();
  await expect(view().getByTestId('import-apply')).toBeDisabled();
  await box.check();
  await view().getByTestId('import-apply').click();
  await expect(view().getByTestId('import-result-counts')).toContainText('Created 0, updated 1');
  const people = await invoke('entry.list', { collection: 'characters', trash: 'exclude' });
  expect(people.entries.find((e) => e.entry.title === 'Margaret Hale')!.entry.death).toEqual({
    year: 2042,
  });
  expect(people.entries).toHaveLength(7);
  const questions = await invoke('entry.list', { collection: 'openQuestions', trash: 'exclude' });
  expect(questions.entries).toHaveLength(1);
  expect(questions.entries[0]!.entry.question).toContain('says 2041');
  expect(questions.entries[0]!.entry.question).toContain('says 2042 [kept]');
});

test('IM-4 a Word document previews with its headings, italics, and scene break, and imports as a general note', async () => {
  await rail(page, 'Import').click();
  await view().getByTestId('import-pick-document').click();
  await expect(view().getByTestId('import-document')).toBeVisible();
  const preview = view().getByTestId('import-document-preview');
  await expect(preview.getByRole('heading', { name: 'Chapter 3: Wedding Weather' })).toBeVisible();
  await expect(preview.locator('em')).toHaveText('lucky');
  await expect(preview.locator('hr')).toHaveCount(1);
  await view().getByTestId('import-kind').selectOption('note');
  await view().getByLabel('Note title').fill('Wedding notes');
  await view().getByTestId('import-compare').click();
  await expect(view().getByTestId('import-summary')).toContainText('1 new');
  await view().getByTestId('import-apply').click();
  await expect(view().getByTestId('import-result-counts')).toContainText('Created 1');
  const sections = await invoke('entry.list', { collection: 'customSections', trash: 'exclude' });
  expect(sections.entries.map((e) => e.entry.name)).toEqual(['Notes']);
  const notes = await invoke('entry.list', { collection: 'customEntries', trash: 'exclude' });
  expect(notes.entries[0]!.entry).toMatchObject({
    title: 'Wedding notes',
    sourceRef: 'chapter-03.docx#p1-p4',
  });
});

test('BK-1 BK-2 a snapshot taken on request can be restored, which takes a safety snapshot first', async () => {
  await rail(page, 'Backups').click();
  const backups = page.getByTestId('backups-view');
  await backups.getByTestId('snapshot-take').click();
  await expect(backups.getByTestId('backups-message')).toContainText('Snapshot taken');
  const rows = backups.getByTestId('snapshot-row');
  // Imports took snapshots before they wrote.
  expect(await rows.count()).toBeGreaterThanOrEqual(5);
  await expect(rows.filter({ hasText: 'Before an import' }).first()).toBeVisible();
  const manual = rows.filter({ hasText: 'Taken on request' }).first();
  const id = await manual.getAttribute('data-id');
  expect(id).toBeTruthy();

  await invoke('entry.create', {
    collection: 'facts',
    data: { title: 'Added after the snapshot', status: 'idea' },
  });
  expect(
    (await invoke('entry.list', { collection: 'facts', trash: 'exclude' })).entries,
  ).toHaveLength(1);

  const target = page.locator(`[data-testid="snapshot-row"][data-id="${id}"]`);
  await target.getByTestId('snapshot-restore').click();
  await target.getByTestId('snapshot-confirm').click();
  await expect(page.getByTestId('reload-notice')).toContainText('Restored the snapshot from');
  await expect
    .poll(
      async () =>
        (await invoke('entry.list', { collection: 'facts', trash: 'exclude' })).entries.length,
    )
    .toBe(0);
  expect(
    (await invoke('entry.list', { collection: 'characters', trash: 'exclude' })).entries,
  ).toHaveLength(7);
  // The view reloaded with the restore's own safety snapshot listed.
  await rail(page, 'Backups').click();
  await expect(
    page.getByTestId('snapshot-row').filter({ hasText: 'Before a restore' }),
  ).toHaveCount(1);
});

test('BK-3 the whole bible exports to one JSON file from the Backups screen', async () => {
  await rail(page, 'Backups').click();
  await page.getByTestId('backup-export').click();
  await expect(page.getByTestId('backups-message')).toContainText('export.json');
});
