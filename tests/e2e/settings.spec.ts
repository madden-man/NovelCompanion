import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { READ_ONLY_REASON } from '../../src/shared/ipcApp';
import type { Invoke } from '../helpers/t5';
import { fileDb, fillEditable, invokeVia, launch, openEditable, rail } from './helpers';
import type { TestDb } from './helpers';

const SLUG = 'settings';
const KEY = 'sk-ant-api03-e2e-test-key-0123456789abcdef';
let db: TestDb;
let app: ElectronApplication | null = null;
let page: Page;
let invoke: Invoke;
/** One data folder across launches: app-wide settings live there, per-bible ones in MongoDB. */
const userData = mkdtempSync(join(tmpdir(), 'nc-e2e-settings-'));

async function start(): Promise<void> {
  ({ app, page } = await launch(db, { NOVEL_COMPANION_USER_DATA: userData }));
  invoke = invokeVia(page);
}

async function openSettings(): Promise<Locator> {
  await invoke('bible.open', { slug: SLUG });
  await expect(page.getByTestId('workspace')).toBeVisible();
  await rail(page, 'Settings').click();
  const view = page.getByTestId('settings-view');
  await expect(view).toBeVisible();
  return view;
}

async function closedUri(): Promise<string> {
  const port = await new Promise<number>((resolve) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port: p } = srv.address() as { port: number };
      srv.close(() => resolve(p));
    });
  });
  return `mongodb://127.0.0.1:${port}/?directConnection=true`;
}

test.beforeAll(async () => {
  db = fileDb();
  await start();
  await invoke('bible.create', { slug: SLUG, name: 'Settings' });
});

test.afterAll(async () => {
  await app?.close();
});

test('ST-1 every setting changed in Settings, by keyboard, is kept after the app restarts', async () => {
  const view = await openSettings();
  // Per-feature model (DB-4).
  const summaries = view.getByTestId('claude-model-summaries');
  await summaries.focus();
  await summaries.selectOption('claude-haiku-5-5');
  // A53: the session window and size budget live on Relevant to Session, not here.
  await expect(view.getByTestId('settings-briefs')).toHaveCount(0);
  // Romanization per language (GL-1): a select that saves on its pick (IP-8).
  const cantonese = view.getByTestId('settings-romanization-cantonese');
  await openEditable(cantonese);
  await cantonese.locator('select').selectOption('');
  await expect(view.getByTestId('settings-romanization')).toContainText(
    'Saved the romanization system for Cantonese.',
  );
  // Snapshot count (BK-1).
  const keep = view.getByTestId('settings-snapshot-keep');
  await keep.fill('12');
  await keep.press('Enter');
  await expect(view.getByTestId('settings-snapshots')).toContainText(
    'Saved. The newest 12 snapshots are kept.',
  );
  // Appearance, chosen with the keyboard: focus the group, arrow to Dark.
  await view.getByTestId('appearance-system').focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(view.getByTestId('appearance-dark')).toBeChecked();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  expect((await invoke('snapshot.list', {})).keep).toBe(12);
  expect((await invoke('appearance.get', {})).appearance).toBe('dark');

  await app?.close();
  await start();
  // Appearance is applied at launch, before any bible opens.
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  const again = await openSettings();
  await expect(again.getByTestId('claude-model-summaries')).toHaveValue('claude-haiku-5-5');
  await expect(again.getByTestId('settings-romanization-cantonese-text')).toHaveText('No system');
  await expect(again.getByTestId('settings-romanization-mandarin-text')).not.toHaveText(
    'No system',
  );
  await expect(again.getByTestId('settings-snapshot-keep')).toHaveValue('12');
  await expect(again.getByTestId('appearance-dark')).toBeChecked();
});

test('ST-1 GL-1 the romanization system saved in Settings shows on the Cultural data Romanization tab', async () => {
  const view = await openSettings();
  const mandarin = view.getByTestId('settings-romanization-mandarin');
  await openEditable(mandarin);
  await mandarin.locator('select').selectOption({ label: 'Jyutping' });
  await expect(view.getByTestId('settings-romanization')).toContainText(
    'Saved the romanization system for Mandarin.',
  );
  await rail(page, 'Romanization').click();
  const roman = page.getByTestId('romanization-view');
  const there = roman.getByTestId('romanization-systems-mandarin');
  await expect(there.getByTestId('romanization-systems-mandarin-text')).toHaveText('Jyutping');
  // Picked back on the Romanization screen, Settings follows.
  await openEditable(there);
  await there.locator('select').selectOption({ label: 'Hanyu Pinyin' });
  await expect
    .poll(
      async () =>
        (await invoke('romanization.get', {})).languages.find((l) => l.id === 'mandarin')?.systemId,
    )
    .toBe('mandarin');
  await rail(page, 'Settings').click();
  await expect(page.getByTestId('settings-romanization-mandarin-text')).toHaveText('Hanyu Pinyin');
});

