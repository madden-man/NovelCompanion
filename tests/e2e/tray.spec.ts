import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import type { Document } from 'mongodb';
import type { Store } from '../../src/main/db';
import { BRIDGE_UP } from '../../src/shared/bridge';
import type { Invoke } from '../helpers/t5';
import { readFixture } from '../helpers/loadFixture';
import { ENTRY_COLLECTIONS } from '../../src/shared/schema';
import { connectTo, fileDb, invokeVia, launch, rail } from './helpers';
import type { TestDb } from './helpers';

/**
 * A56 (FN-1 to FN-9): the From the notebook screen, Voice, the Relevant to
 * Session group, and questions decided on the phone, in the built app. Rows
 * are written as FlowState's function stores them in `bridge_up` (the spec's
 * own bridge database), and the window's `focus` event pulls them.
 */
let db: TestDb;
let app: ElectronApplication;
let page: Page;
let invoke: Invoke;
let store: Store;

const SLUG = 'tray-fixture';
const WORLD = 'tray-fixture';
const KEY = 'sk-ant-api03-e2e-capture-key-0123456789abcdef';
const fixture = readFixture();
const NOV24 = Date.parse('2026-11-24T21:00:00.000Z');
const NOV25 = Date.parse('2026-11-25T21:00:00.000Z');

/** Route A against this bible (as in capture.spec.ts). */
const YEE_HAW = 'Teenagers in Portland begin to say yee haw ironically starting around 2065.';
/** Route C or B: the capture recordings answer it. */
const MOVE = 'Zhou Lan moved to Seattle when Portland started rationing water.';
/** A cultural line with no year, on a page with none. */
const NO_YEAR = 'Teenagers in Guangzhou start to eat mooncakes with coffee.';

test.describe.configure({ mode: 'serial' });

function strip(d: Record<string, unknown>): Record<string, unknown> {
  const { createdAt: _c, modifiedAt: _m, ...rest } = d;
  return rest;
}

async function send(table: string, id: string, rev: number, row: Record<string, unknown> | null) {
  const _id = `${WORLD}:${table}:${id}`;
  await store.bridge
    .collection(BRIDGE_UP)
    .replaceOne(
      { _id } as Document,
      { world: WORLD, table, id, rev, deleted: row === null, row, at: rev },
      { upsert: true },
    );
}

async function focusWindow() {
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.emit('focus');
  });
}

const kept = (id: string, text: string, year: number | null | undefined, date = NOV25) => ({
  id,
  at: date + 1,
  updatedAt: date + 1,
  text,
  wise: false,
  kept: true,
  kind: 'kept',
  date,
  ...(year === undefined ? {} : { year }),
  chips: { characterIds: [], placeIds: [] },
});

test.beforeAll(async () => {
  db = fileDb();
  store = await connectTo(db);
  ({ app, page } = await launch(db));
  invoke = invokeVia(page);
  await invoke('bible.create', { slug: SLUG, name: 'Tray fixture' });
  await invoke('bible.open', { slug: SLUG });
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
    await invoke('test.seed', {
      items: fixture[c]!.map((d) => ({ collection: c as never, data: strip(d) })),
    });
  }
  await invoke('storyTime.set', { time: { year: 2034 } });
  // FN-6: count every claude.capture call main receives, of any kind, sent or not.
  await app.evaluate(({ ipcMain }) => {
    const handlers = (
      ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> }
    )._invokeHandlers;
    const channel = 'nc:claude.capture';
    const original = handlers.get(channel)!;
    (globalThis as { captures?: number }).captures = 0;
    handlers.set(channel, (...args: unknown[]) => {
      (globalThis as { captures?: number }).captures! += 1;
      return original(...args);
    });
  });
});

const captures = () => app.evaluate(() => (globalThis as { captures?: number }).captures ?? -1);

