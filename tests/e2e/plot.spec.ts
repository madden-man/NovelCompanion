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
        order: i + 1,
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

test('PL-3 the move buttons reorder a chapter and the beat list reorders beats', async () => {
  await inspector().getByRole('button', { name: 'Move earlier in its part' }).click();
  await expect.poll(() => readingOrder('CH2')).toBe(1);
  await inspector().getByRole('button', { name: 'Move later in its part' }).click();
  await expect.poll(() => readingOrder('CH2')).toBe(2);
  const beats = page.getByTestId('arc-beats');
  await beats.getByLabel('Arc').selectOption({ label: 'Iris' });
  const titles = () => beats.locator('.beat-title').allTextContents();
  expect(await titles()).toEqual(['The kitchen', 'The song']);
  await beats.getByRole('button', { name: 'Move The song up' }).click();
  await expect.poll(titles).toEqual(['The song', 'The kitchen']);
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
  const city = await invoke('entry.create', {
    collection: 'places',
    data: { title: 'Portland', status: 'canon' },
  });
  await invoke('entry.create', {
    collection: 'places',
    data: {
      title: 'Pearl District',
      parentId: city.entry._id,
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
  const child = view.locator('li[data-depth="1"]');
  await expect(child).toContainText('Pearl District');
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