test('IP-8 GL-1 when the pick of a new system fails, the field says so, keeps the new system for Enter, and records no step', async () => {
  const view = await openSettings();
  const before = await page.getByTestId('top-undo').getAttribute('title');
  // Main answers romanization.set with a failure, as a broken bible write would.
  await app!.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('nc:romanization.set');
    ipcMain.handle('nc:romanization.set', () => {
      throw new Error('The bible could not be written. Try again.');
    });
  });
  try {
    const cantonese = view.getByTestId('settings-romanization-cantonese');
    await openEditable(cantonese);
    await cantonese.locator('select').selectOption('Add new...');
    const name = cantonese.getByLabel('Name of the new item for Romanization system for Cantonese');
    await name.fill('Yale');
    await name.press('Enter');
    await expect(cantonese.getByRole('alert')).toHaveText(
      'Not saved: The bible could not be written. Try again.',
    );
    await expect(name).toBeVisible();
    const yale = async () =>
      (await invoke('lists.get', {})).lists
        .find((l) => l._id === 'romanizationSystems')!
        .items.find((i) => i.label === 'Yale')?.id;
    await expect.poll(yale).toBeTruthy();
    const cantoneseSystem = (await invoke('romanization.get', {})).languages.find(
      (l) => l.id === 'cantonese',
    )?.systemId;
    expect(cantoneseSystem).not.toBe(await yale());
    // Neither the add nor the pick is an undo step.
    await expect(page.getByTestId('top-undo')).toHaveAttribute('title', before ?? '');
  } finally {
    // A fresh launch registers the real handler again.
    await app?.close();
    await start();
  }
});

test('ST-1 appearance applies live, light, dark, or the system, without a reload', async () => {
  const view = await openSettings();
  const background = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await view.getByTestId('appearance-light').check();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  const light = await background();
  await view.getByTestId('appearance-dark').check();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect.poll(background).not.toBe(light);
  await view.getByTestId('appearance-system').check();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'system');
  expect((await invoke('appearance.get', {})).appearance).toBe('system');
  // Every choice is reachable by keyboard and labelled.
  for (const label of ['Match the system', 'Light', 'Dark']) {
    await expect(view.getByRole('radio', { name: label })).toBeVisible();
  }
});

test('ST-1 the API key and the MongoDB connection string are shown masked, never in full', async () => {
  const view = await openSettings();
  await view.getByTestId('claude-key-input').fill(KEY);
  await view.getByTestId('claude-key-save').click();
  await expect(view.getByTestId('claude-key-status')).toContainText('sk-ant-…cdef');
  const status = view.getByTestId('mongo-status');
  await expect(status).toContainText('A connection string is stored in memory');
  await expect(status).toContainText('mongodb://…');
  const uri = db.uri;
  const host = new URL(uri).host;
  await expect(page.locator('body')).not.toContainText(uri);
  await expect(page.locator('body')).not.toContainText(host);
  await expect(page.locator('body')).not.toContainText(KEY);
  const wire = await invoke('mongo.status', {});
  expect(JSON.stringify(wire)).not.toContain(host);
  expect(wire.masked).toBe(`mongodb://…${host.slice(-10)}`);
  await expect(view.getByTestId('mongo-input')).toHaveAttribute('type', 'password');
});

