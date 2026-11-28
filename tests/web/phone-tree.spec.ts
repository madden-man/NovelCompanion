import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { CDPSession, Locator, Page } from '@playwright/test';
import type { Store } from '../../src/main/db';
import { SLUG, connectTo, openFixture, seedFixtureNovel, startWebServer, webDb } from './server';
import type { WebDb, WebServer } from './server';

/**
 * A58 U4: the family tree by touch, through the local function on the fixture
 * novel. Layout, taps, the person sheet and Open and back run on WebKit at
 * iPhone 15 size (project `iphone`); pan, pinch and hold-to-lift run on
 * Chromium at the same size with real touch events sent through CDP
 * `Input.dispatchTouchEvent` (project `touch`). PH-33, PH-35, PH-36.
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

const ROW_H = 132;
type Pos = Record<string, { x: number; y: number; loose?: boolean }>;
type View = { x: number; y: number; w: number; h: number };
type Pt = { x: number; y: number };

const webkitOnly = () =>
  test.skip(test.info().project.name !== 'iphone', 'Layout and taps run on WebKit.');
const touchOnly = () =>
  test.skip(test.info().project.name !== 'touch', 'Real touch events run on Chromium.');

async function positions(): Promise<Pos> {
  const doc = (await store.db
    .collection(`${SLUG}.meta`)
    .findOne({ _id: 'treeLayout' as never })) as unknown as { positions?: Pos } | null;
  return doc?.positions ?? {};
}

async function linkCount(): Promise<number> {
  const live = { deletedAt: null };
  return (
    (await store.db.collection(`${SLUG}.unions`).countDocuments(live)) +
    (await store.db.collection(`${SLUG}.parentLinks`).countDocuments(live))
  );
}

/** The channels the page sends to /rpc, from now on. */
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

const svgOf = (page: Page) => page.locator('[data-testid="tree-svg"]:visible');

async function openTree(page: Page): Promise<void> {
  await openFixture(page, server.url);
  await page.getByTestId('bible-menu-button').tap();
  await page.getByTestId('phone-more').getByRole('button', { name: 'Family tree' }).tap();
  await expect(svgOf(page)).toBeVisible();
  await expect(svgOf(page).locator('.tnode').first()).toBeVisible();
  // The first fit lands after the layout does.
  await page.waitForTimeout(300);
}

async function viewOf(page: Page): Promise<View> {
  const vb = (await svgOf(page).getAttribute('viewBox')) ?? '';
  const [x, y, w, h] = vb.split(/\s+/).map(Number);
  return { x: x ?? 0, y: y ?? 0, w: w ?? 0, h: h ?? 0 };
}

async function rectOf(l: Locator) {
  const b = await l.boundingBox();
  if (!b) throw new Error('The element has no box.');
  return b;
}

/** The view point under a screen point. */
async function toView(page: Page, c: Pt): Promise<Pt> {
  const v = await viewOf(page);
  const r = await rectOf(svgOf(page));
  return { x: v.x + ((c.x - r.x) / r.width) * v.w, y: v.y + ((c.y - r.y) / r.height) * v.h };
}

const person = (page: Page, name: string) => svgOf(page).locator(`.tnode[aria-label^="${name}"]`);

async function personId(page: Page, name: string): Promise<string> {
  return (await person(page, name).getAttribute('data-person')) ?? '';
}

async function drawnAt(page: Page, name: string): Promise<Pt> {
  const t = (await person(page, name).getAttribute('transform')) ?? '';
  const m = /translate\(([-\d.]+),([-\d.]+)\)/.exec(t);
  return { x: Number(m?.[1]), y: Number(m?.[2]) };
}

