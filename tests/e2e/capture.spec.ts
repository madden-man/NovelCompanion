import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { Invoke } from '../helpers/t5';
import { readFixture } from '../helpers/loadFixture';
import { field, invokeVia, launch, rail } from './helpers';

/**
 * KB-6 and KB-7 through the interface: Cmd+K (or Add in the status bar) opens
 * the capture box on every screen, Enter sends the sentence to the recorded
 * Claude, the proposals show with their diffs, File it approves the ticked
 * ones as one undo step, Review later leaves them in the queue, and without a
 * key or with a failed run the text is saved as an open question.
 */
let server: MongoMemoryReplSet;
let app: ElectronApplication;
let page: Page;
let invoke: Invoke;

const KEY = 'sk-ant-api03-e2e-capture-key-0123456789abcdef';
const MOVE = 'Zhou Lan moved to Seattle when Portland started rationing water.';
const RECIPE = 'Meiling and Ruth kept the same recipe box, passed between the families.';
const FERRY = 'The ferry to Macau stopped running in winter.';
const TRAM = 'The tram to the coast was free on Sundays.';
const fixture = readFixture();

test.describe.configure({ mode: 'serial' });

function strip(d: Record<string, unknown>): Record<string, unknown> {
  const { createdAt: _c, modifiedAt: _m, ...rest } = d;
  return rest;
}

test.beforeAll(async () => {
  server = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  ({ app, page } = await launch(server.getUri(), {
    // Slow enough to see the proposals arrive one at a time.
    NOVEL_COMPANION_TEST_CLAUDE_STEP_DELAY_MS: '60',
  }));
  invoke = invokeVia(page);
  await invoke('bible.create', { slug: 'capture-fixture', name: 'Capture fixture' });
  await invoke('bible.open', { slug: 'capture-fixture' });
  await expect(page.getByTestId('workspace')).toBeVisible();
  const seeded = await invoke('entry.list', { collection: 'eraStates', trash: 'exclude' });
  for (const e of seeded.entries) {
    await invoke('entry.delete', { collection: 'eraStates', id: e.entry._id });
  }
  for (const label of ['Portland', 'Guangzhou']) {
    await invoke('lists.addItem', { listId: 'communities', label, parentId: null });
  }
  const order = ['customSections', ...Object.keys(fixture).filter((c) => c !== 'customSections')];
  for (const c of order) {
    if (c === 'lists' || !fixture[c]?.length) continue;
    await invoke('entry.createMany', {
      items: fixture[c]!.map((d) => ({ collection: c as never, data: strip(d) })),
    });
  }
  await invoke('storyTime.set', { time: { year: 2034 } });
  await invoke('claude.setKey', { key: KEY });
  await invoke('claude.acknowledge', {});
});

test.afterAll(async () => {
  await app?.close();
  await server?.stop();
});

const box = () => page.getByTestId('capture-box');
const input = () => box().getByTestId('capture-input');
const cards = () => box().getByTestId('capture-card');

async function send(text: string) {
  await page.keyboard.press('Meta+k');
  await expect(input()).toBeFocused();
  await input().fill(text);
  await input().press('Enter');
}

test('KB-6 NF-2 Cmd+K opens the box from the dashboard and from the tree with the story time; Escape closes it', async () => {
  await expect(page.getByTestId('dashboard')).toBeVisible();
  await page.keyboard.press('Meta+k');
  await expect(box()).toBeVisible();
  await expect(box().getByRole('heading', { name: 'Add to the bible' })).toBeVisible();
  await expect(box().getByTestId('capture-time')).toContainText('Story time 2034');
  await expect(input()).toBeFocused();
  await expect(box()).toContainText('Enter sends it to Claude, Shift+Enter for a new line.');
  // Shift+Enter is a new line, and the unsent text is there when the box opens again.
  await input().pressSequentially('First line');
  await input().press('Shift+Enter');
  await input().pressSequentially('second line');
  await expect(input()).toHaveValue('First line\nsecond line');
  await page.keyboard.press('Escape');
  await expect(box()).toBeHidden();

  await rail(page, 'Family tree').click();
  await page.keyboard.press('Meta+k');
  await expect(box()).toBeVisible();
  await expect(input()).toHaveValue('First line\nsecond line');
  // NF-2: Tab stays inside the box.
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press('Tab');
    expect(await box().evaluate((el) => el.contains(document.activeElement))).toBe(true);
  }
  await input().fill('');
  await page.keyboard.press('Escape');
  await expect(box()).toBeHidden();

  // The status bar Add button is a plain button: Tab and Enter reach it.
  const add = page.getByTestId('status-bar').getByTestId('capture-add');
  await add.focus();
  await page.keyboard.press('Enter');
  await expect(box()).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(add).toBeFocused();
});

