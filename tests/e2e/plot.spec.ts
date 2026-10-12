import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { Invoke } from '../helpers/t5';
import { readFixture } from '../helpers/loadFixture';
import { field, invokeVia, launch, rail } from './helpers';

let server: MongoMemoryReplSet;
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
  server = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  ({ app, page } = await launch(server.getUri()));
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
  // One arc and two beats so the outline and the beat list have something to show.
  await invoke('entry.create', {
    collection: 'arcs',
    data: {
      title: 'Iris',
      name: 'Iris: coming home',
      scope: 'character',
      ownerCharacterId: 'H5',
      startYear: 2045,
      endYear: 2075,
      status: 'planned',
    },
  });
  const arc = (await invoke('entry.list', { collection: 'arcs', trash: 'exclude' })).entries[0]!;
  await invoke('entry.update', {
    collection: 'chapters',
    id: 'CH2',
    patch: { arcIds: [arc.entry._id] },
  });
  for (const [i, t] of ['The kitchen', 'The song'].entries()) {
    await invoke('entry.create', {
      collection: 'plotBeats',
      data: {
        title: t,
        arcIds: [arc.entry._id],
        chapterId: 'CH2',
        year: 2045,
        arcOrders: [{ arcId: arc.entry._id, order: i + 1 }],
        status: 'planned',
      },
    });
  }
});

test.afterAll(async () => {
  await app?.close();
  await server?.stop();
});

const grid = () => page.getByTestId('outline-grid');
const inspector = () => page.getByTestId('outline-inspector');
const readingOrder = async (id: string) =>
  (await invoke('entry.get', { collection: 'chapters', id })).entry.readingOrder;

test('PL-2 the outline is a chapter-by-year grid with strand marks, an arc span, and the story-time cursor', async () => {
  await rail(page, 'Outline').click();
  await expect(grid()).toBeVisible();
  await expect(grid().getByTestId('outline-label')).toHaveCount(fixture.chapters!.length);
  await expect(grid().locator('.ol-group.book')).toContainText('Tide Lines');
  const two = grid().locator('[data-chapter="CH2"]');
  await expect(two.locator('.ol-mark.primary')).toHaveCount(1);
  await expect(two.locator('.ol-mark.backstory')).toHaveCount(1);
  await expect(two.locator('.ol-arc')).toHaveCount(1);
  await expect(grid().locator('.ol-cursor').first()).toBeVisible();
  await expect(page.getByTestId('outline-time')).toContainText('Story time');
});

test('PL-2 the grid flips to story-year order', async () => {
  await page.getByLabel('Row order').selectOption('story');
  await expect(grid()).toHaveAttribute('data-order', 'story');
  const years = await grid()
    .locator('[data-chapter]')
    .evaluateAll((rows) => rows.map((r) => r.getAttribute('data-chapter')));
  const expected = (await invoke('outline.get', { order: 'story', cursorYear: null })).rows
    .filter((r) => r.kind === 'chapter')
    .map((r) => r.id);
  expect(years).toEqual(expected);
  await page.getByLabel('Row order').selectOption('reading');
});

test('PL-2 PL-4 clicking a row opens the chapter page, and its strand years are editable in the inspector', async () => {
  await grid().locator('[data-chapter="CH2"]').getByTestId('outline-label').click();
  const pageView = inspector().getByTestId('chapter-page');
  await expect(pageView).toContainText('Two Kitchens');
  await expect(pageView.getByTestId('chapter-beats')).toContainText('The kitchen');
  await expect(pageView.getByTestId('chapter-beats')).toContainText('The song');
  await expect(pageView.locator('[data-strand="CH2-present"] [data-character="H5"]')).toContainText(
    'alive, age 14',
  );
  await expect(pageView.getByTestId('chapter-arcs')).toContainText('Iris: coming home');
  // PL-4: places per strand, with the place they sit in.
  await expect(
    pageView.locator('[data-strand="CH2-present"]').getByTestId('chapter-places'),
  ).toContainText('Places: Portland > The Hale house');
  await expect(
    pageView.locator('[data-strand="CH2-backstory"]').getByTestId('chapter-places'),
  ).toContainText('Places: Guangzhou');
  const editor = inspector().getByTestId('editor');
  await field(editor, 'strands.1.startYear').locator(':scope > input').fill('2033');
  await expect(editor.getByTestId('autosave')).toHaveText('Saved');
  const ch = (await invoke('entry.get', { collection: 'chapters', id: 'CH2' })).entry;
  expect(
    (ch.strands as { id: string; startYear: number }[]).find((s) => s.id === 'CH2-backstory')
      ?.startYear,
  ).toBe(2033);
  await expect(
    pageView.locator('[data-strand="CH2-backstory"] [data-character="H5"]'),
  ).toContainText('age 2');
});

test('PL-3 dragging a chapter within its part changes the reading order and no story year; undo restores it', async () => {
  const before = [await readingOrder('CH1'), await readingOrder('CH2')];
  expect(before).toEqual([1, 2]);
  const yearsBefore = JSON.stringify(
    (await invoke('entry.get', { collection: 'chapters', id: 'CH2' })).entry.strands,
  );
  await grid()
    .locator('[data-chapter="CH2"]')
    .getByTestId('outline-label')
    .dragTo(grid().locator('[data-chapter="CH1"]').getByTestId('outline-label'));
  await expect.poll(() => readingOrder('CH2')).toBe(1);
  expect(await readingOrder('CH1')).toBe(2);
  expect(
    JSON.stringify(
      (await invoke('entry.get', { collection: 'chapters', id: 'CH2' })).entry.strands,
    ),
  ).toBe(yearsBefore);
  const labels = grid().getByTestId('outline-label');
  await expect(labels.first()).toContainText('Two Kitchens');
  await inspector().getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(() => readingOrder('CH2')).toBe(2);
  expect(await readingOrder('CH1')).toBe(1);
});

