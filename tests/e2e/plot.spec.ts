import { expect, test } from '@playwright/test';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { MongoClient } from 'mongodb';
import type { Invoke } from '../helpers/t5';
import { readFixture } from '../helpers/loadFixture';
import { field, fileDb, invokeVia, launch, rail, sectionList } from './helpers';
import type { TestDb } from './helpers';

let db: TestDb;
let app: ElectronApplication;
let page: Page;
let invoke: Invoke;

const SLUG = 'plot-fixture';
const fixture = readFixture();

test.describe.configure({ mode: 'serial' });

function strip(d: Record<string, unknown>): Record<string, unknown> {
  const { createdAt: _c, modifiedAt: _m, ...rest } = d;
  return rest;
}

test.beforeAll(async () => {
  db = fileDb();
  ({ app, page } = await launch(db));
  invoke = invokeVia(page);
  await invoke('bible.create', { slug: SLUG, name: 'Plot fixture' });
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
  // An outline over the fixture's eight chapters: two scenes in chapter 1, two (and a note) in 2, one each after.
  await invoke('sceneOutline.set', { text: OUTLINE.join('\n'), breaks: BREAKS });
});

test.afterAll(async () => {
  await app?.close();
});

/** The fixture outline, one line per entry; chapter 2 holds lines 2 to 4. */
const OUTLINE = [
  '- Mara reads the archive door',
  '- She finds the key',
  '- Two kitchens at dawn',
  '  - the smell of rice',
  '- The kettle',
  '- Wedding in the rain',
  '- The funeral',
  '- Candles lit',
  '- The letter arrives',
  '- Rain in Guangzhou',
  '- Noor',
];
const BREAKS = { CH1: 0, CH2: 2, CH3: 5, CH4: 6, CH5: 7, CH6: 8, CH7: 9, CH8: 10 };

const view = () => page.getByTestId('outline-view');
const section = (id: string) => view().locator(`[data-testid="scene-text"][data-section="${id}"]`);
const bar = (id: string) => view().locator(`[data-testid="chapter-bar"][data-chapter="${id}"]`);
const yearOf = (scene: number) =>
  view().locator(`.sl[data-scene="${scene}"]`).getByTestId('scene-year');
const stored = () => invoke('sceneOutline.get', {});
// A43: Undo and Redo are in the top bar on every screen.
const undo = () => page.getByTestId('top-undo').click();
const redo = () => page.getByTestId('top-redo').click();
const readingOrder = async (id: string) =>
  (await invoke('entry.get', { collection: 'chapters', id })).entry.readingOrder;
const chapterIds = () =>
  view()
    .getByTestId('chapter-bar')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-chapter')));
async function box(l: Locator) {
  const b = await l.boundingBox();
  if (!b) throw new Error('Not on screen.');
  return b;
}
/** The row of a chapter: its text cell, which its bar sits beside. */
const row = (id: string) => view().locator(`[data-row="${id}"] .scene-edit`);
const near = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(6);
const boundary = (upper: string, lower: string) =>
  view().locator(`[data-testid="boundary"][data-upper="${upper}"][data-lower="${lower}"]`);
const lineOf = (key: string, line: number) =>
  view().locator(`[data-row="${key}"] .sl[data-line="${line}"]`);

test('SM-7 A46 the Outline opens on two panels: one bar per chapter in reading order beside its own scenes, a divider between sections, the trash pinned at the top, no menus, no headings in the text or year grid', async () => {
  await rail(page, 'Outline').click();
  await expect(view().getByTestId('chapter-bar')).toHaveCount(fixture.chapters!.length);
  expect(await chapterIds()).toEqual(['CH1', 'CH2', 'CH3', 'CH4', 'CH5', 'CH6', 'CH7', 'CH8']);
  await expect(bar('CH2').getByTestId('chapter-title')).toHaveText('Two Kitchens');
  await expect(bar('CH2')).toContainText('Ch 2');
  // A46: one flat list; the only sign of the parts is a divider where the second one starts.
  await expect(view().getByTestId('chapter-part')).toHaveCount(0);
  await expect(view().getByTestId('divider')).toHaveCount(1);
  await expect(boundary('CH4', 'CH5').getByTestId('divider')).toContainText('Part Two: The Letter');
  await expect(view().getByTestId('boundary')).toHaveCount(7);
  await expect(view().getByText('Actions', { exact: true })).toHaveCount(0);
  await expect(view().getByTestId('scene-trash')).toBeVisible();
  await expect(bar('CH2').getByTestId('chapter-scenes')).toHaveText('2 scenes');
  await expect(bar('CH4').getByTestId('chapter-scenes')).toHaveText('1 scene');
  // Each section holds only its own scene lines; the chapter names are on the bars.
  await expect(section('CH2')).toHaveValue(
    '- Two kitchens at dawn\n  - the smell of rice\n- The kettle',
  );
  await expect(view().getByTestId('scene-count')).toHaveText('10 scenes');
  // The scene numbers run on across the chapters in the gutter.
  await expect(view().locator('.sl[data-scene="3"] .sl-no')).toHaveText('3');
  // Every bar spans exactly the lines of its section, side by side with them.
  for (const id of ['CH1', 'CH2', 'CH8']) {
    const b = await box(bar(id));
    const r = await box(row(id));
    near(b.y, r.y + 3);
    near(b.y + b.height, r.y + r.height - 3);
    expect(b.x).toBeGreaterThan(r.x + r.width - 2);
  }
  // SM-12: the year grid and its toggle are gone.
  await expect(page.getByRole('button', { name: 'Year grid', exact: true })).toHaveCount(0);
  await expect(page.getByTestId('outline-grid')).toHaveCount(0);
});