test('KB-6 NF-2 Cmd+K does nothing while another dialog holds focus', async () => {
  await page.keyboard.press('Meta+t');
  const story = page.getByTestId('story-time-dialog');
  await expect(story).toBeVisible();
  await page.keyboard.press('Meta+k');
  await expect(box()).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(story).toBeHidden();
});

test('KB-6 Enter shows two proposal cards with diffs; unticking one and Cmd+Enter files the other; the Filed link opens it', async () => {
  const lanBefore = (await invoke('entry.get', { collection: 'characters', id: 'Z3' })).entry;
  await send(MOVE);
  await expect(box()).toHaveAttribute('data-phase', 'running');
  await expect(box().getByTestId('capture-sent')).toHaveText(MOVE);
  await expect(cards()).toHaveCount(2);
  await expect(box()).toHaveAttribute('data-phase', 'review');
  await expect(box().getByTestId('capture-answer')).toContainText(
    "I proposed Seattle from 2034 in Zhou Lan's places lived",
  );
  await expect(cards().nth(0)).toContainText('Change to character Zhou Lan');
  await expect(cards().nth(0).getByTestId('proposal-diff')).toContainText('Places lived');
  await expect(cards().nth(0).getByTestId('proposal-diff')).toContainText('Seattle');
  await expect(cards().nth(1)).toContainText('New world event Portland rations water');
  await expect(cards().nth(1).getByTestId('proposal-diff')).toContainText('2034');
  // AI-3: nothing is written yet.
  expect((await invoke('entry.get', { collection: 'characters', id: 'Z3' })).entry).toEqual(
    lanBefore,
  );

  // NF-2: every control takes focus by Tab, and focus stays in the box.
  const reached = new Set<string>();
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press('Tab');
    const id = await page.evaluate(
      () =>
        document.activeElement?.getAttribute('data-testid') ??
        document.activeElement?.textContent?.trim() ??
        '',
    );
    reached.add(id);
    expect(await box().evaluate((el) => el.contains(document.activeElement))).toBe(true);
  }
  for (const id of ['capture-tick', 'capture-file', 'capture-later', 'Close']) {
    expect([...reached], id).toContain(id);
  }

  // Untick the place lived; File it names how many.
  await cards().nth(0).getByTestId('capture-tick').uncheck();
  await expect(box().getByTestId('capture-file')).toContainText('File 1 of 2');
  await page.keyboard.press('Meta+Enter');
  const filed = box().getByTestId('capture-filed');
  await expect(filed).toContainText('Filed');
  const link = filed.getByRole('button', { name: 'Portland rations water' });
  await expect(link).toBeVisible();
  await expect(filed.getByRole('button', { name: 'Add another' })).toBeVisible();

  const events = await invoke('entry.list', { collection: 'worldEvents', trash: 'exclude' });
  const made = events.entries.find((e) => e.entry.title === 'Portland rations water')!.entry;
  expect(made).toMatchObject({ status: 'idea', start: { year: 2034 } });
  expect(String(made.sourceNote)).toMatch(/^From a capture on /);
  const lan = (await invoke('entry.get', { collection: 'characters', id: 'Z3' })).entry;
  expect(JSON.stringify(lan.placesLived)).not.toContain('Seattle');

  await link.click();
  await expect(box()).toBeHidden();
  await expect(field(page.getByTestId('editor'), 'title').locator('input')).toHaveValue(
    'Portland rations water',
  );
});

