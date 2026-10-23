import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import type { Invoke } from '../helpers/t5';
import { fileDb, invokeVia, launch, rail } from './helpers';
import type { TestDb } from './helpers';

const dir = mkdtempSync(join(tmpdir(), 'nc-e2e-backups-'));

let db: TestDb;
let app: ElectronApplication;
let page: Page;
let invoke: Invoke;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  db = fileDb();
  ({ app, page } = await launch(db, {
    NOVEL_COMPANION_TEST_SAVE_PATH: join(dir, 'export.json'),
  }));
  invoke = invokeVia(page);
  await invoke('bible.create', { slug: 'backups-fixture', name: 'Backups fixture' });
  await invoke('bible.open', { slug: 'backups-fixture' });
  await expect(page.getByTestId('workspace')).toBeVisible();
  // A few places, and one emptied from the trash, which takes a snapshot first (BK-1).
  for (const title of ['Portland', 'Guangzhou', 'The Hale house']) {
    await invoke('entry.create', { collection: 'places', data: { title, status: 'canon' } });
  }
  const { entry } = await invoke('entry.create', {
    collection: 'places',
    data: { title: 'Gone for good', status: 'idea' },
  });
  await invoke('entry.delete', { collection: 'places', id: entry._id });
  await invoke('trash.empty', {});
});

test.afterAll(async () => {
  await app?.close();
});

const places = async () =>
  (await invoke('entry.list', { collection: 'places', trash: 'exclude' })).entries;

test('BK-1 BK-2 a snapshot taken on request can be restored, which takes a safety snapshot first', async () => {
  await rail(page, 'Backups').click();
  const backups = page.getByTestId('backups-view');
  await backups.getByTestId('snapshot-take').click();
  await expect(backups.getByTestId('backups-message')).toContainText('Snapshot taken');
  const rows = backups.getByTestId('snapshot-row');
  // Emptying the trash took a snapshot before it wrote.
  expect(await rows.count()).toBeGreaterThanOrEqual(2);
  await expect(rows.filter({ hasText: 'Before a bulk change' }).first()).toBeVisible();
  const manual = rows.filter({ hasText: 'Taken on request' }).first();
  const id = await manual.getAttribute('data-id');
  expect(id).toBeTruthy();

  await invoke('entry.create', {
    collection: 'places',
    data: { title: 'Added after the snapshot', status: 'idea' },
  });
  expect(
    (await invoke('entry.list', { collection: 'places', trash: 'exclude' })).entries.filter(
      (e) => e.entry.title === 'Added after the snapshot',
    ),
  ).toHaveLength(1);

  const target = page.locator(`[data-testid="snapshot-row"][data-id="${id}"]`);
  await target.getByTestId('snapshot-restore').click();
  await target.getByTestId('snapshot-confirm').click();
  await expect(page.getByTestId('reload-notice')).toContainText('Restored the snapshot from');
  await expect
    .poll(
      async () =>
        (await invoke('entry.list', { collection: 'places', trash: 'exclude' })).entries.filter(
          (e) => e.entry.title === 'Added after the snapshot',
        ).length,
    )
    .toBe(0);
  expect((await places()).map((e) => e.entry.title).sort()).toEqual([
    'Guangzhou',
    'Portland',
    'The Hale house',
  ]);
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
