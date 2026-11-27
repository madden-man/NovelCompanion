import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { OTHER_BIBLE_MESSAGE } from '../../src/shared/ipcApp';
import type { Invoke } from '../helpers/t5';
import { connectTo, field, fileDb, invokeVia, launch, rail, sectionList } from './helpers';
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
    // A57: Import reads back the file Export wrote.
    NOVEL_COMPANION_TEST_BIBLE_FILE: join(dir, 'export.json'),
  }));
  invoke = invokeVia(page);
  await invoke('bible.create', { slug: 'backups-fixture', name: 'Backups fixture' });
  await invoke('bible.open', { slug: 'backups-fixture' });
  await expect(page.getByTestId('workspace')).toBeVisible();
  // A few places, and one emptied from the trash, which takes a snapshot first (BK-1).
  for (const title of ['Portland', 'Guangzhou', 'The Hale house']) {
    await invoke('entry.create', { collection: 'places', data: { title } });
  }
  const { entry } = await invoke('entry.create', {
    collection: 'places',
    data: { title: 'Gone for good' },
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
    data: { title: 'Added after the snapshot' },
  });
  expect(
    (await invoke('entry.list', { collection: 'places', trash: 'exclude' })).entries.filter(
      (e) => e.entry.title === 'Added after the snapshot',
    ),
  ).toHaveLength(1);

  const target = page.locator(`[data-testid="snapshot-row"][data-id="${id}"]`);
  await target.getByTestId('snapshot-restore').click();
  const confirm = page.getByTestId('snapshot-confirm');
  await expect(confirm).toContainText('Replace Backups fixture with the snapshot from');
  await confirm.getByRole('button', { name: 'Replace' }).click();
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

test('A57 Backups carries no explanation: the actions sit in the header and the count lives in Settings', async () => {
  await rail(page, 'Backups').click();
  const backups = page.getByTestId('backups-view');
  await expect(backups.getByTestId('snapshot-row').first()).toBeVisible();
  for (const name of ['Snapshot now', 'Export…', 'Import as a new bible…']) {
    await expect(backups.getByRole('button', { name, exact: true })).toBeVisible();
  }
  await expect(backups.getByRole('columnheader', { name: 'Why' })).toBeVisible();
  for (const gone of [
    'A snapshot is a full copy',
    'Restoring replaces every entry',
    'Writes every entry, list, and setting',
    'Choose a file made by Export',
  ]) {
    await expect(backups).not.toContainText(gone);
  }
  await expect(backups.getByLabel('Snapshots to keep')).toHaveCount(0);
  await expect(backups.getByRole('button', { name: 'Save the number' })).toHaveCount(0);
});

test('A57 Restore says what it replaces once, at the press, and Cancel or Escape keeps the bible', async () => {
  await rail(page, 'Backups').click();
  const backups = page.getByTestId('backups-view');
  const row = backups.getByTestId('snapshot-row').first();
  await row.getByTestId('snapshot-restore').click();
  const confirm = page.getByTestId('snapshot-confirm');
  await expect(confirm).toContainText('Everything in it now is replaced.');
  await expect(confirm).toContainText('The present state is snapshotted first.');
  await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(confirm).toHaveCount(0);
  await row.getByTestId('snapshot-restore').click();
  await page.getByTestId('snapshot-confirm').getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByTestId('snapshot-confirm')).toHaveCount(0);
  expect((await places()).map((e) => e.entry.title).sort()).toEqual([
    'Guangzhou',
    'Portland',
    'The Hale house',
  ]);
});

test('A57 BK-2 with enough snapshots to scroll, the Restore confirm shows in view under the row pressed, and Cancel or Escape gives the focus back to its Restore button', async () => {
  while ((await invoke('snapshot.list', {})).snapshots.length < 30) {
    await invoke('snapshot.take', {});
  }
  await rail(page, 'Characters').click();
  await rail(page, 'Backups').click();
  const backups = page.getByTestId('backups-view');
  const rows = backups.getByTestId('snapshot-row');
  await expect(rows).toHaveCount(30);
  // The table runs past the window.
  await expect(rows.last()).not.toBeInViewport();
  for (const row of [rows.first(), rows.nth(27)]) {
    const restore = row.getByTestId('snapshot-restore');
    await restore.click();
    const confirm = page.getByTestId('snapshot-confirm');
    await expect(confirm).toBeInViewport();
    await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused();
    // It sits in the row straight after the one pressed.
    await expect(row.locator('xpath=following-sibling::tr[1]')).toHaveAttribute(
      'data-testid',
      'snapshot-confirm-row',
    );
    await page.keyboard.press('Escape');
    await expect(confirm).toHaveCount(0);
    await expect(restore).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(confirm).toHaveCount(0);
    await expect(restore).toBeFocused();
  }
  expect((await places()).map((e) => e.entry.title).sort()).toEqual([
    'Guangzhou',
    'Portland',
    'The Hale house',
  ]);
});

