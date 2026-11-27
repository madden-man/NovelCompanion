import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import type { Store } from '../../src/main/db';
import { openBibleSession } from '../../src/main/db/session';
import { factKey } from '../../src/shared/domain/tray';
import { CHANNEL_REACH } from '../../src/shared/ipcPhone';
import type { Channel } from '../../src/shared/ipc';
import { PHONE_WAITS_META_ID } from '../../src/shared/phoneWaits';
import {
  SLUG,
  connectTo,
  openFixture,
  seedFixtureNovel,
  setVisible,
  startWebServer,
  webDb,
} from './server';
import type { WebDb, WebServer } from './server';

/**
 * A58 U5: capture on the phone, WebKit at iPhone 15 size, through the local
 * function on the fixture novel. The + opens it with the field focused
 * (PH-27); no Claude control and no instruction (PH-26, PH-36); a Route A
 * sentence files through the phone's channels as one undo step (PH-27); a
 * sentence that needs Claude is kept for the desk, never sent, and can be
 * taken back (PH-28).
 */
let db: WebDb;
let server: WebServer;
let store: Store;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  db = webDb();
  await seedFixtureNovel(db);
  store = await connectTo(db);
  server = await startWebServer(db);
});

test.afterAll(async () => {
  await server?.stop();
  await store?.close();
});

/** Route A against the fixture novel (as in tests/e2e/capture.spec.ts). */
const MOONCAKES = 'Teenagers in Guangzhou start to eat mooncakes with coffee by the 2050s.';
const MOONCAKES_TITLE = 'Teenagers in Guangzhou start to eat mooncakes with coffee';
/** Route A with no community: the chip is needed. */
const MASKS = 'Teenagers start to wear paper masks by 2060.';
/** Route B, the fast file. */
const KESSLER = 'The Kessler crowd stops tipping by 2070.';
/** Route C, the full capture. */
const TRAM = 'The tram to the coast was free on Sundays.';

const capture = (page: Page) => page.locator('[data-testid="phone-capture"]:visible');
const input = (page: Page) => capture(page).getByTestId('phone-capture-input');
const facts = (page: Page) => capture(page).getByTestId('capture-fact');
const fileButton = (page: Page) => capture(page).getByTestId('phone-capture-file');
const waitingLines = (page: Page) => capture(page).getByTestId('phone-waiting-line');

/** Every channel the page sends to /rpc, from now on. */
function rpcChannels(page: Page): string[] {
  const seen: string[] = [];
  page.on('request', (r) => {
    if (r.url().endsWith('/rpc')) {
      try {
        seen.push(JSON.parse(r.postData() ?? '{}').channel as string);
      } catch {
        // A keepalive batch or an empty body.
      }
    }
  });
  return seen;
}

/** Sentences that tell the reader how to use a screen (IP-19, the A57 rule). */
const INSTRUCTION =
  /(^|[.!?]\s+)(Click|Tap|Drag|Swipe|Press|Type|Pick|Choose|Use|Leave|Enter|Hold|Select)\b|to save\b|undo step|still saves|\bCmd\b|⌘|\bCtrl\b|double-click|right-click|\(from the current position\)/i;