test('ST-1 NF-3 a setting that cannot be read, or a key that cannot be removed, says so on screen', async () => {
  // Main answers these channels with a failure, as a broken settings file or keychain would.
  const fail = (channels: string[]) =>
    app!.evaluate(({ ipcMain }, list) => {
      for (const c of list) {
        ipcMain.removeHandler(`nc:${c}`);
        ipcMain.handle(`nc:${c}`, () => {
          throw new Error('The keychain did not answer. Restart the app, then try again.');
        });
      }
    }, channels);
  await fail(['snapshot.list', 'appearance.get', 'claude.clearKey']);
  try {
    await invoke('claude.setKey', { key: KEY });
    // Leave Settings first, so it mounts again and reads every setting afresh.
    await rail(page, 'Characters').click();
    const view = await openSettings();
    await expect(view.getByTestId('settings-snapshots-failed')).toHaveText(
      'The snapshot setting could not be read. The keychain did not answer. Restart the app, then try again.',
    );
    await expect(view.getByTestId('appearance-failed')).toContainText(
      'The appearance setting could not be read.',
    );
    await expect(view.getByText('Loading the snapshot setting.')).toHaveCount(0);
    await view.getByRole('button', { name: 'Remove key' }).click();
    await expect(view.getByTestId('claude-key-note')).toHaveText(
      'The key was not removed. The keychain did not answer. Restart the app, then try again.',
    );
    await expect(view.getByTestId('claude-key-status')).toContainText('A key is stored');
  } finally {
    // A fresh launch registers the real handlers again.
    await app?.close();
    await start();
  }
});

/** Cmd+Z with nothing focused, as the writer presses it after a change (ED-3). */
async function undoStep(): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Meta+z');
}

test('IP-11 a number saves on Enter as one undo step, the World events grid span follows, and Reset goes back to the default', async () => {
  const view = await openSettings();
  const numbers = view.getByTestId('settings-numbers');
  await fillEditable(numbers.getByTestId('number-timelineEnd'), '2120');
  await expect.poll(async () => (await invoke('settings.get', {})).numbers.timelineEnd).toBe(2120);
  await rail(page, 'World events').click();
  const grid = page.getByTestId('timeline-view').getByTestId('world-grid');
  await expect(grid).toHaveAttribute('data-to', '2120');
  // One step: Cmd+Z puts the last year back, and the grid follows.
  await undoStep();
  await expect.poll(async () => (await invoke('settings.get', {})).numbers.timelineEnd).toBe(2100);
  await expect(grid).toHaveAttribute('data-to', '2100');

  // A value the bible cannot keep is refused at the field in plain words.
  const again = await openSettings();
  const reach = again.getByTestId('number-autosaveMs');
  await openEditable(reach);
  await reach.locator('input').fill('5000');
  await reach.locator('input').press('Enter');
  await expect(reach.getByRole('alert')).toBeVisible();
  await reach.locator('input').press('Escape');
  expect((await invoke('settings.get', {})).numbers.autosaveMs).toBe(500);

  // Reset puts the default back; the default shows beside the field.
  await fillEditable(again.getByTestId('number-windowBefore'), '6');
  await expect.poll(async () => (await invoke('settings.get', {})).numbers.windowBefore).toBe(6);
  await expect(again.getByTestId('settings-numbers')).toContainText('Default 3.');
  await again.getByRole('button', { name: 'Reset world window, years before to 3' }).click();
  await expect.poll(async () => (await invoke('settings.get', {})).numbers.windowBefore).toBe(3);
  await expect(
    again.getByRole('button', { name: 'Reset world window, years before to 3' }),
  ).toBeDisabled();

  // A53: the days between outline versions is one of the numbers, one step like the rest.
  const days = again.getByTestId('number-outlineVersionDays');
  await expect(again.getByTestId('settings-numbers')).toContainText(
    'Days between outline versions',
  );
  await fillEditable(days, '14');
  await expect
    .poll(async () => (await invoke('settings.get', {})).numbers.outlineVersionDays)
    .toBe(14);
  await undoStep();
  await expect
    .poll(async () => (await invoke('settings.get', {})).numbers.outlineVersionDays)
    .toBe(7);
});

test('IP-10 the cultural time unit is a select in Settings, one step per pick', async () => {
  const view = await openSettings();
  const unit = view.getByTestId('culture-unit');
  await expect(view.getByTestId('culture-unit-text')).toHaveText('A decade');
  await openEditable(unit);
  await unit.locator('select').selectOption('five');
  await expect.poll(async () => (await invoke('settings.get', {})).cultureUnit).toBe('five');
  await expect(view.getByTestId('culture-unit-text')).toHaveText('Five years');
  await undoStep();
  await expect.poll(async () => (await invoke('settings.get', {})).cultureUnit).toBe('decade');
});