test('PL-4 a chapter in one strand shows its place, and a chapter with none shows no places line', async () => {
  await grid().locator('[data-chapter="CH7"]').getByTestId('outline-label').click();
  await expect(
    inspector().getByTestId('chapter-page').locator('[data-strand="CH7-present"]'),
  ).toContainText('Places: Guangzhou');
  await grid().locator('[data-chapter="CH4"]').getByTestId('outline-label').click();
  await expect(inspector().getByTestId('chapter-page')).toContainText('Chapter 4');
  await expect(inspector().getByTestId('chapter-places')).toHaveCount(0);
  await grid().locator('[data-chapter="CH2"]').getByTestId('outline-label').click();
});

test('PL-3 dragging a chapter into another part gives it the target part and renumbers both parts; undo restores both', async () => {
  const part = async (id: string) =>
    (await invoke('entry.get', { collection: 'chapters', id })).entry.partId;
  expect(await part('CH1')).toBe('PT1');
  const yearsBefore = JSON.stringify(
    (await invoke('entry.get', { collection: 'chapters', id: 'CH1' })).entry.strands,
  );
  await grid()
    .locator('[data-chapter="CH1"]')
    .getByTestId('outline-label')
    .dragTo(grid().locator('[data-chapter="CH6"]').getByTestId('outline-label'));
  await expect.poll(() => part('CH1')).toBe('PT2');
  // It takes the place of the chapter it was dropped on (CH6 was second in part two).
  const order = async () =>
    (await invoke('entry.list', { collection: 'chapters', trash: 'exclude' })).entries
      .map((e) => e.entry)
      .filter((c) => c.partId === 'PT2')
      .sort((a, b) => Number(a.readingOrder) - Number(b.readingOrder))
      .map((c) => c._id);
  expect(await order()).toEqual(['CH5', 'CH1', 'CH6', 'CH7', 'CH8']);
  const first = (await invoke('entry.list', { collection: 'chapters', trash: 'exclude' })).entries
    .map((e) => e.entry)
    .filter((c) => c.partId === 'PT1')
    .sort((a, b) => Number(a.readingOrder) - Number(b.readingOrder))
    .map((c) => c._id);
  expect(first).toEqual(['CH2', 'CH3', 'CH4']);
  expect(
    JSON.stringify(
      (await invoke('entry.get', { collection: 'chapters', id: 'CH1' })).entry.strands,
    ),
  ).toBe(yearsBefore);
  await expect(grid().locator('[data-chapter]').first()).toHaveAttribute('data-chapter', 'CH2');
  await inspector().getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(() => part('CH1')).toBe('PT1');
  expect(await readingOrder('CH1')).toBe(1);
  expect(await readingOrder('CH2')).toBe(2);
  expect(await readingOrder('CH6')).toBe(6);
});

test('KB-3 PL-3 Move to part on the chapter page moves the open chapter to the end of another part; undo moves it back', async () => {
  await grid().locator('[data-chapter="CH4"]').getByTestId('outline-label').click();
  await inspector().getByLabel('Move to part').selectOption({ label: 'Part 2: The Letter' });
  await expect
    .poll(
      async () => (await invoke('entry.get', { collection: 'chapters', id: 'CH4' })).entry.partId,
    )
    .toBe('PT2');
  await expect(inspector().getByLabel('Move to part')).toHaveValue('PT2');
  await expect(grid().locator('[data-part="PT2"]').getByTestId('part-count')).toHaveText(
    '5 chapters',
  );
  await inspector().getByRole('button', { name: 'Undo', exact: true }).click();
  await expect
    .poll(
      async () => (await invoke('entry.get', { collection: 'chapters', id: 'CH4' })).entry.partId,
    )
    .toBe('PT1');
  await grid().locator('[data-chapter="CH2"]').getByTestId('outline-label').click();
});

test('PL-3 the move buttons reorder a chapter and the beat list reorders beats', async () => {
  await inspector().getByRole('button', { name: 'Move earlier in its part' }).click();
  await expect.poll(() => readingOrder('CH2')).toBe(1);
  await inspector().getByRole('button', { name: 'Move later in its part' }).click();
  await expect.poll(() => readingOrder('CH2')).toBe(2);
  const arcs = page.getByTestId('outline-arcs');
  await arcs.locator('summary').click();
  await arcs.getByRole('button', { name: 'Iris: coming home' }).click();
  const beats = inspector().getByTestId('arc-beats');
  const titles = () => beats.locator('.beat-title').allTextContents();
  expect(await titles()).toEqual(['The kitchen', 'The song']);
  await beats.getByRole('button', { name: 'Move The song up' }).click();
  await expect.poll(titles).toEqual(['The song', 'The kitchen']);
  await beats.getByRole('button', { name: 'Move The song down' }).click();
  await expect.poll(titles).toEqual(['The kitchen', 'The song']);
  await inspector().getByRole('button', { name: 'Close the arc' }).click();
});