async function instructionLines(page: Page): Promise<string[]> {
  const text = await page.locator('body').innerText();
  const titles = await page
    .locator('[title]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('title') ?? ''));
  return [...text.split('\n'), ...titles]
    .map((l) => l.trim())
    .filter((l) => l && INSTRUCTION.test(l));
}

/** Open capture from the bottom bar's +. */
async function openCapture(page: Page) {
  await page.getByTestId('tab-add').tap();
  await expect(capture(page)).toBeVisible();
  await expect(input(page)).toBeFocused();
}

/** Type into the field and wait for the router to place the sentences. */
async function type(page: Page, text: string, count: number) {
  await input(page).fill(text);
  await expect(facts(page)).toHaveCount(count);
  await expect(fileButton(page)).toHaveAttribute('data-current', 'true');
}

async function liveLines(title: string) {
  return store.db
    .collection(`${SLUG}.culturalEntries`)
    .find({ title, deletedAt: null } as never)
    .toArray();
}

async function storedWaits(): Promise<{ id: string; text: string; year: number }[]> {
  const doc = await store.db
    .collection(`${SLUG}.meta`)
    .findOne({ _id: PHONE_WAITS_META_ID as never });
  return (doc?.lines as { id: string; text: string; year: number }[] | undefined) ?? [];
}

/** Every visible control inside `scope` is a 44 px target. */
async function smallTargets(scope: Locator): Promise<string[]> {
  return scope.evaluate((root) =>
    [...root.querySelectorAll<HTMLElement>('button, [role="button"], input, select, label')]
      .filter((el) => el.getClientRects().length > 0)
      .filter((el) => !(el instanceof HTMLInputElement && el.type === 'checkbox'))
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ r }) => r.height < 44 || r.width < 44)
      .map(({ el, r }) => `${el.tagName} ${el.textContent?.trim() ?? ''} ${r.width}x${r.height}`),
  );
}

const noSidewaysScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

test('PH-27 PH-30 the + opens capture as a page with the field focused and the story year it files under', async ({
  page,
}) => {
  await openFixture(page, server.url);
  const topYear = (await page.getByTestId('phone-year').innerText()).trim();
  await openCapture(page);
  await expect(capture(page).getByTestId('phone-capture-year')).toHaveText(`Story year ${topYear}`);
  // The year opens the story year sheet, as the top bar's does.
  await capture(page).getByTestId('phone-capture-year').tap();
  await expect(page.getByTestId('year-sheet')).toBeVisible();
  await page.goBack();
  await expect(page.getByTestId('year-sheet')).toBeHidden();
  // A second + keeps the page and the focus; back returns to the tab under it.
  await page.getByTestId('tab-add').tap();
  await expect(input(page)).toBeFocused();
  await page.getByTestId('phone-back').tap();
  await expect(capture(page)).toHaveCount(0);
  await expect(page.getByTestId('entry-list')).toBeVisible();
});

test('PH-26 PH-36 no Claude control, no Claude word and no instruction anywhere on the phone capture; 44 px targets, 16 px fields, no sideways scroll', async ({
  page,
}) => {
  await openFixture(page, server.url);
  await openCapture(page);
  const seen: string[] = [...(await instructionLines(page))];
  await type(page, `${MOONCAKES} ${KESSLER} ${TRAM}`, 3);
  await expect(facts(page).nth(0)).toHaveAttribute('data-stand', 'local');
  await expect(facts(page).nth(1)).toHaveAttribute('data-stand', 'desk');
  await expect(facts(page).nth(2)).toHaveAttribute('data-stand', 'desk');
  seen.push(...(await instructionLines(page)));
  await expect(page.getByTestId('capture-ask-claude')).toHaveCount(0);
  await expect(page.getByTestId('capture-send-fact')).toHaveCount(0);
  await expect(page.getByTestId('capture-add-key')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /claude/i })).toHaveCount(0);
  expect(await capture(page).innerText()).not.toMatch(/claude|anthropic/i);
  expect(await smallTargets(capture(page))).toEqual([]);
  const sizes = await capture(page).evaluate((root) =>
    [...root.querySelectorAll<HTMLElement>('input, select, textarea, [contenteditable="true"]')]
      .filter((el) => el.getClientRects().length > 0)
      .map((el) => parseFloat(getComputedStyle(el).fontSize)),
  );
  for (const s of sizes) expect(s).toBeGreaterThanOrEqual(16);
  expect(await noSidewaysScroll(page)).toBe(true);
  // A chip's sheet carries none either.
  await facts(page).nth(0).getByTestId('chip-community').tap();
  await expect(page.getByTestId('capture-pick-sheet')).toBeVisible();
  seen.push(...(await instructionLines(page)));
  expect(await smallTargets(page.getByTestId('capture-pick-sheet'))).toEqual([]);
  await page.goBack();
  expect(seen).toEqual([]);
  // Nothing on the page shows only on hover: the chips and the press are there as drawn.
  for (const id of ['chip-section', 'chip-community', 'chip-year']) {
    await expect(facts(page).nth(0).getByTestId(id)).toBeVisible();
  }
  await expect(fileButton(page)).toBeVisible();
  await input(page).fill('');
  await expect(facts(page)).toHaveCount(0);
});

