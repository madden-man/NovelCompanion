import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx';
import type { Invoke } from '../helpers/t5';
import { readFixture } from '../helpers/loadFixture';
import { readSupplement } from '../helpers/briefFixture';
import {
  changes,
  field,
  fileDb,
  fillEditable,
  invokeVia,
  launch,
  openEditable,
  rail,
  screenTab,
  sectionList,
  seedFixture,
} from './helpers';
import { contrast } from '../helpers/contrast';
import type { Rgba } from '../helpers/contrast';
import type { TestDb } from './helpers';

let db: TestDb;
let app: ElectronApplication;
let page: Page;
let invoke: Invoke;

const SLUG = 'sessions';
const fixture = readFixture();
const supplement = readSupplement();
const dir = mkdtempSync(join(tmpdir(), 'nc-e2e-m7-'));
const docPath = join(dir, 'Chapter 6 The Letter.docx');

test.describe.configure({ mode: 'serial' });

function strip(d: Record<string, unknown>): Record<string, unknown> {
  const { createdAt: _c, modifiedAt: _m, ...rest } = d;
  return rest;
}

async function writeDoc(last: string): Promise<void> {
  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({ text: 'The Letter', heading: HeadingLevel.HEADING_1 }),
          new Paragraph({
            children: [
              new TextRun('Iris found the envelope under the '),
              new TextRun({ text: 'attic', italics: true }),
              new TextRun(' boards.'),
            ],
          }),
          new Paragraph({ text: '* * *' }),
          new Paragraph({ text: last }),
        ],
      },
    ],
  });
  writeFileSync(docPath, await Packer.toBuffer(doc));
}

async function start(env: Record<string, string> = {}): Promise<void> {
  ({ app, page } = await launch(db, {
    NOVEL_COMPANION_TEST_PICK_DOCUMENT: docPath,
    ...env,
  }));
  invoke = invokeVia(page);
}

async function openBible(): Promise<void> {
  await invoke('bible.open', { slug: SLUG });
  await expect(page.getByTestId('workspace')).toBeVisible();
}

test.beforeAll(async () => {
  db = fileDb();
  await start();
  await invoke('bible.create', { slug: SLUG, name: 'Sessions' });
  await openBible();
  for (const e of (await invoke('entry.list', { collection: 'eraStates', trash: 'exclude' }))
    .entries) {
    await invoke('entry.delete', { collection: 'eraStates', id: e.entry._id });
  }
  for (const [label, parentId] of [
    ['Robotics', 'technology'],
    ['Energy', 'technology'],
    ['Climate', null],
  ] as const) {
    await invoke('lists.addItem', { listId: 'eventCategories', label, parentId });
  }
  for (const c of Object.keys(fixture)) {
    if (c === 'lists' || !fixture[c]?.length) continue;
    await seedFixture(
      invoke,
      fixture[c]!.map((d) => ({ collection: c as never, data: strip(d) })),
    );
  }
  // The M7 brief supplement: moments, questions, and communities.
  for (const c of ['moments', 'openQuestions']) {
    const docs = supplement.entries[c]!;
    await seedFixture(
      invoke,
      docs.map((d) => {
        const { deletedAt: _d, ...rest } = strip(d);
        return { collection: c as never, data: rest };
      }),
    );
    // Entries in the trash go there the way a person puts them there.
    for (const d of docs.filter((x) => x.deletedAt)) {
      await invoke('entry.delete', { collection: c as never, id: d._id });
    }
  }
  for (const [c, byId] of Object.entries(supplement.patches)) {
    for (const [id, patch] of Object.entries(byId)) {
      await invoke('entry.update', { collection: c as never, id, patch });
    }
  }
  await writeDoc('Daniel said nothing at dinner.');
});

test.afterAll(async () => {
  await app?.evaluate(({ app: electron }) => electron.exit(0)).catch(() => undefined);
});

const writing = () => page.getByTestId('top-writing');
const relevant = () => page.getByTestId('relevant-view');
const strand = (id: string) =>
  relevant().locator(`[data-testid="relevant-strand"][data-strand="${id}"]`);
const groupIds = (scope: ReturnType<Page['locator']>, kind: string) =>
  scope.locator(`[data-testid="sel-group"][data-kind="${kind}"] [data-testid="sel-item"]`);

test('SM-6 SM-11 OQ-1 the app opens on Characters, and Questions lists the open questions', async () => {
  await page.reload();
  await expect(page.getByTestId('workspace')).toBeVisible();
  await expect(page.getByTestId('rail')).toBeVisible();
  await expect(rail(page, 'Characters')).toHaveAttribute('aria-current', 'page');
  await rail(page, 'Questions').click();
  const view = page.getByTestId('questions-view');
  await expect(view.getByRole('heading', { name: 'Questions', level: 2 })).toBeVisible();
  await expect(view.getByLabel('Show questions').locator('option').nth(1)).toHaveText('Open (3)');
  await expect(view.getByTestId('questions-list')).toBeVisible();
  // No inspector column beside the screen.
  await expect(page.getByTestId('inspector')).toHaveCount(0);
});

test('TM-4 picking a chapter strand in Writing moves the story year to that strand year', async () => {
  await writing().selectOption({ label: 'Chapter 2: Two Kitchens, backstory (2032)' });
  await expect(page.getByTestId('top-year')).toHaveValue('2032');
  await expect(page.getByTestId('status-time')).toContainText('Story time 2032');
  await writing().selectOption({ label: 'Chapter 2: Two Kitchens, present (2045)' });
  await expect(page.getByTestId('top-year')).toHaveValue('2045');
  await expect
    .poll(async () => (await invoke('storyTime.get', {})).time)
    .toEqual({ year: 2045, chapterId: 'CH2', strandId: 'CH2-present' });
});