test('KB-3 a new book, part, chapter and beat are made from the outline, each one undo step', async () => {
  const year = Number(
    ((await page.getByTestId('outline-time').textContent()) ?? '').replace(/\D/g, ''),
  );
  await page.getByRole('button', { name: 'New book', exact: true }).click();
  await page.getByTestId('new-book').getByLabel('Book title').fill('Undertow');
  await page.getByTestId('new-book').getByLabel('Book title').press('Enter');
  const book = grid().locator('.ol-group.book').filter({ hasText: 'Undertow' });
  await expect(book).toContainText('Book 2: Undertow');
  await expect(book.getByTestId('book-count')).toHaveText('0 parts');

  await book.getByRole('button', { name: 'New part' }).click();
  await page.getByTestId('new-part').getByLabel('Part title').fill('Slack Water');
  await page.getByRole('button', { name: 'Create part' }).click();
  const part = grid().locator('.ol-group.part').filter({ hasText: 'Slack Water' });
  await expect(part).toContainText('Part 1: Slack Water');
  await expect(part.getByTestId('part-count')).toHaveText('0 chapters');
  await expect(book.getByTestId('book-count')).toHaveText('1 part');

  await part.getByRole('button', { name: 'New chapter' }).click();
  const form = page.getByTestId('new-chapter');
  await form.getByRole('textbox').fill('Salt Marsh');
  await form.getByRole('textbox').press('Enter');
  await expect(part.getByTestId('part-count')).toHaveText('1 chapter');
  const pageView = inspector().getByTestId('chapter-page');
  await expect(pageView).toContainText('Salt Marsh');
  const chapter = (await invoke('entry.list', { collection: 'chapters', trash: 'exclude' })).entries
    .map((e) => e.entry)
    .find((c) => c.title === 'Salt Marsh')!;
  expect(chapter.readingOrder).toBe(9);
  expect(chapter.strands).toEqual([
    expect.objectContaining({ primary: true, startYear: year, endYear: null }),
  ]);
  await expect(grid().locator(`[data-chapter="${chapter._id}"] .ol-mark.primary`)).toHaveCount(1);

  await pageView.getByRole('button', { name: 'New beat' }).click();
  await inspector().getByTestId('new-beat').getByLabel('Beat title').fill('Low water');
  await inspector().getByTestId('new-beat').getByLabel('Beat title').press('Enter');
  await expect(pageView.getByTestId('chapter-beats')).toContainText('Low water');
  const beat = (await invoke('entry.list', { collection: 'plotBeats', trash: 'exclude' })).entries
    .map((e) => e.entry)
    .find((b) => b.title === 'Low water')!;
  expect(beat).toMatchObject({ chapterId: chapter._id, year });

  // Each creation is one undo step: undo takes the beat away and leaves the chapter.
  const history = inspector().getByTestId('undo-history');
  await expect(history.locator('li').first()).toHaveText('Created Low water');
  await inspector().getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(pageView.getByTestId('chapter-beats')).not.toContainText('Low water');
  await expect(pageView).toContainText('Salt Marsh');
  await inspector().getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(pageView.getByTestId('chapter-beats')).toContainText('Low water');
});

test('KB-3 a part heading moves to the trash from its Actions menu after listing what links to it', async () => {
  const part = grid().locator('.ol-group.part').filter({ hasText: 'Slack Water' });
  await part.getByLabel('Actions for Part 1: Slack Water').click();
  await part.getByRole('button', { name: 'Move to trash' }).click();
  const confirm = part.getByRole('dialog', { name: 'Move to trash' });
  await expect(confirm).toContainText('Move Slack Water to the trash?');
  await expect(confirm.getByTestId('linked-count')).toContainText('1 entry links here');
  await confirm.getByRole('button', { name: 'Move to trash' }).click();
  await expect(grid().locator('.ol-group.part').filter({ hasText: 'Slack Water' })).toHaveCount(0);
  await expect(grid().locator('.ol-group.part').filter({ hasText: 'No part' })).toBeVisible();
  await inspector().getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(grid().locator('.ol-group.part').filter({ hasText: 'Slack Water' })).toBeVisible();
});

test('KB-3 a book and a part rename inline: Enter saves, Escape cancels', async () => {
  const idOf = async (collection: 'books' | 'parts', title: string) =>
    (await invoke('entry.list', { collection, trash: 'exclude' })).entries
      .map((e) => e.entry)
      .find((d) => d.title === title)!._id;
  const book = grid().locator(`[data-book="${await idOf('books', 'Undertow')}"]`);
  await book.getByTestId('book-name').click();
  await book.getByLabel('Book title').fill('Riptide');
  await book.getByLabel('Book title').press('Enter');
  await expect(book.getByTestId('book-name')).toHaveText('Book 2: Riptide');
  const part = grid().locator(`[data-part="${await idOf('parts', 'Slack Water')}"]`);
  await part.getByTestId('part-name').click();
  await part.getByLabel('Part title').fill('Never saved');
  await part.getByLabel('Part title').press('Escape');
  await expect(part.getByTestId('part-name')).toHaveText('Part 1: Slack Water');
  await expect(part.getByTestId('part-name')).toBeFocused();
});

