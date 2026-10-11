import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { Invoke } from '../helpers/t5';
import { FILE, READONLY, startFakeGoogle } from '../helpers/fakeGoogle';
import type { FakeGoogle } from '../helpers/fakeGoogle';
import { invokeVia, launch, rail } from './helpers';

const FIXTURES = join(import.meta.dirname, '../../fixtures/files');

let server: MongoMemoryReplSet;
let fake: FakeGoogle;
let app: ElectronApplication;
let page: Page;
let invoke: Invoke;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  fake = await startFakeGoogle({ email: 'tommy@example.com' });
  fake.addFile({
    id: 'folderNovel',
    name: 'Novel',
    mimeType: 'application/vnd.google-apps.folder',
  });
  fake.addFile({
    id: 'docCh3',
    name: 'Chapter 3',
    mimeType: 'application/vnd.google-apps.document',
    parents: ['folderNovel'],
    content: readFileSync(join(FIXTURES, 'chapter-03.docx')),
  });
  fake.addFile({
    id: 'pdfMap',
    name: 'Map.pdf',
    mimeType: 'application/pdf',
    parents: ['folderNovel'],
  });
  server = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  ({ app, page } = await launch(server.getUri(), {
    NOVEL_COMPANION_TEST_GOOGLE_BASE: fake.base,
    NOVEL_COMPANION_TEST_PICK_DOCUMENT: join(FIXTURES, 'chapter-03.docx'),
  }));
  invoke = invokeVia(page);
  await invoke('bible.create', { slug: 'drive-fixture', name: 'Drive fixture' });
  await invoke('bible.open', { slug: 'drive-fixture' });
  await expect(page.getByTestId('workspace')).toBeVisible();
});

test.afterAll(async () => {
  await app?.close();
  await server?.stop();
  await fake?.close();
});

const settings = () => page.getByTestId('settings-view');
const drive = () => page.getByTestId('drive-view');

test('ST-1 GD-1 Settings holds the Drive client in the keychain and connects through the browser, read-only', async () => {
  await rail(page, 'Settings').click();
  const conn = settings().getByTestId('drive-connection');
  await expect(conn.getByTestId('drive-state')).toContainText('Not set up');
  await conn.getByLabel('OAuth client ID').fill(fake.clientId);
  await conn.getByLabel('OAuth client secret').fill(fake.clientSecret);
  await conn.getByRole('button', { name: 'Save the client' }).click();
  await expect(conn.getByTestId('drive-state')).toHaveText('Not connected.');
  await expect(conn).toContainText('123456…ghij.apps.googleusercontent.com');
  await conn.getByTestId('drive-connect').click();
  await expect(conn.getByTestId('drive-state')).toContainText('Connected as tommy@example.com');
  expect(fake.lastAuth?.get('scope')).toBe(READONLY);
  expect(fake.lastAuth?.get('code_challenge_method')).toBe('S256');
  // The page never receives the secret or a token.
  const status = await invoke('drive.status', {});
  expect(JSON.stringify(status)).not.toContain(fake.clientSecret);
  expect(JSON.stringify(status)).not.toMatch(/at-|rt-/);
});

test('GD-2 a folder is browsed, a Google Doc is linked, and it imports through the review step', async () => {
  await rail(page, 'Google Drive').click();
  await drive().getByRole('button', { name: 'Add files or folders from Drive' }).click();
  const browser = drive().getByTestId('drive-browser');
  await browser.getByRole('button', { name: 'Open Novel' }).click();
  await expect(browser.getByTestId('drive-item')).toHaveCount(2);
  await expect(browser.getByRole('checkbox', { name: 'Map.pdf' })).toBeDisabled();
  await browser.getByRole('checkbox', { name: 'Chapter 3' }).check();
  await browser.getByTestId('drive-link-selected').click();
  await expect(drive().getByTestId('drive-link')).toHaveCount(1);
  const row = drive().getByTestId('drive-file').filter({ hasText: 'Chapter 3' });
  await expect(row).toHaveAttribute('data-state', 'new');

  await row.getByTestId('drive-review-file').click();
  const view = page.getByTestId('import-view');
  await expect(view).toContainText('Chapter 3.docx from Google Drive');
  const preview = view.getByTestId('import-document-preview');
  await expect(preview.locator('em')).toHaveText('lucky');
  await view.getByTestId('import-kind').selectOption('note');
  await view.getByLabel('Note title').fill('Wedding notes');
  await view.getByTestId('import-compare').click();
  await expect(view.getByTestId('import-summary')).toContainText('1 new');
  // Nothing is written before approval.
  expect(
    (await invoke('entry.list', { collection: 'customEntries', trash: 'exclude' })).entries,
  ).toHaveLength(0);
  await view.getByTestId('import-apply').click();
  await expect(view.getByTestId('import-result-counts')).toContainText('Created 1');
  const notes = await invoke('entry.list', { collection: 'customEntries', trash: 'exclude' });
  expect(notes.entries[0]!.entry).toMatchObject({
    title: 'Wedding notes',
    sourceRef: 'Chapter 3.docx#p1-p4',
  });
  await page.getByRole('button', { name: 'Back to Google Drive' }).click();
  await expect(drive().getByTestId('drive-file').filter({ hasText: 'Chapter 3' })).toHaveAttribute(
    'data-state',
    'unchanged',
  );
});