async function centre(l: Locator): Promise<Pt> {
  const b = await rectOf(l);
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

/** A point on the tree with nobody under it, near the middle. */
async function emptyPoint(page: Page): Promise<Pt> {
  const r = await rectOf(svgOf(page));
  const found = await page.evaluate((r) => {
    for (let dy = 0.5; dy > 0.05; dy -= 0.05) {
      for (let dx = 0.3; dx < 0.7; dx += 0.05) {
        const x = r.x + r.width * dx;
        const y = r.y + r.height * dy;
        const el = document.elementFromPoint(x, y);
        if (el && el.closest('[data-testid="tree-svg"]') && !el.closest('.tnode, text'))
          return { x, y };
      }
    }
    return null;
  }, r);
  if (!found) throw new Error('No empty point on the tree.');
  return found;
}

/** Real touch events through CDP, as a finger sends them. */
class Fingers {
  constructor(private cdp: CDPSession) {}
  static async on(page: Page): Promise<Fingers> {
    return new Fingers(await page.context().newCDPSession(page));
  }
  private send(type: 'touchStart' | 'touchMove' | 'touchEnd', pts: Pt[]) {
    return this.cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: pts.map((p, i) => ({ x: p.x, y: p.y, id: i, radiusX: 4, radiusY: 4 })),
    });
  }
  down(...pts: Pt[]) {
    return this.send('touchStart', pts);
  }
  /** Moves every finger from `from` to `to` in a few steps. */
  async move(from: Pt[], to: Pt[], steps = 8) {
    for (let s = 1; s <= steps; s++) {
      await this.send(
        'touchMove',
        from.map((f, i) => ({
          x: f.x + ((to[i]!.x - f.x) * s) / steps,
          y: f.y + ((to[i]!.y - f.y) * s) / steps,
        })),
      );
    }
  }
  up() {
    return this.send('touchEnd', []);
  }
  async drag(from: Pt, to: Pt, holdMs = 0) {
    await this.down(from);
    if (holdMs) await new Promise((r) => setTimeout(r, holdMs));
    await this.move([from], [to]);
    await this.up();
  }
}

const pageState = (page: Page) =>
  page.evaluate(() => ({
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    scale: window.visualViewport?.scale ?? 1,
  }));

/** Sentences that tell the reader how to use a screen (IP-19, the A57 rule). */
const INSTRUCTION =
  /(^|[.!?]\s+)(Click|Tap|Drag|Swipe|Press|Type|Pick|Choose|Use|Leave|Enter|Hold|Select)\b|to save\b|undo step|still saves|\bCmd\b|⌘|\bCtrl\b|double-click|right-click|long[- ]press|pinch/i;

async function instructionLines(page: Page): Promise<string[]> {
  const text = await page.locator('body').innerText();
  const titles = await page
    .locator('[title]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('title') ?? ''));
  return [...text.split('\n'), ...titles]
    .map((l) => l.trim())
    .filter((l) => l && INSTRUCTION.test(l));
}

// ---- WebKit: layout, taps, the sheet ----

test('PH-33 the tree fills the screen between the bars, its tools in one thumb row, with no page scroll', async ({
  page,
}) => {
  webkitOnly();
  await openTree(page);
  const bar = page.locator('.tree-bar:visible');
  const buttons = await bar.getByRole('button').all();
  expect(buttons.length).toBeGreaterThanOrEqual(3);
  const tops = new Set<number>();
  for (const b of buttons) {
    const r = await rectOf(b);
    tops.add(Math.round(r.y));
    expect(r.height).toBeGreaterThanOrEqual(44);
    expect(r.width).toBeGreaterThanOrEqual(44);
  }
  expect(tops.size).toBe(1);
  await expect(bar.getByRole('button', { name: 'Tidy layout' })).toBeVisible();
  await expect(bar.getByRole('button', { name: 'Fit' })).toBeVisible();
  // Desk only: adding people, full screen and Export.
  for (const name of ['Add person', 'Full screen', 'Export']) {
    await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
  }
  // The tree sits between the top and bottom bars, and the page has nothing to scroll.
  const top = await rectOf(page.getByTestId('phone-top-bar'));
  const bottom = await rectOf(page.getByTestId('phone-bottom-bar'));
  const tree = await rectOf(page.locator('.tree-wrap:visible'));
  expect(tree.y).toBeGreaterThanOrEqual(top.y + top.height);
  expect(tree.y + tree.height).toBeLessThanOrEqual(bottom.y + 1);
  expect(tree.height).toBeGreaterThan(300);
  const doc = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth,
    cw: document.documentElement.clientWidth,
    sh: document.documentElement.scrollHeight,
    ih: window.innerHeight,
  }));
  expect(doc.sw).toBeLessThanOrEqual(doc.cw);
  expect(doc.sh).toBeLessThanOrEqual(doc.ih);
  // The page itself takes no finger on the tree.
  expect(
    await page.locator('.tree-wrap:visible').evaluate((el) => getComputedStyle(el).touchAction),
  ).toBe('none');
});

