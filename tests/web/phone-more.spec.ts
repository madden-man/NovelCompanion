import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import type { Store } from '../../src/main/db';
import { PHONE_CHANNELS } from '../../src/shared/ipcPhone';
import { KEY_STORAGE } from '../../src/web/transport';
import { SLUG, connectTo, openFixture, seedFixtureNovel, startWebServer, webDb } from './server';
import type { WebDb, WebServer } from './server';

/**
 * A58 U6: the bible menu's More screens and every section list on the phone,
 * through the local function on the fixture novel. Layout on WebKit at iPhone
 * 15 size; the hold-to-lift reorder on Chromium with CDP touches (the `touch`
 * project). Backstory's grid scrolls sideways with its names held (PH-34);
 * nothing hides behind a pointer or a key, drags start with a hold, Undo is
 * the shell's button (PH-35); no instructions (PH-36).
 */
let db: WebDb;
let server: WebServer;
let store: Store;

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

/** Layout tests run on the iPhone (WebKit); the touch drags on Chromium. */
const onIphone = () => test.skip(test.info().project.name !== 'iphone', 'Layout runs on WebKit.');
const onTouch = () =>
  test.skip(test.info().project.name !== 'touch', 'Touch drags run on Chromium.');

/** The screens under More, by the label on their row. */
const MORE = [
  'Backstory',
  'Questions',
  'Cultural data',
  'Writing tools',
  'Place tree',
  'Romanization',
  'Glossary table',
  'Lists',
  'Trash',
  'Settings',
] as const;

/** Each More screen's own root, to know it rendered. */
const ROOT: Record<(typeof MORE)[number], string> = {
  Backstory: 'backstory-view',
  Questions: 'questions-view',
  'Cultural data': 'cultural-data',
  'Writing tools': 'writing-tools-screen',
  'Place tree': 'places-view',
  Romanization: 'romanization-view',
  'Glossary table': 'glossary-table',
  Lists: 'lists-view',
  Trash: 'trash-view',
  Settings: 'settings-view',
};

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

/** The page on top of the active tab. */
const top = (page: Page) => page.locator('[data-testid="phone-page"]:visible');

async function openMore(page: Page, label: string): Promise<Locator> {
  await page.getByTestId('bible-menu-button').tap();
  await page.getByTestId('phone-more').getByRole('button', { name: label, exact: true }).tap();
  await expect(page.getByTestId('bible-sheet')).toBeHidden();
  return top(page);
}

async function openSection(page: Page, label: string): Promise<Locator> {
  await page.getByTestId('bible-menu-button').tap();
  await page.getByTestId('phone-sections').getByRole('button', { name: label, exact: true }).tap();
  await expect(page.getByTestId('bible-sheet')).toBeHidden();
  return top(page);
}

/** Sentences that tell the reader how to use a screen (IP-19, the A57 rule). */
const INSTRUCTION =
  /(^|[.!?]\s+)(Click|Tap|Drag|Swipe|Press|Type|Pick|Choose|Use|Leave|Enter|Hold|Select)\b|to save\b|undo step|still saves|\bCmd\b|⌘|\bCtrl\b|double-click|right-click/i;

/** Lines of the screen that read as instructions; a control's own name is not a sentence. */
async function instructionLines(scope: Locator): Promise<string[]> {
  const { text, names, titles } = await scope.evaluate((root) => ({
    text: (root as HTMLElement).innerText,
    names: [...root.querySelectorAll('button, option, [role="tab"], label')].map((el) =>
      (el as HTMLElement).innerText.trim(),
    ),
    titles: [...root.querySelectorAll('[title]')].map((el) => el.getAttribute('title') ?? ''),
  }));
  const controls = new Set(names);
  return [...text.split('\n').filter((l) => !controls.has(l.trim())), ...titles]
    .map((l) => l.trim())
    .filter((l) => l && INSTRUCTION.test(l));
}

/**
 * Every control in `scope` a thumb could miss: under 44 px. A radio or a box
 * counts by its label. Left out: the grid's markers, which carry a 44 px hit
 * area of their own (`::after`), and the shared grid header's era band.
 */
