import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { TEST_PHONE_KEY_SEAM } from '../../src/main/ipc/pwaHandlers';
import { fileDb, invokeVia, launch, rail } from './helpers';

/**
 * A58 P4 (PH-15, PH-5 on the desk): the phone key in Settings. Under test the
 * key lives in memory and Copy never reaches the system clipboard, so the
 * keychain and the clipboard of the person at the Mac are never touched.
 */
let app: ElectronApplication;
let page: Page;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  ({ app, page } = await launch(fileDb()));
  const invoke = invokeVia(page);
  await invoke('bible.create', { slug: 'phone-key', name: 'Phone key' });
  await invoke('bible.open', { slug: 'phone-key' });
  await expect(page.getByTestId('workspace')).toBeVisible();
});

test.afterAll(async () => {
  await app?.close();
});

test('PH-15 Settings shows the phone key masked, with Make a key when none is set and Copy once one is', async () => {
  await rail(page, 'Settings').click();
  const box = page.getByTestId('phone-key-settings');
  await expect(box).toBeVisible();
  await expect(box.getByTestId('phone-key-masked')).toHaveText('None');
  await expect(box.getByTestId('phone-key-copy')).toHaveCount(0);
  await box.getByTestId('phone-key-make').click();
  await expect(box.getByTestId('phone-key-masked')).toHaveText(/^•{8}[A-Za-z0-9_-]{4}$/);
  await expect(box.getByTestId('phone-key-make')).toHaveCount(0);
  await box.getByTestId('phone-key-copy').click();
  await expect(box.getByTestId('phone-key-note')).toHaveText('Copied.');
  // The whole stored key is what reached the clipboard seam (main's stand-in for the clipboard).
  const seam = await app.evaluate((_electron, name) => {
    const s = (globalThis as Record<string, unknown>)[name] as
      { store: { get(): string | null }; copied: string | null } | undefined;
    return { stored: s?.store.get() ?? null, copied: s?.copied ?? null };
  }, TEST_PHONE_KEY_SEAM);
  expect(seam.stored).toMatch(/^[A-Za-z0-9_-]{32}$/);
  expect(seam.copied).toBe(seam.stored);
  // The page never holds the whole key: only the masked form comes back.
  const status = await invokeVia(page)('phoneKey.status', {});
  expect(status.masked).toMatch(/^•{8}.{4}$/);
  expect(status.masked).toBe(`••••••••${seam.stored!.slice(-4)}`);
  // A second Make keeps the key that is set.
  const again = await invokeVia(page)('phoneKey.make', {});
  expect(again.masked).toBe(status.masked);
});

test('PH-5 the desk may use every channel, and every desk control still shows', async () => {
  const caps = await invokeVia(page)('app.capabilities', {});
  expect(caps.channels).toContain('claude.ask');
  expect(caps.channels).toContain('phoneKey.copy');
  await expect(page.getByTestId('claude-settings')).toBeVisible();
  await expect(page.getByTestId('mongo-settings-section')).toBeVisible();
  await expect(page.getByTestId('settings-snapshots')).toBeVisible();
  await expect(
    page.getByTestId('rail-main').getByRole('button', { name: 'Continuity checker' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: /Ask Claude/ })).toBeVisible();
});
