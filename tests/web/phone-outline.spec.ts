import { expect, test } from '@playwright/test';
import type { CDPSession, Locator, Page } from '@playwright/test';
import type { Store } from '../../src/main/db';
import { SLUG, connectTo, openFixture, seedFixtureNovel, startWebServer, webDb } from './server';
import type { WebDb, WebServer } from './server';
import { noSidewaysScroll, smallTargets } from './layout';

/**
 * A58 U2: the Outline, the chapter page and Relevant to Session on the phone,
 * through the local function on the fixture novel. Layout and taps on WebKit
 * at iPhone 15 size; the hold-to-lift drags on Chromium with real touch
 * events (CDP), tagged @touch. One column (PH-35), a line edited by one tap
 * (PH-32), every action by tap and every drag held first (PH-35), a chapter
 * as a page with back (PH-31), no instruction text (PH-36).
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

const OUTLINE = [
  '- Arrival at the archive',
  '  - the door is locked',
  '- The ledger',
  '- Kitchen one',
  '- Kitchen two',
  '- Rain on the river',
];
const BREAKS = { CH1: 0, CH2: 3, CH3: 5, CH4: 6, CH5: 6, CH6: 6, CH7: 6, CH8: 6 };

type Stored = { text: string; breaks: Record<string, number> };
type Api = {
  api: { invoke: (channel: string, req: unknown, context?: unknown) => Promise<unknown> };
};

/** A channel through the page's own transport, as the app sends it. */
const invoke = <T>(page: Page, channel: string, req: unknown, context?: unknown): Promise<T> =>
  page.evaluate(
    ([c, r, x]) =>
      (window as unknown as Api).api.invoke(c as string, r, x ?? undefined) as Promise<T>,
    [channel, req, context ?? null] as const,
  );
const stored = (page: Page) => invoke<Stored>(page, 'sceneOutline.get', {});
const storedLines = async (page: Page) => (await stored(page)).text.split('\n');

/** The fixture with the test's outline, then the Outline tab. */
async function openOutline(page: Page): Promise<Locator> {
  await openFixture(page, server.url);
  // A write carries the bible it was made in (A57); the function refuses one that does not.
  const { bible } = await invoke<{ bible: { id: string } }>(page, 'bible.current', {});
  await invoke(
    page,
    'sceneOutline.set',
    { text: OUTLINE.join('\n'), breaks: BREAKS },
    { bible: bible.id },
  );
  await page.getByTestId('tab-outline').tap();
  const view = page.getByTestId('outline-view');
  await expect(view.getByTestId('ph-line').first()).toBeVisible();
  return view;
}

const line = (page: Page, key: string, n: number) =>
  page.locator(`[data-testid="ph-line"][data-key="${key}"][data-line="${n}"]`);
const bar = (page: Page, id: string) =>
  page.locator(`[data-testid="chapter-bar"][data-chapter="${id}"]`);

const box = async (l: Locator) => {
  const b = await l.boundingBox();
  if (!b) throw new Error('The element has no box.');
  return b;
};

/** Sentences that tell the reader how to use a screen (IP-19, the A57 rule). */
const INSTRUCTION =
  /(^|[.!?]\s+)(Click|Tap|Drag|Swipe|Press|Type|Pick|Choose|Use|Leave|Enter|Hold|Select)\b|to save\b|undo step|still saves|\bCmd\b|⌘|\bCtrl\b|double-click|right-click/i;

async function instructionLines(page: Page): Promise<string[]> {
  const text = await page.locator('body').innerText();
  const titles = await page
    .locator('[title]:visible')
    .evaluateAll((els) => els.map((e) => e.getAttribute('title') ?? ''));
  return [...text.split('\n'), ...titles]
    .map((l) => l.trim())
    .filter((l) => l && INSTRUCTION.test(l));
}