async function smallTargets(scope: Locator): Promise<string[]> {
  return scope.evaluate((root) => {
    const out: string[] = [];
    const sel =
      'button, a[href], [role="tab"], [role="button"], select, summary, textarea, input, .editable > .editable-text';
    for (const el of root.querySelectorAll<HTMLElement>(sel)) {
      if (el.closest('.sr-only, .wg-marker, .wg-head')) continue;
      if (el.getClientRects().length === 0) continue;
      const boxed =
        el instanceof HTMLInputElement && (el.type === 'radio' || el.type === 'checkbox')
          ? (el.closest('label') ?? el)
          : el;
      const r = boxed.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.height < 43.5 || r.width < 43.5) {
        out.push(
          `${el.tagName} "${(el.innerText || el.getAttribute('aria-label') || '').slice(0, 30)}" ${Math.round(r.width)}x${Math.round(r.height)}`,
        );
      }
    }
    return out;
  });
}

/** Controls that show only under a pointer: see-through until hovered. */
async function hoverOnly(scope: Locator): Promise<string[]> {
  return scope.evaluate((root) => {
    const out: string[] = [];
    for (const el of root.querySelectorAll<HTMLElement>('button, a[href], [role="button"]')) {
      if (el.getClientRects().length === 0 || el.closest('.sr-only')) continue;
      let o = 1;
      for (let n: HTMLElement | null = el; n && n !== root; n = n.parentElement) {
        const s = getComputedStyle(n);
        o *= Number(s.opacity);
        if (s.visibility === 'hidden') o = 0;
      }
      if (o < 0.3) out.push(`${el.tagName} ${el.getAttribute('aria-label') ?? el.innerText}`);
    }
    // Every value's pencil shows without a pointer over it.
    for (const el of root.querySelectorAll<HTMLElement>(
      '.editable:not(.is-disabled):not([data-save-state="saved"]) > .editable-text',
    )) {
      if (el.getClientRects().length === 0) continue;
      if (Number(getComputedStyle(el, '::after').opacity) < 0.3) {
        out.push(`pencil of ${el.innerText.slice(0, 30)}`);
      }
    }
    return out;
  });
}

const sidewaysScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);

/** The checks every screen of the tour passes. */
async function checkScreen(page: Page, scope: Locator, what: string) {
  await expect(scope, what).toBeVisible();
  expect(await sidewaysScroll(page), `${what}: no sideways page scroll`).toBe(false);
  expect(await smallTargets(scope), `${what}: targets under 44 px`).toEqual([]);
  expect(await hoverOnly(scope), `${what}: controls only on hover`).toEqual([]);
  expect(await instructionLines(scope), `${what}: instruction sentences`).toEqual([]);
  await expect(page.locator('kbd:visible'), `${what}: key hints`).toHaveCount(0);
  // PH-30: a More screen belongs to no tab, so no tab shows as the one open.
  await expect(page.locator('[data-testid="phone-bottom-bar"] [aria-current="page"]')).toHaveCount(
    0,
  );
}

const coll = (name: string) => store.db.collection(`${SLUG}.${name}`);
const doc = async (name: string, id: string) =>
  (await coll(name).findOne({ _id: id as never })) as Record<string, unknown> | null;

test('PH-35 PH-36 a tour of every More screen and section list: it renders, one column, 44 px targets, nothing on hover, no instructions, no kbd, no tab lit', async ({
  page,
}) => {
  onIphone();
  await openFixture(page, server.url);
  for (const label of MORE) {
    const scope = await openMore(page, label);
    await expect(scope.getByTestId(ROOT[label])).toBeVisible();
    await checkScreen(page, scope, label);
    if (label === 'Cultural data') {
      for (const tab of ['Eras', 'Places', 'Glossary']) {
        await scope.getByRole('tab', { name: tab }).tap();
        await expect(scope.getByRole('tab', { name: tab })).toHaveAttribute(
          'aria-selected',
          'true',
        );
        await checkScreen(page, scope, `Cultural data, ${tab}`);
      }
    }
    await page.getByTestId('phone-back').tap();
    await expect(page.getByTestId('tab-people')).toHaveAttribute('aria-current', 'page');
  }
  // Changes: the session's steps as a list in a sheet.
  await page.getByTestId('bible-menu-button').tap();
  await page.getByTestId('phone-more').getByRole('button', { name: 'Changes' }).tap();
  const changes = page.getByTestId('changes-sheet');
  await expect(changes.getByTestId('undo-history')).toBeVisible();
  expect(await instructionLines(changes)).toEqual([]);
  await page.goBack();
  await expect(changes).toBeHidden();
  // Every section list under All sections.
  await page.getByTestId('bible-menu-button').tap();
  const sections = await page.getByTestId('phone-sections').getByRole('button').allInnerTexts();
  await page.goBack();
  expect(sections.length).toBeGreaterThan(8);
  for (const label of sections) {
    const scope = await openSection(page, label);
    await expect(scope.locator('h2')).toBeVisible();
    await checkScreen(page, scope, `${label} list`);
    await page.getByTestId('phone-back').tap();
  }
});