test('KB-3 a chapter renames inline in its heading, and undo puts the old title back', async () => {
  await grid().locator('[data-chapter="CH3"]').getByTestId('outline-label').click();
  await inspector().getByTestId('chapter-title').click();
  const input = inspector().getByLabel('Chapter title');
  await input.fill('Wedding Storm');
  await input.press('Enter');
  await expect(grid().locator('[data-chapter="CH3"]')).toContainText('Wedding Storm');
  await expect
    .poll(
      async () => (await invoke('entry.get', { collection: 'chapters', id: 'CH3' })).entry.title,
    )
    .toBe('Wedding Storm');
  await expect(inspector().getByTestId('undo-history').locator('li').first()).toContainText(
    'Wedding Storm',
  );
  await inspector().getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(grid().locator('[data-chapter="CH3"]')).toContainText('Wedding Weather');
  await expect
    .poll(
      async () => (await invoke('entry.get', { collection: 'chapters', id: 'CH3' })).entry.title,
    )
    .toBe('Wedding Weather');
});

test('KB-3 Alt+Down moves a chapter within its part and the reading order persists after reload', async () => {
  const row = grid().locator('[data-chapter="CH1"]').getByTestId('outline-label');
  await row.focus();
  await page.keyboard.press('Alt+ArrowDown');
  await expect.poll(() => readingOrder('CH1')).toBe(2);
  expect(await readingOrder('CH2')).toBe(1);
  await expect(row).toBeFocused();
  // Alt+Down at the end of a part does nothing.
  const last = grid().locator('[data-chapter="CH4"]').getByTestId('outline-label');
  await last.focus();
  await page.keyboard.press('Alt+ArrowDown');
  expect(await readingOrder('CH4')).toBe(4);

  await page.reload();
  await expect(page.getByTestId('workspace')).toBeVisible();
  await rail(page, 'Outline').click();
  await expect(grid().locator('[data-chapter]').first()).toHaveAttribute('data-chapter', 'CH2');
  await expect(grid().locator('[data-chapter]').nth(1)).toHaveAttribute('data-chapter', 'CH1');

  await grid().locator('[data-chapter="CH1"]').getByTestId('outline-label').focus();
  await page.keyboard.press('Alt+ArrowUp');
  await expect.poll(() => readingOrder('CH1')).toBe(1);
  expect(await readingOrder('CH2')).toBe(2);
});

test('KB-3 Alt+Up on a part heading moves the part within its book; undo moves it back', async () => {
  const name = grid().locator('[data-part="PT2"]').getByTestId('part-name');
  await name.focus();
  await page.keyboard.press('Alt+ArrowUp');
  await expect
    .poll(async () => (await invoke('entry.get', { collection: 'parts', id: 'PT2' })).entry.number)
    .toBe(1);
  await expect(grid().locator('.ol-group.part').first()).toHaveAttribute('data-part', 'PT2');
  await expect(name).toBeFocused();
  // Reading order is the chapters' own number and does not change.
  expect(await readingOrder('CH5')).toBe(5);
  await inspector().getByRole('button', { name: 'Undo', exact: true }).click();
  await expect
    .poll(async () => (await invoke('entry.get', { collection: 'parts', id: 'PT2' })).entry.number)
    .toBe(2);
});

test('KB-3 the chapter page edits a strand point of view and characters present, and the row shows it', async () => {
  await grid().locator('[data-chapter="CH4"]').getByTestId('outline-label').click();
  const strand = inspector().locator('[data-strand="CH4-present"]');
  await strand.getByLabel('Point of view').selectOption({ label: 'Iris Hale-Zhou' });
  await strand.getByLabel('Add a character to present').selectOption({ label: 'Iris Hale-Zhou' });
  await expect(inspector().getByTestId('autosave')).toHaveText('Saved');
  await strand.getByRole('button', { name: 'Move Iris Hale-Zhou up in present' }).click();
  await expect(inspector().getByTestId('autosave')).toHaveText('Saved');
  await expect
    .poll(async () => {
      const ch = (await invoke('entry.get', { collection: 'chapters', id: 'CH4' })).entry;
      const s = (ch.strands as { povCharacterId: string; characterIds: string[] }[])[0]!;
      return [s.povCharacterId, s.characterIds];
    })
    .toEqual(['H5', ['H1', 'H2', 'H3', 'H5', 'H4']]);
  // The grid row shows the new point of view and who is present.
  const mark = grid().locator('[data-chapter="CH4"] [data-strand="CH4-present"]');
  await expect(mark).toHaveAttribute('aria-label', /point of view Iris Hale-Zhou/);
  await expect(mark).toHaveAttribute('title', /present: .*Iris Hale-Zhou/);
  // The chapter page shows her age in that strand year.
  await expect(strand.locator('[data-character="H5"]')).toContainText('alive, age 1');
});