test('A57 BK-3 Import as a new bible opens the file dialog directly and opens the bible it makes', async () => {
  await rail(page, 'Backups').click();
  await page.getByTestId('backup-import').click();
  // The file's bible is called Backups fixture, so the new one is numbered beside it.
  await expect(page.getByTestId('current-bible')).toHaveText('Backups fixture 2', {
    timeout: 60_000,
  });
  expect((await invoke('bible.current', {})).bible?.id).toBe('backups-fixture-2');
  expect((await places()).map((e) => e.entry.title).sort()).toEqual([
    'Guangzhou',
    'Portland',
    'The Hale house',
  ]);
});

// A57: the original and its imported copy share every _id, so a write sent to the wrong
// one would fit it. Each test reads the copy straight from MongoDB, past the app.
const ORIGINAL = 'backups-fixture';
const COPY = 'backups-fixture-2';

/** The stored body of Portland in a bible, read from MongoDB, tags taken out. */
async function portlandBody(slug: string): Promise<string> {
  const store = await connectTo(db);
  try {
    const doc = await store.db
      .collection<{ _id: string; title?: string; body?: unknown }>(`${slug}.places`)
      .findOne({ title: 'Portland' });
    return String(doc?.body ?? '').replace(/<[^>]+>/g, '');
  } finally {
    await store.close();
  }
}

async function outlineText(slug: string): Promise<string> {
  const store = await connectTo(db);
  try {
    const doc = await store.db
      .collection<{ _id: string; text?: unknown }>(`${slug}.meta`)
      .findOne({ _id: 'sceneOutline' });
    return String(doc?.text ?? '');
  } finally {
    await store.close();
  }
}

/** Main's `entry.update` handler, replaced for a test; `restoreUpdate` puts it back. */
async function wrapUpdates(mode: 'refuse' | 'hold'): Promise<void> {
  await app.evaluate(({ ipcMain }, how) => {
    const handlers = (
      ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> }
    )._invokeHandlers;
    const channel = 'nc:entry.update';
    const original = handlers.get(channel)!;
    const seen = globalThis as {
      held?: number;
      answered?: string[];
      waiting?: (() => void)[] | null;
    };
    seen.held = 0;
    seen.answered = [];
    seen.waiting = [];
    handlers.set(channel, async (...args: unknown[]) => {
      if (how === 'refuse') throw new Error('The bible could not be written. Try again.');
      seen.held! += 1;
      // Held until the test lets the writes go (`releaseUpdates`).
      if (seen.waiting) await new Promise<void>((r) => seen.waiting!.push(r));
      try {
        const r = await original(...args);
        seen.answered!.push('stored');
        return r;
      } catch (e) {
        seen.answered!.push(e instanceof Error ? e.message : String(e));
        throw e;
      }
    });
    (globalThis as { restoreUpdate?: () => void }).restoreUpdate = () =>
      handlers.set(channel, original);
  }, mode);
}
/** Let every held entry write go on, and the ones after it pass at once. */
const releaseUpdates = () =>
  app.evaluate(() => {
    const seen = globalThis as { waiting?: (() => void)[] | null };
    const waiting = seen.waiting ?? [];
    seen.waiting = null;
    for (const go of waiting) go();
  });

/** How many entry writes main held, and how each held one was answered. */
const held = () =>
  app.evaluate(() => {
    const seen = globalThis as { held?: number; answered?: string[] };
    return { held: seen.held ?? 0, answered: seen.answered ?? [] };
  });
const restoreUpdate = async () => {
  await releaseUpdates();
  await app.evaluate(() => (globalThis as { restoreUpdate?: () => void }).restoreUpdate?.());
};

async function openOriginalPortland() {
  await invoke('bible.open', { slug: ORIGINAL });
  await expect(page.getByTestId('current-bible')).toHaveText('Backups fixture');
  await sectionList(page, 'Places');
  await page
    .getByTestId('entry-list')
    .getByRole('button', { name: /^Portland/ })
    .click();
  const body = field(page.getByTestId('editor'), 'body').getByRole('textbox');
  await expect(page.getByTestId('autosave')).toHaveText('Saved');
  return body;
}

async function switchTo(name: string) {
  await page.getByTestId('bible-menu-button').click();
  await page.getByTestId('bible-menu').getByRole('button', { name, exact: true }).click();
}