test('PL-5 the scene text keeps its rules: Enter continues a bullet, Cmd+] and Cmd+[ indent, autosave to Saved, Up carries on into the section above, and the text survives leaving the screen', async () => {
  const eight = section('CH8');
  await eight.click();
  await eight.press('Meta+ArrowDown');
  await eight.press('Enter');
  await eight.pressSequentially('Noor at the window');
  await eight.press('Meta+]');
  await expect(eight).toHaveValue('- Noor\n  - Noor at the window');
  // An indented bullet belongs to the scene above it.
  await expect(view().getByTestId('scene-count')).toHaveText('10 scenes');
  await eight.press('Meta+[');
  await expect(view().getByTestId('scene-count')).toHaveText('11 scenes');
  await expect(bar('CH8').getByTestId('chapter-scenes')).toHaveText('2 scenes');
  await expect(view().getByTestId('scene-autosave')).toHaveText('Saved');
  await expect
    .poll(async () => (await stored()).text)
    .toBe([...OUTLINE, '- Noor at the window'].join('\n'));
  expect((await stored()).breaks).toEqual(BREAKS);
  expect(await stored()).not.toHaveProperty('ranges');
  // Up on the first line carries on into the section above.
  await eight.press('Meta+ArrowUp');
  await eight.press('ArrowUp');
  await expect(section('CH7')).toBeFocused();
  // The text is still there after leaving and coming back.
  await rail(page, 'Characters').click();
  await rail(page, 'Outline').click();
  await expect(section('CH8')).toHaveValue('- Noor\n- Noor at the window');
});

test('SM-5 a year typed in the gutter is stored in years and shown beside the scene; the scene below inherits it faded until it has its own; the first scene shows the chapter year', async () => {
  // Chapter 2 (2045) holds scenes 3 and 4; both show 2045 faded, from the chapter.
  for (const n of [3, 4]) {
    await expect(yearOf(n)).toHaveValue('');
    await expect(yearOf(n)).toHaveAttribute('placeholder', '2045');
    await expect(yearOf(n)).toHaveAttribute('data-own', 'false');
    await expect(yearOf(n)).toHaveClass(/inherited/);
  }
  // A46: focused, an inherited year fills in so it can be edited; left as it was it stays inherited.
  await yearOf(3).click();
  await expect(yearOf(3)).toHaveValue('2045');
  await yearOf(4).click();
  await expect(yearOf(3)).toHaveValue('');
  await expect(yearOf(3)).toHaveAttribute('data-own', 'false');
  await expect(yearOf(4)).toHaveValue('2045');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Backspace');
  await page.keyboard.type('6');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await stored()).years).toEqual({ '4': 2046 });
  await expect(yearOf(4)).toHaveValue('2046');
  await expect(yearOf(4)).toHaveAttribute('data-own', 'true');
  await expect(yearOf(4)).not.toHaveClass(/inherited/);
  // A committed year is one undo step.
  await undo();
  await expect.poll(async () => (await stored()).years).toEqual({});
  await expect(yearOf(4)).toHaveValue('');
  await expect(yearOf(4)).toHaveAttribute('placeholder', '2045');
  await redo();
  await expect.poll(async () => (await stored()).years).toEqual({ '4': 2046 });
  await expect(yearOf(4)).toHaveValue('2046');
  // A new scene below inherits 2046, faded.
  const two = section('CH2');
  await two.click();
  await two.press('Meta+ArrowDown');
  await two.press('Enter');
  await two.pressSequentially('The kettle sings');
  await expect(yearOf(5)).toHaveAttribute('placeholder', '2046');
  await expect(yearOf(5)).toHaveAttribute('data-own', 'false');
  // Given its own year it stops inheriting; cleared, it inherits again.
  await yearOf(5).fill('2050');
  await yearOf(5).press('Enter');
  await expect.poll(async () => (await stored()).years).toEqual({ '4': 2046, '5': 2050 });
  await expect(yearOf(5)).toHaveAttribute('data-own', 'true');
  await yearOf(5).fill('');
  await yearOf(5).press('Enter');
  await expect.poll(async () => (await stored()).years).toEqual({ '4': 2046 });
  await expect(yearOf(5)).toHaveAttribute('placeholder', '2046');
  // Inheritance stops at the next chapter: chapter 3's first scene shows 2029, its own chapter's year.
  await expect(yearOf(6)).toHaveAttribute('placeholder', '2029');
  // The first scene follows its chapter's year at once.
  await bar('CH2').getByTestId('chapter-year').fill('2044');
  await bar('CH2').getByTestId('chapter-year').press('Enter');
  await expect(yearOf(3)).toHaveAttribute('placeholder', '2044');
  await undo();
  await expect(yearOf(3)).toHaveAttribute('placeholder', '2045');
});

/** Drag the line between two chapters to just below `line` of section `key`. */
async function dragLine(upper: string, lower: string, key: string, line: number) {
  const grip = boundary(upper, lower).getByTestId('boundary-grip');
  await grip.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  const g = await box(grip);
  const l = await box(lineOf(key, line));
  await page.mouse.move(g.x + g.width / 3, g.y + g.height / 2);
  await page.mouse.down();
  await page.mouse.move(g.x + g.width / 3, l.y + l.height * 0.85, { steps: 6 });
  await page.mouse.up();
}

/** Drag a bar by its number to a point on the screen. */
async function dragBar(id: string, to: { x?: number; y: number }) {
  const grip = await box(bar(id).locator('.cbar-no'));
  await page.mouse.move(grip.x + 4, grip.y + 4);
  await page.mouse.down();
  await page.mouse.move(to.x ?? grip.x + 4, to.y, { steps: 8 });
  await page.mouse.up();
}