test('IP-14 templates edit in place: a legend label from Settings shows in the tree', async () => {
  const view = await openSettings();
  const templates = view.getByTestId('settings-templates');
  await fillEditable(templates.getByTestId('template-link-married'), 'Wed');
  await expect
    .poll(async () => (await invoke('settings.get', {})).templates.linkTypeLabels.married)
    .toBe('Wed');
  await expect(templates.getByTestId('template-brief-headings')).toHaveCount(0);
  await fillEditable(templates.getByTestId('template-chapterTitle'), 'Untitled chapter');
  await expect
    .poll(async () => (await invoke('settings.get', {})).templates.chapterTitle)
    .toBe('Untitled chapter');
  // An empty template is refused at the field.
  const part = templates.getByTestId('template-partTitle');
  await openEditable(part);
  await part.locator('input').fill('');
  await part.locator('input').press('Enter');
  await expect(part.getByRole('alert')).toBeVisible();
  await part.locator('input').press('Escape');

  await rail(page, 'Family tree').click();
  await page.getByRole('button', { name: 'Legend', exact: true }).click();
  const legend = page.getByRole('region', { name: 'Tree legend' });
  await expect(legend).toContainText('Wed');
  await page.getByRole('button', { name: 'Hide legend' }).click();
  await invoke('settings.set', {
    templates: {
      linkTypeLabels: { married: 'Married' },
      chapterTitle: 'New chapter',
    },
  });
});

test('IP-12 an era default added and named in Settings is copied into a new bible', async () => {
  const view = await openSettings();
  const eras = view.getByTestId('settings-era-defaults');
  const before = (await invoke('eraDefaults.get', {})).rows;
  await eras.getByRole('button', { name: /^Add a default era from / }).click();
  await expect(eras.getByTestId('era-default-row')).toHaveCount(before.length + 1);
  const row = eras.getByTestId('era-default-row').last();
  await fillEditable(row.getByTestId('era-default-name'), 'Harbor years');
  await expect
    .poll(async () => (await invoke('eraDefaults.get', {})).rows.at(-1)?.name)
    .toBe('Harbor years');
  const start = (await invoke('eraDefaults.get', {})).rows.at(-1)!.startYear;
  await fillEditable(row.getByTestId('era-default-end'), String(start + 4));
  await expect
    .poll(async () => (await invoke('eraDefaults.get', {})).rows.at(-1)?.endYear)
    .toBe(start + 4);

  // New bible copies the defaults of the bible open now.
  await invoke('bible.create', { slug: 'settings-eras', name: 'Settings eras' });
  await invoke('bible.open', { slug: 'settings-eras' });
  await expect(page.getByTestId('current-bible')).toHaveText('Settings eras');
  const made = (await invoke('entry.list', { collection: 'eraStates', trash: 'exclude' })).entries;
  const harbor = made.find((e) => e.entry.name === 'Harbor years');
  expect(harbor?.entry).toMatchObject({ startYear: start, endYear: start + 4 });
  expect(made).toHaveLength(before.length + 1);

  // Remove takes the row out again (one step).
  const back = await openSettings();
  const rows = back.getByTestId('settings-era-defaults').getByTestId('era-default-row');
  await back.getByRole('button', { name: 'Remove Harbor years' }).click();
  await expect(rows).toHaveCount(before.length);
  expect((await invoke('eraDefaults.get', {})).rows).toEqual(before);
});

test('IP-15 an instruction saves from its box, Reset to default puts the default back, and the fixed footer stays under it', async () => {
  const view = await openSettings();
  const [first] = (await invoke('claude.instructions.get', {})).instructions;
  if (!first) throw new Error('No Claude features');
  const card = view.locator(`[data-feature="${first.feature}"]`);
  const footer = card.getByTestId(`instructions-footer-${first.feature}`);
  await expect(footer).toHaveText(first.footer);
  // The footer is read-only text in the primary text colour.
  await expect(footer.locator('input, textarea, [contenteditable="true"]')).toHaveCount(0);
  const fg = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--fg').trim(),
  );
  expect(fg).not.toBe('');
  const text = card.getByTestId(`instructions-${first.feature}-text`);
  await text.focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Meta+a');
  await page.keyboard.type('Keep each answer to short plain lines.');
  await page.keyboard.press('Meta+Enter');
  await expect
    .poll(
      async () =>
        (await invoke('claude.instructions.get', {})).instructions.find(
          (i) => i.feature === first.feature,
        )?.text,
    )
    .toBe('Keep each answer to short plain lines.');
  await expect(card).toContainText('Your own');
  await expect(footer).toHaveText(first.footer);
  await card.getByRole('button', { name: `Reset ${first.label} to default` }).click();
  await expect
    .poll(
      async () =>
        (await invoke('claude.instructions.get', {})).instructions.find(
          (i) => i.feature === first.feature,
        )?.text ?? null,
    )
    .toBeNull();
  await expect(card).toContainText('Default');
  await expect(
    card.getByRole('button', { name: `Reset ${first.label} to default` }),
  ).toBeDisabled();
  await expect(footer).toHaveText(first.footer);
  // The reset is a step too: Cmd+Z brings the writer's text back.
  await undoStep();
  await expect
    .poll(
      async () =>
        (await invoke('claude.instructions.get', {})).instructions.find(
          (i) => i.feature === first.feature,
        )?.text,
    )
    .toBe('Keep each answer to short plain lines.');
  await invoke('claude.instructions.set', { feature: first.feature, text: null });
});