test('PH-35 the Outline is one column in page order, with no sideways scroll', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'webkit', 'Layout runs on WebKit.');
  const view = await openOutline(page);
  await noSidewaysScroll(page);
  const width = page.viewportSize()?.width ?? 390;
  // Each bar carries its story year and runs across the column, its lines under it.
  await expect(bar(page, 'CH1').getByTestId('chapter-year')).toHaveText('2075');
  await expect(bar(page, 'CH2').getByTestId('chapter-year')).toHaveText('2045');
  let last = 0;
  for (const [key, n] of [
    ['CH1', -1],
    ['CH1', 0],
    ['CH1', 1],
    ['CH1', 2],
    ['CH2', -1],
    ['CH2', 0],
    ['CH2', 1],
    ['CH3', -1],
    ['CH3', 0],
  ] as const) {
    const b = await box(n < 0 ? bar(page, key) : line(page, key, n));
    expect(b.y).toBeGreaterThan(last);
    expect(b.x).toBeLessThan(40);
    expect(b.x + b.width).toBeLessThanOrEqual(width);
    expect(b.width).toBeGreaterThan(width * 0.8);
    last = b.y;
  }
  // The indented line sits deeper than its scene.
  const scene = await box(line(page, 'CH1', 0).getByTestId('ph-line-text'));
  const under = await box(line(page, 'CH1', 1).getByTestId('ph-line-text'));
  expect(under.x).toBeGreaterThan(scene.x + 10);
  expect(await smallTargets(view)).toEqual([]);
});

test('PH-32 a scene line edits on one tap, at 16 px, and is saved through /rpc', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'webkit', 'Layout runs on WebKit.');
  await openOutline(page);
  const sent: string[] = [];
  page.on('request', (r) => {
    if (r.url().endsWith('/rpc')) sent.push(String(JSON.parse(r.postData() ?? '{}').channel));
  });
  await line(page, 'CH1', 2).getByTestId('ph-line-text').tap();
  const input = line(page, 'CH1', 2).getByTestId('ph-line-input');
  await expect(input).toBeFocused();
  expect(
    await input.evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
  ).toBeGreaterThanOrEqual(16);
  await input.fill('The ledger, burned');
  // Return starts the next scene under it, in the same chapter.
  await input.press('Enter');
  const next = line(page, 'CH1', 3).getByTestId('ph-line-input');
  await expect(next).toBeFocused();
  await next.fill('A new scene');
  await next.evaluate((el) => (el as HTMLTextAreaElement).blur());
  await expect
    .poll(() => storedLines(page))
    .toEqual([
      '- Arrival at the archive',
      '  - the door is locked',
      '- The ledger, burned',
      '- A new scene',
      '- Kitchen one',
      '- Kitchen two',
      '- Rain on the river',
    ]);
  expect((await stored(page)).breaks.CH2).toBe(4);
  expect(sent).toContain('sceneOutline.set');
  // The visible + adds a scene at a chapter's end.
  await page.locator('[data-testid="ph-new-scene"][aria-label="New scene in chapter 3"]').tap();
  const added = line(page, 'CH3', 1).getByTestId('ph-line-input');
  await expect(added).toBeFocused();
  await added.fill('Flood');
  await added.evaluate((el) => (el as HTMLTextAreaElement).blur());
  await expect.poll(async () => (await storedLines(page)).at(-1)).toBe('- Flood');
});

test('PH-35 every line action is one tap away: indent, outdent, move, a new chapter, delete', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'webkit', 'Layout runs on WebKit.');
  await openOutline(page);
  const sheet = page.getByTestId('line-sheet');
  const openSheet = async (key: string, n: number) => {
    await line(page, key, n).getByTestId('ph-line-more').tap();
    await expect(sheet).toBeVisible();
  };
  await openSheet('CH1', 2);
  expect(await smallTargets(sheet)).toEqual([]);
  await sheet.getByTestId('ph-line-indent').tap();
  await expect.poll(async () => (await storedLines(page))[2]).toBe('  - The ledger');
  await sheet.getByTestId('ph-line-outdent').tap();
  await expect.poll(async () => (await storedLines(page))[2]).toBe('- The ledger');
  // Down from a chapter's last line crosses into the next chapter; the sheet follows the line.
  await sheet.getByTestId('ph-line-down').tap();
  await expect.poll(async () => (await stored(page)).breaks.CH2).toBe(2);
  await sheet.getByTestId('ph-line-down').tap();
  await expect
    .poll(() => storedLines(page))
    .toEqual([
      '- Arrival at the archive',
      '  - the door is locked',
      '- Kitchen one',
      '- The ledger',
      '- Kitchen two',
      '- Rain on the river',
    ]);
  await sheet.getByTestId('ph-line-up').tap();
  await sheet.getByTestId('ph-line-up').tap();
  await expect.poll(() => storedLines(page)).toEqual(OUTLINE);
  await expect.poll(async () => (await stored(page)).breaks.CH2).toBe(3);
  // A scene moves with the lines under it.
  await page.goBack();
  await openSheet('CH1', 0);
  await sheet.getByTestId('ph-line-down').tap();
  await expect
    .poll(async () => (await storedLines(page)).slice(0, 3))
    .toEqual(['- The ledger', '- Arrival at the archive', '  - the door is locked']);
  await page.goBack();
  await page.getByTestId('phone-undo').tap();
  await expect.poll(() => storedLines(page)).toEqual(OUTLINE);
  // Delete takes one line; Undo brings it back.
  await openSheet('CH2', 1);
  await sheet.getByTestId('ph-line-delete').tap();
  await expect(sheet).toBeHidden();
  await expect.poll(async () => (await storedLines(page)).includes('- Kitchen two')).toBe(false);
  await page.getByTestId('phone-undo').tap();
  await expect.poll(() => storedLines(page)).toEqual(OUTLINE);
  // A new chapter at a line takes that line and the ones after it in its chapter.
  const chapters = page.locator('[data-testid="chapter-bar"]');
  const before = await chapters.count();
  await openSheet('CH2', 1);
  await sheet.getByTestId('ph-line-new-chapter').tap();
  await expect(chapters).toHaveCount(before + 1);
  const made = await chapters.nth(2).getAttribute('data-chapter');
  expect(made).not.toBe('CH3');
  await expect.poll(async () => (await stored(page)).breaks[made as string]).toBe(4);
  // Its lines show under the new bar.
  await expect(line(page, made as string, 0)).toContainText('Kitchen two');
  await page.getByTestId('phone-undo').tap();
  await expect(chapters).toHaveCount(before);
});