test('KB-6 ED-3 Cmd+Z undoes the filing in one step', async () => {
  await page.getByTestId('status-bar').click();
  await page.keyboard.press('Meta+z');
  await expect
    .poll(async () => {
      const list = await invoke('entry.list', { collection: 'worldEvents', trash: 'exclude' });
      return list.entries.some((e) => e.entry.title === 'Portland rations water');
    })
    .toBe(false);
  await page.keyboard.press('Shift+Meta+z');
  await expect
    .poll(async () => {
      const list = await invoke('entry.list', { collection: 'worldEvents', trash: 'exclude' });
      return list.entries.some((e) => e.entry.title === 'Portland rations water');
    })
    .toBe(true);
});

test('KB-6 Review later leaves the proposal pending in the review queue', async () => {
  await send(RECIPE);
  await expect(cards()).toHaveCount(1);
  await expect(cards().first()).toContainText('New fact Meiling and Ruth shared one recipe box');
  await box().getByTestId('capture-later').click();
  await expect(box()).toBeHidden();
  const { proposals } = await invoke('proposal.list', { state: 'pending' });
  expect(proposals.map((p) => p.proposal.data.title)).toContain(
    'Meiling and Ruth shared one recipe box',
  );
  await rail(page, 'Review queue').click();
  await expect(page.getByTestId('review-queue')).toContainText(
    'Meiling and Ruth shared one recipe box',
  );
  // Reopening starts fresh: the sent text is not put back.
  await page.keyboard.press('Meta+k');
  await expect(input()).toHaveValue('');
  await page.keyboard.press('Escape');
});

test('KB-6 Escape in the review leaves the proposals pending, as Review later does', async () => {
  const pending = async () =>
    (await invoke('proposal.list', { state: 'pending' })).proposals.filter(
      (p) => p.proposal.data.title === 'Meiling and Ruth shared one recipe box',
    ).length;
  const before = await pending();
  await send(RECIPE);
  await expect(cards()).toHaveCount(1);
  await expect(box()).toHaveAttribute('data-phase', 'review');
  await page.keyboard.press('Escape');
  await expect(box()).toBeHidden();
  expect(await pending()).toBe(before + 1);
});

test('KB-7 AI-7 a failed run saves the text as an open question tagged capture, with a link', async () => {
  await send(FERRY);
  const saved = box().getByTestId('capture-saved');
  await expect(saved).toContainText('Saved as an open question');
  await expect(saved).toContainText('could not reach Anthropic');
  const list = await invoke('entry.list', { collection: 'openQuestions', trash: 'exclude' });
  const q = list.entries.find((e) => e.entry.title === FERRY)!.entry;
  expect(q).toMatchObject({ tags: ['capture'], question: FERRY });
  expect(String(q.body)).toContain('Story time 2034');
  await saved.getByRole('button', { name: FERRY }).click();
  await expect(box()).toBeHidden();
  await expect(field(page.getByTestId('editor'), 'title').locator('input')).toHaveValue(FERRY);
});

test('KB-7 with the key removed, Enter saves an open question and sends nothing', async () => {
  await invoke('claude.clearKey', {});
  const before = (await invoke('claude.runs', { feature: 'capture' })).runs.length;
  await send(TRAM);
  await expect(box().getByTestId('capture-saved')).toContainText('Saved as an open question');
  const list = await invoke('entry.list', { collection: 'openQuestions', trash: 'exclude' });
  expect(list.entries.find((e) => e.entry.title === TRAM)?.entry.tags).toEqual(['capture']);
  expect((await invoke('claude.runs', { feature: 'capture' })).runs).toHaveLength(before);
  // Add another clears the box for the next one.
  await box().getByRole('button', { name: 'Add another' }).click();
  await expect(input()).toHaveValue('');
  await expect(input()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(box()).toBeHidden();
});
