import { expect, test } from '@playwright/test';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { MongoClient } from 'mongodb';
import type { Invoke } from '../helpers/t5';
import { readFixture } from '../helpers/loadFixture';
import { field, fileDb, invokeVia, launch, rail } from './helpers';
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
    await invoke('entry.createMany', {
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
const undo = () => view().getByRole('button', { name: 'Undo', exact: true }).click();
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

test('SM-7 the Outline opens on two panels: one bar per chapter in reading order, titled with chapter and part, beside its own scenes, and no headings in the text or year grid', async () => {
  await rail(page, 'Outline').click();
  await expect(view().getByTestId('chapter-bar')).toHaveCount(fixture.chapters!.length);
  expect(await chapterIds()).toEqual(['CH1', 'CH2', 'CH3', 'CH4', 'CH5', 'CH6', 'CH7', 'CH8']);
  await expect(bar('CH2').getByTestId('chapter-title')).toHaveText('Two Kitchens');
  await expect(bar('CH2')).toContainText('Ch 2');
  await expect(bar('CH2').getByTestId('chapter-part')).toContainText('High Water');
  await expect(bar('CH5').getByTestId('chapter-part')).toContainText('The Letter');
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
  await yearOf(4).fill('2046');
  await yearOf(4).press('Enter');
  await expect.poll(async () => (await stored()).years).toEqual({ '4': 2046 });
  await expect(yearOf(4)).toHaveValue('2046');
  await expect(yearOf(4)).toHaveAttribute('data-own', 'true');
  await expect(yearOf(4)).not.toHaveClass(/inherited/);
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

/** Pull a bar's edge to the lower part of a scene's line. */
async function pullTo(id: string, edge: 'bar-start' | 'bar-end', scene: number, at = 0.85) {
  const handle = await box(bar(id).getByTestId(edge));
  const line = await box(view().locator(`.sl[data-scene="${scene}"]`));
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2, line.y + line.height * at, { steps: 6 });
  await page.mouse.up();
}

test("SM-7 pulling a bar's bottom edge down a scene moves the break and the next chapter shrinks; Undo restores it", async () => {
  // Chapter 1 holds scenes 1 and 2, chapter 2 scenes 3 to 5.
  await expect(bar('CH2').getByTestId('chapter-scenes')).toHaveText('3 scenes');
  await pullTo('CH1', 'bar-end', 3);
  await expect.poll(async () => (await stored()).breaks.CH2).toBe(4);
  await expect(bar('CH1').getByTestId('chapter-scenes')).toHaveText('3 scenes');
  await expect(bar('CH2').getByTestId('chapter-scenes')).toHaveText('2 scenes');
  await expect(section('CH1')).toHaveValue(
    '- Mara reads the archive door\n- She finds the key\n- Two kitchens at dawn\n  - the smell of rice',
  );
  // Scene 3 now opens chapter 1, so it shows chapter 1's year; scene 4 keeps its own.
  await expect(yearOf(3)).toHaveAttribute('placeholder', '2075');
  expect((await stored()).years).toEqual({ '4': 2046 });
  // The bars still sit beside their sections.
  near((await box(bar('CH2'))).y, (await box(row('CH2'))).y + 3);
  await undo();
  await expect.poll(async () => (await stored()).breaks.CH2).toBe(2);
  await expect(bar('CH2').getByTestId('chapter-scenes')).toHaveText('3 scenes');
  // The top edge works the same way: chapter 3 starts a scene earlier.
  await pullTo('CH3', 'bar-start', 5, 0.15);
  await expect.poll(async () => (await stored()).breaks.CH3).toBe(5);
  await expect(bar('CH3').getByTestId('chapter-scenes')).toHaveText('2 scenes');
  await undo();
  await expect.poll(async () => (await stored()).breaks.CH3).toBe(6);
});

test('SM-7 dragging a bar past the next bar swaps the chapters: their scenes and years move with them and the reading numbers change; one Undo restores both', async () => {
  const before = await stored();
  const grip = await box(bar('CH1').locator('.cbar-no'));
  const target = await box(bar('CH2'));
  await page.mouse.move(grip.x + 4, grip.y + 4);
  await page.mouse.down();
  await page.mouse.move(grip.x + 4, target.y + target.height / 2, { steps: 8 });
  await page.mouse.up();
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

test('SM-7 NF-2 from a focused bar: Up and Down swap it with its neighbour, Shift with the arrows moves its end, Alt its start, each one Undo step', async () => {
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

  // Shift+Up on chapter 2 hands its last scene to chapter 3; Alt+Down starts it a scene later.
  await bar('CH2').focus();
  await page.keyboard.press('Shift+ArrowUp');
  await expect.poll(async () => (await stored()).breaks.CH3).toBe(5);
  await expect(section('CH3')).toHaveValue('- The kettle sings\n- Wedding in the rain');
  await page.keyboard.press('Alt+ArrowDown');
  await expect.poll(async () => (await stored()).breaks.CH2).toBe(4);
  await expect(bar('CH2').getByTestId('chapter-scenes')).toHaveText('1 scene');
  // Chapter 2 keeps its last scene: neither edge moves further in.
  await page.keyboard.press('Alt+ArrowDown');
  await page.keyboard.press('Shift+ArrowUp');
  await expect(bar('CH2').getByTestId('chapter-scenes')).toHaveText('1 scene');
  expect((await stored()).breaks).toMatchObject({ CH2: 4, CH3: 5 });
  await undo();
  await expect.poll(async () => (await stored()).breaks.CH2).toBe(2);
  await undo();
  await expect.poll(async () => (await stored()).breaks.CH3).toBe(6);
  await expect(bar('CH2').getByTestId('chapter-scenes')).toHaveText('3 scenes');
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

test('SM-7 NF-2 the Outline by keyboard: a scene year, the chapter name on its bar, and its story year are reached and edited from the keyboard', async () => {
  // Shift+Tab from a chapter's text reaches the year field of its last scene.
  await section('CH1').focus();
  await page.keyboard.press('Shift+Tab');
  await expect(yearOf(2)).toBeFocused();
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
  await expect
    .poll(
      async () => (await invoke('entry.get', { collection: 'chapters', id: 'CH1' })).entry.title,
    )
    .toBe('The Archive Door');
  await expect(bar('CH1').getByTestId('chapter-title')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(bar('CH1').getByTestId('chapter-year')).toBeFocused();
  await undo();
  await expect(bar('CH1').getByTestId('chapter-title')).toHaveText("The Archivist's Door");
});

test('CU-2 culture by year lists the entries that apply to a community and year', async () => {
  await rail(page, 'Culture by year').click();
  const view = page.getByTestId('culture-view');
  await view.getByLabel('Community').selectOption({ label: 'Guangzhou' });
  await view.getByLabel('Year').fill('2020');
  await expect(view.getByTestId('culture-results')).toContainText('lotus seed mooncakes');
  await view.getByLabel('Year').fill('2080');
  await expect(view.getByTestId('culture-results')).toContainText('Printed mooncakes');
  await expect(view.getByTestId('culture-results')).not.toContainText('lotus seed');
  await view.getByLabel('Year').fill('1900');
  await expect(view.getByTestId('culture-empty')).toBeVisible();
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
  await rail(page, 'Glossary').click();
  await page.getByTestId('entry-list').getByRole('button', { name: /^广东/ }).click();
  await expect(page.getByTestId('inspector').getByTestId('warning-count')).toBeVisible();
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
      names: { full: 'Wen Test', chinese: '文测', romanization: '' },
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
    collection: 'facts',
    data: { title: '晓曦的信', body: '她写了晓曦和月饼。\n\n第二段。', status: 'idea' },
  });
  await rail(page, 'Facts').click();
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
  // The long text field keeps its text area and adds a read-only preview with focusable runs.
  const body = field(editor, 'body');
  await expect(body.locator('textarea')).toHaveValue(/晓曦和月饼/);
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

test('GL-3 the glossary table and the culture view show the meaning of Chinese on hover and focus', async () => {
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

  // Culture view.
  await invoke('entry.create', {
    collection: 'culturalEntries',
    data: {
      title: '中秋月饼',
      communityId: 'guangzhou',
      startYear: 1980,
      endYear: 2100,
      generationNotes: '外婆 bakes them.',
      status: 'canon',
    },
  });
  await rail(page, 'Culture by year').click();
  const culture = page.getByTestId('culture-view');
  await culture.getByLabel('Community').selectOption({ label: 'Guangzhou' });
  await culture.getByLabel('Year').fill('2020');
  const results = culture.getByTestId('culture-results');
  const moon = results.locator('[data-term="GL5"]').first();
  await moon.focus();
  await expect(moon.getByRole('tooltip')).toHaveText('yuèbǐng: mooncake');
  const gran = results.locator('[data-term="GL4"]').first();
  await gran.focus();
  await expect(gran.getByRole('tooltip')).toHaveText('wàipó: maternal grandmother');
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
