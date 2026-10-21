import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx';
import type { Invoke } from '../helpers/t5';
import { readFixture } from '../helpers/loadFixture';
import { readSupplement } from '../helpers/briefFixture';
import { changes, field, fileDb, invokeVia, launch, rail, screenTab, sectionList } from './helpers';
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
const exportDir = mkdtempSync(join(tmpdir(), 'nc-e2e-m7-export-'));

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
    NOVEL_COMPANION_TEST_BRIEF_EXPORT_DIR: exportDir,
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
    await invoke('entry.createMany', {
      items: fixture[c]!.map((d) => ({ collection: c as never, data: strip(d) })),
    });
  }
  // The M7 brief supplement: moments, questions, session logs, and communities.
  for (const c of ['moments', 'openQuestions']) {
    const docs = supplement.entries[c]!;
    await invoke('entry.createMany', {
      items: docs.map((d) => {
        const { deletedAt: _d, ...rest } = strip(d);
        return { collection: c as never, data: rest };
      }),
    });
    // Entries in the trash go there the way a person puts them there.
    for (const d of docs.filter((x) => x.deletedAt)) {
      await invoke('entry.delete', { collection: c as never, id: d._id });
    }
  }
  for (const c of ['sessionLogs']) {
    await invoke('entry.createMany', {
      items: supplement.entries[c]!.map((d) => ({ collection: c as never, data: strip(d) })),
    });
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

test('DB-1 SM-11 the app opens on Sessions: last note, story time, position, open questions, rewrite tasks, two controls', async () => {
  await page.reload();
  await expect(page.getByTestId('workspace')).toBeVisible();
  await expect(page.getByTestId('sessions-view')).toBeVisible();
  await expect(rail(page, 'Sessions')).toHaveAttribute('aria-current', 'page');
  const dash = page.getByTestId('dashboard');
  await expect(dash).toBeVisible();
  // SL-1: the newest note first (SL3, 2026-10-09).
  await expect(dash.getByTestId('launch-note')).toHaveText('Margaret blows out the candles.');
  await expect(dash.getByTestId('launch-panel')).toContainText('Chapter: Candles');
  await expect(dash.getByTestId('dash-time')).toContainText('2040');
  await expect(dash.getByTestId('dash-position')).toContainText('Chapter 5');
  await expect(dash.getByTestId('dash-position')).toContainText('Candles');
  await expect(dash.getByTestId('dash-questions').locator('.tile-num')).toHaveText('3');
  await expect(dash.getByTestId('dash-tasks')).toContainText('No open rewrite tasks.');
  await expect(dash.getByTestId('dash-task-count').locator('.tile-num')).toHaveText('0');
  // The questions tile leads to the questions list on the same screen.
  await dash.getByRole('button', { name: 'Go to the questions' }).click();
  await expect(page.getByTestId('questions-list')).toBeInViewport();
  await expect(dash.getByRole('button', { name: 'Start session' })).toBeVisible();
  await dash.getByRole('button', { name: 'Check alignment' }).click();
  // SM-11: Check alignment opens the Continuity checker on its alignment tab.
  await expect(rail(page, 'Continuity checker')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('heading', { name: 'Alignment check', level: 2 })).toBeVisible();
  await rail(page, 'Sessions').click();
  await expect(page.getByTestId('dashboard')).toBeVisible();
});

test('SM-11 SL-1 SB-8 A43 Sessions lists the session log newest first and the saved briefs, a log opens under its row', async () => {
  const log = page.getByTestId('session-log');
  await expect(log.locator('.entry-row')).toHaveCount(3);
  expect(
    await log.locator('.entry-row').evaluateAll((els) => els.map((e) => e.getAttribute('data-id'))),
  ).toEqual(['SL3', 'SL2', 'SL1']);
  await expect(log.locator('[data-id="SL3"]')).toContainText(
    'Stopped at: Margaret blows out the candles.',
  );
  await log.locator('[data-id="SL2"]').click();
  // The editor opens inside the row's list item, right under the row.
  const row = log.locator('li').filter({ has: page.locator('[data-id="SL2"]') });
  const opened = row.getByTestId('session-row-editor');
  await expect(opened.getByTestId('editor')).toHaveAttribute('data-entry-id', 'SL2');
  await expect(log.locator('[data-id="SL2"]')).toHaveAttribute('aria-expanded', 'true');
  // One at a time: another log replaces it.
  await log.locator('[data-id="SL3"]').click();
  await expect(page.getByTestId('session-row-editor')).toHaveCount(1);
  await expect(page.getByTestId('session-row-editor').getByTestId('editor')).toHaveAttribute(
    'data-entry-id',
    'SL3',
  );
  await expect(log.locator('[data-id="SL2"]')).toHaveAttribute('aria-expanded', 'false');
  // A second click on the open row closes it, as Close does.
  await log.locator('[data-id="SL3"]').click();
  await expect(page.getByTestId('session-row-editor')).toHaveCount(0);
  await log.locator('[data-id="SL2"]').click();
  await opened.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByTestId('session-row-editor')).toHaveCount(0);
  await expect(log.locator('[data-id="SL2"]')).toBeFocused();
  // No inspector column beside the screen.
  await expect(page.getByTestId('inspector')).toHaveCount(0);
  await expect(page.getByText('No briefs yet. Start a session to write one.')).toBeVisible();
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
  // SM-10: the characters are tiles: name, age, and point of view.
  await expect(
    strand('CH2-present').locator('[data-kind="characters"] [data-testid="tile-toggle"]'),
  ).toHaveText([/^Daniel Hale60point of view$/, /^Zhou Lan57$/, /^Iris Hale-Zhou14$/]);
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
  await expect(groupIds(s, 'eventsWindow').getByRole('button')).toHaveText(
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
  await expect.poll(() => ids('sessionNote')).toEqual(['SL2']);

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
  await groupIds(s, 'culture').getByRole('button', { name: 'Flood memorial walk' }).click();
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
  await expect(tiles.getByTestId('tile-toggle')).toHaveText([
    /^Iris Hale-Zhou14point of view$/,
    /^Daniel Hale60$/,
  ]);
  await expect(tiles.nth(0).getByTestId('tile-chinese').locator('.zh-chars')).toHaveText('晓曦');
  await expect(tiles.nth(1).getByTestId('tile-chinese')).toHaveCount(0);
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
  // The latest three at or before 2045: not 2040, not B5 in 2050.
  await expect(iris.getByTestId('tile-moments').locator('li')).toHaveText([
    /^2043 Learns to make dumplings$/,
    /^2044 First year of high school$/,
    /^2045 Iris finds the letter\. Iris finds an envelope in the attic\.$/,
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

let briefId = '';

test('DB-2 DB-3 SB-7 Start session from the top bar: the selection, a structured brief, a session log, the story time', async () => {
  await rail(page, 'Lists').click();
  await page.getByTestId('top-start-session').click();
  const view = page.getByTestId('start-session');
  await expect(view).toBeVisible();
  // SB-1: the strand being written is the section, not the whole chapter.
  await expect(view.getByTestId('start-strand')).toHaveValue('CH6|CH6-present');
  await expect(view.getByTestId('claude-unavailable')).toBeVisible();
  await expect(view).toContainText('What the bible selects: Chapter 6: The Letter');
  const logsBefore = (await invoke('entry.list', { collection: 'sessionLogs', trash: 'exclude' }))
    .entries.length;
  await view.getByTestId('start-session-go').click();
  const brief = page.getByTestId('brief-view');
  await expect(brief).toBeVisible();
  await expect(brief.getByTestId('brief-model')).toHaveText('Structured brief, no synthesis');
  // ARCH-4: with no key stored the note says so and links to Settings.
  await expect(brief.getByTestId('brief-note')).toContainText('No Anthropic API key is stored');
  await expect(
    brief.getByTestId('brief-note').getByRole('button', { name: 'Open settings' }),
  ).toBeVisible();
  await expect(brief.getByTestId('brief-body').locator('h2')).toHaveText([
    '1. Characters and their ages',
    '2. World events ongoing',
    '3. Cultural expectations',
    '4. Places',
    '5. Backstory',
    '6. Previous chapters',
    '7. Glossary and open questions',
    '8. Last session note',
  ]);
  await expect(brief.getByTestId('brief-problems')).toHaveCount(0);
  const briefs = (await invoke('entry.list', { collection: 'briefs', trash: 'exclude' })).entries;
  expect(briefs).toHaveLength(1);
  briefId = briefs[0]!.entry._id;
  expect(briefs[0]!.entry.chapterId).toBe('CH6');
  const logs = (await invoke('entry.list', { collection: 'sessionLogs', trash: 'exclude' }))
    .entries;
  expect(logs).toHaveLength(logsBefore + 1);
  const log = logs.find((l) => l.entry.briefId === briefId)!;
  expect(log.entry).toMatchObject({ chapterId: 'CH6', storyYear: 2045, povCharacterId: 'H5' });
  expect((await invoke('storyTime.get', {})).time).toEqual({
    year: 2045,
    chapterId: 'CH6',
    strandId: 'CH6-present',
  });
  await expect(page.getByTestId('status-time')).toContainText('Story time 2045');
});

test('SB-9 removing and adding entries in the brief view, then regenerating', async () => {
  const brief = page.getByTestId('brief-view');
  const sel = brief.getByTestId('brief-selection');
  await sel
    .locator('[data-testid="sel-item"][data-id="E5"]')
    .first()
    .getByRole('button', { name: /^Remove/ })
    .click();
  await sel.getByPlaceholder('Add an entry to the selection').fill('Zhou Jun');
  await sel.getByRole('option').filter({ hasText: 'Zhou Jun' }).first().click();
  await expect(brief.getByTestId('brief-pending')).toContainText('To add: Z4');
  await expect(brief.getByTestId('brief-pending')).toContainText('To remove: E5');
  await brief.getByTestId('brief-regenerate').click();
  await expect(brief.getByTestId('brief-note')).toBeVisible();
  const saved = (await invoke('entry.get', { collection: 'briefs', id: briefId })).entry;
  expect(saved.entryIds).toContain('Z4');
  expect(saved.entryIds).not.toContain('E5');
  await expect(brief.getByTestId('brief-body')).toContainText('9. Added by you');
  await expect(brief.getByTestId('brief-body')).toContainText('removed by you');
});

test('SB-8 SB-4 the brief is edited in place, a foreign citation is flagged, and it exports as Markdown and PDF', async () => {
  const brief = page.getByTestId('brief-view');
  await brief.getByRole('button', { name: 'Edit the text' }).click();
  const text =
    '# My brief\n\n## 1. Characters\n- Iris is fourteen. [[H5]]\n- A stray line. [[Z2]]\n';
  await brief.getByTestId('brief-text').fill(text);
  await expect(brief.getByTestId('autosave')).toHaveText('Saved');
  await expect(brief.getByTestId('brief-problems')).toContainText('Z2');
  await brief.getByRole('button', { name: 'Show the brief' }).click();
  await expect(brief.locator('.cite.bad')).toHaveText('Z2 not in the selection');
  await brief.getByRole('button', { name: 'Export Markdown' }).click();
  const md = join(exportDir, 'Brief Chapter 6 The Letter present 2045.md');
  await expect(brief.getByTestId('brief-note')).toHaveText(`Saved to ${md}`);
  expect(readFileSync(md, 'utf8')).toBe(text);
  await brief.getByRole('button', { name: 'Export PDF' }).click();
  const pdf = join(exportDir, 'Brief Chapter 6 The Letter present 2045.pdf');
  await expect(brief.getByTestId('brief-note')).toHaveText(`Saved to ${pdf}`);
  expect(readFileSync(pdf).subarray(0, 5).toString()).toBe('%PDF-');
});

test('SM-11 SB-8 DB-2 Start session lives on Sessions; a saved brief opens there in place and Back to Sessions returns', async () => {
  await expect(rail(page, 'Sessions')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('sessions-view')).toHaveAttribute('data-sub', 'brief');
  await page.getByRole('button', { name: 'Back to Sessions' }).click();
  await expect(page.getByTestId('sessions-view')).toHaveAttribute('data-sub', 'home');
  // The Start session panel is on the screen, its selection folded until asked for.
  await expect(page.getByTestId('sessions-start').getByTestId('start-session')).toBeVisible();
  await expect(page.getByTestId('start-selection')).not.toHaveAttribute('open', '');
  const briefs = page.getByTestId('session-briefs');
  await expect(briefs.locator(`[data-id="${briefId}"]`)).toContainText('Brief: Chapter 6');
  await briefs.locator(`[data-id="${briefId}"]`).click();
  await expect(page.getByTestId('brief-view')).toBeVisible();
  await expect(page.getByTestId('sessions-view')).toHaveAttribute('data-sub', 'brief');
  await page.getByRole('button', { name: 'Back to Sessions' }).click();
  await expect(page.getByTestId('session-log').locator('.entry-row').first()).toBeVisible();
  // Start session in the top bar unfolds the selection.
  await page.getByTestId('top-start-session').click();
  await expect(page.getByTestId('start-selection')).toHaveAttribute('open', '');
});

test('SB-4 DB-4 with Claude available the brief is written by the brief model from the selection', async () => {
  await app.evaluate(({ app: electron }) => electron.exit(0)).catch(() => undefined);
  await start({
    NOVEL_COMPANION_TEST_ANTHROPIC_KEY: 'sk-ant-api03-e2e-session-key-0123456789abcdef',
  });
  await openBible();
  // The recorded brief puts E9 under Planned ahead. World events lost their places in A39, so
  // E9 reaches CH6 only as the year after the story year (A33), as in the integration test.
  await invoke('entry.update', {
    collection: 'worldEvents',
    id: 'E9',
    patch: { start: { year: 2046 } },
  });
  await page.getByTestId('top-start-session').click();
  const view = page.getByTestId('start-session');
  await view.getByRole('button', { name: 'A chapter', exact: true }).click();
  await view.getByTestId('start-chapter').selectOption('CH6');
  await expect(view.getByTestId('start-session-go')).toHaveText(
    'Start session with claude-opus-5-5',
  );
  await view.getByTestId('start-session-go').click();
  // AI-6: the first Claude use in this bible says what is sent before anything is.
  await view.getByTestId('claude-disclosure').getByTestId('claude-acknowledge').click();
  const brief = page.getByTestId('brief-view');
  await expect(brief.getByTestId('brief-model')).toHaveText('Written by claude-opus-5-5');
  await expect(brief.getByTestId('brief-problems')).toHaveCount(0);
  await expect(brief.getByTestId('brief-missing-lead')).toHaveCount(0);
  await expect(brief.getByTestId('brief-uncited')).toHaveCount(0);
  // A line that cites nothing is flagged on a Claude-written brief.
  await brief.getByRole('button', { name: 'Edit the text' }).click();
  const text = await brief.getByTestId('brief-text').inputValue();
  await brief.getByTestId('brief-text').fill(`${text}- Daniel has always hated rain.\n`);
  await expect(brief.getByTestId('autosave')).toHaveText('Saved');
  await expect(brief.getByTestId('brief-uncited')).toContainText('Daniel has always hated rain.');
  await brief.getByRole('button', { name: 'Show the brief' }).click();
  await expect(brief.locator('.uncited-flag')).toHaveText(['cites nothing']);
});

test('MS-1 MS-2 MS-3 MS-4 MS-5 SM-11 import a chapter from Word, mark it written, approve the summary, promote, and re-import with a diff', async () => {
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

test('SB-4 DB-2 DB-4 AI-1 AI-6 MS-2 with an API key, briefs and summaries run through the Claude runtime: disclosure, streaming, Stop, saved runs', async () => {
  await app.evaluate(({ app: electron }) => electron.exit(0)).catch(() => undefined);
  // T-3: the recorded Claude (NOVEL_COMPANION_TEST_CLAUDE) with a key held in memory.
  await start({
    NOVEL_COMPANION_TEST_ANTHROPIC_KEY: 'sk-ant-api03-e2e-session-key-0123456789abcdef',
    NOVEL_COMPANION_TEST_CLAUDE_STEP_DELAY_MS: '60',
  });
  await openBible();

  // ST-1 DB-4: the brief and summary models with their defaults, and the brief window and budget.
  await rail(page, 'Settings').click();
  const settings = page.getByTestId('settings-view');
  await expect(settings.getByTestId('claude-model-briefs')).toHaveValue('claude-opus-5-5');
  await expect(settings.getByTestId('claude-model-summaries')).toHaveValue('claude-sonnet-5-5');
  await expect(settings.getByTestId('settings-briefs')).toContainText(
    'Briefs are written with claude-opus-5-5',
  );
  await expect(
    settings.getByTestId('settings-briefs').getByLabel('Size budget (characters)'),
  ).toHaveValue('40000');

  // DB-2 SB-4 AI-6: the first brief asks for the disclosure, then Claude writes it.
  await page.getByTestId('top-start-session').click();
  const view = page.getByTestId('start-session');
  await view.getByRole('button', { name: 'A chapter', exact: true }).click();
  await view.getByTestId('start-chapter').selectOption('CH6');
  await expect(view.getByTestId('start-session-go')).toHaveText(
    'Start session with claude-opus-5-5',
  );
  await view.getByTestId('start-session-go').click();
  await view.getByTestId('claude-disclosure').getByTestId('claude-acknowledge').click();
  await expect(view.getByTestId('claude-progress')).toBeVisible();
  const brief = page.getByTestId('brief-view');
  await expect(brief.getByTestId('brief-model')).toHaveText('Written by claude-opus-5-5');
  await expect(brief.getByTestId('brief-problems')).toHaveCount(0);
  await expect(brief.getByTestId('brief-uncited')).toHaveCount(0);
  await expect(brief.getByTestId('brief-missing-lead')).toHaveCount(0);
  await expect(brief.getByTestId('brief-body').locator('h2').first()).toHaveText(
    '1. Characters and their ages',
  );
  await expect(brief.getByTestId('brief-body')).toContainText('Planned ahead (after 2045)');
  const runs = (await invoke('claude.runs', { feature: 'briefs' })).runs;
  expect(runs[0]).toMatchObject({ feature: 'briefs', status: 'done' });

  // AI-1: Stop ends a brief run; the structured brief is saved and the note says why.
  await page.getByTestId('top-start-session').click();
  await view.getByRole('button', { name: 'A chapter', exact: true }).click();
  await view.getByTestId('start-chapter').selectOption('CH5');
  await view.getByTestId('start-session-go').click();
  await expect(view.getByTestId('claude-progress')).toContainText('Claude is writing the brief');
  await view.getByTestId('claude-run-stop').click();
  await expect(brief.getByTestId('brief-model')).toHaveText('Structured brief, no synthesis');
  await expect(brief.getByTestId('brief-note')).toContainText('you stopped it');
  expect((await invoke('claude.runs', { feature: 'briefs' })).runs[0]).toMatchObject({
    status: 'stopped',
  });

  // MS-2: the written chapter's summary is drafted by the summary model; nothing saved yet.
  const before = (await invoke('entry.get', { collection: 'chapters', id: 'CH6' })).entry.summary;
  await screenTab(page, 'Continuity checker', 'Manuscript');
  const ms = page.getByTestId('manuscript-view');
  await ms.locator('[data-chapter="CH6"]').click();
  await ms.getByRole('button', { name: 'Summary and promotions' }).click();
  const flow = ms.getByTestId('written-flow');
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
  // Each moment opens in the editor.
  await rows.nth(1).getByRole('button', { name: 'First year of high school' }).click();
  await expect(page.getByTestId('editor')).toHaveAttribute('data-entry-id', made[1]!);

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
  // Start session offers the same two pickers.
  await page.getByTestId('top-start-session').click();
  const view = page.getByTestId('start-session');
  await view.getByRole('button', { name: 'A story year and point of view' }).click();
  await view.getByLabel('Point of view').selectOption('H5');
  await expect(view.getByTestId('session-places')).toBeVisible();
  await view.getByTestId('session-characters').selectOption(['Z4']);
  await expect(view.locator('[data-testid="sel-item"][data-id="Z4"]').first()).toBeVisible();
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