test('A46 dragging the line between two chapters moves lines either way, an indented line too; each drag is one Undo step', async () => {
  // Chapter 1 holds lines 0 and 1; chapter 2 starts at "Two kitchens at dawn".
  await expect(bar('CH2').getByTestId('chapter-scenes')).toHaveText('3 scenes');
  await dragLine('CH1', 'CH2', 'CH2', 0);
  await expect.poll(async () => (await stored()).breaks.CH2).toBe(3);
  await expect(bar('CH1').getByTestId('chapter-scenes')).toHaveText('3 scenes');
  await expect(section('CH1')).toHaveValue(
    '- Mara reads the archive door\n- She finds the key\n- Two kitchens at dawn',
  );
  // The chapter below can start on an indented line; it keeps it, with no scene of its own above.
  await expect(section('CH2')).toHaveValue(
    '  - the smell of rice\n- The kettle\n- The kettle sings',
  );
  await expect(bar('CH2').getByTestId('chapter-scenes')).toHaveText('2 scenes');
  // The years stay on their lines; scene 3 now shows chapter 1's year.
  expect((await stored()).years).toEqual({ '4': 2046 });
  await expect(yearOf(3)).toHaveAttribute('placeholder', '2075');
  near((await box(bar('CH2'))).y, (await box(row('CH2'))).y + 3);
  // A second drag takes the indented line too.
  await dragLine('CH1', 'CH2', 'CH2', 0);
  await expect.poll(async () => (await stored()).breaks.CH2).toBe(4);
  await undo();
  await expect.poll(async () => (await stored()).breaks.CH2).toBe(3);
  await undo();
  await expect.poll(async () => (await stored()).breaks.CH2).toBe(2);
  await expect(bar('CH2').getByTestId('chapter-scenes')).toHaveText('3 scenes');
  await redo();
  await expect.poll(async () => (await stored()).breaks.CH2).toBe(3);
  await undo();
  await expect.poll(async () => (await stored()).breaks.CH2).toBe(2);
  // Upward: chapter 3 takes the last line of chapter 2.
  await dragLine('CH2', 'CH3', 'CH2', 2);
  await expect.poll(async () => (await stored()).breaks.CH3).toBe(5);
  await expect(section('CH3')).toHaveValue('- The kettle sings\n- Wedding in the rain');
  await undo();
  await expect.poll(async () => (await stored()).breaks.CH3).toBe(6);
  // From the keyboard: the line is focusable, and Down and Up move it a line.
  const grip = boundary('CH1', 'CH2').getByTestId('boundary-grip');
  await grip.focus();
  await page.keyboard.press('ArrowDown');
  await expect.poll(async () => (await stored()).breaks.CH2).toBe(3);
  await page.keyboard.press('ArrowUp');
  await expect.poll(async () => (await stored()).breaks.CH2).toBe(2);
});

test('SM-7 dragging a bar below the next bar moves the chapter: its scenes and years move with it and the reading numbers change; one Undo restores both', async () => {
  const before = await stored();
  await bar('CH1').evaluate((el) => el.scrollIntoView({ block: 'center' }));
  const target = await box(bar('CH2'));
  await dragBar('CH1', { y: target.y + target.height * 0.75 });
  await expect.poll(() => readingOrder('CH1')).toBe(2);
  expect(await readingOrder('CH2')).toBe(1);
  await expect.poll(chapterIds).toEqual(['CH2', 'CH1', 'CH3', 'CH4', 'CH5', 'CH6', 'CH7', 'CH8']);
  await expect(bar('CH1')).toContainText('Ch 2');
  await expect
    .poll(async () => (await stored()).text)
    .toBe(
      [
        '- Two kitchens at dawn',
        '  - the smell of rice',
        '- The kettle',
        '- The kettle sings',
        '- Mara reads the archive door',
        '- She finds the key',
        ...OUTLINE.slice(5),
        '- Noor at the window',
      ].join('\n'),
    );
  expect((await stored()).years).toEqual({ '2': 2046 });
  expect((await stored()).breaks).toMatchObject({ CH2: 0, CH1: 4, CH3: 6 });
  await undo();
  await expect.poll(() => readingOrder('CH1')).toBe(1);
  expect(await readingOrder('CH2')).toBe(2);
  await expect.poll(async () => (await stored()).text).toBe(before.text);
  expect((await stored()).years).toEqual(before.years);
  await expect.poll(chapterIds).toEqual(['CH1', 'CH2', 'CH3', 'CH4', 'CH5', 'CH6', 'CH7', 'CH8']);
});

test('SM-7 NF-2 from a focused bar: Up and Down move it past its neighbour, each one Undo step', async () => {
  // Tab goes from a chapter's text to its bar.
  await section('CH3').focus();
  await page.keyboard.press('Tab');
  await expect(bar('CH3')).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect.poll(() => readingOrder('CH3')).toBe(2);
  await expect.poll(chapterIds).toEqual(['CH1', 'CH3', 'CH2', 'CH4', 'CH5', 'CH6', 'CH7', 'CH8']);
  await expect(bar('CH3')).toBeFocused();
  await expect(section('CH3')).toHaveValue('- Wedding in the rain');
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => readingOrder('CH3')).toBe(3);
  await expect(bar('CH3')).toBeFocused();
  await undo();
  await expect.poll(() => readingOrder('CH3')).toBe(2);
  await undo();
  await expect.poll(() => readingOrder('CH3')).toBe(3);
});