/**
 * What the tree's edges cut in two, by screen boxes: any end year at either
 * edge, and any card at the left edge. (A tree wider than a readable view
 * goes on past the right edge, where its rows need not line up.)
 */
async function cutAtTheEdges(page: Page): Promise<string[]> {
  return svgOf(page).evaluate((svg) => {
    const r = svg.getBoundingClientRect();
    const out: string[] = [];
    const across = (b: DOMRect, x: number) => b.left < x - 0.5 && b.right > x + 0.5;
    for (const el of svg.querySelectorAll('[data-union-label]')) {
      const b = el.getBoundingClientRect();
      if (b.width && (across(b, r.left) || across(b, r.right)))
        out.push(`${el.textContent} ${Math.round(b.left)} to ${Math.round(b.right)}`);
    }
    for (const el of svg.querySelectorAll('.tnode-box')) {
      const b = el.getBoundingClientRect();
      if (b.width && across(b, r.left)) {
        const name = el.closest('.tnode')?.getAttribute('aria-label') ?? '';
        out.push(`${name.split(',')[0]} ${Math.round(b.left)} to ${Math.round(b.right)}`);
      }
    }
    return out;
  });
}

test('PH-33 labels are whole at the default zoom and readable at fit', async ({ page }) => {
  webkitOnly();
  await openTree(page);
  const svg = svgOf(page);
  const r = await rectOf(svg);
  // At the default view no end year and no card at the left is cut by the
  // tree's edges, the leftmost people are in view, and the top row sits near the top.
  expect(await cutAtTheEdges(page)).toEqual([]);
  const boxes = await svg.evaluate((el) =>
    [...el.querySelectorAll('.tnode-box')].map((b) => b.getBoundingClientRect().toJSON()),
  );
  const left = Math.min(...boxes.map((b) => b.left));
  const top = Math.min(...boxes.map((b) => b.top));
  expect(left).toBeGreaterThanOrEqual(r.x);
  expect(left).toBeLessThan(r.x + 60);
  expect(top).toBeGreaterThanOrEqual(r.y);
  expect(top).toBeLessThan(r.y + 60);
  await expect(person(page, 'Margaret Hale')).toBeInViewport({ ratio: 1 });
  const inView = await svg.evaluate((el) => {
    const s = el.getBoundingClientRect();
    return [...el.querySelectorAll('[data-union-label]')].filter((l) => {
      const b = l.getBoundingClientRect();
      return b.left >= s.left && b.right <= s.right && b.top >= s.top && b.bottom <= s.bottom;
    }).length;
  });
  expect(inView).toBeGreaterThan(0);
  // End years are drawn over the people, whole.
  const ends = svg.locator('[data-union-label]');
  expect(await ends.count()).toBeGreaterThan(0);
  for (const t of await ends.all()) await expect(t).toHaveText(/^ended -?\d+$/);
  const hidden = await svg.evaluate((el) => {
    const labels = [...el.querySelectorAll('[data-union-label]')];
    const nodes = el.querySelector('.tree-nodes');
    // Every end year comes after the people in paint order, so no person covers one.
    return labels.filter(
      (l) => nodes && !(nodes.compareDocumentPosition(l) & Node.DOCUMENT_POSITION_FOLLOWING),
    ).length;
  });
  expect(hidden).toBe(0);
  // No name is cut short in the fixture.
  for (const n of await svg.locator('.tnode-name').allTextContents()) expect(n).not.toMatch(/…$/);
  // At fit the names and years are drawn at a readable size, and none is cut.
  await page.locator('.tree-ctl:visible').getByRole('button', { name: 'Zoom in' }).tap();
  await page.locator('.tree-bar:visible').getByRole('button', { name: 'Fit' }).tap();
  expect(await cutAtTheEdges(page)).toEqual([]);
  const sizes = await svg.evaluate((el) =>
    [...el.querySelectorAll('.tnode-name, .tnode-years')]
      .map((t) => t.getBoundingClientRect().height)
      .filter((h) => h > 0),
  );
  expect(sizes.length).toBeGreaterThan(0);
  for (const h of sizes) expect(h).toBeGreaterThanOrEqual(9);
  expect(r.width).toBeGreaterThan(300);
});