test('PH-35 the phone never sends a desk channel on a tour of every screen', async ({ page }) => {
  onIphone();
  const channels = rpcChannels(page);
  await openFixture(page, server.url);
  for (const tab of ['outline', 'world', 'search', 'people']) {
    await page.getByTestId(`tab-${tab}`).tap();
    await page.waitForTimeout(200);
  }
  for (const label of [...MORE, 'Family tree', 'Relevant to Session']) {
    await openMore(page, label);
    await page.waitForTimeout(200);
    await page.getByTestId('phone-back').tap();
  }
  await page.getByTestId('bible-menu-button').tap();
  const sections = await page.getByTestId('phone-sections').getByRole('button').allInnerTexts();
  await page.goBack();
  for (const label of sections) {
    await openSection(page, label);
    await page.getByTestId('phone-back').tap();
  }
  await page.getByTestId('phone-year').tap();
  await page.goBack();
  await page.waitForTimeout(300);
  expect(channels.length).toBeGreaterThan(5);
  const phone = new Set<string>(PHONE_CHANNELS);
  expect([...new Set(channels)].filter((c) => !phone.has(c))).toEqual([]);
  expect(channels).not.toContain('notebook.claimSteps');
});

test('PH-34 Backstory: one thumb row of controls, no story time header, and the names stay at the left edge while the grid scrolls sideways', async ({
  page,
}) => {
  onIphone();
  await openFixture(page, server.url);
  const scope = await openMore(page, 'Backstory');
  const view = scope.getByTestId('backstory-view');
  await expect(view.getByTestId('backstory-time')).toHaveCount(0);
  // Zoom and New moment share one row, all on the first screen.
  const zoom = view.getByRole('group', { name: 'Zoom' }).getByRole('button');
  const add = view.getByRole('button', { name: 'New moment' });
  const tops = await Promise.all(
    [...(await zoom.all()), add].map(async (b) => (await b.boundingBox())?.y ?? -1),
  );
  expect(Math.max(...tops) - Math.min(...tops)).toBeLessThan(4);
  const grid = view.getByTestId('backstory-grid');
  await expect(grid).toBeInViewport();
  // It opens scrolled to the story year, and scrolls sideways inside itself.
  const story = await grid.evaluate((el) => ({ left: el.scrollLeft, wide: el.scrollWidth }));
  expect(story.left).toBeGreaterThan(0);
  expect(story.wide).toBeGreaterThan(1000);
  const cell = grid.locator('.bs-row[data-person="H1"] .bs-row-cell');
  const gridBox = (await grid.boundingBox())!;
  for (const x of [0, 400, story.wide]) {
    await grid.evaluate((el, to) => (el.scrollLeft = to), x);
    await page.waitForTimeout(50);
    const c = (await cell.boundingBox())!;
    expect(Math.abs(c.x - gridBox.x)).toBeLessThan(2);
  }
  expect(await sidewaysScroll(page)).toBe(false);
});