test('SM-7 the two panels scroll as one: a bar stays beside its first scene as the outline scrolls', async () => {
  const many = Array.from({ length: 40 }, (_, i) => `- Noor, day ${i + 1}`).join('\n');
  await section('CH8').fill(many);
  await expect(view().getByTestId('scene-autosave')).toHaveText('Saved');
  const scroller = page.getByTestId('outline-scroll');
  await scroller.evaluate((el) => el.scrollTo(0, 0));
  const first = view().locator('[data-row="CH7"] .sl[data-scene]').first();
  const before = { bar: (await box(bar('CH7'))).y, scene: (await box(first)).y };
  near(before.bar, before.scene - 6 + 3);
  await scroller.evaluate((el) => el.scrollTo(0, 400));
  await expect.poll(async () => (await box(first)).y).toBeLessThan(before.scene - 300);
  const after = { bar: (await box(bar('CH7'))).y, scene: (await box(first)).y };
  near(after.bar - after.scene, before.bar - before.scene);
  await scroller.evaluate((el) => el.scrollTo(0, 0));
  await section('CH8').fill('- Noor\n- Noor at the window');
  await expect(view().getByTestId('scene-autosave')).toHaveText('Saved');
});

test('SM-5 PL-5 versions keep the years: restoring an older version brings its years back', async () => {
  // The edits so far share one version; age it so the next edit opens a new one.
  const raw = await new MongoClient(db.uri).connect();
  try {
    await raw
      .db(db.name)
      .collection(`${SLUG}.sceneOutlineVersions`)
      .updateMany(
        {},
        { $set: { at: '2026-01-01T09:00:00.000Z', until: '2026-01-01T09:00:00.000Z' } },
      );
  } finally {
    await raw.close();
  }
  expect((await stored()).years).toEqual({ '4': 2046 });
  await yearOf(4).fill('2047');
  await yearOf(4).press('Enter');
  await expect.poll(async () => (await stored()).years).toEqual({ '4': 2047 });
  const versions = view().getByTestId('scene-versions');
  await versions.locator('summary').click();
  await expect(versions.getByTestId('scene-version')).toHaveCount(2);
  const old = versions.getByTestId('scene-version').nth(1);
  await old.getByRole('button').first().click();
  await expect(versions.locator('textarea')).toHaveValue(/Two kitchens at dawn/);
  await old.getByRole('button', { name: 'Restore this version' }).click();
  await expect(yearOf(4)).toHaveValue('2046');
  expect((await stored()).years).toEqual({ '4': 2046 });
  await expect(versions.getByTestId('scene-version')).toHaveCount(3);
  await versions.locator('summary').click();
});

test('KB-3 A46 New chapter at the foot is one undo step', async () => {
  const foot = view().getByTestId('track-foot');
  const ids = await chapterIds();
  await foot.getByRole('button', { name: 'New chapter', exact: true }).click();
  await expect(view().getByTestId('chapter-bar')).toHaveCount(ids.length + 1);
  const made = view().getByTestId('chapter-bar').last();
  const id = (await made.getAttribute('data-chapter'))!;
  await expect(made.getByTestId('chapter-title')).toHaveText('New chapter');
  expect((await invoke('entry.get', { collection: 'chapters', id })).entry).toMatchObject({
    partId: 'PT2',
    readingOrder: ids.length + 1,
  });
  // Its text takes the focus with one empty scene line, and its break is stored at the end.
  await expect(section(id)).toBeFocused();
  await expect(section(id)).toHaveValue('- ');
  const lines = (await stored()).text.split('\n').length;
  await expect.poll(async () => (await stored()).breaks[id]).toBe(lines);
  await undo();
  await expect(view().getByTestId('chapter-bar')).toHaveCount(ids.length);
  expect((await invoke('entry.get', { collection: 'chapters', id })).entry.deletedAt).toBeTruthy();
  expect(await chapterIds()).toEqual(ids);
});

const chapterOf = async (id: string) =>
  (await invoke('entry.get', { collection: 'chapters', id })).entry;
const partNumber = async (id: string) =>
  (await invoke('entry.get', { collection: 'parts', id })).entry.number;

test('A46 a chapter dragged onto the trash pinned at the top goes, its lines join the chapter above, and Undo brings both back; Delete on a focused bar does the same', async () => {
  // The chapter made and undone above has left the stored outline.
  await expect.poll(async () => Object.keys((await stored()).breaks)).toHaveLength(8);
  const before = await stored();
  const trash = view().getByTestId('scene-trash');
  await expect(trash).toBeVisible();
  await bar('CH4').evaluate((el) => el.scrollIntoView({ block: 'center' }));
  const t = await box(trash);
  await dragBar('CH4', { x: t.x + t.width / 2, y: t.y + t.height / 2 });
  await expect(bar('CH4')).toHaveCount(0);
  await expect(view().getByTestId('scene-done')).toContainText('After the Funeral is in the trash');
  await expect(section('CH3')).toHaveValue('- Wedding in the rain\n- The funeral');
  await expect.poll(async () => Object.keys((await stored()).breaks)).not.toContain('CH4');
  expect((await stored()).text).toBe(before.text);
  expect((await chapterOf('CH4')).deletedAt).toBeTruthy();
  await undo();
  await expect(bar('CH4')).toHaveCount(1);
  await expect(section('CH4')).toHaveValue('- The funeral');
  await expect(section('CH3')).toHaveValue('- Wedding in the rain');
  await expect.poll(async () => (await stored()).breaks).toEqual(before.breaks);
  expect((await stored()).years).toEqual(before.years);
  // Redo trashes it again with its lines handed up, and Undo brings both back once more.
  await redo();
  await expect(bar('CH4')).toHaveCount(0);
  await expect(section('CH3')).toHaveValue('- Wedding in the rain\n- The funeral');
  await undo();
  await expect(bar('CH4')).toHaveCount(1);
  await expect.poll(async () => (await stored()).breaks).toEqual(before.breaks);
  // Delete on a focused bar.
  await bar('CH4').focus();
  await page.keyboard.press('Delete');
  await expect(bar('CH4')).toHaveCount(0);
  await undo();
  await expect(bar('CH4')).toHaveCount(1);
  await expect.poll(async () => (await stored()).breaks).toEqual(before.breaks);
});