test('PH-35 the chapter menu by tap: move, written, a new section, a new chapter, delete', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'webkit', 'Layout runs on WebKit.');
  await openOutline(page);
  const sheet = page.getByTestId('chapter-sheet');
  const openMenu = async (id: string) => {
    await bar(page, id).getByTestId('chapter-more').tap();
    await expect(sheet).toBeVisible();
  };
  const order = () =>
    page
      .locator('[data-testid="chapter-bar"]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-chapter')));
  await openMenu('CH2');
  expect(await smallTargets(sheet)).toEqual([]);
  await sheet.getByTestId('chapter-move-down').tap();
  await expect.poll(async () => (await order()).slice(0, 3)).toEqual(['CH1', 'CH3', 'CH2']);
  // Its scenes went with it.
  await expect(line(page, 'CH2', 0)).toContainText('Kitchen one');
  await sheet.getByTestId('chapter-move-up').tap();
  await expect.poll(async () => (await order()).slice(0, 3)).toEqual(['CH1', 'CH2', 'CH3']);
  await sheet.getByTestId('chapter-written').tap();
  await expect(bar(page, 'CH2')).toHaveAttribute('data-written', 'true');
  await sheet.getByTestId('chapter-written').tap();
  await expect(bar(page, 'CH2')).toHaveAttribute('data-written', 'false');
  // A new section from here puts a divider over the chapter; its × takes it away.
  await sheet.getByTestId('add-divider').tap();
  const dividers = page.locator('[data-testid="divider"]');
  const count = await dividers.count();
  await expect.poll(() => dividers.count()).toBeGreaterThan(1);
  const removes = page.locator('[data-testid="remove-divider"]:visible');
  const r = await box(removes.last());
  expect(r.width).toBeGreaterThanOrEqual(44);
  expect(r.height).toBeGreaterThanOrEqual(44);
  await page.getByTestId('phone-undo').tap();
  await expect.poll(() => dividers.count()).toBeLessThan(count + 1);
  // A new chapter after this one, then gone again.
  const bars = page.locator('[data-testid="chapter-bar"]');
  const n = await bars.count();
  await openMenu('CH2');
  await sheet.getByTestId('chapter-new-here').tap();
  await expect(bars).toHaveCount(n + 1);
  expect((await order())[2]).not.toBe('CH3');
  await page.getByTestId('phone-undo').tap();
  await expect(bars).toHaveCount(n);
  // Delete: the chapter goes to the trash, its scenes join the one above; Undo brings both back.
  await openMenu('CH3');
  await sheet.getByTestId('chapter-delete').tap();
  await expect(bar(page, 'CH3')).toHaveCount(0);
  await expect(page.getByTestId('scene-done')).toBeVisible();
  await expect.poll(async () => (await stored(page)).breaks.CH3).toBeUndefined();
  await page.getByTestId('scene-done-undo').tap();
  await expect(bar(page, 'CH3')).toBeVisible();
  await expect.poll(async () => (await stored(page)).breaks.CH3).toBe(5);
  // The foot's New chapter is there without a pointer.
  await expect(page.getByTestId('new-chapter')).toBeVisible();
});

