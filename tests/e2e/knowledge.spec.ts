import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import type { Invoke } from '../helpers/t5';
import { readFixture } from '../helpers/loadFixture';
import { changes, field, fileDb, invokeVia, launch, rail, screenTab } from './helpers';
import type { TestDb } from './helpers';

let db: TestDb;
let app: ElectronApplication;
let page: Page;
let invoke: Invoke;

const SLUG = 'knowledge';
const fixture = readFixture();

test.describe.configure({ mode: 'serial' });

function strip(d: Record<string, unknown>): Record<string, unknown> {
  const { createdAt: _c, modifiedAt: _m, ...rest } = d;
  return rest;
}

async function openBible(): Promise<void> {
  await invoke('bible.open', { slug: SLUG });
  await expect(page.getByTestId('workspace')).toBeVisible();
}

test.beforeAll(async () => {
  db = fileDb();
  ({ app, page } = await launch(db));
  invoke = invokeVia(page);
  await invoke('bible.create', { slug: SLUG, name: 'Knowledge' });
  await openBible();
  const seeded = await invoke('entry.list', { collection: 'eraStates', trash: 'exclude' });
  for (const e of seeded.entries) {
    await invoke('entry.delete', { collection: 'eraStates', id: e.entry._id });
  }
  for (const label of ['Portland', 'Guangzhou']) {
    await invoke('lists.addItem', { listId: 'communities', label, parentId: null });
  }
  for (const c of Object.keys(fixture)) {
    if (c === 'lists' || !fixture[c]?.length) continue;
    await invoke('entry.createMany', {
      items: fixture[c]!.map((d) => ({ collection: c as never, data: strip(d) })),
    });
  }
});

test.afterAll(async () => {
  // Exit directly: a failed SL-1 test may leave the stop prompt open, and close() would wait on it.
  await app?.evaluate(({ app: electron }) => electron.exit(0)).catch(() => undefined);
});

const sessions = () => page.getByTestId('sessions-view');
const questions = () => sessions().getByTestId('questions-list');
const pick = (name: RegExp | string) => questions().getByRole('button', { name });
/** A43: a log or a question opens in place, under its row. */
const rowEditor = () => sessions().getByTestId('session-row-editor');
const saved = () => expect(rowEditor().getByTestId('autosave')).toHaveText('Saved');
const questionRows = () => questions().locator('.entry-row');

test('OQ-1 SM-11 on Sessions, an open question is made, marked decided, warns until it has a decision, and filters by state', async () => {
  await rail(page, 'Sessions').click();
  await expect(sessions().getByTestId('questions-empty')).toHaveText('No questions yet.');
  for (const title of ['Who wrote the second letter?', 'Does Iris go back to Guangzhou?']) {
    await sessions().getByRole('button', { name: 'New question', exact: true }).click();
    // A43: the form opens at the top of the questions, and the new question opens under its row.
    const form = sessions().getByTestId('question-new').getByTestId('new-entry');
    await field(form, 'title').locator(':scope > input').fill(title);
    await form.getByRole('button', { name: 'Create open question' }).click();
    await expect(sessions().getByTestId('question-new')).toHaveCount(0);
    await expect(
      rowEditor().getByTestId('editor').getByRole('heading', { name: title }),
    ).toBeVisible();
    await expect(pick(title)).toHaveAttribute('aria-expanded', 'true');
    await saved();
  }
  await pick(/Who wrote/).click();
  // One row is open at a time: picking another closes the first.
  await expect(rowEditor()).toHaveCount(1);
  const editor = rowEditor().getByTestId('editor');
  await expect(pick(/Who wrote/)).toHaveAttribute('aria-expanded', 'true');
  await expect(pick(/Does Iris go back/)).toHaveAttribute('aria-expanded', 'false');
  await field(editor, 'state').locator(':scope > select').selectOption('decided');
  await saved();
  await expect(field(editor, 'decision')).toContainText('marked decided, but no decision');
  await field(editor, 'decision').locator(':scope > textarea').fill('Peter wrote it in 2029.');
  await saved();
  await expect(field(editor, 'decision')).not.toContainText('marked decided, but no decision');
  // Close puts the editor away and gives the focus back to the row.
  await editor.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(rowEditor()).toHaveCount(0);
  await expect(pick(/Who wrote/)).toBeFocused();
  const show = sessions().getByLabel('Show questions');
  await expect(pick(/Who wrote/)).toContainText('decided');
  await expect(show.locator('option')).toHaveText(['All (2)', 'Open (1)', 'Decided (1)']);
  await show.selectOption('open');
  await expect(questionRows()).toHaveCount(1);
  await expect(pick(/Does Iris go back/)).toBeVisible();
  await show.selectOption('decided');
  await expect(questionRows()).toHaveCount(1);
  await expect(pick(/Who wrote/)).toBeVisible();
  await show.selectOption('all');
  await expect(questionRows()).toHaveCount(2);
  // DB-1: the overview counts the open one.
  await expect(page.getByTestId('dash-questions').locator('.tile-num')).toHaveText('1');
  // A question links to any entry from the Links field.
  const stored = (
    await invoke('entry.list', { collection: 'openQuestions', trash: 'exclude' })
  ).entries.find((e) => e.entry.title === 'Who wrote the second letter?')!;
  expect(stored.entry).toMatchObject({ state: 'decided', decision: 'Peter wrote it in 2029.' });
});