/** Every entry of every section, with its last change, and the proposals: what "nothing written" watches. */
async function everything(): Promise<string> {
  const out: string[] = [];
  for (const collection of ENTRY_COLLECTIONS) {
    const { entries } = await invoke('entry.list', { collection, trash: 'include' });
    for (const e of entries) {
      const d = e.entry as Record<string, unknown>;
      out.push(`${collection}:${String(d._id)}:${String(d.modifiedAt)}`);
    }
  }
  const { proposals } = await invoke('proposal.list', {});
  out.push(...proposals.map((p) => `proposal:${p.proposal._id}:${p.proposal.state}`));
  const { lists } = await invoke('lists.get', {});
  out.push(...lists.map((l) => `list:${l._id}:${l.items.length}`));
  return out.sort().join('\n');
}

test.afterAll(async () => {
  await app?.close();
  await store?.close();
});

const tray = () => page.getByTestId('notebook-tray');
const item = (text: string) =>
  tray()
    .getByTestId('tray-item')
    .filter({ has: page.getByText(text, { exact: false }) });

async function openTray() {
  await rail(page, 'From the notebook').click();
  await expect(tray()).toBeVisible();
}

test('FN-1 the tray offers kept lines and councils about the story, grouped by day and by council; an in-story council offers nothing, and nothing is written', async () => {
  await send('messages', 'K1', 1, kept('K1', YEE_HAW, 2066));
  await send('messages', 'K2', 1, kept('K2', MOVE, 2034, NOV24));
  await send('pages', 'CA', 1, {
    id: 'CA',
    kind: 'council',
    title: 'Where does Lan go?',
    state: 'open',
    createdAt: NOV24,
    updatedAt: NOV24,
    seats: ['c:Z3'],
    reading: 'about',
    year: 2061,
  });
  await send('messages', 'ca1', 1, {
    id: 'ca1',
    pageId: 'CA',
    at: NOV24 + 1,
    text: 'Teenagers in Guangzhou start to eat mooncakes with coffee by the 2050s.',
    kept: false,
  });
  await send('pages', 'CI', 1, {
    id: 'CI',
    kind: 'council',
    title: 'In the kitchen',
    state: 'open',
    createdAt: NOV24,
    updatedAt: NOV24,
    seats: ['c:Z3'],
    reading: 'in',
    year: 2045,
  });
  await send('messages', 'ci1', 1, {
    id: 'ci1',
    pageId: 'CI',
    at: NOV24 + 1,
    text: 'Teenagers in Portland begin to wear paper masks in 2045.',
    voiceId: 'c:Z3',
    kept: false,
  });
  await focusWindow();
  await expect
    .poll(async () => (await invoke('notebook.offered', {})).pages.map((p) => p.id).sort())
    .toEqual(['CA', 'K1', 'K2']);
  const before = await everything();
  await openTray();
  const groups = tray().getByTestId('tray-group');
  await expect(groups).toHaveCount(3);
  await expect(groups.nth(0)).toHaveAttribute('data-group', /^day:2026-11-25/);
  await expect(groups.nth(1)).toHaveAttribute('data-group', 'council:CA');
  await expect(groups.nth(1).locator('h3')).toContainText('Where does Lan go?');
  await expect(groups.nth(1).locator('h3')).toContainText('story year 2061');
  await expect(tray()).not.toContainText('paper masks');
  // The Route A card shows its chips and the ED-7 diff with a tick.
  const yee = item(YEE_HAW);
  await expect(yee.getByTestId('capture-fact')).toHaveAttribute('data-stand', 'local');
  await expect(yee.getByTestId('chip-section')).toBeVisible();
  await expect(yee.getByTestId('draft-diff')).toBeVisible();
  // The Route B or C card waits behind Send to Claude.
  const move = item(MOVE);
  await expect(move.getByTestId('capture-fact')).toHaveAttribute('data-stand', 'unsent');
  await expect(move.getByTestId('capture-send-fact')).toBeVisible();
  // Showing the tray wrote nothing anywhere, and sent nothing to Claude.
  expect(await everything()).toBe(before);
  expect(await invoke('tray.state', {})).toEqual({ dismissed: [], filed: [], sent: [] });
  expect(await captures()).toBe(0);
});