test('PH-27 a Route A sentence files through the phone channels as one undo step; the toast says what with Undo, which takes it back; the Filed list opens it as a page', async ({
  page,
}) => {
  await openFixture(page, server.url);
  const channels = rpcChannels(page);
  await openCapture(page);
  await type(page, MOONCAKES, 1);
  const card = facts(page).first();
  await expect(card).toHaveAttribute('data-stand', 'local');
  await expect(card).toContainText(`New cultural entry ${MOONCAKES_TITLE}`);
  await expect(card.getByTestId('chip-community')).toContainText('Guangzhou');
  await expect(card.getByTestId('chip-age')).toContainText('Ages 0 to 18');
  await expect(card.getByTestId('chip-year')).toContainText('2050');
  const diff = card.getByTestId('draft-diff');
  await expect(diff.locator('tr[data-path="communityId"]')).toContainText('Guangzhou');
  await expect(diff.locator('tr[data-path="startYear"]')).toContainText('2050');
  await expect(fileButton(page)).toHaveText('File 1');
  // Nothing is written before the press (CR-6).
  expect(await liveLines(MOONCAKES_TITLE)).toHaveLength(0);

  await fileButton(page).tap();
  await expect(page.getByTestId('phone-toast')).toContainText(`Filed ${MOONCAKES_TITLE}`);
  await expect.poll(async () => (await liveLines(MOONCAKES_TITLE)).length).toBe(1);
  const made = (await liveLines(MOONCAKES_TITLE))[0]!;
  expect(made).toMatchObject({ communityId: 'guangzhou', demographic: '0-18', startYear: 2050 });
  await expect(input(page)).toHaveText('');
  // Only phone channels, and nothing for Claude.
  for (const c of channels) expect(CHANNEL_REACH[c as Channel], c).toBe('phone');
  expect(channels.filter((c) => c.startsWith('claude.'))).toEqual([]);

  // The toast's Undo takes the filing back in one step.
  await page.getByTestId('phone-toast').getByTestId('undo-notice-undo').tap();
  await expect.poll(async () => (await liveLines(MOONCAKES_TITLE)).length).toBe(0);
  await page.getByTestId('phone-redo').tap();
  await expect.poll(async () => (await liveLines(MOONCAKES_TITLE)).length).toBe(1);

  // The Filed list opens the entry as a page; back returns to capture.
  const link = capture(page).getByTestId('phone-capture-filed-link');
  await expect(link).toContainText(MOONCAKES_TITLE);
  await link.tap();
  await expect(page.locator('[data-testid="phone-page"]:visible')).toContainText(MOONCAKES_TITLE);
  await page.getByTestId('phone-back').tap();
  await expect(capture(page)).toBeVisible();
});

test('PH-27 PH-28 a Route A sentence and one for the desk go in one press, and one Undo takes both back', async ({
  page,
}) => {
  await openFixture(page, server.url);
  await openCapture(page);
  const title = 'Teenagers in Portland begin to say yee haw ironically';
  await type(
    page,
    `Teenagers in Portland begin to say yee haw ironically starting around 2065. ${KESSLER}`,
    2,
  );
  await expect(fileButton(page)).toHaveText('File 1, keep 1 for the Mac');
  const waitsBefore = (await storedWaits()).length;
  await fileButton(page).tap();
  await expect(page.getByTestId('phone-toast')).toContainText('1 waiting for the Mac');
  await expect.poll(async () => (await liveLines(title)).length).toBe(1);
  expect((await storedWaits()).map((l) => l.text)).toContain(KESSLER);
  await expect(waitingLines(page)).toHaveCount(waitsBefore + 1);
  await page.getByTestId('phone-undo').tap();
  await expect.poll(async () => (await liveLines(title)).length).toBe(0);
  await expect.poll(async () => (await storedWaits()).map((l) => l.text)).not.toContain(KESSLER);
  await expect(waitingLines(page)).toHaveCount(waitsBefore);
});