test('PH-31 a reload with a line or chapter sheet open comes back to the Outline with the sheet closed', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'webkit', 'Layout runs on WebKit.');
  await openOutline(page);
  const lineSheet = page.getByTestId('line-sheet');
  const chapterSheet = page.getByTestId('chapter-sheet');
  await line(page, 'CH1', 0).getByTestId('ph-line-more').tap();
  await expect(lineSheet).toBeVisible();
  await page.reload();
  await expect(line(page, 'CH1', 0)).toBeVisible();
  await expect(lineSheet).toHaveCount(0);
  await bar(page, 'CH2').getByTestId('chapter-more').tap();
  await expect(chapterSheet).toBeVisible();
  await page.reload();
  await expect(bar(page, 'CH2')).toBeVisible();
  await expect(chapterSheet).toHaveCount(0);
  // Opened again, the sheet knows its chapter.
  await bar(page, 'CH2').getByTestId('chapter-more').tap();
  await expect(chapterSheet.getByTestId('chapter-move-down')).toBeEnabled();
});

test('PH-31 a chapter opens as a page, its fields edit on one tap, and back returns to the same place', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'webkit', 'Layout runs on WebKit.');
  await openOutline(page);
  await bar(page, 'CH6').scrollIntoViewIfNeeded();
  const y = await page.evaluate(() => window.scrollY);
  expect(y).toBeGreaterThan(100);
  await bar(page, 'CH6').getByTestId('chapter-open').tap();
  const editor = page.locator('[data-testid="editor"][data-entry-id="CH6"]');
  await expect(editor).toBeVisible();
  await expect(page.getByTestId('phone-back')).toBeVisible();
  await expect(editor.getByTestId('editor-heading')).toContainText('The Letter');
  // The strands with their year and cast, the summary and the scene note show; the desk's parts do not.
  await expect(editor.getByText('Characters present').first()).toBeVisible();
  await expect(editor.getByText('Summary', { exact: true })).toBeVisible();
  await expect(editor.getByTestId('chapter-alignment')).toHaveCount(0);
  await expect(editor.getByText('Summary may be out of date')).toHaveCount(0);
  await expect(editor.getByText('Re-import')).toHaveCount(0);
  await noSidewaysScroll(page);
  expect(await smallTargets(editor)).toEqual([]);
  expect(await smallTargets(page.getByTestId('phone-top-bar'))).toEqual([]);
  const summary = editor
    .locator('[data-field="summary"]')
    .locator('textarea, [contenteditable="true"], .editable-text')
    .first();
  await summary.tap();
  const typing = editor.locator('[data-field="summary"]').locator(':focus');
  await expect(typing).toHaveCount(1);
  expect(
    await typing.evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
  ).toBeGreaterThanOrEqual(16);
  await page.keyboard.type('Noor reads the letter twice.');
  await page.getByTestId('phone-back').tap();
  await expect
    .poll(async () => {
      const c = (await store.db
        .collection(`${SLUG}.chapters`)
        .findOne({ _id: 'CH6' as never })) as unknown as { summary?: string };
      return c.summary ?? '';
    })
    .toContain('Noor reads the letter twice.');
  await expect(page.getByTestId('outline-view')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(y - 30);
  expect(Math.abs((await page.evaluate(() => window.scrollY)) - y)).toBeLessThan(30);
});