test('FN-6 with no key Send to Claude is off and says why; nothing is sent until it is pressed', async () => {
  const sendButton = item(MOVE).getByTestId('capture-send-fact');
  await expect(sendButton).toBeDisabled();
  await expect(sendButton).toHaveAttribute('title', /No Anthropic key/);
  await expect(item(MOVE).getByTestId('capture-ask-claude')).toBeDisabled();
  expect(await captures()).toBe(0);
});

test('FN-3 File it writes the ticked draft as a plain new entry in one undo step; undo offers it again and redo files it again', async () => {
  const group = tray().getByTestId('tray-group').filter({ hasText: YEE_HAW });
  await group.getByTestId('tray-file').click();
  await expect(tray().getByTestId('tray-filed')).toBeVisible();
  await expect(item(YEE_HAW)).toHaveCount(0);
  const lines = async () =>
    (await invoke('entry.list', { collection: 'culturalEntries', trash: 'exclude' })).entries
      .map((e) => e.entry as Record<string, unknown>)
      .filter((e) => /yee haw/i.test(String(e.title) + String(e.body)));
  await expect.poll(async () => (await lines()).length).toBe(1);
  const made = (await lines())[0]!;
  expect(made.startYear).toBe(2065);
  expect(made).not.toHaveProperty('status');
  expect(made).not.toHaveProperty('sourceNote');
  await page.getByTestId('top-undo').click();
  await expect.poll(async () => (await lines()).length).toBe(0);
  await expect(item(YEE_HAW)).toHaveCount(1);
  await page.getByTestId('top-redo').click();
  await expect.poll(async () => (await lines()).length).toBe(1);
  await expect(item(YEE_HAW)).toHaveCount(0);
});

test('FN-2 a line from the whole book asks for its year with a highlighted chip and files only once it is picked', async () => {
  await send('messages', 'K3', 1, kept('K3', NO_YEAR, null));
  await focusWindow();
  await expect(item(NO_YEAR)).toHaveCount(1, { timeout: 10_000 });
  const card = item(NO_YEAR);
  const year = card.getByTestId('chip-year');
  await expect(year).toHaveAttribute('data-needed', 'true');
  const group = tray().getByTestId('tray-group').filter({ hasText: NO_YEAR });
  await expect(group.getByTestId('tray-file')).toBeDisabled();
  await year.getByTestId('chip-year-field').click();
  await page.keyboard.type('2072');
  await page.keyboard.press('Enter');
  await expect(card.getByTestId('chip-year')).not.toHaveAttribute('data-needed', 'true');
  await expect(group.getByTestId('tray-file')).toBeEnabled();
  await group.getByTestId('tray-file').click();
  await expect(item(NO_YEAR)).toHaveCount(0);
  const coffee = async () =>
    (await invoke('entry.list', { collection: 'culturalEntries', trash: 'exclude' })).entries
      .map((e) => e.entry as Record<string, unknown>)
      .filter(
        (e) =>
          /mooncakes with coffee\.?$/i.test(String(e.title)) || /coffee\.$/.test(String(e.body)),
      );
  await expect.poll(async () => (await coffee()).map((e) => e.startYear)).toEqual([2072]);
});

test('FN-4 FN-5 Dismiss is one undo step; a dismissed card stays dismissed after a restart of the screen; the line edited on the phone is offered again', async () => {
  const TEA = 'Teenagers in Portland start to drink tea with milk.';
  await send('messages', 'K5', 1, kept('K5', TEA, 2050));
  await focusWindow();
  await expect(item(TEA)).toHaveCount(1, { timeout: 10_000 });
  await item(TEA).getByTestId('tray-dismiss').click();
  await expect(item(TEA)).toHaveCount(0);
  await page.getByTestId('top-undo').click();
  await expect(item(TEA)).toHaveCount(1);
  expect((await invoke('tray.state', {})).dismissed).toEqual([]);
  await item(TEA).getByTestId('tray-dismiss').click();
  await expect(item(TEA)).toHaveCount(0);
  await rail(page, 'Characters').click();
  await openTray();
  await expect(tray().getByTestId('tray-group').first()).toBeVisible();
  await expect(item(TEA)).toHaveCount(0);
  const edited = 'Teenagers in Portland start to drink tea with honey.';
  await send('messages', 'K5', 2, kept('K5', edited, 2050));
  await focusWindow();
  await expect(item(edited)).toHaveCount(1, { timeout: 10_000 });
  // A line no longer kept takes its facts with it.
  await send('messages', 'K5', 3, { ...kept('K5', edited, 2050), kept: false });
  await focusWindow();
  await expect(item(edited)).toHaveCount(0, { timeout: 10_000 });
});