test('PH-34 Backstory: the held names tell the fixture people apart, wrapping before they are cut, and a Chinese name shows whole', async ({
  page,
}) => {
  onIphone();
  await openFixture(page, server.url);
  const scope = await openMore(page, 'Backstory');
  const grid = scope.getByTestId('backstory-grid');
  await expect(grid.locator('.bs-row').first()).toBeVisible();
  const rows = await grid.evaluate((root) =>
    [...root.querySelectorAll<HTMLElement>('.bs-row:not(.bs-person-row)')].map((row) => {
      const cell = row.querySelector<HTMLElement>('.bs-row-cell')!.getBoundingClientRect();
      const link = row.querySelector<HTMLElement>('.bs-name-link')!;
      const l = link.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(link);
      const lines = new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size;
      const zh = row.querySelector<HTMLElement>('.bs-zh');
      const z = zh?.getBoundingClientRect();
      const plus = row.querySelector<HTMLElement>('.bs-row-add')?.getBoundingClientRect();
      return {
        name: link.textContent ?? '',
        lines,
        whole: l.right <= cell.right + 1 && link.scrollWidth <= link.clientWidth + 1,
        inRow: l.top >= cell.top - 1 && l.bottom <= cell.bottom + 1,
        tall: l.height >= 43.5,
        zh: zh
          ? {
              text: zh.textContent ?? '',
              shown: z!.width > 0 && getComputedStyle(zh).display !== 'none',
              uncut:
                zh.scrollWidth <= zh.clientWidth + 1 && z!.right <= (plus?.left ?? cell.right) + 1,
              noEllipsis: getComputedStyle(zh).textOverflow !== 'ellipsis',
            }
          : null,
      };
    }),
  );
  expect(rows.length).toBeGreaterThanOrEqual(13);
  // Every fixture name fits in two lines, so none is cut: the Zhou rows read in full.
  expect(rows.filter((r) => r.lines > 2 || !r.whole || !r.inRow || !r.tall)).toEqual([]);
  expect(rows.filter((r) => r.name.startsWith('Zhou')).map((r) => r.name)).toEqual([
    'Zhou Meiling',
    'Zhou Wei',
    'Zhou Lan',
    'Zhou Jun',
  ]);
  // A Chinese name is whole, never a stray dot: Iris Hale-Zhou shows 晓曦.
  const zh = rows.flatMap((r) => (r.zh ? [{ name: r.name, ...r.zh }] : []));
  expect(zh.map((z) => z.text)).toContain('晓曦');
  expect(zh.filter((z) => !z.shown || !z.uncut || !z.noEllipsis)).toEqual([]);
  // The last resort: a name two lines cannot hold ends in an ellipsis on its second line.
  const clamped = await grid
    .locator('.bs-row:not(.bs-person-row) .bs-name-link')
    .first()
    .evaluate((el) => {
      el.textContent = 'Margaret Eleanor Whitcombe-Hale of the Upper Columbia River';
      const s = getComputedStyle(el);
      return {
        height: el.getBoundingClientRect().height,
        clamp: s.getPropertyValue('-webkit-line-clamp'),
        overflow: s.overflowY,
      };
    });
  expect(clamped).toEqual({ height: 44, clamp: '2', overflow: 'hidden' });
});

test('PH-34 PH-31 Backstory: the row "+" is a 44 px target that adds a moment as a page with back; a marker opens its page; nothing drags', async ({
  page,
}) => {
  onIphone();
  const channels = rpcChannels(page);
  await openFixture(page, server.url);
  const scope = await openMore(page, 'Backstory');
  const grid = scope.getByTestId('backstory-grid');
  const plus = grid.locator('.bs-row[data-person="H4"]').getByTestId('row-add');
  const b = (await plus.boundingBox())!;
  expect(b.width).toBeGreaterThanOrEqual(44);
  expect(b.height).toBeGreaterThanOrEqual(44);
  // No drag handles on the lifespans, and a marker is not a drag source.
  await expect(grid.getByTestId('life-handle-start')).toHaveCount(0);
  const before = await coll('moments').countDocuments({ characterId: 'H4' } as never);
  await plus.tap();
  const momentPage = top(page).getByTestId('backstory-moment-page');
  await expect(momentPage).toBeVisible();
  await expect(momentPage.getByTestId('moment-dialog')).toHaveAttribute('data-person', 'H4');
  expect(await coll('moments').countDocuments({ characterId: 'H4' } as never)).toBe(before + 1);
  expect(channels).toContain('entry.create');
  await page.getByTestId('phone-back').tap();
  await expect(top(page).getByTestId('backstory-view')).toBeVisible();
  // A marker opens its moment as a page; Next steps to the person's next one.
  const marker = grid.locator('.wg-marker[data-id="Z3-lives-0"]');
  await marker.tap();
  const moment = top(page).getByTestId('moment-dialog');
  await expect(moment).toHaveAttribute('data-id', 'Z3-lives-0');
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await moment.getByRole('button', { name: 'Next' }).tap();
  await expect(top(page).getByTestId('moment-dialog')).toHaveAttribute('data-id', 'Z3-lives-1');
  await page.getByTestId('phone-back').tap();
  await expect(top(page).getByTestId('backstory-view')).toBeVisible();
  // Undo is the shell's button: the new moment goes.
  await page.getByTestId('phone-undo').tap();
  await expect
    .poll(() => coll('moments').countDocuments({ characterId: 'H4', deletedAt: null } as never))
    .toBe(before);
});