test('SB-1 SB-2 Relevant to Session opens from every screen and shows the selection for the chapter being written, primary strand first', async () => {
  for (const screen of ['Family tree', 'World events', 'Lists', 'Characters']) {
    await rail(page, screen).click();
    await page.getByTestId('top-relevant').click();
    await expect(relevant()).toBeVisible();
  }
  // SB-1: a picked strand is that strand alone. A35: the chapter heads the view.
  await expect(page.getByTestId('relevant-label')).toHaveText('Two Kitchens');
  await expect(relevant().getByTestId('relevant-strand')).toHaveCount(1);
  await expect(strand('CH2-backstory')).toHaveCount(0);
  await expect(strand('CH2-present')).toContainText('writing now');
  await expect(strand('CH2-present')).toContainText('Ch. 2');
  // A35: with no strand picked the primary strand is the scene, and the
  // backstory strand's years are its Backstory section.
  await invoke('storyTime.set', { time: { year: 2045, chapterId: 'CH2' } });
  await expect(page.getByTestId('relevant-label')).toHaveText('Two Kitchens');
  const strands = relevant().getByTestId('relevant-strand');
  await expect(strands).toHaveCount(1);
  await expect(strands.nth(0)).toHaveAttribute('data-strand', 'CH2-present');
  await expect(strand('CH2-present').getByTestId('sel-backstory')).toContainText(
    'Backstory backstory · 2032',
  );
  // SM-10: the characters are tiles: name, age, and point of view. IP-2: the name is a field.
  const ch2Tiles = strand('CH2-present').locator(
    '[data-kind="characters"] [data-testid="sel-item"]',
  );
  await expect(ch2Tiles.getByTestId('tile-name-text')).toHaveText([
    'Daniel Hale',
    'Zhou Lan',
    'Iris Hale-Zhou',
  ]);
  await expect(ch2Tiles.getByTestId('tile-age')).toHaveText(['60', '57', '14']);
  await expect(ch2Tiles.nth(0)).toContainText('point of view');
  // SM-10: the scene note, the tiles, the world events strip, the cultural context; then
  // the backstory of the backstory years (A35), and the rest folded.
  await expect
    .poll(() =>
      strand('CH2-present').evaluate((el) =>
        Array.from(
          el.querySelectorAll(':scope > [data-testid]'),
          (e) => e.getAttribute('data-kind') ?? e.getAttribute('data-testid'),
        ),
      ),
    )
    .toEqual([
      'scene-note',
      'characters',
      'eventsWindow',
      'culture',
      'sel-backstory',
      'relevant-more',
    ]);
  await expect(strand('CH2-present').getByTestId('relevant-more')).not.toHaveAttribute('open');

  // The view follows the Writing picker live.
  await writing().selectOption({ label: 'Chapter 6: The Letter, present (2045)' });
  await expect(page.getByTestId('relevant-label')).toHaveText('The Letter');
  const s = strand('CH6-present');
  await expect(groupIds(s, 'era')).toHaveAttribute('data-id', 'ERA-2040');
  await expect(groupIds(s, 'culture')).toHaveAttribute('data-id', 'CU4');
  // SM-4: world events have no places, so E9 (2072, the Hale house) no longer reaches this chapter.
  await expect(groupIds(s, 'plannedAhead')).toHaveCount(0);
  // A33: the window is a strip of five year columns, 2042 to 2046 around 2045, titles only.
  const strip = s.locator('[data-testid="sel-group"][data-kind="eventsWindow"]');
  await expect(strip.locator('h4')).toHaveText('World events 2042 to 2046 (1)');
  const cols = strip.locator('.we-col');
  await expect(cols).toHaveCount(5);
  await expect(cols.first()).toHaveAttribute('data-year', '2042');
  await expect(cols.last()).toHaveAttribute('data-year', '2046');
  await expect(cols.nth(3)).toHaveAttribute('aria-current', 'date');
  await expect(groupIds(s, 'eventsWindow')).toHaveAttribute('data-id', 'E5');
  // IP-2: the title on the strip is a field, with Open beside it.
  await expect(groupIds(s, 'eventsWindow').getByTestId('event-title-text')).toHaveText(
    'Grid batteries replace the last coal plant in Guangdong',
  );
  await expect(strip).not.toContainText('planned');
  const shared = relevant();
  const ids = async (kind: string, scope = shared) =>
    groupIds(scope, kind).evaluateAll((els) => els.map((e) => e.getAttribute('data-id')));
  // SM-3: the moments of the characters present, up to the story year.
  await expect.poll(() => ids('moments', s)).toEqual(['B4']);
  await expect.poll(() => ids('previousChapters')).toEqual(['CH1', 'CH3', 'CH4', 'CH5']);
  await expect.poll(() => ids('openQuestions')).toEqual(['Q1', 'Q4']);

  // A change anywhere in the bible shows at once.
  const made = (
    await invoke('entry.create', {
      collection: 'moments',
      data: { title: 'Iris paints the attic', status: 'idea', characterId: 'H5', year: 2044 },
    })
  ).entry;
  await expect.poll(() => ids('moments', s)).toEqual([made._id, 'B4']);
  await invoke('entry.delete', { collection: 'moments', id: made._id });
  await expect.poll(() => ids('moments', s)).toEqual(['B4']);

  // SB-5: a moment of the year after the chapter is not backstory; it sits under Planned ahead,
  // never on the world events strip.
  const ahead = (
    await invoke('entry.create', {
      collection: 'moments',
      data: { title: 'Iris answers the letter', status: 'idea', characterId: 'H5', year: 2046 },
    })
  ).entry;
  await expect.poll(() => ids('plannedAhead', s)).toEqual([ahead._id]);
  await expect(groupIds(s, 'plannedAhead')).toContainText('Iris answers the letter');
  await expect.poll(() => ids('moments', s)).toEqual(['B4']);
  await expect(strip.locator(`[data-id="${ahead._id}"]`)).toHaveCount(0);
  await expect(strip.locator('h4')).toHaveText('World events 2042 to 2046 (1)');
  await invoke('entry.delete', { collection: 'moments', id: ahead._id });
  await expect(groupIds(s, 'plannedAhead')).toHaveCount(0);

  // Each item opens its entry.
  // IP-2: a cultural line opens its page from Open; a click on the line edits it in place.
  await groupIds(s, 'culture').getByRole('button', { name: 'Open Flood memorial walk' }).click();
  await expect(page.getByTestId('editor')).toBeVisible();
  await expect(page.getByTestId('editor')).toContainText('Flood memorial walk');
  await page.getByTestId('top-relevant').click();
  await expect(relevant()).toBeVisible();
  await expect(page.getByTestId('top-relevant')).toHaveAttribute('aria-current', 'page');
});

test('SM-10 the scene note saves to chapters.sceneNote over IPC as one undo step, and survives a reload', async () => {
  const note = strand('CH6-present').getByTestId('scene-note');
  const box = note.getByLabel('What happens in this scene');
  await expect(box).toHaveText('');
  await box.fill('Iris climbs to the attic at night and finds the box.');
  await expect(note.getByTestId('autosave')).toHaveText('Saved');
  await expect
    .poll(
      async () =>
        (await invoke('entry.get', { collection: 'chapters', id: 'CH6' })).entry.sceneNote,
    )
    .toBe('Iris climbs to the attic at night and finds the box.');
  // One undo step for the pause, named for the field.
  await expect((await changes(page)).locator('li').first()).toHaveText(
    'Changed What happens in this scene on The Letter',
  );
  await page.keyboard.press('Escape');
  await page.reload();
  await expect(page.getByTestId('workspace')).toBeVisible();
  await page.getByTestId('top-relevant').click();
  await expect(
    strand('CH6-present').getByTestId('scene-note').getByLabel('What happens in this scene'),
  ).toHaveText('Iris climbs to the attic at night and finds the box.');
});