test('PH-31 Relevant to Session: the chapter picked, its strands in one column, an item opened and back', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'webkit', 'Layout runs on WebKit.');
  await openFixture(page, server.url);
  await page.getByTestId('bible-menu-button').tap();
  await page.getByTestId('phone-more').getByRole('button', { name: 'Relevant to Session' }).tap();
  const view = page.getByTestId('relevant-view');
  await expect(view).toBeVisible();
  const picker = view.getByTestId('relevant-writing');
  const letter = await picker
    .locator('option', { hasText: 'The Letter' })
    .first()
    .getAttribute('value');
  await picker.selectOption(letter ?? '');
  const strand = view.getByTestId('relevant-strand');
  await expect(strand).toBeVisible();
  // The picker stays, showing the chapter; the story year follows it.
  await expect(picker).toBeVisible();
  await expect(picker.locator('option:checked')).toContainText('The Letter');
  await expect(page.getByTestId('phone-year')).toHaveText('2045');
  await noSidewaysScroll(page);
  // One column: every section of the strand starts at the same left edge and fits the width.
  const width = page.viewportSize()?.width ?? 390;
  const lefts = await strand.locator(':scope > section, :scope > details').evaluateAll((els) =>
    els
      .filter((e) => e.getClientRects().length > 0)
      .map((e) => {
        const r = e.getBoundingClientRect();
        return [Math.round(r.left), Math.round(r.right)];
      }),
  );
  expect(lefts.length).toBeGreaterThan(1);
  for (const [l, r] of lefts) {
    expect(l).toBe(lefts[0]?.[0]);
    expect(r).toBeLessThanOrEqual(width);
  }
  expect(await smallTargets(view)).toEqual([]);
  // A person's tile opens their page; back returns here.
  const tile = view.locator('[data-testid="tile-toggle"]').first();
  await tile.tap();
  await view.getByRole('button', { name: 'Their page' }).first().tap();
  await expect(page.getByTestId('character-page')).toBeVisible();
  await page.getByTestId('phone-back').tap();
  await expect(view).toBeVisible();
  await expect(strand).toBeVisible();
  // A world event or a cultural entry opens as a page too.
  const item = view.locator('.rel-open:visible').first();
  if ((await item.count()) > 0) {
    await item.tap();
    await expect(page.locator('[data-testid="editor"]:visible')).toBeVisible();
    await page.getByTestId('phone-back').tap();
    await expect(view).toBeVisible();
  }
});

test('PH-31 Relevant to Session opens from a chapter, on that chapter', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'webkit', 'Layout runs on WebKit.');
  await openOutline(page);
  await bar(page, 'CH2').getByTestId('chapter-more').tap();
  await page.getByTestId('chapter-sheet').getByTestId('ph-chapter-relevant').tap();
  const view = page.getByTestId('relevant-view');
  await expect(view.getByTestId('relevant-strand')).toBeVisible();
  await expect(view.getByTestId('relevant-writing').locator('option:checked')).toContainText(
    'Two Kitchens',
  );
  await page.getByTestId('phone-back').tap();
  await expect(page.getByTestId('outline-view')).toBeVisible();
  // And from the chapter's own page.
  await bar(page, 'CH3').getByTestId('chapter-open').tap();
  await page.getByTestId('chapter-relevant').tap();
  await expect(view.getByTestId('relevant-writing').locator('option:checked')).toContainText(
    'Wedding Weather',
  );
  await page.getByTestId('phone-back').tap();
  await expect(page.locator('[data-testid="editor"][data-entry-id="CH3"]')).toBeVisible();
});

test('PH-35 nothing on the Outline shows only on hover: menus, grips, the + and the dividers', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'webkit', 'Layout runs on WebKit.');
  await openOutline(page);
  for (const id of ['ph-line-more', 'chapter-more', 'chapter-grip', 'ph-new-scene', 'divider']) {
    const all = page.locator(`[data-testid="${id}"]:visible`);
    expect(await all.count()).toBeGreaterThan(0);
    const hidden = await all.evaluateAll(
      (els) =>
        els.filter((el) => {
          const s = getComputedStyle(el);
          return Number(s.opacity) < 0.5 || s.visibility !== 'visible';
        }).length,
    );
    expect(hidden).toBe(0);
  }
  await expect(page.locator('kbd:visible')).toHaveCount(0);
});

test('PH-36 the Outline, its sheets, the chapter page and Relevant to Session carry no instruction sentences', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'webkit', 'Layout runs on WebKit.');
  await openOutline(page);
  const seen: string[] = [];
  seen.push(...(await instructionLines(page)));
  await line(page, 'CH1', 0).getByTestId('ph-line-more').tap();
  seen.push(...(await instructionLines(page)));
  await page.goBack();
  await bar(page, 'CH1').getByTestId('chapter-more').tap();
  seen.push(...(await instructionLines(page)));
  await page.getByTestId('ph-chapter-relevant').tap();
  await expect(page.getByTestId('relevant-strand')).toBeVisible();
  seen.push(...(await instructionLines(page)));
  await page.getByTestId('phone-back').tap();
  await bar(page, 'CH1').getByTestId('chapter-open').tap();
  await expect(page.locator('[data-testid="editor"]:visible')).toBeVisible();
  seen.push(...(await instructionLines(page)));
  expect(seen).toEqual([]);
});