test('PH-32 PH-35 a culture line, a glossary term, a place description and a list item each edit on one tap and save through /rpc', async ({
  page,
}) => {
  onIphone();
  const channels = rpcChannels(page);
  await openFixture(page, server.url);

  // A cultural line's text.
  let scope = await openMore(page, 'Cultural data');
  const line = scope.locator('.cu-line[data-id="CU4"]').getByTestId('line-text');
  await line.locator('.editable-text').tap();
  await line.locator('input').fill('Flood memorial walk at dawn');
  await line.locator('input').press('Enter');
  await expect
    .poll(async () => (await doc('culturalEntries', 'CU4'))?.title)
    .toBe('Flood memorial walk at dawn');
  await page.getByTestId('phone-back').tap();

  // A glossary term's romanization.
  scope = await openMore(page, 'Glossary table');
  const rom = scope.locator('tr[data-term="GL4"]').getByTestId('term-romanization');
  await rom.locator('.editable-text').tap();
  await rom.locator('input').fill('wai po');
  await rom.locator('input').press('Enter');
  await expect.poll(async () => (await doc('glossaryTerms', 'GL4'))?.romanization).toBe('wai po');
  // Edit opens the term as a page with back.
  await scope.locator('tr[data-term="GL4"]').getByRole('button', { name: /^Edit/ }).tap();
  await expect(top(page).getByTestId('editor')).toHaveAttribute('data-entry-id', 'GL4');
  await page.getByTestId('phone-back').tap();
  await expect(top(page).getByTestId('glossary-table')).toBeVisible();
  await page.getByTestId('phone-back').tap();

  // A place's description.
  scope = await openMore(page, 'Place tree');
  const desc = scope.locator('[data-place="PLC3"]').getByTestId('place-desc');
  await desc.locator('.editable-text').tap();
  const box = desc.locator('.rich-text-input');
  await expect(box).toBeFocused();
  await page.keyboard.press('End');
  await page.keyboard.type(' Hot in summer.');
  await page.getByTestId('places-view').locator('h2').tap();
  await expect
    .poll(async () => JSON.stringify((await doc('places', 'PLC3'))?.descriptions))
    .toContain('Hot in summer.');
  await page.getByTestId('phone-back').tap();

  // A list item's name.
  scope = await openMore(page, 'Lists');
  const marriedId = await scope
    .locator('.vocab-row')
    .filter({ hasText: 'Married' })
    .getAttribute('data-item');
  const married = scope.locator(`.vocab-row[data-item="${marriedId}"]`).getByTestId('item-name');
  await married.locator('.editable-text').tap();
  await married.locator('input').fill('Wed');
  await married.locator('input').press('Enter');
  await expect(scope.locator('.vocab-row').filter({ hasText: 'Wed' })).toHaveCount(1);
  // One undo step through the shell's button.
  await page.getByTestId('phone-undo').tap();
  await expect(scope.locator('.vocab-row').filter({ hasText: 'Married' })).toHaveCount(1);
  // Add and remove, each its own step.
  await scope.getByPlaceholder('Add to Union types').fill('Engaged');
  await scope.getByRole('button', { name: 'Add to Union types' }).tap();
  await expect(scope.locator('.vocab-row').filter({ hasText: 'Engaged' })).toHaveCount(1);
  await scope.getByRole('button', { name: 'Remove Engaged' }).tap();
  await expect(scope.locator('.vocab-row').filter({ hasText: 'Engaged' })).toHaveCount(0);
  await page.getByTestId('phone-undo').tap();
  await expect(scope.locator('.vocab-row').filter({ hasText: 'Engaged' })).toHaveCount(1);

  for (const c of ['entry.update', 'lists.rename', 'lists.addItem', 'lists.removeItem']) {
    expect(channels).toContain(c);
  }
});