test('SM-10 ED-3 the scene note: typing within a pause is one undo step, typing across a pause is two, and Undo restores the stored note', async () => {
  const note = strand('CH6-present').getByTestId('scene-note');
  const box = note.getByLabel('What happens in this scene');
  // A43: the Changes popover stays open while the box is typed in; it updates as steps land.
  const history = (await changes(page)).locator('li:not(.empty)');
  const stored = async () =>
    (await invoke('entry.get', { collection: 'chapters', id: 'CH6' })).entry.sceneNote;
  const first = 'Iris climbs to the attic at night and finds the box.';
  await expect(box).toHaveText(first);
  const label = 'Changed What happens in this scene on The Letter';

  // Within a pause: a few keys, one save, one step.
  const before = await history.count();
  await box.press('Meta+ArrowRight');
  await page.waitForTimeout(60);
  await box.pressSequentially(' Rain.');
  await expect(note.getByTestId('autosave')).toHaveText('Saved');
  await expect.poll(stored).toBe(`${first} Rain.`);
  await expect(history).toHaveCount(before + 1);
  await expect(history.first()).toHaveText(label);

  // Across a pause: two bursts with a wait longer than the autosave pause between, two steps.
  await box.pressSequentially(' She waits.');
  await expect(note.getByTestId('autosave')).toHaveText('Saved');
  await page.waitForTimeout(1200);
  await box.pressSequentially(' Lan calls.');
  await expect(note.getByTestId('autosave')).toHaveText('Saved');
  await expect.poll(stored).toBe(`${first} Rain. She waits. Lan calls.`);
  await expect(history).toHaveCount(before + 3);
  await expect(history.nth(0)).toHaveText(label);
  await expect(history.nth(1)).toHaveText(label);

  // Undo takes back one pause at a time, in the bible and in the box.
  const undo = page.getByTestId('top-bar').getByRole('button', { name: 'Undo', exact: true });
  await undo.click();
  await expect.poll(stored).toBe(`${first} Rain. She waits.`);
  await expect(box).toHaveText(`${first} Rain. She waits.`);
  await undo.click();
  await expect.poll(stored).toBe(`${first} Rain.`);
  await undo.click();
  await expect.poll(stored).toBe(first);
  await expect(box).toHaveText(first);
});