test('PH-33 a tap on a person raises their sheet: name, years, links, Open; Open and back keep the pan and zoom', async ({
  page,
}) => {
  webkitOnly();
  await openTree(page);
  // A zoom away from the fitted view, to see it kept.
  await page.locator('.tree-ctl:visible').getByRole('button', { name: 'Zoom in' }).tap();
  const before = await viewOf(page);
  await person(page, 'Daniel Hale').tap();
  const sheet = page.getByTestId('tree-sheet');
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('heading', { name: 'Daniel Hale' })).toBeVisible();
  await expect(sheet.getByTestId('tree-sheet-years')).toHaveText(/1985/);
  await expect(sheet.getByTestId('tree-sheet-state')).toHaveText(/age \d+/);
  await expect(sheet.locator('[data-group="parent"]').getByRole('button')).toHaveCount(2);
  await expect(sheet.locator('[data-group="partner"]')).toContainText('Zhou Lan');
  await expect(sheet.locator('[data-group="child"]')).toContainText('Iris Hale-Zhou');
  // No tree surgery on the phone: no add, remove or link type controls in the sheet.
  await expect(sheet.getByRole('button', { name: /^Add|Remove/ })).toHaveCount(0);
  await expect(sheet.locator('select')).toHaveCount(0);
  // A relative's row selects them in the sheet.
  await sheet.locator('[data-group="partner"]').getByRole('button').first().tap();
  await expect(sheet.getByRole('heading', { name: 'Zhou Lan' })).toBeVisible();
  // Open pushes the person's page; back comes to the tree where it was.
  await sheet.getByTestId('tree-sheet-open').tap();
  await expect(page.locator('[data-testid="character-page"]:visible')).toBeVisible();
  await expect(page.getByTestId('tree-sheet')).toHaveCount(0);
  await page.getByTestId('phone-back').tap();
  await expect(svgOf(page)).toBeVisible();
  expect(await viewOf(page)).toEqual(before);
  await expect(page.getByTestId('tree-sheet')).toHaveCount(0);
});

test('PH-33 PH-35 no + stubs, collapse controls are 44 px targets, and nothing shows only on hover', async ({
  page,
}) => {
  webkitOnly();
  await openTree(page);
  const svg = svgOf(page);
  await expect(svg.locator('[data-stub]')).toHaveCount(0);
  await person(page, 'Peter Hale').tap();
  await expect(page.getByTestId('tree-sheet')).toBeVisible();
  // Still none with a person selected.
  await expect(svg.locator('[data-stub]')).toHaveCount(0);
  await page.goBack();
  await expect(page.getByTestId('tree-sheet')).toHaveCount(0);
  const toggles = svg.locator('.tnode-toggle');
  expect(await toggles.count()).toBeGreaterThan(0);
  for (const t of await toggles.all()) {
    const r = await rectOf(t);
    expect(r.width).toBeGreaterThanOrEqual(44);
    expect(r.height).toBeGreaterThanOrEqual(44);
  }
  // Every control on the screen is drawn without a pointer over it.
  const unseen = await page.locator('.tree-screen:visible').evaluate((root) =>
    [...root.querySelectorAll('button, [role="button"]')]
      .filter((el) => {
        const s = getComputedStyle(el);
        return s.visibility === 'hidden' || Number(s.opacity) === 0;
      })
      .map((el) => el.getAttribute('aria-label') ?? el.textContent),
  );
  expect(unseen).toEqual([]);
  // The tree buttons are thumb-sized.
  for (const b of await page
    .locator('.tree-ctl:visible, .tree-legend:visible')
    .getByRole('button')
    .all()) {
    const r = await rectOf(b);
    expect(r.height).toBeGreaterThanOrEqual(44);
    expect(r.width).toBeGreaterThanOrEqual(44);
  }
  // A tap on a collapse control folds that branch and another brings it back.
  const first = toggles.first();
  const expanded = await first.getAttribute('aria-expanded');
  await first.tap();
  await expect(first).toHaveAttribute('aria-expanded', expanded === 'true' ? 'false' : 'true');
  await expect(page.getByTestId('tree-sheet')).toHaveCount(0);
  await first.tap();
  await expect(first).toHaveAttribute('aria-expanded', expanded ?? 'true');
});