test('IP-16 Remove revisions older than a date shows the count from a dry run, then asks for the word', async () => {
  await invoke('bible.open', { slug: SLUG });
  const { entry } = await invoke('entry.create', {
    collection: 'openQuestions',
    data: { title: 'Who keeps the harbor log?', status: 'idea' },
  });
  for (const t of ['Who keeps the log?', 'Who keeps the tide log?']) {
    await invoke('entry.update', {
      collection: 'openQuestions',
      id: entry._id,
      patch: { title: t },
    });
  }
  const view = await openSettings();
  const prune = view.getByTestId('settings-prune');
  const before = '2999-01-01';
  const { count } = await invoke('revisions.prune', { before, dryRun: true });
  expect(count).toBeGreaterThan(0);
  await prune.getByTestId('prune-date').fill(before);
  await expect(prune.getByTestId('prune-count')).toHaveText(
    `${count} ${count === 1 ? 'revision was' : 'revisions were'} written before ${before}.`,
  );
  const things = `${count} ${count === 1 ? 'revision' : 'revisions'}`;
  await prune.getByRole('button', { name: `Remove ${things}`, exact: true }).click();
  const confirm = prune.getByRole('button', { name: `Remove ${things} for good` });
  await expect(confirm).toBeDisabled();
  await prune.getByLabel(`Type remove to remove ${things} for good`).fill('remov');
  await expect(confirm).toBeDisabled();
  // Nothing was removed while the word was not typed.
  expect((await invoke('revisions.prune', { before, dryRun: true })).count).toBe(count);
  // A save made after the count is kept: the confirm removes exactly what was counted.
  await invoke('entry.update', {
    collection: 'openQuestions',
    id: entry._id,
    patch: { title: 'Who keeps the harbor tide log?' },
  });
  await prune.getByLabel(`Type remove to remove ${things} for good`).fill('remove');
  await confirm.click();
  await expect(prune.getByTestId('prune-note')).toHaveText(
    `Removed ${things} written before ${before}. This is not an undo step.`,
  );
  expect((await invoke('revisions.prune', { before, dryRun: true })).count).toBe(1);
  // The entry itself is untouched.
  expect(
    (await invoke('entry.get', { collection: 'openQuestions', id: entry._id })).entry.title,
  ).toBe('Who keeps the harbor tide log?');
});

test('IP-16 ARCH-6 on a snapshot open read-only, the prune control is off with the reason', async () => {
  // A server of its own, stopped mid-session so the snapshot opens read-only (as editable.spec.ts does).
  const own = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });
  try {
    const member = own.servers[0]!;
    await app?.close();
    ({ app, page } = await launch(own.getUri(), { NOVEL_COMPANION_USER_DATA: userData }));
    invoke = invokeVia(page);
    await invoke('bible.create', { slug: 'ro', name: 'Read only' });
    await invoke('bible.open', { slug: 'ro' });
    await expect(page.getByTestId('workspace')).toBeVisible();
    await invoke('snapshot.take', {});
    await rail(page, 'Settings').click();
    const view = page.getByTestId('settings-view');
    await member.stop({ doCleanup: false, force: true });
    // The lost connection shows on the next write; the snapshot opens read-only in place.
    const reach = view.getByTestId('number-pickerReach');
    await openEditable(reach);
    await reach.locator('input').fill('4');
    await reach.locator('input').press('Enter');
    await expect(reach.getByRole('alert')).toBeVisible({ timeout: 60_000 });
    await reach.locator('input').press('Escape');
    const banner = page.getByTestId('connection-banner');
    await expect(banner).toHaveAttribute('data-state', 'unavailable', { timeout: 30_000 });
    await banner.getByTestId('open-snapshot').click();
    await expect(banner).toHaveAttribute('data-state', 'readOnly');
    await rail(page, 'Settings').click();
    const date = page.getByTestId('settings-view').getByTestId('prune-date');
    await expect(date).toBeDisabled();
    await expect(date).toHaveAttribute('title', READ_ONLY_REASON);
    await expect(date).toHaveAttribute('aria-describedby', 'read-only-reason');
    await expect(page.locator('#read-only-reason')).toContainText(READ_ONLY_REASON);
  } finally {
    await app?.close();
    await own.stop().catch(() => undefined);
    await start();
  }
});