test('KB-6 SM-6 Cmd+K opens the capture box with the story time on Continuity checker, Cultural data and Backstory, and Escape closes it', async () => {
  const capture = page.getByTestId('capture-box');
  for (const screen of ['Continuity checker', 'Cultural data', 'Backstory']) {
    await rail(page, screen).click();
    await expect(rail(page, screen)).toHaveAttribute('aria-current', 'page');
    await page.keyboard.press('Meta+k');
    await expect(capture).toBeVisible();
    await expect(capture.getByTestId('capture-time')).toContainText('Story time 2045');
    await expect(capture.getByTestId('capture-input')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(capture).toBeHidden();
  }
  await page.getByTestId('top-relevant').click();
});

test('SM-10 the tiles list the chapter characters with Chinese name and age, the point of view first and marked', async () => {
  const tiles = strand('CH6-present').locator('[data-kind="characters"] [data-testid="sel-item"]');
  await expect(tiles).toHaveCount(2);
  await expect(tiles.getByTestId('tile-name-text')).toHaveText(['Iris Hale-Zhou', 'Daniel Hale']);
  await expect(tiles.getByTestId('tile-age')).toHaveText(['14', '60']);
  await expect(tiles.nth(0)).toContainText('point of view');
  await expect(tiles.nth(1)).not.toContainText('point of view');
  await expect(tiles.nth(0).getByTestId('tile-chinese').locator('.zh-chars')).toHaveText('晓曦');
  // IP-2: with no Chinese name the field offers one.
  await expect(tiles.nth(1).getByTestId('tile-chinese')).toHaveText('Add a Chinese name');
  await expect(tiles.nth(0)).toHaveClass(/pov/);
  for (const t of await tiles.getByTestId('tile-toggle').all()) {
    await expect(t).toHaveAttribute('aria-expanded', 'false');
  }
});

test('SM-10 a tile opens to role, description, the three latest moments up to the year and the family; its buttons open the page and Backstory', async () => {
  await invoke('entry.update', {
    collection: 'characters',
    id: 'H5',
    patch: {
      role: 'The daughter who finds the letter.',
      body: 'Quiet, stubborn, draws on everything.',
    },
  });
  const made: string[] = [];
  for (const [title, year] of [
    ['Starts at the river school', 2040],
    ['Learns to make dumplings', 2043],
    ['First year of high school', 2044],
  ] as const) {
    made.push(
      (
        await invoke('entry.create', {
          collection: 'moments',
          data: { title, status: 'idea', characterId: 'H5', year },
        })
      ).entry._id,
    );
  }
  const iris = strand('CH6-present').locator('[data-testid="sel-item"][data-id="H5"]');
  const toggle = iris.getByTestId('tile-toggle');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  const detail = iris.getByTestId('tile-detail');
  await expect(detail.getByTestId('tile-role')).toHaveText('The daughter who finds the letter.');
  await expect(detail.getByTestId('tile-description')).toHaveText(
    'Quiet, stubborn, draws on everything.',
  );
  // The latest three at or before 2045: not 2040, not B5 in 2050. IP-2: year and text are fields.
  await expect(iris.getByTestId('tile-moments').locator('li')).toHaveText([
    /^2043 Learns to make dumplings$/,
    /^2044 First year of high school$/,
    /^2045 Iris finds the letter$/,
  ]);
  await expect(detail.getByTestId('tile-family')).toContainText('Parents: Daniel Hale, Zhou Lan.');
  await expect(detail.getByTestId('tile-family')).toContainText('Partner: Tomas Reyes');
  await expect(detail.getByTestId('tile-family')).not.toContainText('Child');
  // Enter closes it again from the keyboard.
  await toggle.focus();
  await page.keyboard.press('Enter');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(iris.getByTestId('tile-detail')).toHaveCount(0);
  await page.keyboard.press('Enter');
  // IP-2: the family line opens the tree at the person.
  await detail.getByTestId('tile-family').getByRole('button').click();
  await expect(rail(page, 'Family tree')).toHaveAttribute('aria-current', 'page');
  await page.getByTestId('top-relevant').click();
  await iris.getByTestId('tile-toggle').click();
  await iris.getByRole('button', { name: 'Their page' }).click();
  await expect(page.getByTestId('character-page')).toContainText('Iris Hale-Zhou');
  await expect(rail(page, 'Characters')).toHaveAttribute('aria-current', 'page');
  await page.getByTestId('top-relevant').click();
  await iris.getByTestId('tile-toggle').click();
  await iris.getByRole('button', { name: 'Their backstory' }).click();
  await expect(rail(page, 'Backstory')).toHaveAttribute('aria-current', 'page');
  await expect(
    page.getByTestId('backstory-view').locator('.bs-row-label[aria-pressed="true"]'),
  ).toContainText('Iris Hale-Zhou');
  for (const id of made) await invoke('entry.delete', { collection: 'moments', id });
  await invoke('entry.update', {
    collection: 'characters',
    id: 'H5',
    patch: { role: '', body: '' },
  });
});

const undoButton = () =>
  page.getByTestId('top-bar').getByRole('button', { name: 'Undo', exact: true });
const entry = async (collection: string, id: string) =>
  (await invoke('entry.get', { collection: collection as never, id })).entry;
const strandOf = async (chapterId: string, strandId: string) =>
  ((await entry('chapters', chapterId)).strands as Record<string, unknown>[]).find(
    (x) => x.id === strandId,
  )!;
const lastStep = async () => (await changes(page)).locator('li:not(.empty)').first();

test('IP-2 IP-6 the heading renames the chapter and Undo renames it back', async () => {
  await page.getByTestId('top-relevant').click();
  const s = strand('CH6-present');
  // IP-18: a chapter never imported has no Re-import.
  await expect(s.getByTestId('scene-note')).toBeVisible();
  expect((await entry('chapters', 'CH6')).manuscriptSource ?? null).toBeNull();
  await expect(s.getByTestId('reimport')).toHaveCount(0);
  await fillEditable(s.getByTestId('relevant-title'), 'The Letter Home');
  await expect.poll(async () => (await entry('chapters', 'CH6')).title).toBe('The Letter Home');
  await expect(page.getByTestId('relevant-label')).toHaveText('The Letter Home');
  await expect(await lastStep()).toHaveText('Changed Chapter title on The Letter Home');
  await page.keyboard.press('Escape');
  await undoButton().click();
  await expect.poll(async () => (await entry('chapters', 'CH6')).title).toBe('The Letter');
  await expect(page.getByTestId('relevant-label')).toHaveText('The Letter');
});

test('IP-2 the story year and the point of view write the writing strand, and the story time follows the year', async () => {
  const s = strand('CH6-present');
  await fillEditable(s.getByTestId('relevant-year'), '2046');
  await expect.poll(async () => (await strandOf('CH6', 'CH6-present')).startYear).toBe(2046);
  await expect(page.getByTestId('top-year')).toHaveValue('2046');
  await expect(page.getByTestId('status-time')).toContainText('Story time 2046');
  await expect(await lastStep()).toHaveText('Story year of The Letter');
  await page.keyboard.press('Escape');
  await expect(s.getByTestId('tile-age').first()).toHaveText('15');
  await fillEditable(s.getByTestId('relevant-year'), '2045');
  await expect.poll(async () => (await strandOf('CH6', 'CH6-present')).startYear).toBe(2045);
  await expect(page.getByTestId('top-year')).toHaveValue('2045');

  const pov = s.getByTestId('relevant-pov');
  await openEditable(pov);
  await pov.locator('select').selectOption('H3');
  await expect.poll(async () => (await strandOf('CH6', 'CH6-present')).povCharacterId).toBe('H3');
  await expect(pov.locator('.editable-text')).toHaveText('Daniel Hale');
  await expect(await lastStep()).toHaveText('Point of view of The Letter');
  await page.keyboard.press('Escape');
  await undoButton().click();
  await expect.poll(async () => (await strandOf('CH6', 'CH6-present')).povCharacterId).toBe('H5');
  await expect(pov.locator('.editable-text')).toHaveText('Iris Hale-Zhou');
});

test('IP-2 a tile edits name, birth and role in place, and the age follows the birth', async () => {
  const daniel = strand('CH6-present').locator(
    '[data-kind="characters"] [data-testid="sel-item"][data-id="H3"]',
  );
  // IP-1: opening a field on one tile moves nothing: the next tile stays where it was.
  const iris = strand('CH6-present').locator(
    '[data-kind="characters"] [data-testid="sel-item"][data-id="H5"]',
  );
  const box0 = await daniel.boundingBox();
  await openEditable(iris.getByTestId('tile-name'));
  await expect(iris.getByTestId('tile-name').locator('input')).toBeFocused();
  expect(await daniel.boundingBox()).toEqual(box0);
  await page.keyboard.press('Escape');
  await expect(iris.getByTestId('tile-name').locator('input')).toHaveCount(0);
  expect(await daniel.boundingBox()).toEqual(box0);
  // The name is a field on the closed tile; the title follows it.
  await fillEditable(daniel.getByTestId('tile-name'), 'Dan Hale');
  await expect.poll(async () => (await entry('characters', 'H3')).title).toBe('Dan Hale');
  expect((await entry('characters', 'H3')).names).toMatchObject({ full: 'Dan Hale' });
  await expect(daniel.getByTestId('tile-name-text')).toHaveText('Dan Hale');
  await fillEditable(daniel.getByTestId('tile-name'), 'Daniel Hale');
  await expect.poll(async () => (await entry('characters', 'H3')).title).toBe('Daniel Hale');
  // The Chinese name too.
  await fillEditable(daniel.getByTestId('tile-chinese'), '丹尼');
  await expect
    .poll(async () => (await entry('characters', 'H3')).names)
    .toMatchObject({ full: 'Daniel Hale', chinese: '丹尼' });

  // The rest opens under it, without leaving the screen.
  await daniel.getByTestId('tile-toggle').click();
  await fillEditable(daniel.getByTestId('tile-birth'), '1980', 'blur');
  await expect.poll(async () => (await entry('characters', 'H3')).birth).toEqual({ year: 1980 });
  await expect(daniel.getByTestId('tile-age')).toHaveText('65');
  await fillEditable(daniel.getByTestId('tile-birth'), '1985', 'blur');
  await expect(daniel.getByTestId('tile-age')).toHaveText('60');
  await fillEditable(daniel.getByTestId('tile-death'), '2090', 'blur');
  await expect.poll(async () => (await entry('characters', 'H3')).death).toEqual({ year: 2090 });

  // In the story is the A44 box in place: Enter saves.
  await daniel.getByTestId('tile-role').locator('.editable-text').click();
  await expect(daniel.getByTestId('tile-role').getByRole('textbox')).toBeFocused();
  await page.keyboard.type('The father who says nothing.');
  await page.keyboard.press('Enter');
  await expect
    .poll(async () => (await entry('characters', 'H3')).role)
    .toBe('The father who says nothing.');
  await expect(daniel.getByTestId('tile-role')).toHaveText('The father who says nothing.');
  await expect(await lastStep()).toHaveText('Changed In the story on Daniel Hale');
  await page.keyboard.press('Escape');
  // Description, the same box.
  await daniel.getByTestId('tile-description').locator('.editable-text').click();
  await expect(daniel.getByTestId('tile-description').getByRole('textbox')).toBeFocused();
  await page.keyboard.type('Tall, tired, kind.');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await entry('characters', 'H3')).body).toBe('Tall, tired, kind.');
  await expect(daniel.getByTestId('tile-description')).toHaveText('Tall, tired, kind.');
  await invoke('entry.update', {
    collection: 'characters',
    id: 'H3',
    patch: { role: '', body: '', death: null, names: { full: 'Daniel Hale' } },
  });
});