test('A46 a bar dragged across a divider joins the section on the other side; Undo puts it back', async () => {
  const lowerOf = () =>
    view()
      .getByTestId('divider')
      .evaluateAll((els) =>
        els.map((e) => e.closest('[data-testid="boundary"]')?.getAttribute('data-lower')),
      );
  expect(await lowerOf()).toEqual(['CH5']);
  // Chapter 4 dropped just under the divider: first in the section below.
  await bar('CH5').evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await dragBar('CH4', { y: (await box(bar('CH5'))).y + 4 });
  await expect.poll(async () => (await chapterOf('CH4')).partId).toBe('PT2');
  await expect.poll(lowerOf).toEqual(['CH4']);
  expect(await chapterIds()).toEqual(['CH1', 'CH2', 'CH3', 'CH4', 'CH5', 'CH6', 'CH7', 'CH8']);
  await expect(section('CH4')).toHaveValue('- The funeral');
  await undo();
  await expect.poll(async () => (await chapterOf('CH4')).partId).toBe('PT1');
  await expect.poll(lowerOf).toEqual(['CH5']);
  // Chapter 5 dropped just over the divider: last in the section above.
  const four = await box(bar('CH4'));
  await dragBar('CH5', { y: four.y + four.height + 2 });
  await expect.poll(async () => (await chapterOf('CH5')).partId).toBe('PT1');
  await expect.poll(lowerOf).toEqual(['CH6']);
  await undo();
  await expect.poll(async () => (await chapterOf('CH5')).partId).toBe('PT2');
  await expect.poll(lowerOf).toEqual(['CH5']);
});

test('A46 a divider is added between two chapters, named in place, and removed; each is one undo step', async () => {
  // + Divider before chapter 3: chapters 3 and 4 start a new section, numbered after part one.
  const line = boundary('CH2', 'CH3');
  await line.hover();
  await line.getByTestId('add-divider').click();
  await expect(view().getByTestId('divider')).toHaveCount(2);
  await expect.poll(async () => (await chapterOf('CH3')).partId).not.toBe('PT1');
  const made = String((await chapterOf('CH3')).partId);
  expect((await chapterOf('CH4')).partId).toBe(made);
  expect(await partNumber(made)).toBe(2);
  expect(await partNumber('PT2')).toBe(3);
  await expect(line.getByTestId('divider-name')).toHaveText('New section');
  // Renamed in place.
  await line.getByTestId('divider-name').click();
  await line.getByLabel('Divider name').fill('Slack Water');
  await line.getByLabel('Divider name').press('Enter');
  await expect
    .poll(async () => (await invoke('entry.get', { collection: 'parts', id: made })).entry.title)
    .toBe('Slack Water');
  await undo();
  await expect(line.getByTestId('divider-name')).toHaveText('New section');
  await undo();
  await expect(view().getByTestId('divider')).toHaveCount(1);
  await expect.poll(async () => (await chapterOf('CH3')).partId).toBe('PT1');
  expect(await partNumber('PT2')).toBe(2);
  expect(
    (await invoke('entry.get', { collection: 'parts', id: made })).entry.deletedAt,
  ).toBeTruthy();
  // × on a divider: the chapters below it join the section above, and its part goes to the trash.
  await boundary('CH4', 'CH5').getByTestId('remove-divider').click();
  await expect(view().getByTestId('divider')).toHaveCount(0);
  await expect.poll(async () => (await chapterOf('CH8')).partId).toBe('PT1');
  expect(
    (await invoke('entry.get', { collection: 'parts', id: 'PT2' })).entry.deletedAt,
  ).toBeTruthy();
  expect(await chapterIds()).toEqual(['CH1', 'CH2', 'CH3', 'CH4', 'CH5', 'CH6', 'CH7', 'CH8']);
  await undo();
  await expect(view().getByTestId('divider')).toHaveCount(1);
  await expect.poll(async () => (await chapterOf('CH5')).partId).toBe('PT2');
  expect((await chapterOf('CH8')).partId).toBe('PT2');
  expect(
    (await invoke('entry.get', { collection: 'parts', id: 'PT2' })).entry.deletedAt,
  ).toBeFalsy();
});

test('KB-3 A40 A43 each chapter bar shows its title, story year and scene count (the bullets of its section), edits the title and the year as one undo step each, and opens the chapter page', async () => {
  // There is no side panel: everything the panel held is on the bar.
  await expect(page.getByTestId('outline-inspector')).toHaveCount(0);
  // The count is the top-level bullets of the chapter's section.
  const bullets = async (id: string) =>
    (await section(id).inputValue()).split('\n').filter((l) => /^[-*•]\s?.*\S/.test(l)).length;
  for (const id of ['CH2', 'CH6']) {
    const n = await bullets(id);
    await expect(bar(id).getByTestId('chapter-scenes')).toHaveText(
      `${n} ${n === 1 ? 'scene' : 'scenes'}`,
    );
  }
  await expect(bar('CH6').getByTestId('chapter-title')).toHaveText('The Letter');
  await expect(bar('CH6').getByTestId('chapter-year')).toHaveValue('2045');
  // The title is renamed in place on the bar and writes on Enter.
  await bar('CH6').getByTestId('chapter-title').click();
  await page.keyboard.press('Meta+a');
  await page.keyboard.type('The Letter, Again');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await chapterOf('CH6')).title).toBe('The Letter, Again');
  await expect(bar('CH6').getByTestId('chapter-title')).toHaveText('The Letter, Again');
  // The year moves the primary strand.
  await bar('CH6').getByTestId('chapter-year').fill('2047');
  await bar('CH6').getByTestId('chapter-year').press('Enter');
  await expect
    .poll(async () => ((await chapterOf('CH6')).strands as { startYear: number }[])[0]!.startYear)
    .toBe(2047);
  // One undo step each (ED-3), from the top bar.
  await undo();
  await expect(bar('CH6').getByTestId('chapter-year')).toHaveValue('2045');
  await undo();
  await expect(bar('CH6').getByTestId('chapter-title')).toHaveText('The Letter');
  // Open on the bar opens the chapter's own page.
  await bar('CH6').getByTestId('chapter-open').click();
  await expect(page.getByTestId('editor')).toHaveAttribute('data-entry-id', 'CH6');
  await expect(page.getByTestId('editor').getByTestId('chapter-strand').first()).toBeVisible();
  await rail(page, 'Outline').click();
  await expect(view()).toBeVisible();
});