/** WCAG contrast of two `rgb()` colours. */
function contrast(a: string, b: string): number {
  const lum = (c: string) => {
    const [r, g, bl] = (c.match(/\d+(\.\d+)?/g) ?? ['0', '0', '0']).slice(0, 3).map((v) => {
      const x = Number(v) / 255;
      return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

test('NF-2 IP-11 IP-15 the new Settings fields work from the keyboard and read clearly in both themes', async () => {
  for (const theme of ['light', 'dark'] as const) {
    await invoke('appearance.set', { appearance: theme });
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
    const view = await openSettings();
    // A number opens with Enter, takes typing, and saves with Enter; the focus comes back to it.
    const reach = view.getByTestId('number-pickerReach-text');
    await reach.focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Meta+a');
    await page.keyboard.type(theme === 'light' ? '2' : '1');
    await page.keyboard.press('Enter');
    await expect(reach).toBeFocused();
    await expect
      .poll(async () => (await invoke('settings.get', {})).numbers.pickerReach)
      .toBe(theme === 'light' ? 2 : 1);
    // The focus ring shows on the field's text.
    const ring = await reach.evaluate((el) => getComputedStyle(el).outlineStyle);
    expect(ring).not.toBe('none');
    // Labels, the footer and the hints read at 4.5 to 1 or better against the page.
    for (const el of [
      view.locator('.settings-label').first(),
      view.locator('.instruction-footer').first(),
      view.locator('.settings-default').first(),
      view.getByTestId('settings-prune').getByText('Remove revisions older than'),
    ]) {
      const [color, bg] = await el.evaluate((e) => {
        // The first box behind the text with a background of its own.
        let at: Element | null = e;
        while (at) {
          const b = getComputedStyle(at).backgroundColor;
          if (b && b !== 'rgba(0, 0, 0, 0)' && b !== 'transparent') break;
          at = at.parentElement;
        }
        return [
          getComputedStyle(e).color,
          getComputedStyle(at ?? document.body).backgroundColor,
        ] as const;
      });
      expect(contrast(color, bg), `${theme}: ${color} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
  }
  await invoke('appearance.set', { appearance: 'system' });
});

test('ST-1 Test connection reports success and failure plainly; Replace switches only after the test passes', async () => {
  const view = await openSettings();
  const note = view.getByTestId('mongo-note');
  // The stored string, with the box empty.
  await view.getByTestId('mongo-test').click();
  await expect(note).toContainText('Connected. MongoDB answered');
  // A string that cannot connect: plain words, nothing saved.
  const before = await view.getByTestId('mongo-status').textContent();
  const bad = await closedUri();
  await view.getByTestId('mongo-input').fill(bad);
  await view.getByTestId('mongo-test').click();
  await expect(note).toContainText(/Nothing answered at that address|did not answer in time/, {
    timeout: 30_000,
  });
  await expect(note).not.toContainText(/ECONNREFUSED|Error/);
  await view.getByTestId('mongo-replace').click();
  await expect(note).toContainText('The connection string was not changed.', { timeout: 30_000 });
  await expect(view.getByTestId('mongo-status')).toHaveText(before ?? '');
  // The bible is still open on the old connection.
  expect((await invoke('bible.current', {})).bible?.id).toBe(SLUG);

  // A second deployment that connects: the app switches to it after the test passes.
  const other = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });
  try {
    await view.getByTestId('mongo-input').fill(other.getUri());
    await view.getByTestId('mongo-replace').click();
    await expect(page.getByTestId('no-bibles')).toBeVisible({ timeout: 30_000 });
    // That deployment has no bible "settings", so the app went back to the list, now from it.
    expect((await invoke('bible.list', {})).bibles).toEqual([]);
    const otherHost = new URL(other.getUri()).host;
    expect((await invoke('mongo.status', {})).masked).toBe(`mongodb://…${otherHost.slice(-10)}`);
    await expect(page.locator('body')).not.toContainText(other.getUri());
  } finally {
    await app?.close();
    app = null;
    await other.stop();
  }
});