test('IP-2 Add a moment lands at the story year for that person and the tile shows it', async () => {
  const iris = strand('CH6-present').locator(
    '[data-kind="characters"] [data-testid="sel-item"][data-id="H5"]',
  );
  await iris.getByTestId('tile-toggle').click();
  await iris.getByRole('button', { name: 'Add a moment in 2045' }).click();
  const input = iris.getByTestId('tile-moments').locator('input');
  await expect(input).toBeFocused();
  await input.fill('Iris hides the letter');
  await input.press('Enter');
  await expect(input).toHaveCount(0);
  const made = async () =>
    (await invoke('entry.list', { collection: 'moments', trash: 'exclude' })).entries
      .map((e) => e.entry)
      .find((m) => m.title === 'Iris hides the letter');
  await expect.poll(async () => (await made())?.year).toBe(2045);
  expect(await made()).toMatchObject({ characterId: 'H5', year: 2045 });
  await expect(iris.getByTestId('tile-moments')).toContainText('2045 Iris hides the letter');
  // Its year and its text edit in the tile.
  const id = (await made())!._id;
  const row = iris.getByTestId('tile-moments').locator(`li[data-id="${id}"]`);
  await fillEditable(row.locator('[data-field="year"]'), '2044');
  await expect.poll(async () => (await entry('moments', id)).year).toBe(2044);
  await fillEditable(row.locator('[data-field="title"]'), 'Iris hides the letter in a book');
  await expect
    .poll(async () => (await entry('moments', id)).title)
    .toBe('Iris hides the letter in a book');
  await expect(row).toHaveText('2044 Iris hides the letter in a book');
  await invoke('entry.delete', { collection: 'moments', id });
  await iris.getByTestId('tile-toggle').click();
});

test('IP-2 the In this scene chip row adds and removes a character and the tiles follow', async () => {
  const s = strand('CH6-present');
  const row = s.getByTestId('scene-characters');
  const tiles = s.locator('[data-kind="characters"] [data-testid="sel-item"]');
  const present = async () => (await strandOf('CH6', 'CH6-present')).characterIds;
  await row.getByRole('button', { name: 'Add a character to this scene' }).click();
  await row.getByLabel('Character to add to this scene').fill('Zhou Jun');
  await row.getByRole('option', { name: 'Zhou Jun' }).click();
  await expect.poll(present).toEqual(['H5', 'H3', 'Z4']);
  await expect(tiles.locator('[data-testid="tile-name-text"]')).toHaveText([
    'Iris Hale-Zhou',
    'Daniel Hale',
    'Zhou Jun',
  ]);
  await expect(await lastStep()).toHaveText('Added Zhou Jun to The Letter');
  await page.keyboard.press('Escape');
  await row.getByRole('button', { name: 'Remove Zhou Jun from In this scene' }).click();
  await expect.poll(present).toEqual(['H5', 'H3']);
  await expect(tiles).toHaveCount(2);
  await expect(await lastStep()).toHaveText('Removed Zhou Jun from The Letter');
  await page.keyboard.press('Escape');

  // Add new makes the character and adds it, one step; Undo takes both back.
  await row.getByRole('button', { name: 'Add a character to this scene' }).click();
  await row.getByLabel('Character to add to this scene').fill('Mei Lin');
  await row.getByRole('option', { name: 'Add new...' }).click();
  const name = row.getByLabel('Name of the new item for In this scene');
  await name.fill('Mei Lin');
  await name.press('Enter');
  const mei = async () =>
    (await invoke('entry.list', { collection: 'characters', trash: 'exclude' })).entries
      .map((e) => e.entry)
      .find((c) => c.title === 'Mei Lin');
  await expect.poll(async () => (await mei())?._id).toBeTruthy();
  const meiId = (await mei())!._id;
  await expect.poll(present).toEqual(['H5', 'H3', meiId]);
  await expect(tiles).toHaveCount(3);
  await expect(await lastStep()).toHaveText('Added Mei Lin to The Letter');
  await page.keyboard.press('Escape');
  await undoButton().click();
  await expect.poll(present).toEqual(['H5', 'H3']);
  await expect.poll(mei).toBeUndefined();
  await expect(tiles).toHaveCount(2);
});

test('IP-2 Add an event makes an event at the story year with its title typed on the strip', async () => {
  const s = strand('CH6-present');
  const strip = s.locator('[data-testid="sel-group"][data-kind="eventsWindow"]');
  await strip.getByRole('button', { name: 'Add an event in 2045' }).click();
  const input = strip.locator('input');
  await expect(input).toBeFocused();
  await input.fill('Typhoon closes the port');
  await input.press('Enter');
  await expect(input).toHaveCount(0);
  const made = async () =>
    (await invoke('entry.list', { collection: 'worldEvents', trash: 'exclude' })).entries
      .map((e) => e.entry)
      .find((e) => e.title === 'Typhoon closes the port');
  await expect.poll(async () => (await made())?.start).toEqual({ year: 2045 });
  // The first category, and the first status of kind planned.
  const first = (await invoke('lists.get', {})).lists.find((l) => l._id === 'eventCategories')!
    .items[0]!.id;
  expect(await made()).toMatchObject({ categoryId: first, status: 'planned' });
  await expect(
    strip.locator('.we-col[data-year="2045"] [data-testid="event-title-text"]'),
  ).toContainText(['Typhoon closes the port']);
  // A title on the strip edits in place.
  const id = (await made())!._id;
  await fillEditable(
    strip.locator(`[data-testid="sel-item"][data-id="${id}"]`).getByTestId('event-title'),
    'Typhoon shuts the port',
  );
  await expect
    .poll(async () => (await entry('worldEvents', id)).title)
    .toBe('Typhoon shuts the port');
  await invoke('entry.delete', { collection: 'worldEvents', id });
});

test('IP-2 Write it yourself makes a cultural line in the community for the unit and age group all', async () => {
  const s = strand('CH6-present');
  await invoke('entry.delete', { collection: 'culturalEntries', id: 'CU4' });
  const gap = s.getByTestId('culture-gap');
  // The community is labelled as this bible's list has it.
  await expect(gap).toContainText('Nothing covers Portland, Oregon in 2045.');
  await expect(
    gap.getByRole('button', { name: /^Add culture for Portland, Oregon, 2045/ }),
  ).toBeVisible();
  await gap
    .getByRole('button', { name: 'Write a line for Portland, Oregon, 2045 yourself' })
    .click();
  const culture = s.locator('[data-testid="sel-group"][data-kind="culture"]');
  const input = culture.locator('input');
  await expect(input).toBeFocused();
  await input.fill('Rice comes by ration card.');
  await input.press('Enter');
  await expect(input).toHaveCount(0);
  const made = async () =>
    (await invoke('entry.list', { collection: 'culturalEntries', trash: 'exclude' })).entries
      .map((e) => e.entry)
      .find((e) => e.title === 'Rice comes by ration card.');
  await expect.poll(async () => (await made())?.communityId).toBe('portland');
  expect(await made()).toMatchObject({ startYear: 2040, endYear: 2049, demographic: 'all' });
  await expect(culture.getByTestId('culture-line-text')).toHaveText(['Rice comes by ration card.']);
  await invoke('entry.delete', { collection: 'culturalEntries', id: (await made())!._id });
  await invoke('entry.restore', { collection: 'culturalEntries', id: 'CU4' });
  await expect(culture.getByTestId('culture-line-text')).toHaveText(['Flood memorial walk']);
});