/** The chapter's own page, opened from the Chapters list under More (A40). */
async function openChapterPage(id: string) {
  await sectionList(page, 'Chapters');
  const title = String((await chapterOf(id)).title);
  await page
    .getByRole('button', { name: new RegExp(title) })
    .first()
    .click();
  const editor = page.getByTestId('editor');
  await expect(editor).toHaveAttribute('data-entry-id', id);
  return editor;
}
const pageSaved = () =>
  expect(page.getByTestId('editor').getByTestId('autosave')).toHaveText('Saved');

test('KB-3 A40 the chapter page under More edits strand label, end year, places, a new strand and the primary choice', async () => {
  const editor = await openChapterPage('CH6');
  type S = {
    id: string;
    label: string;
    startYear: number;
    endYear: number | null;
    primary: boolean;
    placeIds: string[];
  };
  const strands = async () => (await chapterOf('CH6')).strands as S[];

  await field(editor, 'strands.0.label').locator('input').fill('now');
  await field(editor, 'strands.0.endYear').locator('input').fill('2047');
  await pageSaved();
  await expect
    .poll(async () => (await strands())[0])
    .toMatchObject({ label: 'now', startYear: 2045, endYear: 2047 });

  // Places: add one, see it on the page, remove it.
  const first = editor.locator('[data-strand="CH6-present"]');
  await first.getByLabel('Add a place to now').selectOption({ label: 'Portland > The Hale house' });
  await pageSaved();
  await expect.poll(async () => (await strands())[0]!.placeIds).toEqual(['PLC2']);
  await expect(first.getByTestId('chapter-places')).toHaveText('Places: Portland > The Hale house');
  await first.getByRole('button', { name: 'Remove Portland > The Hale house from now' }).click();
  await pageSaved();
  await expect.poll(async () => (await strands())[0]!.placeIds).toEqual([]);
  await expect(first.getByTestId('chapter-places')).toHaveCount(0);

  // A new strand, made primary: the chapter's story year follows it.
  await editor.getByRole('button', { name: 'Add a strand' }).click();
  await field(editor, 'strands.1.startYear').locator('input').fill('2030');
  await editor.getByTestId('chapter-strand').nth(1).getByLabel('Primary strand').check();
  await pageSaved();
  await expect
    .poll(async () => (await strands()).map((s) => [s.label, s.startYear, s.primary]))
    .toEqual([
      ['now', 2045, false],
      ['backstory', 2030, true],
    ]);
  await rail(page, 'Outline').click();
  await expect(bar('CH6').getByTestId('chapter-year')).toHaveValue('2030');
  // Removing it hands the primary choice back to the strand that is left.
  const again = await openChapterPage('CH6');
  await again.getByRole('button', { name: 'Remove the strand backstory' }).click();
  await pageSaved();
  await expect
    .poll(async () => (await strands()).map((s) => [s.id, s.primary]))
    .toEqual([['CH6-present', true]]);
  await rail(page, 'Outline').click();
  await expect(bar('CH6').getByTestId('chapter-year')).toHaveValue('2045');
});

test('KB-3 A40 the chapter page under More edits a strand point of view and characters present', async () => {
  const editor = await openChapterPage('CH4');
  const strand = editor.locator('[data-strand="CH4-present"]');
  await strand.getByLabel('Point of view').selectOption({ label: 'Iris Hale-Zhou' });
  await strand.getByLabel('Add a character to present').selectOption({ label: 'Iris Hale-Zhou' });
  await pageSaved();
  await strand.getByRole('button', { name: 'Move Iris Hale-Zhou up in present' }).click();
  await pageSaved();
  await expect
    .poll(async () => {
      const ch = await chapterOf('CH4');
      const s = (ch.strands as { povCharacterId: string; characterIds: string[] }[])[0]!;
      return [s.povCharacterId, s.characterIds];
    })
    .toEqual(['H5', ['H1', 'H2', 'H3', 'H5', 'H4']]);
  // The chapter page shows her age in that strand year.
  await expect(strand.locator('[data-character="H5"]')).toContainText('alive, age 1');
  await rail(page, 'Outline').click();
  await expect(view()).toBeVisible();
});