test('PH-35 Trash: restore by tap, delete forever and empty the trash with the desk confirm', async ({
  page,
}) => {
  onIphone();
  await openFixture(page, server.url);
  // A moment trashed from its page.
  let scope = await openMore(page, 'Backstory');
  await scope.getByTestId('backstory-grid').locator('.wg-marker[data-id="H5-voice-0"]').tap();
  const moment = top(page).getByTestId('backstory-moment-page');
  await moment.getByRole('button', { name: 'Delete' }).tap();
  await moment
    .getByRole('dialog', { name: 'Move to trash' })
    .getByRole('button', {
      name: 'Move to trash',
    })
    .tap();
  await expect.poll(async () => (await doc('moments', 'H5-voice-0'))?.deletedAt).toBeTruthy();
  await expect(top(page).getByTestId('backstory-view')).toBeVisible();
  await page.getByTestId('phone-back').tap();

  scope = await openMore(page, 'Trash');
  await scope.getByRole('button', { name: 'Restore Voice' }).tap();
  await expect.poll(async () => (await doc('moments', 'H5-voice-0'))?.deletedAt ?? null).toBe(null);
  await expect(page.getByTestId('phone-toast')).toBeVisible();
  await page.getByTestId('phone-back').tap();

  // Two terms in the trash, each from its page: one deleted forever, then the trash emptied.
  for (const id of ['GL5', 'GL1']) {
    scope = await openMore(page, 'Glossary table');
    await scope.locator(`tr[data-term="${id}"]`).getByRole('button', { name: /^Edit/ }).tap();
    const entry = top(page);
    await entry.getByRole('button', { name: 'Move to trash' }).tap();
    await entry
      .getByRole('dialog', { name: 'Move to trash' })
      .getByRole('button', { name: 'Move to trash' })
      .tap();
    await expect.poll(async () => (await doc('glossaryTerms', id))?.deletedAt).toBeTruthy();
    // People again goes back to its root, past the pages over it.
    await page.getByTestId('tab-people').tap();
    await expect(page.getByTestId('phone-people')).toBeVisible();
  }
  scope = await openMore(page, 'Trash');
  await scope.getByRole('button', { name: 'Delete 月饼 forever' }).tap();
  const purge = scope.getByTestId('trash-purge-confirm');
  await purge.locator('input').fill('月饼');
  await purge.getByRole('button', { name: 'Delete 月饼 forever' }).tap();
  await expect.poll(() => doc('glossaryTerms', 'GL5')).toBe(null);
  await scope.getByTestId('trash-empty-all').tap();
  const empty = scope.getByTestId('trash-empty-confirm');
  await empty.locator('input').fill('empty');
  await empty.getByRole('button', { name: /forever$/ }).tap();
  await expect.poll(() => doc('glossaryTerms', 'GL1')).toBe(null);
  await expect(scope.getByTestId('trash-empty')).toBeVisible();
  await checkScreen(page, top(page), 'Trash, emptied');
});

test('PH-35 sign out of this phone: the confirm, then the paste screen with no bible on it', async ({
  page,
}) => {
  onIphone();
  await openFixture(page, server.url);
  const scope = await openMore(page, 'Settings');
  await expect(scope.getByTestId('mongo-settings-section')).toHaveCount(0);
  await scope.getByTestId('sign-out').tap();
  const confirm = scope.getByTestId('sign-out-confirm');
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: 'Stay signed in' }).tap();
  await expect(confirm).toBeHidden();
  await scope.getByTestId('sign-out').tap();
  await scope.getByTestId('sign-out-confirm-button').tap();
  await expect(page.getByTestId('key-gate')).toBeVisible();
  await expect(page.getByTestId('workspace')).toHaveCount(0);
  const text = await page.locator('body').innerText();
  for (const name of ['Fixture novel', 'Margaret Hale', 'Portland'])
    expect(text).not.toContain(name);
  expect(await page.evaluate((k) => localStorage.getItem(k), KEY_STORAGE)).toBe(null);
});