test('KB-3 an arc is added and renamed from the Arcs list, its spans light up, and New beat adds a beat to it', async () => {
  const arcs = page.getByTestId('outline-arcs');
  if (!(await arcs.evaluate((d) => (d as HTMLDetailsElement).open))) {
    await arcs.locator('summary').click();
  }
  await arcs.getByRole('button', { name: 'New arc' }).click();
  await arcs.getByLabel('Arc name').fill('Flood years');
  await arcs.getByLabel('Arc name').press('Enter');
  const panel = inspector().getByTestId('arc-panel');
  await expect(panel.getByTestId('arc-name')).toHaveText('Flood years');
  await panel.getByTestId('arc-name').click();
  await panel.getByLabel('Rename the arc').fill('Flood decades');
  await panel.getByLabel('Rename the arc').press('Enter');
  await expect(arcs.getByRole('button', { name: 'Flood decades' })).toBeVisible();
  await panel.getByRole('button', { name: 'New beat' }).click();
  await panel.getByLabel('Beat title').fill('The levee breaks');
  await panel.getByLabel('Beat title').press('Enter');
  await expect(panel.getByTestId('arc-beats')).toContainText('The levee breaks');
  await expect(arcs.locator('li').filter({ hasText: 'Flood decades' })).toContainText('1 beat');

  // Picking the Iris arc lights up its span on Two Kitchens and dims the rest.
  await arcs.getByRole('button', { name: 'Iris: coming home' }).click();
  const iris = (await invoke('entry.list', { collection: 'arcs', trash: 'exclude' })).entries
    .map((e) => e.entry)
    .find((a) => a.name === 'Iris: coming home')!;
  await expect(grid().locator(`[data-chapter="CH2"] [data-arc="${iris._id}"]`)).toHaveClass(
    /\bhl\b/,
  );
  await expect(arcs.getByRole('button', { name: 'Iris: coming home' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await inspector().getByRole('button', { name: 'Close the arc' }).click();
  await expect(grid().locator('.ol-arc.hl')).toHaveCount(0);
});

// ---------- KB-3 fix round: drag, undo, chapter page edits, deletes, reorders ----------

const partOrder = async (partId: string) =>
  (await invoke('entry.list', { collection: 'chapters', trash: 'exclude' })).entries
    .map((e) => e.entry)
    .filter((c) => c.partId === partId)
    .sort((a, b) => Number(a.readingOrder) - Number(b.readingOrder))
    .map((c) => c._id);
const gridOrder = async (partId: string) =>
  (
    await grid()
      .locator('[data-chapter]')
      .evaluateAll((rows) => rows.map((r) => r.getAttribute('data-chapter')))
  ).filter((id) => partId === 'PT1' && ['CH1', 'CH2', 'CH3', 'CH4'].includes(String(id)));
const label = (id: string) => grid().locator(`[data-chapter="${id}"]`).getByTestId('outline-label');
const chapterOf = async (id: string) =>
  (await invoke('entry.get', { collection: 'chapters', id })).entry;
const undoButton = () => inspector().getByRole('button', { name: 'Undo', exact: true });
const firstHistory = () => inspector().getByTestId('undo-history').locator('li').first();

test('KB-3 PL-3 a chapter dragged down lands in the target place, one can reach the last place, and the order persists after reload', async () => {
  expect(await partOrder('PT1')).toEqual(['CH1', 'CH2', 'CH3', 'CH4']);
  // Down onto Wedding Weather: it takes that place, so it lands after Two Kitchens and Wedding Weather.
  await label('CH1').dragTo(label('CH3'));
  await expect.poll(() => partOrder('PT1')).toEqual(['CH2', 'CH3', 'CH1', 'CH4']);
  expect(await readingOrder('CH1')).toBe(3);
  // Down onto the last chapter: the last place.
  await label('CH1').dragTo(label('CH4'));
  await expect.poll(() => partOrder('PT1')).toEqual(['CH2', 'CH3', 'CH4', 'CH1']);
  // A drop on its own part heading moves a chapter to the end of that part.
  await label('CH2').dragTo(grid().locator('[data-part="PT1"]').getByTestId('part-count'));
  await expect.poll(() => partOrder('PT1')).toEqual(['CH3', 'CH4', 'CH1', 'CH2']);
  // Up onto the first chapter: before it.
  await label('CH1').dragTo(label('CH3'));
  await expect.poll(() => partOrder('PT1')).toEqual(['CH1', 'CH3', 'CH4', 'CH2']);
  expect([1, 2, 3, 4]).toEqual(
    await Promise.all(['CH1', 'CH3', 'CH4', 'CH2'].map((id) => readingOrder(id))),
  );

  await page.reload();
  await expect(page.getByTestId('workspace')).toBeVisible();
  await rail(page, 'Outline').click();
  await expect.poll(() => gridOrder('PT1')).toEqual(['CH1', 'CH3', 'CH4', 'CH2']);

  // Put Two Kitchens back in second place for the tests that follow.
  await label('CH2').dragTo(label('CH3'));
  await expect.poll(() => partOrder('PT1')).toEqual(['CH1', 'CH2', 'CH3', 'CH4']);
});

test('KB-3 a new book, a new part and a new chapter are each one undo step, and one Undo restores every reading number a new chapter shifted', async () => {
  const books = async () =>
    (await invoke('entry.list', { collection: 'books', trash: 'exclude' })).entries.map(
      (e) => e.entry.title,
    );
  await page.getByRole('button', { name: 'New book', exact: true }).click();
  await page.getByTestId('new-book').getByLabel('Book title').fill('Scratch Book');
  await page.getByTestId('new-book').getByLabel('Book title').press('Enter');
  await expect(grid().locator('.ol-group.book').filter({ hasText: 'Scratch Book' })).toBeVisible();
  await expect(firstHistory()).toHaveText('Created Scratch Book');
  await undoButton().click();
  await expect(firstHistory()).toHaveText('Undone: Created Scratch Book');
  await expect(grid().locator('.ol-group.book').filter({ hasText: 'Scratch Book' })).toHaveCount(0);
  expect(await books()).not.toContain('Scratch Book');

  await grid().locator('[data-book="BK1"]').getByRole('button', { name: 'New part' }).click();
  await page.getByTestId('new-part').getByLabel('Part title').fill('Scratch Part');
  await page.getByTestId('new-part').getByLabel('Part title').press('Enter');
  await expect(grid().locator('[data-book="BK1"]').getByTestId('book-count')).toHaveText('3 parts');
  await expect(firstHistory()).toHaveText('Created Scratch Part');
  await undoButton().click();
  await expect(firstHistory()).toHaveText('Undone: Created Scratch Part');
  await expect(grid().locator('[data-book="BK1"]').getByTestId('book-count')).toHaveText('2 parts');

  // A chapter added at the end of part one moves every later chapter up by one.
  const ids = ['CH1', 'CH2', 'CH3', 'CH4', 'CH5', 'CH6', 'CH7', 'CH8'];
  const numbers = async () => Promise.all(ids.map((id) => readingOrder(id)));
  const before = await numbers();
  const salt = (await invoke('entry.list', { collection: 'chapters', trash: 'exclude' })).entries
    .map((e) => e.entry)
    .find((c) => c.title === 'Salt Marsh')!;
  const saltBefore = salt.readingOrder;
  await grid().locator('[data-part="PT1"]').getByRole('button', { name: 'New chapter' }).click();
  await page.getByTestId('new-chapter').getByRole('textbox').fill('Interlude');
  await page.getByTestId('new-chapter').getByRole('textbox').press('Enter');
  await expect(inspector().getByTestId('chapter-page')).toContainText('Interlude');
  const interlude = (
    await invoke('entry.list', { collection: 'chapters', trash: 'exclude' })
  ).entries
    .map((e) => e.entry)
    .find((c) => c.title === 'Interlude')!;
  expect(interlude).toMatchObject({ partId: 'PT1', readingOrder: 5 });
  expect(await numbers()).toEqual([1, 2, 3, 4, 6, 7, 8, 9]);
  expect(await readingOrder(salt._id)).toBe(Number(saltBefore) + 1);
  await expect(grid().locator('[data-chapter="CH5"] .ol-no')).toHaveText('6');
  await expect(firstHistory()).toHaveText('Created Interlude');

  await undoButton().click();
  await expect(firstHistory()).toHaveText('Undone: Created Interlude');
  await expect.poll(numbers).toEqual(before);
  expect(await readingOrder(salt._id)).toBe(saltBefore);
  expect((await chapterOf(interlude._id)).deletedAt).toBeTruthy();
  await expect(grid().locator(`[data-chapter="${interlude._id}"]`)).toHaveCount(0);
});

test('KB-3 the chapter page in the outline edits strand label, end year, places, a new strand and the primary choice, arcs, themes and facts in play', async () => {
  const { entry: theme } = await invoke('entry.create', {
    collection: 'themes',
    data: { title: 'Paper', status: 'idea' },
  });
  const iris = (await invoke('entry.list', { collection: 'arcs', trash: 'exclude' })).entries
    .map((e) => e.entry)
    .find((a) => a.name === 'Iris: coming home')!;
  await label('CH6').click();
  const editor = inspector().getByTestId('editor');
  const saved = () => expect(editor.getByTestId('autosave')).toHaveText('Saved');
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
  await saved();
  await expect
    .poll(async () => (await strands())[0])
    .toMatchObject({
      label: 'now',
      startYear: 2045,
      endYear: 2047,
    });
  await expect(grid().locator('[data-chapter="CH6"] [data-strand="CH6-present"]')).toHaveAttribute(
    'aria-label',
    /strand now, 2045 to 2047/,
  );

  // Places: add one, see it on the page, remove it.
  const first = inspector().locator('[data-strand="CH6-present"]');
  await first.getByLabel('Add a place to now').selectOption({ label: 'Portland > The Hale house' });
  await saved();
  await expect.poll(async () => (await strands())[0]!.placeIds).toEqual(['PLC2']);
  await expect(first.getByTestId('chapter-places')).toHaveText('Places: Portland > The Hale house');
  await first.getByRole('button', { name: 'Remove Portland > The Hale house from now' }).click();
  await saved();
  await expect.poll(async () => (await strands())[0]!.placeIds).toEqual([]);
  await expect(first.getByTestId('chapter-places')).toHaveCount(0);

  // A new strand, made primary: the row's filled mark moves to it.
  await editor.getByRole('button', { name: 'Add a strand' }).click();
  await field(editor, 'strands.1.startYear').locator('input').fill('2030');
  await editor.getByTestId('chapter-strand').nth(1).getByLabel('Primary strand').check();
  await saved();
  await expect
    .poll(async () => (await strands()).map((s) => [s.label, s.startYear, s.primary]))
    .toEqual([
      ['now', 2045, false],
      ['backstory', 2030, true],
    ]);
  const added = (await strands())[1]!.id;
  await expect(grid().locator('[data-chapter="CH6"] .ol-mark.primary')).toHaveAttribute(
    'data-strand',
    added,
  );
  await expect(grid().locator('[data-chapter="CH6"] .ol-mark.backstory')).toHaveAttribute(
    'data-strand',
    'CH6-present',
  );
  // Removing it hands the primary choice back to the strand that is left.
  await editor.getByRole('button', { name: 'Remove the strand backstory' }).click();
  await saved();
  await expect
    .poll(async () => (await strands()).map((s) => [s.id, s.primary]))
    .toEqual([['CH6-present', true]]);
  await expect(grid().locator('[data-chapter="CH6"] .ol-mark')).toHaveCount(1);

  // Arcs, themes and facts in play, through the manifest fields.
  await field(editor, 'arcIds').locator('select').selectOption({ label: 'Iris' });
  await saved();
  await expect.poll(async () => (await chapterOf('CH6')).arcIds).toEqual([iris._id]);
  await expect(inspector().getByTestId('chapter-arcs')).toContainText('Iris: coming home');
  await expect(grid().locator(`[data-chapter="CH6"] [data-arc="${iris._id}"]`)).toHaveCount(1);

  await field(editor, 'themeIds').locator('select').selectOption({ label: 'Paper' });
  await saved();
  await expect.poll(async () => (await chapterOf('CH6')).themeIds).toEqual([theme._id]);
  await expect(inspector().getByTestId('chapter-themes')).toContainText('Paper');

  const facts = async () => (await chapterOf('CH6')).factsInPlay;
  const factsBefore = (await facts()) as unknown[];
  await field(editor, 'factsInPlay').getByRole('button', { name: 'Add to Facts in play' }).click();
  const at = factsBefore.length;
  await field(editor, `factsInPlay.${at}.factId`).locator('select').selectOption('F1');
  await field(editor, `factsInPlay.${at}.characterId`).locator('select').selectOption('Z3');
  await field(editor, `factsInPlay.${at}.note`).locator('input').fill('Meiling keeps it quiet.');
  await saved();
  await expect
    .poll(async () => ((await facts()) as unknown[]).at(-1))
    .toEqual({ factId: 'F1', characterId: 'Z3', note: 'Meiling keeps it quiet.' });
  await expect(inspector().getByTestId('chapter-facts')).toContainText(
    'acts on Meiling was engaged before Wei',
  );
});

test('KB-3 a beat, a chapter, a book and an arc move to the trash from the outline after listing what links to them, and Undo brings each back', async () => {
  const salt = (await invoke('entry.list', { collection: 'chapters', trash: 'exclude' })).entries
    .map((e) => e.entry)
    .find((c) => c.title === 'Salt Marsh')!;
  const confirm = () => inspector().getByRole('dialog', { name: 'Move to trash' });

  // A beat, from its editor in the inspector.
  await label(salt._id).click();
  await inspector()
    .getByTestId('chapter-beats')
    .getByRole('button', { name: 'Low water', exact: true })
    .click();
  await inspector().getByRole('button', { name: 'Move to trash' }).click();
  await expect(confirm()).toContainText('Nothing links here.');
  await confirm().getByRole('button', { name: 'Move to trash' }).click();
  await expect(inspector().getByTestId('editor')).toContainText('This entry is in the trash');
  await inspector().getByRole('button', { name: 'Back to the chapter' }).click();
  await expect(inspector().getByTestId('chapter-beats')).not.toContainText('Low water');
  await undoButton().click();
  await expect(inspector().getByTestId('chapter-beats')).toContainText('Low water');

  // The chapter, from its page: the beat in it links here.
  await inspector().getByRole('button', { name: 'Move to trash' }).click();
  await expect(confirm().getByTestId('linked-count')).toHaveText(
    '1 entry links here. Its link is kept and works again if you restore this entry.',
  );
  await expect(confirm()).toContainText('Low water');
  await confirm().getByRole('button', { name: 'Move to trash' }).click();
  await expect(grid().locator(`[data-chapter="${salt._id}"]`)).toHaveCount(0);
  expect((await chapterOf(salt._id)).deletedAt).toBeTruthy();
  await undoButton().click();
  await expect(grid().locator(`[data-chapter="${salt._id}"]`)).toHaveCount(1);

  // A book, from its heading's Actions menu: its part links here.
  const book = grid().locator('.ol-group.book').filter({ hasText: 'Riptide' });
  await book.getByLabel('Actions for Book 2: Riptide').click();
  await book.getByRole('button', { name: 'Move to trash' }).click();
  const bookConfirm = book.getByRole('dialog', { name: 'Move to trash' });
  await expect(bookConfirm.getByTestId('linked-count')).toContainText('1 entry links here');
  await expect(bookConfirm).toContainText('Slack Water');
  await bookConfirm.getByRole('button', { name: 'Move to trash' }).click();
  await expect(grid().locator('.ol-group.book').filter({ hasText: 'Riptide' })).toHaveCount(0);
  await expect(grid().locator('.ol-group.book').filter({ hasText: 'No book' })).toBeVisible();
  await undoButton().click();
  await expect(grid().locator('.ol-group.book').filter({ hasText: 'Riptide' })).toBeVisible();

  // An arc, from its panel: its beat links here; in the trash it says so and offers Restore.
  const arcs = page.getByTestId('outline-arcs');
  if (!(await arcs.evaluate((d) => (d as HTMLDetailsElement).open))) {
    await arcs.locator('summary').click();
  }
  await arcs.getByRole('button', { name: 'Flood decades' }).click();
  await inspector().getByRole('button', { name: 'Move to trash' }).click();
  await expect(confirm().getByTestId('linked-count')).toContainText('1 entry links here');
  await expect(confirm()).toContainText('The levee breaks');
  await confirm().getByRole('button', { name: 'Move to trash' }).click();
  await expect(arcs.getByRole('button', { name: 'Flood decades' })).toHaveCount(0);
  await expect(inspector().getByTestId('arc-panel')).toContainText('This entry is in the trash');
  await expect(inspector().getByRole('button', { name: 'Restore from trash' })).toBeVisible();
  await undoButton().click();
  await expect(arcs.getByRole('button', { name: 'Flood decades' })).toBeVisible();
  await inspector().getByRole('button', { name: 'Close the arc' }).click();
});

test('KB-3 PL-3 beats reorder by dragging in the arc panel', async () => {
  const arcs = page.getByTestId('outline-arcs');
  if (!(await arcs.evaluate((d) => (d as HTMLDetailsElement).open))) {
    await arcs.locator('summary').click();
  }
  await arcs.getByRole('button', { name: 'Iris: coming home' }).click();
  const beats = inspector().getByTestId('arc-beats');
  const titles = () => beats.locator('.beat-title').allTextContents();
  const item = (t: string) => beats.locator('li').filter({ hasText: t });
  expect(await titles()).toEqual(['The kitchen', 'The song']);
  await item('The song').dragTo(item('The kitchen'));
  await expect.poll(titles).toEqual(['The song', 'The kitchen']);
  await item('The song').dragTo(item('The kitchen'));
  await expect.poll(titles).toEqual(['The kitchen', 'The song']);
  await inspector().getByRole('button', { name: 'Close the arc' }).click();
});

test('KB-3 PL-3 beats on the chapter page move with Up and Down and by dragging, in the arc that orders them', async () => {
  const arcId = (await invoke('entry.list', { collection: 'arcs', trash: 'exclude' })).entries
    .map((e) => e.entry)
    .find((a) => a.name === 'Iris: coming home')!._id;
  const stored = async () =>
    (await invoke('entry.list', { collection: 'plotBeats', trash: 'exclude' })).entries
      .map((e) => e.entry)
      .filter((b) => b.chapterId === 'CH2')
      .map((b) => [
        b.title,
        (b.arcOrders as { arcId: string; order: number }[]).find((o) => o.arcId === arcId)?.order,
      ])
      .sort((a, b) => Number(a[1]) - Number(b[1]))
      .map((x) => x[0]);
  await label('CH2').click();
  const beats = inspector().getByTestId('chapter-beats');
  const titles = () => beats.locator('.beat-title').allTextContents();
  expect(await titles()).toEqual(['The kitchen', 'The song']);
  await expect(beats.getByRole('button', { name: 'Move The kitchen up' })).toBeDisabled();
  await beats.getByRole('button', { name: 'Move The song up' }).click();
  await expect.poll(titles).toEqual(['The song', 'The kitchen']);
  expect(await stored()).toEqual(['The song', 'The kitchen']);
  await beats.getByRole('button', { name: 'Move The song down' }).click();
  await expect.poll(titles).toEqual(['The kitchen', 'The song']);
  expect(await stored()).toEqual(['The kitchen', 'The song']);

  const item = (t: string) => beats.locator('li').filter({ hasText: t });
  await item('The song').dragTo(item('The kitchen'));
  await expect.poll(titles).toEqual(['The song', 'The kitchen']);
  expect(await stored()).toEqual(['The song', 'The kitchen']);
  await undoButton().click();
  await expect.poll(titles).toEqual(['The kitchen', 'The song']);
});

test('KB-3 Alt+Down and Alt+Up on a book heading move the book among the books', async () => {
  const riptide = (await invoke('entry.list', { collection: 'books', trash: 'exclude' })).entries
    .map((e) => e.entry)
    .find((b) => b.title === 'Riptide')!;
  const number = async (id: string) =>
    (await invoke('entry.get', { collection: 'books', id })).entry.number;
  const name = grid().locator('[data-book="BK1"]').getByTestId('book-name');
  await name.focus();
  await page.keyboard.press('Alt+ArrowDown');
  await expect.poll(() => number('BK1')).toBe(2);
  expect(await number(riptide._id)).toBe(1);
  await expect(grid().locator('.ol-group.book').first()).toHaveAttribute('data-book', riptide._id);
  await expect(name).toBeFocused();
  await page.keyboard.press('Alt+ArrowUp');
  await expect.poll(() => number('BK1')).toBe(1);
  expect(await number(riptide._id)).toBe(2);
  await expect(grid().locator('.ol-group.book').first()).toHaveAttribute('data-book', 'BK1');
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

test('GL-3 the glossary table, the culture view, and the chapter page show the meaning of Chinese on hover and focus', async () => {
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

  // Chapter page: a place name with Chinese in a strand.
  const { entry: place } = await invoke('entry.create', {
    collection: 'places',
    data: { title: '晓曦楼', status: 'idea' },
  });
  const ch7 = (await invoke('entry.get', { collection: 'chapters', id: 'CH7' })).entry;
  const strands = (ch7.strands as { placeIds: string[] }[]).map((s) => ({
    ...s,
    placeIds: [...s.placeIds, place._id],
  }));
  await invoke('entry.update', { collection: 'chapters', id: 'CH7', patch: { strands } });
  await rail(page, 'Outline').click();
  await grid().locator('[data-chapter="CH7"]').getByTestId('outline-label').click();
  const places = inspector().getByTestId('chapter-places');
  await expect(places).toContainText('Guangzhou');
  const house = places.locator('[data-term="GL1"]');
  await house.focus();
  await expect(house.getByRole('tooltip')).toHaveText('xiǎoxī: dawn light');
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