test('PH-27 chips open pickers as sheets and change the draft; a needed chip holds the press', async ({
  page,
}) => {
  await openFixture(page, server.url);
  await openCapture(page);
  await type(page, MASKS, 1);
  const card = facts(page).first();
  const community = card.getByTestId('chip-community');
  await expect(community).toHaveAttribute('data-needed', 'true');
  await expect(fileButton(page)).toBeDisabled();
  await community.tap();
  const sheet = page.getByTestId('capture-pick-sheet');
  await expect(sheet).toBeVisible();
  await sheet.getByRole('button', { name: 'Guangzhou' }).tap();
  await expect(sheet).toBeHidden();
  await expect(community).toContainText('Guangzhou');
  await expect(community).not.toHaveAttribute('data-needed', 'true');
  await expect(card.getByTestId('draft-diff').locator('tr[data-path="communityId"]')).toContainText(
    'Guangzhou',
  );
  await expect(fileButton(page)).toBeEnabled();

  // The year chip takes digits in its sheet.
  await card.getByTestId('chip-year').tap();
  await sheet.getByTestId('capture-pick-year').fill('2061');
  await sheet.getByTestId('capture-pick-set').tap();
  await expect(card.getByTestId('chip-year')).toContainText('2061');
  await expect(card.getByTestId('draft-diff').locator('tr[data-path="startYear"]')).toContainText(
    '2061',
  );

  // The section chip re-routes: a world event needs Claude, so it would wait for the desk.
  await card.getByTestId('chip-section').tap();
  await sheet.getByRole('button', { name: 'World event' }).tap();
  await expect(card).toHaveAttribute('data-stand', 'desk');
  await expect(card.getByTestId('chip-category')).toBeVisible();
  await expect(card.getByTestId('draft-diff')).toHaveCount(0);
  await expect(fileButton(page)).toHaveText('Keep 1 for the Mac');
  await card.getByTestId('chip-section').tap();
  await sheet.getByRole('button', { name: 'Cultural data' }).tap();
  await expect(card).toHaveAttribute('data-stand', 'local');
  await expect(fileButton(page)).toHaveText('File 1');
  // Nothing was written by a chip.
  expect(await liveLines('Teenagers start to wear paper masks')).toHaveLength(0);
  await input(page).fill('');
  await expect(facts(page)).toHaveCount(0);
});