test('PH-36 no instruction text on the tree, its sheet or its legend', async ({ page }) => {
  webkitOnly();
  await openTree(page);
  expect(await instructionLines(page)).toEqual([]);
  await page.locator('.tree-legend:visible').getByRole('button', { name: 'Legend' }).tap();
  expect(await instructionLines(page)).toEqual([]);
  await page.locator('.tree-legend:visible').getByRole('button', { name: 'Hide legend' }).tap();
  await person(page, 'Margaret Hale').tap();
  await expect(page.getByTestId('tree-sheet')).toBeVisible();
  expect(await instructionLines(page)).toEqual([]);
  await page.goBack();
  await page.getByTestId('tree-warn-count').tap();
  await expect(page.getByTestId('tree-sheet')).toBeVisible();
  expect(await instructionLines(page)).toEqual([]);
});

// ---- Chromium: real touch events ----

test('PH-33 one-finger pan moves the canvas and not the page', async ({ page }) => {
  touchOnly();
  await openTree(page);
  const f = await Fingers.on(page);
  const from = await emptyPoint(page);
  const v0 = await viewOf(page);
  const r = await rectOf(svgOf(page));
  const k = v0.w / r.width;
  await f.drag(from, { x: from.x - 60, y: from.y - 90 });
  const v1 = await viewOf(page);
  expect(v1.w).toBeCloseTo(v0.w, 3);
  expect(v1.x - v0.x).toBeCloseTo(60 * k, 0);
  expect(v1.y - v0.y).toBeCloseTo(90 * k, 0);
  expect(await pageState(page)).toEqual({ scrollX: 0, scrollY: 0, scale: 1 });
  await expect(page.getByTestId('tree-sheet')).toHaveCount(0);
});

test('PH-33 a pinch zooms about its midpoint, within limits, and never zooms the page', async ({
  page,
}) => {
  touchOnly();
  await openTree(page);
  const f = await Fingers.on(page);
  const m = await centre(svgOf(page));
  const under = await toView(page, m);
  const v0 = await viewOf(page);
  // Fingers spread from 60 px apart to 150 px: zoom in by 2.5.
  const a0 = { x: m.x - 30, y: m.y };
  const b0 = { x: m.x + 30, y: m.y };
  const a1 = { x: m.x - 75, y: m.y };
  const b1 = { x: m.x + 75, y: m.y };
  await f.down(a0, b0);
  await f.move([a0, b0], [a1, b1]);
  await f.up();
  const v1 = await viewOf(page);
  expect(v1.w).toBeCloseTo(v0.w / 2.5, 0);
  const after = await toView(page, m);
  expect(after.x).toBeCloseTo(under.x, 0);
  expect(after.y).toBeCloseTo(under.y, 0);
  expect(await pageState(page)).toEqual({ scrollX: 0, scrollY: 0, scale: 1 });

  const pinch = async (from: number, to: number) => {
    const p0 = [
      { x: m.x - from / 2, y: m.y },
      { x: m.x + from / 2, y: m.y },
    ];
    const p1 = [
      { x: m.x - to / 2, y: m.y },
      { x: m.x + to / 2, y: m.y },
    ];
    await f.down(...p0);
    await f.move(p0, p1);
    await f.up();
    return (await viewOf(page)).w;
  };
  const svgW = (await rectOf(svgOf(page))).width;
  // Zoom in hard: it stops at three times, and goes no further.
  await pinch(16, 160);
  const inner = await pinch(16, 160);
  expect(await pinch(16, 160)).toBeCloseTo(inner, 3);
  expect(inner).toBeCloseTo(svgW / 3, 0);
  // Zoom out hard: it stops a little past the whole tree.
  await pinch(160, 16);
  const outer = await pinch(160, 16);
  expect(await pinch(160, 16)).toBeCloseTo(outer, 3);
  expect(outer).toBeGreaterThan(v0.w);
  expect(outer).toBeLessThan(v0.w * 5);
  expect(await pageState(page)).toEqual({ scrollX: 0, scrollY: 0, scale: 1 });
});