test('PH-35 a list item moves by hold-to-lift on its grip, one undo step; a quick swipe on the grip moves nothing', async ({
  page,
}) => {
  onTouch();
  await openFixture(page, server.url);
  const scope = await openMore(page, 'Lists');
  const panel = scope
    .locator('.panel')
    .filter({ has: page.locator('h3', { hasText: 'Union types' }) });
  const labels = () => panel.locator('.vocab-row [data-testid="item-name"]').allInnerTexts();
  const first = (await labels()).map((l) => l.trim());
  expect(first.slice(0, 3)).toEqual(['Married', 'Partnered', 'Other']);
  const cdp = await page.context().newCDPSession(page);
  const touch = (type: string, x: number, y: number) =>
    cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: type === 'touchEnd' ? [] : [{ x, y }],
    } as never);
  const grip = panel.locator('.vocab-row').first().getByTestId('drag-handle');
  await grip.scrollIntoViewIfNeeded();
  const g = (await grip.boundingBox())!;
  const last = (await panel.locator('.vocab-row').nth(2).boundingBox())!;
  const x = g.x + g.width / 2;
  const y = g.y + g.height / 2;
  const to = last.y + last.height * 0.75;

  // A quick swipe: no hold, nothing lifts or moves.
  await touch('touchStart', x, y);
  await touch('touchMove', x, y + 40);
  await touch('touchMove', x, to);
  await touch('touchEnd', x, to);
  await page.waitForTimeout(500);
  expect((await labels()).map((l) => l.trim()).slice(0, 3)).toEqual(first.slice(0, 3));

  // A hold lifts the row; the drop moves it.
  await touch('touchStart', x, y);
  await page.waitForTimeout(500);
  await expect(panel.locator('.vocab-row.lifted')).toHaveCount(1);
  for (let i = 1; i <= 8; i++) await touch('touchMove', x, y + ((to - y) * i) / 8);
  await touch('touchEnd', x, to);
  await expect
    .poll(async () => (await labels()).map((l) => l.trim()).slice(0, 3))
    .toEqual(['Partnered', 'Other', 'Married']);
  // One step: Undo puts it back.
  await page.getByTestId('phone-undo').tap();
  await expect
    .poll(async () => (await labels()).map((l) => l.trim()).slice(0, 3))
    .toEqual(['Married', 'Partnered', 'Other']);
});

test('PH-34 PH-35 PH-36 screens for the record, light and dark', async ({ page }) => {
  onIphone();
  test.skip(!process.env.NC_PHONE_SCREENS, 'Set NC_PHONE_SCREENS=1 to save the screens.');
  const dir = join(import.meta.dirname, '../../docs/phone-screens/u6');
  mkdirSync(dir, { recursive: true });
  await openFixture(page, server.url);
  const shoot = async (name: string) => {
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.screenshot({ path: join(dir, `${name}-${scheme}.png`) });
    }
  };
  const shots: [string, string][] = [
    ['01-backstory', 'Backstory'],
    ['03-cultural-data', 'Cultural data'],
    ['04-place-tree', 'Place tree'],
    ['05-glossary', 'Glossary table'],
    ['06-romanization', 'Romanization'],
    ['07-lists', 'Lists'],
    ['08-trash', 'Trash'],
    ['09-settings', 'Settings'],
    ['10-questions', 'Questions'],
    ['11-writing-tools', 'Writing tools'],
  ];
  for (const [name, label] of shots) {
    const scope = await openMore(page, label);
    await page.waitForTimeout(300);
    await shoot(name);
    if (label === 'Backstory') {
      await scope.getByTestId('backstory-grid').locator('.wg-marker[data-id="Z3-lives-0"]').tap();
      await expect(top(page).getByTestId('moment-dialog')).toBeVisible();
      await shoot('02-moment-page');
      await page.getByTestId('phone-back').tap();
    }
    if (label === 'Settings') {
      await scope.getByTestId('sign-out').scrollIntoViewIfNeeded();
      await scope.getByTestId('sign-out').tap();
      await scope
        .getByTestId('sign-out-confirm')
        .evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
      await shoot('09b-settings-sign-out');
    }
    await page.getByTestId('phone-back').tap();
  }
  await page.getByTestId('bible-menu-button').tap();
  await page.getByTestId('phone-more').getByRole('button', { name: 'Changes' }).tap();
  await shoot('12-changes');
});