test('IP-2 SB-9 More shows no raw IDs, and Remove and Keep work on the desk', async () => {
  const s = strand('CH6-present');
  const more = s.getByTestId('relevant-more');
  await more.locator('summary').click();
  // No raw ID anywhere on the screen.
  const ids = await relevant()
    .locator('[data-id]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-id') ?? ''));
  expect(ids).toContain('CH1');
  const text = await relevant().innerText();
  for (const id of new Set(ids)) expect(text).not.toMatch(new RegExp(`\\b${id}\\b`));
  const prev = more.locator(
    '[data-kind="previousChapters"] [data-testid="sel-item"][data-id="CH1"]',
  );
  const title = (await prev.getByRole('button').first().innerText()).trim();
  await prev.getByRole('button', { name: `Remove ${title}` }).click();
  await expect(prev).toHaveCount(0);
  const left = more.locator('[data-testid="omitted-item"][data-id="CH1"]');
  await expect(left).toContainText('removed by you');
  await left.getByRole('button', { name: `Keep ${title}` }).click();
  await expect(prev).toHaveCount(1);
  await expect(left).toHaveCount(0);
});

test('IP-2 SB-9 removals are forgotten when the section changes', async () => {
  const more = () => strand('CH6-present').getByTestId('relevant-more');
  const prev = () =>
    more().locator('[data-kind="previousChapters"] [data-testid="sel-item"][data-id="CH1"]');
  const left = () => more().locator('[data-testid="omitted-item"][data-id="CH1"]');
  // The desk may still be loading its selection when it opens, so open More until it stays open.
  const openMore = async () => {
    await expect(async () => {
      if ((await more().getAttribute('open')) === null) await more().locator('summary').click();
      await expect(prev().or(left())).toBeVisible({ timeout: 1000 });
    }).toPass({ timeout: 15000 });
  };
  const removeCh1 = async () => {
    const title = (await prev().getByRole('button').first().innerText()).trim();
    await prev()
      .getByRole('button', { name: `Remove ${title}` })
      .click();
    await expect(left()).toContainText('removed by you');
  };
  await page.getByTestId('top-relevant').click();
  await openMore();
  await removeCh1();
  // Another section forgets it.
  await writing().selectOption({ label: 'Chapter 2: Two Kitchens, present (2045)' });
  await expect(page.getByTestId('relevant-label')).toHaveText('Two Kitchens');
  await writing().selectOption({ label: 'Chapter 6: The Letter, present (2045)' });
  await expect(page.getByTestId('relevant-label')).toHaveText('The Letter');
  await openMore();
  await expect(prev()).toHaveCount(1);
  await expect(left()).toHaveCount(0);
});

test('MS-1 MS-2 MS-3 MS-4 MS-5 SM-11 import a chapter from Word, mark it written, approve the summary, promote, and re-import with a diff', async () => {
  // T-3: the recorded Claude drafts the summary, so the app runs with a key held in memory.
  await app.evaluate(({ app: electron }) => electron.exit(0)).catch(() => undefined);
  await start({
    NOVEL_COMPANION_TEST_ANTHROPIC_KEY: 'sk-ant-api03-e2e-session-key-0123456789abcdef',
  });
  await openBible();
  // AI-6: the disclosure was read for this bible (the test below shows it being asked).
  await invoke('claude.acknowledge', {});
  // SM-11: the manuscript is the Continuity checker's second tab.
  await screenTab(page, 'Continuity checker', 'Manuscript');
  const view = page.getByTestId('manuscript-view');
  await view.locator('[data-chapter="CH6"]').click();
  const ch = view.getByTestId('ms-chapter');
  await ch.getByRole('button', { name: 'Import from a Word file' }).click();
  const compare = ch.getByTestId('ms-compare');
  await expect(compare).toContainText('Chapter 6 The Letter.docx');
  await expect(compare.locator('tr[data-kind="added"]')).toHaveText([
    /The Letter/,
    /Iris found the envelope under the attic boards\./,
    /\* \* \*/,
    /Daniel said nothing at dinner\./,
  ]);
  await compare.getByRole('button', { name: 'Apply' }).click();
  await expect(ch.getByTestId('ms-note')).toHaveText(
    'Imported. The summary may be out of date now.',
  );
  await expect(ch.getByTestId('summary-stale')).toBeVisible();
  await expect(ch.getByTestId('ms-source')).toHaveText('Source: Chapter 6 The Letter.docx');
  const stored = (await invoke('entry.get', { collection: 'chapters', id: 'CH6' })).entry;
  expect(stored.manuscriptText).toContain('<em>attic</em>');
  expect(stored.manuscriptSource).toBe(`word:${docPath}`);

  // MS-2, MS-3: mark it written.
  await ch.getByRole('button', { name: 'Mark as written' }).click();
  const flow = ch.getByTestId('written-flow');
  const draft = flow.getByLabel('Summary to approve');
  // The recorded Claude (T-3) drafts it from the imported chapter text.
  await expect(draft).toHaveText(
    'Iris finds an envelope under the attic boards. Daniel says nothing at dinner.',
  );
  expect((await invoke('entry.get', { collection: 'chapters', id: 'CH6' })).entry.summary).toBe(
    'Iris starts asking questions.',
  );
  await draft.fill('Iris finds the letter in the attic.');
  await flow.getByRole('button', { name: 'Approve summary' }).click();
  await expect(flow.getByTestId('summary-done')).toHaveText('Summary saved.');
  await expect(ch.getByTestId('summary-stale')).toHaveCount(0);
  const list = flow.getByTestId('promote-list');
  // SM-3: Iris's planned moment of 2045 is the one this chapter establishes.
  const label = 'Iris finds the letter (a moment of the point of view in these years)';
  await expect(list.locator('label')).toHaveText([label]);
  await list.getByLabel(label).check();
  await flow.getByRole('button', { name: 'Promote checked to canon' }).click();
  await expect(list.locator('label')).toHaveCount(0);
  expect((await invoke('entry.get', { collection: 'moments', id: 'B4' })).entry.status).toBe(
    'canon',
  );

  // MS-4: the file changes; reading it again shows the diff and marks the summary.
  await writeDoc('Daniel left the table before dessert.');
  const bytes = readFileSync(docPath);
  await ch.getByRole('button', { name: 'Read the linked file again' }).click();
  await expect(compare.locator('tr[data-kind="removed"]')).toHaveText([
    /Daniel said nothing at dinner\./,
  ]);
  await expect(compare.locator('tr[data-kind="added"]')).toHaveText([
    /Daniel left the table before dessert\./,
  ]);
  await compare.getByRole('button', { name: 'Apply' }).click();
  await expect(ch.getByTestId('summary-stale')).toBeVisible();
  // MS-5: reading never wrote to the manuscript.
  expect(readFileSync(docPath).equals(bytes)).toBe(true);
});

test('IP-18 Re-import on the desk reads the linked Word chapter again, shows the diff and applies it', async () => {
  await writeDoc('Daniel cleared the plates in silence.');
  await writing().selectOption({ label: 'Chapter 6: The Letter, present (2045)' });
  await page.getByTestId('top-relevant').click();
  const re = strand('CH6-present').getByTestId('reimport');
  await expect(re).toContainText('Manuscript: Chapter 6 The Letter.docx');
  await re.getByRole('button', { name: 'Re-import' }).click();
  const compare = re.getByTestId('reimport-compare');
  await expect(compare.locator('tr[data-kind="removed"]')).toHaveText([
    /Daniel left the table before dessert\./,
  ]);
  await expect(compare.locator('tr[data-kind="added"]')).toHaveText([
    /Daniel cleared the plates in silence\./,
  ]);
  await compare.getByRole('button', { name: 'Apply' }).click();
  await expect(re.getByTestId('reimport-note')).toContainText('Imported.');
  await expect
    .poll(async () => String((await entry('chapters', 'CH6')).manuscriptText))
    .toContain('Daniel cleared the plates in silence.');
  // Reading again finds nothing new.
  await re.getByRole('button', { name: 'Re-import' }).click();
  await expect(compare).toContainText('no change from the text in the bible');
  await compare.getByRole('button', { name: 'Discard' }).click();
});