test('PH-33 a hold lifts a person, a drag moves them to a slot, stored through /rpc, Undo puts them back, and it is kept on reload', async ({
  page,
}) => {
  touchOnly();
  await openTree(page);
  const seen = rpcChannels(page);
  const f = await Fingers.on(page);
  const id = await personId(page, 'Daniel Hale');
  const stored0 = await positions();
  const was = await drawnAt(page, 'Daniel Hale');
  const from = await centre(person(page, 'Daniel Hale').locator('.tnode-box'));
  const k = (await viewOf(page)).w / (await rectOf(svgOf(page))).width;
  // Down a row and to the right, by screen pixels.
  const to = { x: from.x + 40, y: from.y + ROW_H / k };
  await f.down(from);
  await page.waitForTimeout(700);
  // The person is lifted, visibly.
  await expect(person(page, 'Daniel Hale')).toHaveClass(/\blifted\b/);
  await f.move([from], [to], 10);
  await expect(page.getByTestId('tree-zones')).toHaveCount(0);
  await f.up();
  await expect(person(page, 'Daniel Hale')).not.toHaveClass(/\blifted\b/);
  await expect.poll(() => seen.includes('tree.savePositions')).toBe(true);
  await expect.poll(async () => (await positions())[id]?.y).toBe(was.y + ROW_H);
  const stored1 = await positions();
  expect(stored1[id]!.y % ROW_H).toBe(0);
  expect(stored1[id]!.x).not.toBe(was.x);
  // Nobody else moved.
  for (const [other, p] of Object.entries(stored0)) {
    if (other !== id) expect(stored1[other]).toEqual(p);
  }
  // One undo step puts them back, and redo moves them again.
  await page.getByTestId('phone-undo').click();
  await expect.poll(async () => (await positions())[id]).toEqual(stored0[id]);
  await expect.poll(() => drawnAt(page, 'Daniel Hale')).toEqual(was);
  await page.getByTestId('phone-redo').click();
  await expect.poll(async () => (await positions())[id]).toEqual(stored1[id]);
  // Kept on reload.
  await page.reload();
  const open = page.getByRole('button', { name: 'Open Fixture novel' });
  await expect(open.or(svgOf(page))).toBeVisible();
  if (await open.isVisible()) await openTree(page);
  await expect
    .poll(() => drawnAt(page, 'Daniel Hale'))
    .toEqual({
      x: stored1[id]!.x,
      y: stored1[id]!.y,
    });
});

test('PH-33 a drag that starts on a person without the hold pans and moves nobody', async ({
  page,
}) => {
  touchOnly();
  await openTree(page);
  const seen = rpcChannels(page);
  const f = await Fingers.on(page);
  const stored0 = await positions();
  const was = await drawnAt(page, 'Daniel Hale');
  const v0 = await viewOf(page);
  const from = await centre(person(page, 'Daniel Hale').locator('.tnode-box'));
  await f.drag(from, { x: from.x + 70, y: from.y + 40 });
  const v1 = await viewOf(page);
  expect(v1.x).toBeLessThan(v0.x);
  expect(v1.y).toBeLessThan(v0.y);
  expect(await drawnAt(page, 'Daniel Hale')).toEqual(was);
  await expect(person(page, 'Daniel Hale')).not.toHaveClass(/\blifted\b/);
  await page.waitForTimeout(300);
  expect(seen).not.toContain('tree.savePositions');
  expect(await positions()).toEqual(stored0);
  expect(await pageState(page)).toEqual({ scrollX: 0, scrollY: 0, scale: 1 });
  await expect(page.getByTestId('tree-sheet')).toHaveCount(0);
});

test('PH-33 a drop over another person is a move and makes no link; no drop zones show', async ({
  page,
}) => {
  touchOnly();
  await openTree(page);
  const seen = rpcChannels(page);
  const f = await Fingers.on(page);
  const links0 = await linkCount();
  const id = await personId(page, 'Ruth Hale');
  const from = await centre(person(page, 'Ruth Hale').locator('.tnode-box'));
  const to = await centre(person(page, 'Peter Hale').locator('.tnode-box'));
  const ontoAt = await drawnAt(page, 'Peter Hale');
  await f.down(from);
  await page.waitForTimeout(700);
  await expect(person(page, 'Ruth Hale')).toHaveClass(/\blifted\b/);
  await f.move([from], [to], 10);
  // Over another person: no parent, partner or child zones on the phone.
  await expect(page.getByTestId('tree-zones')).toHaveCount(0);
  await expect(page.locator('[data-zone]')).toHaveCount(0);
  await f.up();
  await expect.poll(() => seen.includes('tree.savePositions')).toBe(true);
  await page.waitForTimeout(300);
  expect(seen).not.toContain('entry.create');
  expect(seen).not.toContain('entry.createMany');
  expect(await linkCount()).toBe(links0);
  // A move: they were placed in that row, and the person under them did not move.
  expect((await positions())[id]?.y).toBe(ontoAt.y);
  expect(await drawnAt(page, 'Peter Hale')).toEqual(ontoAt);
  await page.getByTestId('phone-undo').click();
});