test('SL-1 SM-11 the session log on Sessions is newest first, and each entry has date, chapter, stop point, and notes', async () => {
  const morning = (
    await invoke('entry.create', {
      collection: 'sessionLogs',
      data: { title: 'Morning session', status: 'canon', date: '2026-10-01' },
    })
  ).entry;
  await invoke('entry.create', {
    collection: 'sessionLogs',
    data: {
      title: 'Later session',
      status: 'canon',
      date: '2026-10-05',
      stoppedAt: 'End of chapter 2',
    },
  });
  const rows = sessions().getByTestId('session-log').locator('.entry-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText('Later session');
  await expect(rows.first()).toContainText('Stopped at: End of chapter 2');
  await expect(rows.last()).toContainText('Morning session');
  // A43: a log opens under its row, where its chapter, stop point and notes are edited.
  await rows.last().click();
  const editor = sessions()
    .getByTestId('session-log')
    .getByTestId('session-row-editor')
    .getByTestId('editor');
  await expect(editor).toHaveAttribute('data-entry-id', morning._id);
  await field(editor, 'chapterId').locator(':scope > select').selectOption('CH2');
  await field(editor, 'stoppedAt').locator(':scope > textarea').fill('Daniel burns the rice');
  await field(editor, 'notes').locator(':scope > textarea').fill('Check the kitchen timeline');
  await saved();
  await expect(rows.last()).toContainText('Two Kitchens');
  await expect(rows.last()).toContainText('Stopped at: Daniel burns the rice');
  expect(
    (await invoke('entry.get', { collection: 'sessionLogs', id: morning._id })).entry,
  ).toMatchObject({
    chapterId: 'CH2',
    stoppedAt: 'Daniel burns the rice',
    notes: 'Check the kitchen timeline',
  });
});

test('SR-1 one search box finds entries, chapter text, briefs, and Chinese by characters and by tone-free romanization', async () => {
  await invoke('entry.create', {
    collection: 'briefs',
    data: {
      title: 'Brief for chapter 3',
      status: 'planned',
      content: 'Remember the lantern in the rain.',
    },
  });
  const box = page.getByRole('searchbox', { name: 'Search the bible' });
  const results = page.getByTestId('search-results');
  await box.fill('casseroles');
  await expect(results).toContainText('After the Funeral');
  await box.fill('lantern');
  await expect(results.getByRole('button', { name: /Brief for chapter 3/ })).toBeVisible();
  await box.fill('晓曦');
  await expect(results).toContainText('晓曦');
  await box.fill('tuanyuan');
  await expect(results).toContainText('团圆');
  await box.fill('family reunion');
  await expect(results).toContainText('团圆');
  await box.fill('qqqqzzzz');
  await expect(page.getByTestId('search-empty')).toBeVisible();
  // Picking a result opens the entry: SM-3, Iris's voice moment.
  await box.fill('Guarded');
  await results.locator('[data-hit="H5-voice-0"]').click();
  await expect(page.getByTestId('editor')).toHaveAttribute('data-entry-id', 'H5-voice-0');
});

test('SR-2 filters narrow the results by section, status, provenance, family, place, tag, and year range', async () => {
  const place = (
    await invoke('entry.create', {
      collection: 'places',
      data: { title: 'The Archive', status: 'canon' },
    })
  ).entry;
  await invoke('entry.update', {
    collection: 'chapters',
    id: 'CH1',
    patch: {
      tags: ['opening'],
      strands: [
        {
          ...(
            (await invoke('entry.get', { collection: 'chapters', id: 'CH1' })).entry
              .strands as object[]
          )[0],
          placeIds: [place._id],
        },
      ],
    },
  });
  await page.getByRole('searchbox', { name: 'Search the bible' }).fill('letter');
  const view = page.getByTestId('search-view');
  const results = view.getByTestId('search-results');
  const count = view.getByTestId('search-count');
  const voice = results.locator('[data-hit="H5-voice-0"]');
  await expect(voice).toHaveCount(1);
  await expect(results).toContainText('The Letter');

  // SM-3: the moments section holds Iris's voice moment, which mentions the letter.
  await view.getByLabel('Section').selectOption('moments');
  await expect(results.getByRole('button')).toHaveCount(1);
  await expect(results).not.toContainText('The Letter');
  await view.getByLabel('Section').selectOption('');

  await view.getByLabel('Status').selectOption('idea');
  await expect(voice).toHaveCount(0);
  await view.getByLabel('Status').selectOption('');

  await view.getByLabel('Provenance').selectOption('researched');
  await expect(page.getByTestId('search-empty')).toBeVisible();
  await view.getByLabel('Provenance').selectOption('');

  await view.getByLabel('From year').fill('2060');
  await view.getByLabel('To year').fill('2060');
  await expect(voice).toHaveCount(1);
  await view.getByLabel('From year').fill('2061');
  await view.getByLabel('To year').fill('2061');
  await expect(voice).toHaveCount(0);
  await view.getByLabel('From year').fill('');
  await view.getByLabel('To year').fill('');

  await view.getByLabel('Family').selectOption('FAM-ZHOU');
  // Wait until the list answers the Zhou filter, so stale unfiltered hits cannot satisfy the checks.
  const region = view.getByTestId('search-region');
  await expect(region).toHaveAttribute('data-query-key', /FAM-ZHOU/);
  await expect(region).toHaveAttribute('aria-busy', 'false');
  // Iris is in the Zhou family too, so her moment stays.
  await expect(voice).toHaveCount(1);
  await view.getByLabel('Family').selectOption('');

  await page.getByRole('searchbox', { name: 'Search the bible' }).fill('door');
  await view.getByLabel('Place').selectOption(place._id);
  await expect(results).toContainText("The Archivist's Door");
  await view.getByLabel('Place').selectOption('');
  await view.getByLabel('Tag').selectOption('opening');
  await expect(results).toContainText("The Archivist's Door");
  await view.getByLabel('Tag').selectOption('');
  await expect(count).toContainText('match');
});

const culture = () => page.getByTestId('culture-view');
const group = (demographic: string) =>
  culture().locator(`section[data-demographic="${demographic}"]`);
const lineOf = (id: string) => culture().locator(`.cu-line[data-id="${id}"]`);
const notesOf = async () => (await invoke('community.notes.get', {})).notes;

test("CU-1 A42 SM-11 Cultural data shows one community for the story year's decade, by age group, and the top-bar year moves the decade", async () => {
  await invoke('storyTime.set', { time: { year: 2030 } });
  await expect(page.getByTestId('status-time')).toContainText('Story time 2030');
  await rail(page, 'Cultural data').click();
  await expect(page.getByRole('tab', { name: 'Communities' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByRole('tab', { name: 'Writing tools' })).toHaveCount(0);
  // The first community opens on the story year's decade.
  await expect(culture().getByLabel('Community', { exact: true })).toHaveValue('portland');
  await expect(culture().getByTestId('culture-heading')).toHaveText('Portland in the 2030s');
  // Every age group has a place, everyone first; both Portland lines touch the 2030s.
  await expect(culture().locator('section[data-demographic] h4')).toHaveText([
    'Everyone',
    'Ages 0 to 18',
    'Ages 18 to 30',
    'Ages 30 to 50',
    'Ages 50 to 70',
    'Ages 70 and over',
  ]);
  await expect(group('all').locator('.cu-line')).toHaveCount(2);
  await expect(lineOf('CU3').getByTestId('line-text')).toHaveValue('Sunday ferry picnics');
  await expect(lineOf('CU3').getByTestId('line-span')).toHaveText('2000 to 2034');
  await expect(lineOf('CU4').getByTestId('line-span')).toHaveText('2035 to 2100');
  await expect(lineOf('CU3').getByTestId('line-note')).toHaveValue(/ride the river ferry/);
  await expect(lineOf('CU3').getByTestId('line-group')).toHaveValue('all');
  await expect(lineOf('CU3').getByTestId('line-decade')).toHaveValue('2000');
  // No decade picker: the year at the top moves the decade.
  await expect(culture().getByLabel('Decade', { exact: true })).toHaveCount(0);
  await invoke('storyTime.set', { time: { year: 2047 } });
  await expect(culture().getByTestId('culture-heading')).toHaveText('Portland in the 2040s');
  await expect(group('all').locator('.cu-line')).toHaveCount(1);
  await expect(lineOf('CU4')).toBeVisible();
  // Guangzhou in the 2040s: the planned mooncakes, not the canon ones.
  await culture().getByLabel('Community', { exact: true }).selectOption({ label: 'Guangzhou' });
  await expect(culture().getByTestId('culture-heading')).toHaveText('Guangzhou in the 2040s');
  await expect(lineOf('CU2')).toBeVisible();
  await expect(lineOf('CU1')).toHaveCount(0);
  // The description saves when the field is left, and one Undo takes it back (ED-3).
  await culture().getByLabel('About Guangzhou').fill('River city; the Lis came from here.');
  await culture().getByLabel('Community', { exact: true }).focus();
  await expect
    .poll(async () => (await notesOf()).guangzhou)
    .toBe('River city; the Lis came from here.');
  await page.keyboard.press('Meta+z');
  await expect.poll(async () => (await notesOf()).guangzhou).toBeUndefined();
  await expect(culture().getByLabel('About Guangzhou')).toHaveValue('');
});

test('CU-1 A42 ED-3 a line is added under an age group with Enter, edited directly, moved by its age group and decade selects, given a note, and removed, each one undo step', async () => {
  await culture().getByLabel('Community', { exact: true }).selectOption({ label: 'Portland' });
  await expect(culture().getByTestId('culture-heading')).toHaveText('Portland in the 2040s');
  const add = group('18-30').getByLabel('New line for ages 18 to 30 in the 2040s');
  await add.fill('Apprenticeships at the shipyard');
  await add.press('Enter');
  const made = async () =>
    (await invoke('entry.list', { collection: 'culturalEntries', trash: 'exclude' })).entries.find(
      (e) => e.entry.title === 'Apprenticeships at the shipyard',
    )?.entry;
  await expect.poll(made).toMatchObject({
    communityId: 'portland',
    demographic: '18-30',
    startYear: 2040,
    endYear: 2049,
    status: 'idea',
  });
  const id = (await made())!._id;
  const entry = async () =>
    (await invoke('entry.get', { collection: 'culturalEntries', id })).entry;
  const line = () => lineOf(id);
  await expect(line()).toBeVisible();
  await expect(line().getByTestId('line-span')).toHaveCount(0);
  await expect(line().getByTestId('line-note')).toHaveCount(0);
  await expect(add).toHaveValue('');
  // The text is a field: type and press Enter.
  await line().getByTestId('line-text').fill('Shipyard apprenticeships');
  await line().getByTestId('line-text').press('Enter');
  await expect.poll(async () => (await entry()).title).toBe('Shipyard apprenticeships');
  // The age group select moves it to another group.
  await line().getByTestId('line-group').selectOption('30-50');
  await expect(group('30-50').locator(`.cu-line[data-id="${id}"]`)).toBeVisible();
  await expect(group('18-30').locator(`.cu-line[data-id="${id}"]`)).toHaveCount(0);
  await expect.poll(async () => (await entry()).demographic).toBe('30-50');
  // The decade select moves it out of this decade entirely.
  await line().getByTestId('line-decade').selectOption('2050');
  await expect.poll(entry).toMatchObject({ startYear: 2050, endYear: 2059 });
  await expect(line()).toHaveCount(0);
  await invoke('storyTime.set', { time: { year: 2055 } });
  await expect(culture().getByTestId('culture-heading')).toHaveText('Portland in the 2050s');
  await expect(line()).toBeVisible();
  await expect(line().getByTestId('line-span')).toHaveCount(0);
  // A note written through the write path shows as a field and edits directly.
  await invoke('entry.update', {
    collection: 'culturalEntries',
    id,
    patch: { body: 'Union jobs.' },
  });
  await expect(line().getByTestId('line-note')).toHaveValue('Union jobs.');
  await line().getByTestId('line-note').fill('Union jobs for the first time since the flood.');
  await line().getByTestId('line-text').focus();
  await expect
    .poll(async () => (await entry()).body)
    .toBe('Union jobs for the first time since the flood.');
  // Remove moves it to the trash; Cmd+Z brings it back.
  await line().getByRole('button', { name: 'Remove Shipyard apprenticeships' }).click();
  await expect(line()).toHaveCount(0);
  await expect(culture().getByTestId('culture-notice')).toContainText(
    'Removed Shipyard apprenticeships',
  );
  await page.keyboard.press('Meta+z');
  await expect(line()).toBeVisible();
  // Then the note edit, the decade, the age group, the rename, and the add itself, one step each.
  await page.keyboard.press('Meta+z');
  await expect.poll(async () => (await entry()).body).toBe('Union jobs.');
  await page.keyboard.press('Meta+z');
  await expect.poll(async () => (await entry()).startYear).toBe(2040);
  await invoke('storyTime.set', { time: { year: 2047 } });
  await expect(line()).toBeVisible();
  await page.keyboard.press('Meta+z');
  await expect(group('18-30').locator(`.cu-line[data-id="${id}"]`)).toBeVisible();
  await page.keyboard.press('Meta+z');
  await expect(line().getByTestId('line-text')).toHaveValue('Apprenticeships at the shipyard');
  await page.keyboard.press('Meta+z');
  await expect(line()).toHaveCount(0);
});

test('A42 a community is added, renamed, and removed with its lines, and Undo brings them back', async () => {
  await culture().getByLabel('New community').fill('San Francisco');
  await culture().getByRole('button', { name: 'Add community' }).click();
  await expect(culture().getByLabel('Community', { exact: true })).toHaveValue('san-francisco');
  await expect(culture().getByTestId('culture-heading')).toContainText('San Francisco in the');
  await expect(culture().getByLabel('About San Francisco')).toBeVisible();
  // Rename in place; the select follows.
  await culture().getByTestId('community-rename').click();
  await culture().getByLabel('Name of San Francisco').fill('SF Bay');
  await page.keyboard.press('Enter');
  await expect(culture().getByLabel('Community', { exact: true })).toContainText('SF Bay');
  await expect(culture().getByTestId('culture-heading')).toContainText('SF Bay in the');
  // Two lines, then Remove: one confirmation, then the community and its lines go together.
  for (const t of ['Fog season', 'Ferry commutes']) {
    const add = group('all').getByLabel(/^New line for everyone/);
    await add.fill(t);
    await add.press('Enter');
    await expect(
      group('all')
        .locator('.cu-line')
        .filter({ has: page.locator(`input[value="${t}"]`) }),
    ).toHaveCount(1);
  }
  const titles = async () =>
    (await invoke('entry.list', { collection: 'culturalEntries', trash: 'exclude' })).entries
      .filter((e) => e.entry.communityId === 'san-francisco')
      .map((e) => e.entry.title)
      .sort();
  await expect.poll(titles).toEqual(['Ferry commutes', 'Fog season']);
  await culture().getByTestId('community-remove').click();
  const confirm = culture().getByTestId('community-confirm');
  await expect(confirm).toContainText('Remove SF Bay and its 2 lines? They go to the trash.');
  await confirm.getByRole('button', { name: 'Remove SF Bay' }).click();
  await expect(confirm).toHaveCount(0);
  await expect(culture().getByTestId('culture-notice')).toContainText(
    'Removed SF Bay and its 2 lines',
  );
  await expect(culture().getByLabel('Community', { exact: true })).not.toContainText('SF Bay');
  await expect.poll(titles).toEqual([]);
  // One Undo: the community is back in the list with both lines.
  await page.keyboard.press('Meta+z');
  await expect(culture().getByLabel('Community', { exact: true })).toContainText('SF Bay');
  await expect.poll(titles).toEqual(['Ferry commutes', 'Fog season']);
  await culture().getByLabel('Community', { exact: true }).selectOption({ label: 'SF Bay' });
  await expect(group('all').locator('.cu-line')).toHaveCount(2);
  await invoke('storyTime.set', { time: { year: 2030 } });
});

test("SM-11 WE-2 the Eras tab shows the story year's era, edits it in place as one undo step, flags a gap, and New era adds one", async () => {
  await screenTab(page, 'Cultural data', 'Eras');
  const eras = page.getByTestId('eras-view');
  const rows = eras.locator('li[data-era]');
  // Only the era of the story year (2030, set above) is shown, and it is marked.
  await expect(rows).toHaveCount(1);
  await expect(eras.locator('li[data-era="ERA-2030"]')).toHaveAttribute('aria-current', 'date');
  await expect(eras.getByTestId('era-gap')).toHaveCount(0);
  // Moving the story year moves the era.
  await invoke('storyTime.set', { time: { year: 2045 } });
  await expect(rows).toHaveCount(1);
  const forties = eras.locator('li[data-era="ERA-2040"]');
  await expect(forties.getByLabel('Era name')).toHaveValue('The forties');
  await expect(forties.getByLabel('Start year')).toHaveValue('2040');
  await expect(forties.getByLabel('End year')).toHaveValue('2049');
  await expect(forties.getByLabel('What the world is like')).toHaveValue(
    /Grid batteries everywhere\./,
  );
  // Name and body are saved through the write path when the field is left.
  await forties.getByLabel('Era name').fill('The battery forties');
  await forties.getByLabel('What the world is like').focus();
  await expect
    .poll(
      async () => (await invoke('entry.get', { collection: 'eraStates', id: 'ERA-2040' })).entry,
    )
    .toMatchObject({ name: 'The battery forties', title: 'The battery forties' });
  await expect((await changes(page)).locator('li').first()).toHaveText(
    'Era name on The battery forties',
  );
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect
    .poll(
      async () =>
        (await invoke('entry.get', { collection: 'eraStates', id: 'ERA-2040' })).entry.name,
    )
    .toBe('The forties');
  await expect(forties.getByLabel('Era name')).toHaveValue('The forties');
  // WE-2: an end year that leaves the story year uncovered is flagged and still saved, and
  // the row stays on screen.
  await forties.getByLabel('End year').fill('2044');
  await forties.getByLabel('End year').press('Enter');
  await expect(eras.getByTestId('era-gap')).toContainText('No era covers 2045.');
  await expect(forties).toBeVisible();
  expect(
    (await invoke('entry.get', { collection: 'eraStates', id: 'ERA-2040' })).entry.endYear,
  ).toBe(2044);
  await invoke('entry.update', {
    collection: 'eraStates',
    id: 'ERA-2040',
    patch: { endYear: 2049 },
  });
  await expect(eras.getByTestId('era-gap')).toHaveCount(0);
  // New era starts after the last one, with its name ready to type.
  await eras.getByRole('button', { name: 'New era', exact: true }).click();
  await expect(rows).toHaveCount(2);
  const fresh = rows.last();
  await expect(fresh.getByLabel('Era name')).toBeFocused();
  await expect(fresh.getByLabel('Start year')).toHaveValue('2101');
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('After the century');
  // Tab saves the name and moves on; the save does not rebuild the row, so focus stays and
  // what is typed while it is written is kept.
  await page.keyboard.press('Tab');
  const start = fresh.getByLabel('Start year');
  await expect(start).toBeFocused();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('2102');
  const freshId = String(await fresh.getAttribute('data-era'));
  await expect
    .poll(
      async () => (await invoke('entry.get', { collection: 'eraStates', id: freshId })).entry.name,
    )
    .toBe('After the century');
  await expect(start).toBeFocused();
  await expect(start).toHaveValue('2102');
  await expect(fresh.getByLabel('Era name')).toHaveValue('After the century');
  await page.keyboard.press('Enter');
  await expect
    .poll(async () => (await invoke('entry.get', { collection: 'eraStates', id: freshId })).entry)
    .toMatchObject({ name: 'After the century', title: 'After the century', startYear: 2102 });
  await expect(start).toBeFocused();
  // One undo step each, newest first, after the step that made the era.
  const history = (await changes(page)).locator('li');
  await expect(history.nth(0)).toHaveText('Start year on After the century');
  await expect(history.nth(1)).toHaveText('Era name on After the century');
  await expect(history.nth(2)).toHaveText('Created New era');
  await page.keyboard.press('Escape');
  await invoke('storyTime.set', { time: { year: 2030 } });
});

test('WE-2 with no era for the story year, New era fills the gap around it', async () => {
  await invoke('storyTime.set', { time: { year: 2150 } });
  await screenTab(page, 'Cultural data', 'Eras');
  const eras = page.getByTestId('eras-view');
  await expect(eras.getByTestId('era-gap')).toContainText('No era covers 2150.');
  await expect(eras.locator('li[data-era]')).toHaveCount(0);
  await eras.getByRole('button', { name: 'New era for 2150' }).click();
  const fresh = eras.locator('li[data-era]');
  await expect(fresh).toHaveCount(1);
  await expect(fresh).toHaveAttribute('aria-current', 'date');
  const start = Number(await fresh.getByLabel('Start year').inputValue());
  expect(start).toBeLessThanOrEqual(2150);
  expect(Number(await fresh.getByLabel('End year').inputValue())).toBeGreaterThanOrEqual(2150);
  await expect(eras.getByTestId('era-gap')).toHaveCount(0);
  await invoke('storyTime.set', { time: { year: 2030 } });
});

test('SM-11 WE-2 a new bible shows its seeded default eras on the Eras tab', async () => {
  await invoke('bible.create', { slug: 'knowledge-eras', name: 'Knowledge eras' });
  await invoke('bible.open', { slug: 'knowledge-eras' });
  await expect(page.getByTestId('workspace')).toBeVisible();
  const seeded = (await invoke('entry.list', { collection: 'eraStates', trash: 'exclude' }))
    .entries;
  expect(seeded.length).toBeGreaterThan(0);
  const first = [...seeded].sort(
    (a, b) => Number(a.entry.startYear) - Number(b.entry.startYear),
  )[0]!;
  await invoke('storyTime.set', { time: { year: Number(first.entry.startYear) } });
  await screenTab(page, 'Cultural data', 'Eras');
  const eras = page.getByTestId('eras-view');
  await expect(
    eras.locator(`li[data-era="${first.entry._id}"]`).getByLabel('Era name'),
  ).toHaveValue(String(first.entry.name));
  await expect(eras).toContainText(`${seeded.length} eras in all`);
  await openBible();
});

test('SL-1 closing the app asks where you stopped, saves the note, and the next launch shows it first', async () => {
  test.setTimeout(180_000);
  await app.close();
  ({ app, page } = await launch(db, { NOVEL_COMPANION_SKIP_STOP_PROMPT: '0' }));
  invoke = invokeVia(page);
  await openBible();
  // The newest note from the earlier session log test is already on the launch panel.
  await expect(page.getByTestId('launch-note')).toHaveText('End of chapter 2');
  await page.getByTestId('launch-panel').getByRole('button', { name: 'Start working' }).click();
  await expect(page.getByTestId('launch-panel')).toHaveCount(0);

  // Window close: the prompt appears, and "Keep working" cancels it.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
  const prompt = page.getByTestId('stop-prompt');
  await expect(prompt.getByRole('heading', { name: 'Where did you stop?' })).toBeVisible();
  // Only the window is closing, so the buttons say close, not quit.
  await expect(prompt.getByRole('button', { name: 'Close without a note' })).toBeVisible();
  await prompt.getByLabel('Where did you stop?', { exact: true }).fill('A note');
  await expect(prompt.getByRole('button', { name: 'Save note and close' })).toBeVisible();
  await expect(prompt.getByRole('button', { name: /quit/i })).toHaveCount(0);
  await prompt.getByRole('button', { name: 'Keep working' }).click();
  await expect(prompt).toHaveCount(0);
  await expect(page.getByTestId('workspace')).toBeVisible();

  // Quit (what Cmd+Q does): answer, and the note is saved before the app exits.
  const closing = app.close();
  await expect(prompt).toBeVisible();
  await expect(prompt.getByRole('button', { name: 'Quit without a note' })).toBeVisible();
  await prompt
    .getByLabel('Where did you stop?', { exact: true })
    .fill('Iris is opening the box in the attic.');
  await expect(prompt.getByRole('button', { name: 'Save note and quit' })).toBeVisible();
  await prompt.getByLabel('Chapter (optional)').selectOption('CH6');
  await prompt.getByRole('button', { name: 'Save note and quit' }).click();
  await closing;

  ({ app, page } = await launch(db, { NOVEL_COMPANION_SKIP_STOP_PROMPT: '0' }));
  invoke = invokeVia(page);
  await openBible();
  const panel = page.getByTestId('launch-panel');
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId('launch-note')).toHaveText(
    'Iris is opening the box in the attic.',
  );
  await expect(panel).toContainText('The Letter');
  const latest = (await invoke('sessionLog.latest', {})).log!;
  expect(latest.stoppedAt).toBe('Iris is opening the box in the attic.');
  await panel.getByRole('button', { name: 'Start working' }).click();
  await expect(panel).toHaveCount(0);

  // Leaving the answer empty still quits, and writes no log.
  const before = (await invoke('entry.list', { collection: 'sessionLogs', trash: 'exclude' }))
    .entries.length;
  const quitting = app.close();
  const emptyPrompt = page.getByTestId('stop-prompt');
  await expect(emptyPrompt).toBeVisible();
  await expect(emptyPrompt.getByRole('button', { name: 'Quit without a note' })).toBeVisible();
  await emptyPrompt.getByRole('button', { name: 'Quit without a note' }).click();
  await quitting;
  ({ app, page } = await launch(db));
  invoke = invokeVia(page);
  await openBible();
  expect(
    (await invoke('entry.list', { collection: 'sessionLogs', trash: 'exclude' })).entries,
  ).toHaveLength(before);
});

test('SL-1 a page that never answers cannot trap the window: it closes after the wait with no log written', async () => {
  test.setTimeout(120_000);
  await app.close();
  // A short wait for the test; a real app waits 10 seconds.
  ({ app, page } = await launch(db, {
    NOVEL_COMPANION_SKIP_STOP_PROMPT: '0',
    NOVEL_COMPANION_STOP_PROMPT_TIMEOUT_MS: '1500',
  }));
  invoke = invokeVia(page);
  await openBible();
  const logs = async () =>
    (await invoke('entry.list', { collection: 'sessionLogs', trash: 'exclude' })).entries.length;
  const before = await logs();
  // Hang the page: its script is busy for longer than the wait, so it cannot show the prompt.
  void page
    .evaluate(() => {
      const end = Date.now() + 8_000;
      while (Date.now() < end) {
        // busy
      }
    })
    .catch(() => undefined);
  const started = Date.now();
  const closed = new Promise<void>((resolve) => app.process().once('exit', () => resolve()));
  await app.evaluate(({ app: electron }) => electron.quit()).catch(() => undefined);
  await closed;
  const waited = Date.now() - started;
  expect(waited).toBeGreaterThanOrEqual(1_400);
  expect(waited).toBeLessThan(7_500);
  ({ app, page } = await launch(db));
  invoke = invokeVia(page);
  await openBible();
  expect(await logs()).toBe(before);
});