// ---------- touch drags, Chromium with CDP touches ----------

async function touches(page: Page): Promise<CDPSession> {
  return page.context().newCDPSession(page);
}
type Point = { x: number; y: number };
const centre = async (l: Locator): Promise<Point> => {
  const b = await box(l);
  return { x: b.x + Math.min(b.width / 2, 120), y: b.y + b.height / 2 };
};
async function touch(cdp: CDPSession, type: string, p?: Point) {
  await cdp.send('Input.dispatchTouchEvent', {
    type: type as 'touchStart',
    touchPoints: p ? [{ x: p.x, y: p.y }] : [],
  });
}
/** A finger that rests on `from` until it lifts, then drags to `to` and comes up. */
async function holdAndDrag(page: Page, cdp: CDPSession, from: Point, to: Point) {
  await touch(cdp, 'touchStart', from);
  await page.waitForTimeout(700);
  const steps = 12;
  for (let i = 1; i <= steps; i++) {
    await touch(cdp, 'touchMove', {
      x: from.x + ((to.x - from.x) * i) / steps,
      y: from.y + ((to.y - from.y) * i) / steps,
    });
    await page.waitForTimeout(30);
  }
  await touch(cdp, 'touchEnd');
}

test('PH-35 the Outline has a touchmove guard that can stop the scroll before any touch starts @touch', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'Listeners are read through CDP on Chromium.');
  await openOutline(page);
  const cdp = await touches(page);
  const { result } = await cdp.send('Runtime.evaluate', { expression: 'document' });
  const { listeners } = await cdp.send('DOMDebugger.getEventListeners', {
    objectId: result.objectId as string,
  });
  const guards = listeners.filter((l) => l.type === 'touchmove' && !l.passive);
  expect(guards.length).toBeGreaterThan(0);
});

test('PH-35 a scene line held lifts and moves, into another chapter too @touch', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'Touch drags run on Chromium.');
  await openOutline(page);
  const cdp = await touches(page);
  // The ledger, held, goes below Kitchen one in chapter 2.
  const from = await centre(line(page, 'CH1', 2).getByTestId('ph-line-text'));
  const target = await box(line(page, 'CH2', 1));
  await holdAndDrag(page, cdp, from, { x: from.x, y: target.y + 4 });
  await expect
    .poll(() => storedLines(page))
    .toEqual([
      '- Arrival at the archive',
      '  - the door is locked',
      '- Kitchen one',
      '- The ledger',
      '- Kitchen two',
      '- Rain on the river',
    ]);
  expect((await stored(page)).breaks.CH2).toBe(2);
  // The lift did not also open the line for editing.
  await expect(page.getByTestId('ph-line-input')).toHaveCount(0);
});

test('PH-35 a chapter bar held drags the line between it and the chapter above @touch', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'Touch drags run on Chromium.');
  await openOutline(page);
  const cdp = await touches(page);
  const from = await centre(bar(page, 'CH2').getByTestId('chapter-open'));
  const target = await box(line(page, 'CH1', 2));
  await holdAndDrag(page, cdp, from, { x: from.x, y: target.y + 2 });
  await expect.poll(async () => (await stored(page)).breaks.CH2).toBe(2);
  expect(await storedLines(page)).toEqual(OUTLINE);
  await expect(line(page, 'CH2', 0)).toContainText('The ledger');
  // The drop did not also open the chapter.
  await expect(page.locator('[data-testid="editor"]:visible')).toHaveCount(0);
});

test('PH-35 a plain swipe scrolls the Outline and moves nothing @touch', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'Touch drags run on Chromium.');
  await openOutline(page);
  const cdp = await touches(page);
  const before = await stored(page);
  const from = await centre(line(page, 'CH1', 2).getByTestId('ph-line-text'));
  await touch(cdp, 'touchStart', from);
  for (let i = 1; i <= 10; i++) {
    await touch(cdp, 'touchMove', { x: from.x, y: from.y - i * 30 });
    await page.waitForTimeout(16);
  }
  await touch(cdp, 'touchEnd');
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(100);
  await page.waitForTimeout(1500);
  expect(await stored(page)).toEqual(before);
  await expect(page.getByTestId('ph-line-input')).toHaveCount(0);
  await expect(page.getByTestId('drop-guide')).toHaveCount(0);
});