test('PH-33 PH-35 zoomed out, the collapse control keeps off the age and goes when it cannot fit; a hold on the card lifts the person', async ({
  page,
}) => {
  touchOnly();
  await openTree(page);
  const f = await Fingers.on(page);
  const m = await centre(svgOf(page));
  /** Each collapse control drawn: its target's size and whether its circle covers the age. */
  const toggles = () =>
    svgOf(page).evaluate((svg) =>
      [...svg.querySelectorAll('.tnode-toggle')].map((t) => {
        const hit = t.querySelector('.tnode-hit')!.getBoundingClientRect();
        const drawn = t.querySelector('circle:not(.tnode-hit)')!.getBoundingClientRect();
        const card = t.closest('.tnode')!;
        const state = card.querySelector('.tnode-state')!.getBoundingClientRect();
        const box = card.querySelector('.tnode-box')!.getBoundingClientRect();
        return {
          name: (card.getAttribute('aria-label') ?? '').split(',')[0],
          hit: Math.min(hit.width, hit.height),
          coversAge: drawn.top < state.bottom - 1 && drawn.left < state.right,
          // How far up the card the target reaches, as a share of its height.
          reach: (box.bottom - Math.max(hit.top, box.top)) / box.height,
        };
      }),
    );
  const pinchOut = async () => {
    const p0 = [
      { x: m.x - 80, y: m.y },
      { x: m.x + 80, y: m.y },
    ];
    const p1 = [
      { x: m.x - 20, y: m.y },
      { x: m.x + 20, y: m.y },
    ];
    await f.down(...p0);
    await f.move(p0, p1);
    await f.up();
  };
  // At every zoom on the way out, a control shown is a whole 44 px target
  // that keeps off the age and to the lower part of its card.
  let last = (await viewOf(page)).w;
  for (let i = 0; i < 6; i++) {
    for (const t of await toggles()) {
      expect(t.hit, t.name).toBeGreaterThanOrEqual(44);
      expect(t.coversAge, t.name).toBe(false);
      expect(t.reach, t.name).toBeLessThanOrEqual(0.75);
    }
    await pinchOut();
    const w = (await viewOf(page)).w;
    if (Math.abs(w - last) < 0.5) break;
    last = w;
  }
  // At the outer limit no 44 px target fits on a card, so the control goes;
  // the person sheet's Collapse branch stands in for it.
  expect(await toggles()).toEqual([]);
  // A hold on the right third of a card, where the control was, lifts that person.
  const card = await rectOf(person(page, 'Margaret Hale').locator('.tnode-box'));
  const right = { x: card.x + (card.width * 5) / 6, y: card.y + card.height * 0.7 };
  const was = await drawnAt(page, 'Margaret Hale');
  await f.down(right);
  await page.waitForTimeout(700);
  await expect(person(page, 'Margaret Hale')).toHaveClass(/\blifted\b/);
  await f.up();
  await expect(person(page, 'Margaret Hale')).not.toHaveClass(/\blifted\b/);
  expect(await drawnAt(page, 'Margaret Hale')).toEqual(was);
});