test('SM-7 A46 NF-2 the Outline by keyboard: a scene year, the chapter name on its bar, its story year, Open and the line between chapters', async () => {
  // Shift+Tab from a chapter's text reaches the year field of its last scene, filled in from above.
  await section('CH1').focus();
  await page.keyboard.press('Shift+Tab');
  await expect(yearOf(2)).toBeFocused();
  await expect(yearOf(2)).toHaveValue('2075');
  await page.keyboard.type('2076');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await stored()).years).toEqual({ '1': 2076, '4': 2046 });
  // Tab: the text, then the bar, then the chapter name, renamed in place with Enter.
  await page.keyboard.press('Tab');
  await expect(section('CH1')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(bar('CH1')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(bar('CH1').getByTestId('chapter-title')).toBeFocused();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Meta+a');
  await page.keyboard.type('The Archive Door');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await chapterOf('CH1')).title).toBe('The Archive Door');
  await expect(bar('CH1').getByTestId('chapter-title')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(bar('CH1').getByTestId('chapter-year')).toBeFocused();
  await undo();
  await expect(bar('CH1').getByTestId('chapter-title')).toHaveText("The Archivist's Door");
  // Then Open, then the line under the chapter, which Down moves a line.
  await bar('CH1').getByTestId('chapter-year').focus();
  await page.keyboard.press('Tab');
  await expect(bar('CH1').getByTestId('chapter-open')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(boundary('CH1', 'CH2').getByTestId('boundary-grip')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect.poll(async () => (await stored()).breaks.CH2).toBe(3);
  await undo();
  await expect.poll(async () => (await stored()).breaks.CH2).toBe(2);
});

test("CU-2 A42 a community and the story year's decade list the lines that apply", async () => {
  await rail(page, 'Cultural data').click();
  const view = page.getByTestId('culture-view');
  const line = (id: string) => view.locator(`.cu-line[data-id="${id}"]`);
  await view.getByLabel('Community', { exact: true }).selectOption({ label: 'Guangzhou' });
  const was = (await invoke('storyTime.get', {})).time;
  await invoke('storyTime.set', { time: { year: 2025 } });
  await expect(view.getByTestId('culture-heading')).toHaveText('Guangzhou in the 2020s');
  await expect(line('CU1').getByTestId('line-text')).toHaveValue('Mid-Autumn mooncakes');
  await expect(line('CU1').getByTestId('line-note')).toHaveText(/lotus seed mooncakes/);
  await expect(line('CU2')).toHaveCount(0);
  await invoke('storyTime.set', { time: { year: 2083 } });
  await expect(view.getByTestId('culture-heading')).toHaveText('Guangzhou in the 2080s');
  await expect(line('CU2').getByTestId('line-note')).toHaveText(/Printed mooncakes/);
  await expect(line('CU1')).toHaveCount(0);
  await invoke('storyTime.set', { time: { year: 1975 } });
  await expect(view.locator('.cu-line')).toHaveCount(0);
  await invoke('storyTime.set', { time: was });
});

test('PC-1 the place tree nests places and shows each description for the year', async () => {
  // Portland is a place in the fixture; the district nests inside it.
  await invoke('entry.create', {
    collection: 'places',
    data: {
      title: 'Pearl District',
      parentId: 'PLC1',
      status: 'canon',
      descriptions: [
        { startYear: null, endYear: 2034, text: 'Warehouses by the river.' },
        { startYear: 2035, endYear: null, text: 'Stilt houses above the waterline.' },
      ],
    },
  });
  await rail(page, 'Place tree').click();
  const view = page.getByTestId('places-view');
  await view.getByLabel('Year').fill('2000');
  const child = view.locator('li[data-depth="1"]').filter({ hasText: 'Pearl District' });
  await expect(view.locator('li[data-place="PLC2"]')).toHaveAttribute('data-depth', '1');
  await expect(child).toHaveCount(1);
  await expect(child.getByTestId('place-description')).toContainText('Warehouses by the river.');
  await view.getByLabel('Year').fill('2050');
  await expect(child.getByTestId('place-description')).toContainText('Stilt houses');
  // A43: a picked place opens its editor in place, under its row, and Close puts it away.
  const name = child.getByRole('button', { name: 'Pearl District', exact: true });
  await name.click();
  await expect(name).toHaveAttribute('aria-expanded', 'true');
  const placeEditor = child.getByTestId('place-editor').getByTestId('editor');
  await expect(placeEditor.getByRole('heading', { name: 'Pearl District' })).toBeVisible();
  await expect(page.getByTestId('inspector')).toHaveCount(0);
  await placeEditor.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(view.getByTestId('place-editor')).toHaveCount(0);
  await expect(name).toBeFocused();
});

test('GL-1 a term that breaks the language system is flagged and listed, and the setting changes that', async () => {
  await invoke('entry.create', {
    collection: 'glossaryTerms',
    data: {
      title: '广东',
      characters: '广东',
      language: 'mandarin',
      romanization: 'gwong2dung1',
      status: 'canon',
    },
  });
  await rail(page, 'Romanization').click();
  const view = page.getByTestId('romanization-view');
  await expect(view.getByTestId('romanization-flagged')).toContainText('gwong2dung1');
  await expect(view.getByTestId('romanization-flagged')).toContainText(
    'does not follow Hanyu Pinyin',
  );
  await view.getByLabel('Mandarin').selectOption({ label: 'Jyutping' });
  // Under Jyutping the Pinyin terms are the ones flagged, and gwong2dung1 is not.
  const flagged = view.getByTestId('romanization-flagged');
  await expect(flagged).toContainText('does not follow Jyutping');
  await expect(flagged).not.toContainText('gwong2dung1');
  await view.getByLabel('Mandarin').selectOption({ label: 'Hanyu Pinyin' });
  await expect(view.getByTestId('romanization-flagged')).toBeVisible();
  await sectionList(page, 'Glossary');
  await page.getByTestId('entry-list').getByRole('button', { name: /^广东/ }).click();
  await expect(page.getByTestId('editor').getByTestId('warning-count')).toBeVisible();
  await expect(field(page.getByTestId('editor'), 'romanization')).toContainText(
    'does not follow Hanyu Pinyin',
  );
});

test('GL-3 a name with a term links to it; a run with no term offers Add to glossary', async () => {
  await rail(page, 'Characters').click();
  await page
    .getByTestId('entry-list')
    .getByRole('button', { name: /^Iris Hale-Zhou/ })
    .click();
  const run = page.locator('.char-name').getByTestId('zh').first();
  await run.click();
  await expect(page.getByTestId('editor').getByRole('heading', { name: '晓曦' })).toBeVisible();

  await invoke('entry.create', {
    collection: 'characters',
    data: {
      title: 'Wen Test',
      names: { full: 'Wen Test', chinese: '文测' },
      birth: { year: 1990 },
      status: 'idea',
    },
  });
  await rail(page, 'Characters').click();
  await page
    .getByTestId('entry-list')
    .getByRole('button', { name: /^Wen Test/ })
    .click();
  const bare = page.locator('.char-name').getByTestId('zh').first();
  await expect(bare).not.toHaveAttribute('data-term', /.+/);
  await bare.focus();
  const tip = bare.getByRole('tooltip');
  await expect(tip).toBeVisible();
  await expect(tip).toContainText('Not in the glossary yet.');
  await tip.getByRole('button', { name: 'Add to glossary' }).click();
  await expect(page.getByTestId('editor').getByRole('heading', { name: '文测' })).toBeVisible();
  const terms = await invoke('entry.list', { collection: 'glossaryTerms', trash: 'exclude' });
  expect(terms.entries.some((t) => t.entry.characters === '文测')).toBe(true);
});

test('GL-3 hovering a glossary name in the place tree shows its romanization and meaning', async () => {
  await invoke('entry.create', {
    collection: 'places',
    data: { title: '月饼街', status: 'idea' },
  });
  await rail(page, 'Place tree').click();
  const run = page.getByTestId('places-view').getByTestId('zh').first();
  await run.hover();
  await expect(run.getByRole('tooltip')).toContainText('yuèbǐng: mooncake');
});

test('GL-3 the editor shows a Meaning control on a title with Chinese and a preview of a long text field, both with the glossary meaning on focus', async () => {
  await invoke('entry.create', {
    collection: 'places',
    data: { title: '晓曦的信', body: '她写了晓曦和月饼。\n\n第二段。', status: 'idea' },
  });
  await sectionList(page, 'Places');
  await page
    .getByTestId('entry-list')
    .getByRole('button', { name: /晓曦\s*的信/ })
    .click();
  const editor = page.getByTestId('editor');
  await expect(editor.getByRole('heading', { name: /晓曦\s*的信/ })).toBeVisible();
  // The title field: a small Meaning control shows the card on keyboard focus.
  const title = field(editor, 'title');
  const meaning = title.getByTestId('zh-meaning');
  const card = title.getByRole('tooltip');
  await expect(card).toBeHidden();
  await meaning.focus();
  await expect(card).toBeVisible();
  await expect(card).toContainText('晓曦: xiǎoxī, dawn light');
  await expect(card).toContainText('的信: not in the glossary yet');
  // The long text field keeps its rich text box (A44) and adds a read-only preview with focusable runs.
  const body = field(editor, 'body');
  await expect(body.getByRole('textbox')).toHaveText(/晓曦和月饼/);
  const preview = body.getByTestId('zh-preview');
  await expect(preview).toBeVisible();
  await expect(preview.locator('p')).toHaveCount(2);
  const run = preview.locator('[data-term="GL1"]');
  await expect(run.locator('.zh-chars')).toHaveText('晓曦');
  await run.focus();
  await expect(run.getByRole('tooltip')).toBeVisible();
  await expect(run.getByRole('tooltip')).toHaveText('xiǎoxī: dawn light');
  await preview.locator('[data-term="GL5"]').focus();
  await expect(preview.locator('[data-term="GL5"]').getByRole('tooltip')).toHaveText(
    'yuèbǐng: mooncake',
  );
  // A field with no Chinese shows neither.
  await expect(field(editor, 'sourceNote').getByTestId('zh-preview')).toHaveCount(0);
  await expect(field(editor, 'sourceNote').getByTestId('zh-meaning')).toHaveCount(0);
});

test('GL-3 the glossary table shows the meaning of Chinese on hover and focus', async () => {
  // Glossary table.
  await rail(page, 'Glossary table').click();
  const table = page.getByTestId('glossary-table');
  const row = table.locator('tr[data-term="GL5"]');
  await expect(row).toContainText('yuèbǐng');
  await expect(row).toContainText('mooncake');
  const chars = row.getByTestId('zh').first();
  await chars.focus();
  await expect(chars.getByRole('tooltip')).toHaveText('yuèbǐng: mooncake');
  await chars.blur();
  await chars.hover();
  await expect(chars.getByRole('tooltip')).toBeVisible();
  await page.mouse.move(0, 0);

  // A43: Edit opens the term in a row right under its own, the width of the table.
  const edit = row.getByRole('button', { name: /^Edit / });
  await edit.click();
  await expect(edit).toHaveAttribute('aria-expanded', 'true');
  const under = row.locator('xpath=following-sibling::tr[1]');
  await expect(under.getByTestId('term-editor').getByTestId('editor')).toHaveAttribute(
    'data-entry-id',
    'GL5',
  );
  await under.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(table.getByTestId('term-editor')).toHaveCount(0);

  // A42: the culture lines are plain fields, so the meaning shows on the glossary table and in text, not there.
});

test('GL-1 a system with no checker shows a visible note on the Romanization screen and flags nothing', async () => {
  const { item } = await invoke('lists.addItem', {
    listId: 'romanizationSystems',
    label: 'Wade-Giles',
    parentId: null,
  });
  await rail(page, 'Romanization').click();
  const view = page.getByTestId('romanization-view');
  await expect(view.getByTestId('romanization-no-checker')).toHaveCount(0);
  await view.getByLabel('Mandarin').selectOption({ label: 'Wade-Giles' });
  await expect(view.getByTestId('romanization-no-checker')).toHaveText(
    'No checker for this system; terms are not flagged',
  );
  expect(
    (await invoke('romanization.get', {})).languages.find((l) => l.id === 'mandarin')?.systemId,
  ).toBe(item.id);
  await view.getByLabel('Mandarin').selectOption({ label: 'Hanyu Pinyin' });
  await expect(view.getByTestId('romanization-no-checker')).toHaveCount(0);
});