test('DB-4 AI-1 AI-6 MS-2 with an API key, summaries run through the Claude runtime: disclosure, streaming, saved runs', async () => {
  await app.evaluate(({ app: electron }) => electron.exit(0)).catch(() => undefined);
  // T-3: the recorded Claude (NOVEL_COMPANION_TEST_CLAUDE) with a key held in memory.
  await start({
    NOVEL_COMPANION_TEST_ANTHROPIC_KEY: 'sk-ant-api03-e2e-session-key-0123456789abcdef',
    NOVEL_COMPANION_TEST_CLAUDE_STEP_DELAY_MS: '60',
  });
  await openBible();

  // ST-1 DB-4: the summary model with its default; briefs have no model and no panel.
  await rail(page, 'Settings').click();
  const settings = page.getByTestId('settings-view');
  await expect(settings.getByTestId('claude-model-summaries')).toHaveValue('claude-sonnet-5-5');
  await expect(settings.getByTestId('claude-model-briefs')).toHaveCount(0);
  await expect(settings.getByTestId('settings-briefs')).toHaveCount(0);

  // MS-2: the written chapter's summary is drafted by the summary model; nothing saved yet.
  const before = (await invoke('entry.get', { collection: 'chapters', id: 'CH6' })).entry.summary;
  await screenTab(page, 'Continuity checker', 'Manuscript');
  const ms = page.getByTestId('manuscript-view');
  await ms.locator('[data-chapter="CH6"]').click();
  await ms.getByRole('button', { name: 'Summary and promotions' }).click();
  const flow = ms.getByTestId('written-flow');
  // AI-6: the first Claude use in this bible says what is sent before anything is.
  await flow.getByTestId('claude-disclosure').getByTestId('claude-acknowledge').click();
  await expect(flow.getByTestId('claude-progress')).toBeVisible();
  await expect(flow.getByLabel('Summary to approve')).toHaveText(
    'Iris finds an envelope under the attic boards. Daniel says nothing at dinner.',
  );
  await expect(flow).toContainText('Generated summary (claude-sonnet-5-5)');
  expect((await invoke('entry.get', { collection: 'chapters', id: 'CH6' })).entry.summary).toBe(
    before,
  );
  expect((await invoke('claude.runs', { feature: 'summaries' })).runs[0]).toMatchObject({
    status: 'done',
  });
});

test('A27 TM-3 the top bar year slider and typed year move the story time, the era label, and the status bar; typing commits on Enter, one control per name', async () => {
  await rail(page, 'Characters').click();
  const bar = page.getByTestId('top-bar');
  await expect(bar.getByLabel('Story year', { exact: true })).toHaveCount(1);
  await bar.getByTestId('top-year-slider').fill('2032');
  await expect(page.getByTestId('status-time')).toContainText('Story time 2032');
  await expect(bar.getByTestId('top-year')).toHaveValue('2032');
  // Typing 2045 must not set 2, 20, and 204 on the way.
  const box = bar.getByTestId('top-year');
  await box.click();
  await box.press('ControlOrMeta+a');
  await box.pressSequentially('2045');
  await expect(page.getByTestId('status-time')).toContainText('Story time 2032');
  await box.press('Enter');
  await expect(page.getByTestId('status-time')).toContainText('Story time 2045');
  await expect(bar).toContainText('The forties');
  // Leaving the box commits too.
  await box.fill('2041');
  await page.getByTestId('top-writing').focus();
  await expect(page.getByTestId('status-time')).toContainText('Story time 2041');
});