test('PH-28 sentences for Routes B and C are kept for the desk, never sent; they survive a reload and one is taken back', async ({
  page,
}) => {
  await openFixture(page, server.url);
  const channels = rpcChannels(page);
  await openCapture(page);
  await type(page, `${KESSLER} ${TRAM}`, 2);
  await expect(facts(page).nth(0)).toHaveAttribute('data-route', 'fast');
  await expect(facts(page).nth(1)).toHaveAttribute('data-route', 'full');
  await expect(facts(page).nth(0).getByTestId('capture-fact-state')).toHaveText('For the Mac');
  await expect(fileButton(page)).toHaveText('Keep 2 for the Mac');
  const before = (await storedWaits()).length;
  await fileButton(page).tap();
  await expect.poll(async () => (await storedWaits()).length).toBe(before + 2);
  const kept = (await storedWaits()).slice(-2);
  expect(kept.map((l) => l.text)).toEqual([KESSLER, TRAM]);
  const topYear = Number((await page.getByTestId('phone-year').innerText()).trim());
  for (const l of kept) expect(l.year).toBe(topYear);
  await expect(waitingLines(page)).toHaveCount(before + 2);
  await expect(waitingLines(page).last().getByTestId('phone-waiting-state')).toHaveText('Waiting');
  await expect(input(page)).toHaveText('');
  // They are not notebook pages, so the notebook pull never owns them.
  const pages = await store.db.collection(`${SLUG}.notebookPages`).find({}).toArray();
  for (const l of kept) expect(pages.some((p) => String(p._id) === l.id)).toBe(false);

  // A reload keeps the page and what waits.
  await page.reload();
  await expect(capture(page)).toBeVisible();
  await expect(waitingLines(page).filter({ hasText: KESSLER })).toHaveCount(1);
  await expect(waitingLines(page).filter({ hasText: TRAM })).toHaveCount(1);

  // Take back: gone from the store, and the sentence is back in the field.
  await waitingLines(page)
    .filter({ hasText: KESSLER })
    .getByTestId('phone-waiting-take-back')
    .tap();
  await expect.poll(async () => (await storedWaits()).map((l) => l.text)).not.toContain(KESSLER);
  await expect(waitingLines(page).filter({ hasText: KESSLER })).toHaveCount(0);
  await expect(input(page)).toContainText(KESSLER);
  // Undo keeps it again.
  await page.getByTestId('phone-undo').tap();
  await expect.poll(async () => (await storedWaits()).map((l) => l.text)).toContain(KESSLER);
  await expect(waitingLines(page).filter({ hasText: KESSLER })).toHaveCount(1);
  await input(page).fill('');

  // Nothing went to Claude: the server has no Claude channel, and none was asked for.
  expect(channels.filter((c) => c.startsWith('claude.'))).toEqual([]);
  // The shell's undo asks for the bridge's steps on every load (desk only, refused); not capture's.
  for (const c of channels.filter((x) => x !== 'notebook.claimSteps')) {
    expect(CHANNEL_REACH[c as Channel], c).toBe('phone');
  }
});

test('PH-28 a sentence the desk handles leaves the phone at the next freshness check', async ({
  page,
}) => {
  await openFixture(page, server.url);
  await openCapture(page);
  const tram = (await storedWaits()).find((l) => l.text === TRAM);
  expect(tram).toBeDefined();
  await expect(waitingLines(page).filter({ hasText: TRAM })).toHaveCount(1);
  // The desk files it from the tray: its fact is marked filed, through the desk's own repository.
  const desk = await openBibleSession(store, SLUG);
  await desk.repo.setTrayMarks([factKey(tram!.id, tram!.text, 0)], 'filed');
  await setVisible(page, false);
  await setVisible(page, true);
  await expect(waitingLines(page).filter({ hasText: TRAM })).toHaveCount(0);
  // Still stored for the desk's undo; only no longer waiting.
  expect((await storedWaits()).map((l) => l.text)).toContain(TRAM);
});

test('PH-27 PH-28 screens for the record, light and dark', async ({ page }) => {
  test.skip(!process.env.NC_PHONE_SCREENS, 'Set NC_PHONE_SCREENS=1 to save the screens.');
  const dir = join(import.meta.dirname, '../../docs/phone-screens/u5');
  mkdirSync(dir, { recursive: true });
  await openFixture(page, server.url);
  await openCapture(page);
  const shots: [string, () => Promise<void>][] = [
    ['01-capture-empty', async () => {}],
    [
      '02-capture-route-a',
      async () => {
        await type(page, MOONCAKES, 1);
      },
    ],
    [
      '03-capture-chip-sheet',
      async () => {
        await facts(page).first().getByTestId('chip-community').tap();
        await expect(page.getByTestId('capture-pick-sheet')).toBeVisible();
      },
    ],
    [
      '04-capture-for-the-mac',
      async () => {
        await page.goBack();
        await type(page, `${MOONCAKES} ${KESSLER}`, 2);
      },
    ],
    [
      '05-capture-filed-and-waiting',
      async () => {
        await fileButton(page).tap();
        await expect(page.getByTestId('phone-toast')).toBeVisible();
      },
    ],
  ];
  for (const [name, step] of shots) {
    await step();
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.screenshot({ path: join(dir, `${name}-${scheme}.png`), fullPage: true });
    }
  }
});