test('FN-6 Send to Claude hands the sentence to the capture box, which sends it on its route; a run that fails offers the card again', async () => {
  await invoke('claude.setKey', { key: KEY });
  await rail(page, 'Characters').click();
  await openTray();
  // AI-6: the tray's own confirmation comes first; Send waits for it.
  const sendButton = item(MOVE).getByTestId('capture-send-fact');
  await expect(sendButton).toBeDisabled();
  await tray().getByTestId('claude-disclosure').getByTestId('claude-acknowledge').click();
  await expect(tray().getByTestId('claude-disclosure')).toHaveCount(0);
  expect((await invoke('claude.status', {})).acknowledgedAt).toBeTruthy();
  await expect(sendButton).toBeEnabled();
  expect(await captures()).toBe(0);
  await sendButton.click();
  const box = page.getByTestId('capture-box');
  await expect(box).toBeVisible();
  await expect(box.getByTestId('capture-sent')).toHaveText(MOVE);
  await expect(box.getByTestId('capture-run').first()).toHaveAttribute('data-route', 'fast');
  expect(await captures()).toBe(1);
  // The fast file has no recording for this line, so the run fails: the card comes back.
  await expect(item(MOVE)).toHaveCount(1, { timeout: 10_000 });
  expect((await invoke('tray.state', {})).sent).toEqual([]);
  if (await box.isVisible()) await page.keyboard.press('Escape');
  await expect(box).toBeHidden();
});

test('FN-6 Ask Claude instead sends it on Route C; closed without filing it comes back, filed in the box it stays gone', async () => {
  const box = page.getByTestId('capture-box');
  await item(MOVE).getByTestId('capture-ask-claude').click();
  await expect(box.getByTestId('capture-run').first()).toHaveAttribute('data-route', 'full');
  await expect(box.getByTestId('capture-card').first()).toBeVisible({ timeout: 10_000 });
  await expect(item(MOVE)).toHaveCount(0);
  await box.getByRole('button', { name: 'Close', exact: true }).first().click();
  await expect(box).toBeHidden();
  await expect(item(MOVE)).toHaveCount(1);
  expect((await invoke('tray.state', {})).sent).toEqual([]);
  await item(MOVE).getByTestId('capture-ask-claude').click();
  await expect(box.getByTestId('capture-card').first()).toBeVisible({ timeout: 10_000 });
  await box.getByTestId('capture-file').click();
  await expect(box.getByTestId('capture-filed')).toBeVisible();
  await box.getByRole('button', { name: 'Done' }).click();
  await expect(box).toBeHidden();
  await expect(item(MOVE)).toHaveCount(0);
  expect((await invoke('tray.state', {})).sent).toHaveLength(1);
});

test('FN-8 a character speaking in a council in the story has Voice on their page, by year, opening the council', async () => {
  await rail(page, 'Characters').click();
  await page
    .getByTestId('entry-list')
    .getByRole('button', { name: /^Zhou Lan/ })
    .click();
  const voice = page.getByTestId('voice-list');
  await expect(voice).toBeVisible();
  await expect(voice.locator('li')).toHaveCount(1);
  await expect(voice).toContainText('2045');
  await expect(voice).toContainText('paper masks');
  await voice.getByRole('button').first().click();
  await expect(page.getByTestId('notebook-page')).toHaveAttribute('data-page-id', 'CI');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('character-page')).toBeVisible();
});