test('A57 ED-2 a save that fails during a bible switch keeps the bible open, says what was not saved, and never writes into the other bible', async () => {
  const copyBefore = await portlandBody(COPY);
  const body = await openOriginalPortland();
  await wrapUpdates('refuse');
  try {
    await body.click();
    await page.keyboard.press('End');
    await body.pressSequentially(' by the river');
    await expect(page.getByTestId('autosave')).toContainText('Not saved');
    await switchTo('Backups fixture 2');
    const alert = page.getByRole('alert').filter({ hasText: 'Not saved' });
    await expect(alert).toContainText(/Not saved: .+ on Portland\. The bible could not be written/);
    await expect(page.getByTestId('current-bible')).toHaveText('Backups fixture');
    expect((await invoke('bible.current', {})).bible?.id).toBe(ORIGINAL);
    await expect(body).toContainText('by the river');
  } finally {
    await restoreUpdate();
  }
  // Writable again: the next switch stores the typing where it was typed, then opens the copy.
  await switchTo('Backups fixture 2');
  await expect(page.getByTestId('current-bible')).toHaveText('Backups fixture 2');
  expect(await portlandBody(ORIGINAL)).toContain('by the river');
  expect(await portlandBody(COPY)).toBe(copyBefore);
  await expect(page.getByRole('alert').filter({ hasText: 'Not saved' })).toHaveCount(0);
});

test('A57 ED-2 a write still on its way when another bible opens behind the screen is refused by main, never stored in that bible', async () => {
  const copyBefore = await portlandBody(COPY);
  const originalBefore = await portlandBody(ORIGINAL);
  const body = await openOriginalPortland();
  // Main holds every entry write for a moment, so the autosave arrives after the switch.
  await wrapUpdates('hold');
  try {
    await body.click();
    await page.keyboard.press('End');
    await body.pressSequentially(' in the fog');
    await expect.poll(async () => (await held()).held).toBeGreaterThan(0);
    // The copy opens straight through main, as a launch or a reconnect could, with no flush.
    await invoke('bible.open', { slug: COPY });
    await expect(page.getByTestId('current-bible')).toHaveText('Backups fixture 2');
    await releaseUpdates();
    // Every held write is answered, and main refused each as made in another bible.
    await expect
      .poll(async () => {
        const h = await held();
        return h.answered.length === h.held && h.held > 0;
      })
      .toBe(true);
    expect(new Set((await held()).answered)).toEqual(new Set([OTHER_BIBLE_MESSAGE]));
  } finally {
    await restoreUpdate();
  }
  expect(await portlandBody(COPY)).toBe(copyBefore);
  expect(await portlandBody(ORIGINAL)).toBe(originalBefore);
});

test('A57 BK-3 Import as a new bible stores the typing still on its way in the bible it was typed in first', async () => {
  const body = await openOriginalPortland();
  await wrapUpdates('hold');
  try {
    await body.click();
    await page.keyboard.press('End');
    await body.pressSequentially(' at low tide');
    // Leaving the editor sends the typing; main holds it while Import runs.
    await rail(page, 'Backups').click();
    await expect.poll(async () => (await held()).held).toBeGreaterThan(0);
    await page.getByTestId('backup-import').click();
    // Import waits for the write; nothing has opened while main holds it.
    await expect(page.getByTestId('backup-import')).toBeDisabled();
    expect((await invoke('bible.current', {})).bible?.id).toBe(ORIGINAL);
    await releaseUpdates();
    await expect(page.getByTestId('current-bible')).toHaveText('Backups fixture 3', {
      timeout: 60_000,
    });
  } finally {
    await restoreUpdate();
  }
  expect(await portlandBody(ORIGINAL)).toContain('at low tide');
  expect(await portlandBody('backups-fixture-3')).not.toContain('at low tide');
});

test("A57 PL-5 the Outline's write on leaving never reaches a bible opened behind the screen", async () => {
  const copyBefore = await outlineText(COPY);
  await invoke('bible.open', { slug: ORIGINAL });
  await expect(page.getByTestId('current-bible')).toHaveText('Backups fixture');
  await rail(page, 'Outline').click();
  const text = page.getByTestId('outline-view').getByTestId('scene-text').first();
  await text.click();
  await page.keyboard.press('End');
  await text.pressSequentially('- Written in the original');
  await expect(text).toHaveValue(/Written in the original/);
  // At once, before the autosave delay: the copy opens straight through main.
  await invoke('bible.open', { slug: COPY });
  await expect(page.getByTestId('current-bible')).toHaveText('Backups fixture 2');
  await expect.poll(() => outlineText(COPY)).toBe(copyBefore);
  expect(await outlineText(COPY)).not.toContain('Written in the original');
});