test('PH-33 PH-35 zoomed out to the limit, a tap on the right of a card opens the person, not a branch', async ({
  page,
}) => {
  webkitOnly();
  await openTree(page);
  const out = page.locator('.tree-ctl:visible').getByRole('button', { name: 'Zoom out' });
  let last = (await viewOf(page)).w;
  for (let i = 0; i < 12; i++) {
    await out.tap();
    const w = (await viewOf(page)).w;
    if (Math.abs(w - last) < 0.5) break;
    last = w;
  }
  await expect(svgOf(page).locator('.tnode-toggle')).toHaveCount(0);
  const card = await rectOf(person(page, 'Margaret Hale').locator('.tnode-box'));
  await page.touchscreen.tap(card.x + (card.width * 5) / 6, card.y + card.height * 0.7);
  const sheet = page.getByTestId('tree-sheet');
  await expect(sheet.getByRole('heading', { name: 'Margaret Hale' })).toBeVisible();
  // The sheet's Collapse branch stands in for the control.
  await sheet.getByRole('button', { name: 'Collapse branch' }).tap();
  await expect(person(page, 'Margaret Hale')).toHaveAttribute('aria-expanded', 'false');
  await sheet.getByRole('button', { name: 'Expand branch' }).tap();
  await expect(person(page, 'Margaret Hale')).toHaveAttribute('aria-expanded', 'true');
});

test('PH-33 a lifted person keeps the finger: the tree holds pointer capture, and a drag over the bottom bar and back still drops in the tree', async ({
  page,
}) => {
  touchOnly();
  await page.addInitScript(() => {
    const w = window as unknown as { lastPointer?: number };
    window.addEventListener('pointerdown', (e) => (w.lastPointer = e.pointerId), true);
  });
  await openTree(page);
  const f = await Fingers.on(page);
  const id = await personId(page, 'Ruth Hale');
  const was = await drawnAt(page, 'Ruth Hale');
  const from = await centre(person(page, 'Ruth Hale').locator('.tnode-box'));
  const k = (await viewOf(page)).w / (await rectOf(svgOf(page))).width;
  const bar = await rectOf(page.getByTestId('phone-bottom-bar'));
  const below = { x: from.x, y: bar.y + bar.height / 2 };
  const to = { x: from.x, y: from.y + ROW_H / k };
  const captured = () =>
    svgOf(page).evaluate((svg) =>
      svg.hasPointerCapture((window as unknown as { lastPointer: number }).lastPointer),
    );
  await f.down(from);
  await page.waitForTimeout(700);
  await expect(person(page, 'Ruth Hale')).toHaveClass(/\blifted\b/);
  expect(await captured()).toBe(true);
  // Out over the bottom bar, where the tabs take taps of their own.
  await f.move([from], [below], 12);
  expect(await captured()).toBe(true);
  await expect(person(page, 'Ruth Hale')).toHaveClass(/\blifted\b/);
  // And back into the tree, one row down from where they were.
  await f.move([below], [to], 12);
  await f.up();
  await expect.poll(async () => (await positions())[id]?.y).toBe(was.y + ROW_H);
  const stored = (await positions())[id]!;
  expect(await drawnAt(page, 'Ruth Hale')).toEqual({ x: stored.x, y: stored.y });
  // No tab changed under the finger, and one undo puts them back.
  await expect(page.getByTestId('workspace')).toHaveAttribute('data-tab', 'people');
  await page.getByTestId('phone-undo').click();
  await expect.poll(() => drawnAt(page, 'Ruth Hale')).toEqual(was);
});

test('PH-33 screens for the record, light and dark', async ({ page }) => {
  webkitOnly();
  test.skip(!process.env.NC_PHONE_SCREENS, 'Set NC_PHONE_SCREENS=1 to save the screens.');
  const dir = join(import.meta.dirname, '../../docs/phone-screens/u4');
  mkdirSync(dir, { recursive: true });
  await openTree(page);
  const shots: [string, () => Promise<void>][] = [
    ['01-tree', async () => {}],
    [
      '02-person-sheet',
      async () => {
        await person(page, 'Daniel Hale').tap();
        await expect(page.getByTestId('tree-sheet')).toBeVisible();
        await page.waitForTimeout(300);
      },
    ],
    [
      '03-legend',
      async () => {
        await page.goBack();
        await page.locator('.tree-legend:visible').getByRole('button', { name: 'Legend' }).tap();
      },
    ],
    [
      '04-fit',
      async () => {
        await page
          .locator('.tree-legend:visible')
          .getByRole('button', { name: 'Hide legend' })
          .tap();
        await page.locator('.tree-bar:visible').getByRole('button', { name: 'Fit' }).tap();
      },
    ],
  ];
  for (const [name, step] of shots) {
    await step();
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.screenshot({ path: join(dir, `${name}-${scheme}.png`) });
    }
  }
});