test('FN-9 Relevant to Session lists the pages that touch the scene; one opens across the desk and Close comes back', async () => {
  await send('messages', 'K4', 1, kept('K4', 'Rain in Guangzhou never stops that spring.', 2071));
  await focusWindow();
  await invoke('storyTime.set', {
    time: { year: 2060, chapterId: 'CH7', strandId: 'CH7-present' },
  });
  await page.getByTestId('top-relevant').click();
  const group = page.getByTestId('relevant-notebook');
  await expect(group).toBeVisible({ timeout: 10_000 });
  // By place (Guangzhou, the strand's place) and by cast (Zhou Lan speaks in CI).
  await expect(group.locator('[data-notebook-id="K4"]')).toBeVisible();
  await expect(group.locator('[data-notebook-id="CI"]')).toBeVisible();
  await expect(group.locator('[data-notebook-id="K1"]')).toHaveCount(0);
  await expect(page.getByTestId('relevant-view')).not.toContainText(/Keep|Tick/);
  await group.locator('[data-notebook-id="CI"] button').click();
  await expect(page.getByTestId('notebook-page')).toHaveAttribute('data-page-id', 'CI');
  await page.getByTestId('notebook-page').getByRole('button', { name: 'Close' }).click();
  await expect(page.getByTestId('relevant-notebook')).toBeVisible();
});

test('FN-7 a question answered on the phone is decided in the bible, and Undo in the top bar puts it back open', async () => {
  const { entry } = await invoke('entry.create', {
    collection: 'openQuestions',
    data: { title: 'Does Lan stay in Guangzhou?', question: 'Does Lan stay in Guangzhou?' },
  });
  const at = Date.now() + 5000;
  await send('pages', entry._id, 1, {
    id: entry._id,
    kind: 'question',
    title: 'Does Lan stay in Guangzhou?',
    state: 'answered',
    answeredAt: at,
    createdAt: at - 1000,
    updatedAt: at,
  });
  await send('messages', 'qw1', 1, {
    id: 'qw1',
    pageId: entry._id,
    at,
    text: 'She stays until 2070.',
    wise: true,
    kept: false,
  });
  await focusWindow();
  const q = async () =>
    (await invoke('entry.get', { collection: 'openQuestions', id: entry._id })).entry as Record<
      string,
      unknown
    >;
  await expect.poll(async () => (await q()).state).toBe('decided');
  expect((await q()).decision).toBe('She stays until 2070.');
  await page.getByTestId('top-changes').click();
  await expect(page.getByTestId('changes-popover')).toContainText(
    'From the phone: Does Lan stay in Guangzhou?',
  );
  await page.keyboard.press('Escape');
  await page.getByTestId('top-undo').click();
  await expect.poll(async () => (await q()).state).toBe('open');
  expect((await q()).decision).toBe('');
});

test('FN-7 a question changed by a pull the page could not hear (while it reloads, as on open) is still an undo step', async () => {
  const { entry } = await invoke('entry.create', {
    collection: 'openQuestions',
    data: { title: 'Does the ferry run?', question: 'Does the ferry run?' },
  });
  const at = Date.now() + 5000;
  await send('pages', entry._id, 1, {
    id: entry._id,
    kind: 'question',
    title: 'Does the ferry run?',
    state: 'answered',
    resolvedByTap: true,
    answeredAt: at,
    createdAt: at - 1000,
    updatedAt: at,
  });
  // The pull runs and broadcasts while the page is gone, as the first pull on open can.
  const reloading = page.reload();
  await focusWindow();
  await reloading;
  await expect(page.getByTestId('workspace')).toBeVisible();
  const q = async () =>
    (await invoke('entry.get', { collection: 'openQuestions', id: entry._id })).entry as Record<
      string,
      unknown
    >;
  await expect.poll(async () => (await q()).state).toBe('decided');
  await page.getByTestId('top-changes').click();
  await expect(page.getByTestId('changes-popover')).toContainText(
    'From the phone: Does the ferry run?',
  );
  await page.keyboard.press('Escape');
  await page.getByTestId('top-undo').click();
  await expect.poll(async () => (await q()).state).toBe('open');
});