test('SM-3 A35 Relevant to Session lists the moments of the years before the scene', async () => {
  const made: string[] = [];
  for (const [title, year, body] of [
    ['Learns to make dumplings', 2043, 'Her grandmother teaches her.'],
    ['First year of high school', 2044, 'Lonely.'],
    ['Too early to list', 2039, ''],
  ] as const) {
    made.push(
      (
        await invoke('entry.create', {
          collection: 'moments',
          data: { title, status: 'idea', characterId: 'H5', year, body },
        })
      ).entry._id,
    );
  }
  await writing().selectOption({ label: 'Chapter 6: The Letter, present (2045)' });
  await page.getByTestId('top-relevant').click();
  const s = strand('CH6-present');
  const section = s.getByTestId('sel-backstory');
  // No backstory strand: the three years before the story year.
  await expect(section.locator('h4')).toHaveText('Backstory The three years before · 2042 to 2044');
  const person = section.locator('[data-testid="backstory-person"][data-id="H5"]');
  await expect(person).toContainText('ages 11 to 13');
  const rows = person.getByTestId('backstory-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText(
    '2043Learns to make dumplings Her grandmother teaches her.',
  );
  await expect(rows.nth(1)).toContainText('2044First year of high school Lonely.');
  // IP-2: the year and what happens edit in place; one undo step each.
  await fillEditable(rows.nth(0).getByTestId('backstory-title'), 'Learns to fold dumplings');
  await expect
    .poll(
      async () => (await invoke('entry.get', { collection: 'moments', id: made[0]! })).entry.title,
    )
    .toBe('Learns to fold dumplings');
  await fillEditable(rows.nth(0).getByTestId('backstory-year'), '2042');
  await expect
    .poll(
      async () => (await invoke('entry.get', { collection: 'moments', id: made[0]! })).entry.year,
    )
    .toBe(2042);
  await expect(rows.nth(0)).toContainText('2042Learns to fold dumplings');
  // A50: each moment opens from Open on Backstory, in its person's timeline with its dialog open.
  await rows.nth(1).getByRole('button', { name: 'Open First year of high school' }).click();
  await expect(rail(page, 'Backstory')).toHaveAttribute('aria-current', 'page');
  const bsGrid = page.getByTestId('backstory-grid');
  await expect(bsGrid).toHaveClass(/\bbs-person\b/);
  await expect(bsGrid.locator('.bs-row')).toHaveCount(1);
  await expect(bsGrid.locator('.bs-row[data-person="H5"]')).toHaveCount(1);
  const opened = page.locator(`[data-testid="moment-dialog"][data-id="${made[1]!}"]`);
  await expect(opened.getByRole('heading')).toHaveText('First year of high school');
  await expect(opened.locator('.editable[data-field="title"] > .editable-text')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(opened).toHaveCount(0);
  await expect(bsGrid.locator(`.wg-marker[data-id="${made[1]!}"]`)).toBeFocused();

  // A35: the culture section names its setting.
  await page.getByTestId('top-relevant').click();
  await writing().selectOption({ label: 'Chapter 6: The Letter, present (2045)' });
  await expect(strand('CH6-present').getByTestId('relevant-setting')).toContainText('Setting');

  for (const id of made) await invoke('entry.delete', { collection: 'moments', id });
});

test('SB-1 Relevant to Session takes places and other characters present for a story year and point of view', async () => {
  await writing().selectOption({ label: 'No chapter picked' });
  await page.getByTestId('top-year').fill('2045');
  await page.getByTestId('top-year').press('Enter');
  await page.getByTestId('top-relevant').click();
  await expect(relevant()).toBeVisible();
  await relevant().getByLabel('Point of view in 2045').selectOption('H5');
  const member = (id: string) => relevant().locator(`[data-testid="sel-item"][data-id="${id}"]`);
  await expect(groupIds(relevant(), 'characters').first()).toBeVisible();
  await expect(member('Z4')).toHaveCount(0);
  await relevant().getByTestId('session-characters').selectOption(['Z4']);
  await expect(member('Z4').first()).toBeVisible();
  await relevant()
    .getByTestId('session-places')
    .selectOption([{ index: 0 }]);
  await expect(relevant().getByTestId('relevant-strand')).toHaveCount(1);
});

test('MS-2 SM-11 ticking Written in the chapter editor offers the summary and promotion flow on the Continuity checker', async () => {
  await invoke('entry.update', { collection: 'chapters', id: 'CH3', patch: { written: false } });
  await sectionList(page, 'Chapters');
  const title = String(
    (await invoke('entry.get', { collection: 'chapters', id: 'CH3' })).entry.title,
  );
  await page
    .getByRole('button', { name: new RegExp(title) })
    .first()
    .click();
  const editor = page.getByTestId('editor');
  await expect(editor.getByTestId('written-offer')).toHaveCount(0);
  await field(editor, 'written').locator('input[type="checkbox"]').check();
  await editor.getByTestId('written-offer').getByRole('button').click();
  await expect(page.getByTestId('written-flow')).toBeVisible();
  await expect(rail(page, 'Continuity checker')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('tab', { name: 'Manuscript' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
});

const parseRgb = (c: string): Rgba => {
  const p = (c.match(/[\d.]+/g) ?? []).map(Number);
  return [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0, p[3] ?? 1];
};

test('IP-2 NF-2 every control of the desk works from the keyboard, in both themes, at 1200x800 and 390 wide', async () => {
  await writing().selectOption({ label: 'Chapter 6: The Letter, present (2045)' });
  await page.getByTestId('top-relevant').click();
  const s = strand('CH6-present');
  const resize = (w: number, h: number) =>
    app.evaluate(
      ({ BrowserWindow }, [w2, h2]) => {
        BrowserWindow.getAllWindows()[0]?.setContentSize(w2!, h2!);
      },
      [w, h],
    );
  // Fields open with Enter and save with Enter; the focus comes back to the text.
  const title = s.getByTestId('relevant-title-text');
  // Reached by the keyboard, the field shows its focus ring; Tab goes on to the story year.
  await title.focus();
  await page.keyboard.press('Tab');
  await expect(s.getByTestId('relevant-year-text')).toBeFocused();
  await expect(s.getByTestId('relevant-year-text')).toHaveCSS('outline-style', 'solid');
  await page.keyboard.press('Shift+Tab');
  await expect(title).toBeFocused();
  await expect(title).toHaveCSS('outline-style', 'solid');
  await page.keyboard.press('Enter');
  await page.keyboard.press('End');
  await page.keyboard.type(' Home');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await entry('chapters', 'CH6')).title).toBe('The Letter Home');
  await expect(title).toBeFocused();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Meta+a');
  await page.keyboard.type('The Letter');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await entry('chapters', 'CH6')).title).toBe('The Letter');
  // The tile toggle, the chip row's Add, Add an event and Write or Ask are buttons Tab reaches.
  const iris = s.locator('[data-kind="characters"] [data-testid="sel-item"][data-id="H5"]');
  await iris.getByTestId('tile-toggle').focus();
  await page.keyboard.press('Enter');
  await expect(iris.getByTestId('tile-toggle')).toHaveAttribute('aria-expanded', 'true');
  // Shift+Tab goes back to the Chinese name, a field: Enter opens it, Escape leaves it as it was.
  const zh = iris.getByRole('button', { name: /^Name in Chinese characters/ });
  for (let i = 0; i < 6 && !(await zh.evaluate((el) => el === document.activeElement)); i++) {
    await page.keyboard.press('Shift+Tab');
  }
  await expect(zh).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(iris.getByTestId('tile-chinese').locator('input')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(zh).toBeFocused();
  const add = s.getByTestId('scene-characters').getByRole('button', {
    name: 'Add a character to this scene',
  });
  await add.focus();
  await page.keyboard.press('Enter');
  await page.keyboard.type('Zhou Jun');
  await page.keyboard.press('Enter');
  await expect
    .poll(async () => (await strandOf('CH6', 'CH6-present')).characterIds)
    .toEqual(['H5', 'H3', 'Z4']);
  await s.getByRole('button', { name: 'Remove Zhou Jun from In this scene' }).focus();
  await page.keyboard.press('Enter');
  await expect
    .poll(async () => (await strandOf('CH6', 'CH6-present')).characterIds)
    .toEqual(['H5', 'H3']);
  await iris.getByTestId('tile-toggle').click();

  // Labels and fields read in the primary text colour with 4.5:1 contrast, in both themes and at
  // both sizes, and the desk never scrolls sideways.
  const theme0 = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  for (const [w, h] of [
    [1200, 800],
    [390, 800],
  ] as const) {
    await resize(w, h);
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(w);
    expect(await relevant().evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
      const read = await s.evaluate((root) => {
        const probe = document.createElement('span');
        probe.style.color = 'var(--fg)';
        document.body.append(probe);
        const fg = getComputedStyle(probe).color;
        probe.remove();
        const bgOf = (el: Element | null): string => {
          for (let e = el; e; e = e.parentElement) {
            const b = getComputedStyle(e).backgroundColor;
            if (b && !/rgba\(0, 0, 0, 0\)|transparent/.test(b)) return b;
          }
          return getComputedStyle(document.body).backgroundColor;
        };
        return {
          fg,
          found: [
            ...root.querySelectorAll(
              '.editable-text, .editable-label, h4, .rel-tile-name, .rel-comm',
            ),
          ].map((el) => ({
            what: `${el.className} ${(el.textContent ?? '').slice(0, 30)}`,
            color: getComputedStyle(el).color,
            bg: bgOf(el),
          })),
        };
      });
      expect(read.found.length).toBeGreaterThan(10);
      for (const f of read.found) {
        expect(
          contrast(parseRgb(f.color), parseRgb(f.bg)),
          `${f.what} in ${theme} at ${w}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
      const labels = read.found.filter((f) => /editable-(label|text)/.test(f.what));
      for (const f of labels) expect(f.color, `${f.what} in ${theme}`).toBe(read.fg);
    }
  }
  await page.evaluate((t) => {
    if (t === null) document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', t);
  }, theme0);
  await resize(1200, 800);
});