test('GD-3 on launch the app says which linked file changed, and changes nothing until reviewed', async () => {
  fake.touch('docCh3', new Date(Date.now() + 60_000).toISOString());
  const before = await invoke('entry.list', { collection: 'customEntries', trash: 'exclude' });
  await page.reload();
  await expect(page.getByTestId('workspace')).toBeVisible();
  const notice = page.getByTestId('drive-launch-notice');
  await expect(notice.getByTestId('drive-launch-summary')).toHaveText(
    'One linked Drive file: 1 changed since you last imported. Nothing changes until you review it.',
  );
  await notice.getByRole('button', { name: 'Review in Google Drive' }).click();
  const row = drive().getByTestId('drive-file').filter({ hasText: 'Chapter 3' });
  await expect(row).toHaveAttribute('data-state', 'changed');
  await expect(row.getByTestId('drive-review-file')).toHaveText('Review changes');
  expect(await invoke('entry.list', { collection: 'customEntries', trash: 'exclude' })).toEqual(
    before,
  );
  // On demand: Mark as reviewed clears it without importing.
  await row.getByRole('button', { name: 'Mark as reviewed' }).click();
  await expect(row).toHaveAttribute('data-state', 'unchanged');
  await drive().getByTestId('drive-check').click();
  await expect(drive().getByTestId('drive-summary')).toContainText(
    'Every linked Drive file matches what you imported.',
  );
});

test('GD-4 export asks for drive.file, makes a folder, and writes Markdown by section and one JSON file', async () => {
  await rail(page, 'Google Drive').click();
  const exp = drive().getByTestId('drive-export');
  await exp.getByTestId('drive-allow-export').click();
  expect(fake.lastAuth?.get('scope')).toBe(`${READONLY} ${FILE}`);
  await exp.getByRole('button', { name: 'Make the folder' }).click();
  await expect(exp.getByLabel('Export folder')).toHaveValue(/.+/);
  await exp.getByTestId('drive-export-now').click();
  await expect(exp.getByTestId('drive-export-done')).toContainText('to Drive fixture');
  const json = fake.uploads.find((u) => u.mimeType === 'application/json');
  expect(json?.name).toBe('drive-fixture.json');
  expect(JSON.parse(json!.content)).toMatchObject({ format: 'novel-companion-bible' });
  const md = fake.uploads.filter((u) => u.mimeType === 'text/markdown');
  expect(md.map((u) => u.name)).toContain(
    `Wedding notes (${(await invoke('entry.list', { collection: 'customEntries', trash: 'exclude' })).entries[0]!.entry._id}).md`,
  );
});

test('GD-5 disconnecting removes the tokens and the app keeps working without Drive', async () => {
  await rail(page, 'Settings').click();
  const conn = settings().getByTestId('drive-connection');
  const refresh = fake.revoked.length;
  await conn.getByTestId('drive-disconnect').click();
  await expect(conn.getByTestId('drive-state')).toHaveText('Not connected.');
  expect(fake.revoked.length).toBe(refresh + 1);
  await expect(invoke('drive.browse', {})).rejects.toThrow(/not connected/);
  // Drive asks to connect; local import, editing, and the launch still work.
  await rail(page, 'Google Drive').click();
  await expect(drive().getByTestId('drive-connection')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('workspace')).toBeVisible();
  await expect(page.getByTestId('drive-launch-notice')).toHaveCount(0);
  await rail(page, 'Import').click();
  await page.getByTestId('import-pick-document').click();
  await expect(page.getByTestId('import-document')).toBeVisible();
  await invoke('entry.create', {
    collection: 'facts',
    data: { title: 'Offline fact', status: 'idea' },
  });
});
