import { expect, test } from '@playwright/test';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import type { Invoke } from '../helpers/t5';
import { readFixture } from '../helpers/loadFixture';
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
  seedFixture,
} from './helpers';
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
    await seedFixture(
      invoke,
      fixture[c]!.map((d) => ({ collection: c as never, data: strip(d) })),
    );
  }
});

test.afterAll(async () => {
  // Exit directly: a failed SL-1 test may leave the stop prompt open, and close() would wait on it.
  await app?.evaluate(({ app: electron }) => electron.exit(0)).catch(() => undefined);
});

const sessions = () => page.getByTestId('questions-view');
const questions = () => sessions().getByTestId('questions-list');
const pick = (name: RegExp | string) => questions().getByRole('button', { name });
/** A43: a log or a question opens in place, under its row. */
const rowEditor = () => sessions().getByTestId('session-row-editor');
const saved = () => expect(rowEditor().getByTestId('autosave')).toHaveText('Saved');
const questionRows = () => questions().locator('.entry-row');

test('OQ-1 SM-11 on Questions, an open question is made, marked decided, warns until it has a decision, and filters by state', async () => {
  await rail(page, 'Questions').click();
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
  await field(editor, 'decision')
    .locator(':scope > .rich-text [role="textbox"]')
    .fill('Peter wrote it in 2029.');
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
  // A question links to any entry from the Links field.
  const stored = (
    await invoke('entry.list', { collection: 'openQuestions', trash: 'exclude' })
  ).entries.find((e) => e.entry.title === 'Who wrote the second letter?')!;
  expect(stored.entry).toMatchObject({ state: 'decided', decision: 'Peter wrote it in 2029.' });
});

test('SR-1 one search box finds entries, chapter text, and Chinese by characters and by tone-free romanization', async () => {
  const box = page.getByRole('searchbox', { name: 'Search the bible' });
  const results = page.getByTestId('search-results');
  await box.fill('casseroles');
  await expect(results).toContainText('After the Funeral');
  await box.fill('晓曦');
  await expect(results).toContainText('晓曦');
  await box.fill('tuanyuan');
  await expect(results).toContainText('团圆');
  await box.fill('family reunion');
  await expect(results).toContainText('团圆');
  await box.fill('qqqqzzzz');
  await expect(page.getByTestId('search-empty')).toBeVisible();
  // Picking a result opens the entry: SM-3, Iris's voice moment, which opens on Backstory in her
  // timeline with its dialog (A50: moments have one door).
  await box.fill('Guarded');
  await results.locator('[data-hit="H5-voice-0"]').click();
  await expect(page.getByTestId('moment-dialog')).toHaveAttribute('data-id', 'H5-voice-0');
  await expect(page.getByTestId('backstory-grid')).toHaveClass(/\bbs-person\b/);
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

/** Out of every field, so Cmd+Z steps the app history (ED-3). */
async function leaveFields(): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

/** IP-1: pick a choice in an `Editable` select; it saves on the pick and closes. */
async function pickEditable(f: Locator, value: string): Promise<void> {
  await openEditable(f);
  const select = f.locator('select');
  await select.selectOption(value);
  await expect(select).toHaveCount(0);
}

/** IP-1: type into an `Editable` rich field and save it with Cmd+Enter. */
async function fillRich(f: Locator, text: string): Promise<void> {
  if ((await f.getByRole('textbox').count()) === 0) await f.locator('.editable-text').click();
  const box = f.getByRole('textbox');
  await box.fill(text);
  await box.press('Meta+Enter');
  await expect(f.getByRole('textbox')).toHaveCount(0);
}

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
  await expect(lineOf('CU3').getByTestId('line-text-text')).toHaveText('Sunday ferry picnics');
  await expect(lineOf('CU3').getByTestId('line-span')).toHaveText('2000 to 2034');
  await expect(lineOf('CU4').getByTestId('line-span')).toHaveText('2035 to 2100');
  await expect(lineOf('CU3').getByTestId('line-note-text')).toHaveText(/ride the river ferry/);
  // IP-1, IP-10: the age group and the years are fields that read as text until picked.
  await expect(lineOf('CU3').getByTestId('line-group-text')).toHaveText('Everyone');
  await expect(lineOf('CU3').getByTestId('line-unit-text')).toHaveText('2000s');
  await expect(lineOf('CU3').getByTestId('line-community-text')).toHaveText('Portland');
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
  await expect(culture().getByLabel('About Guangzhou')).toHaveText('');
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
  await fillEditable(line().getByTestId('line-text'), 'Shipyard apprenticeships');
  await expect.poll(async () => (await entry()).title).toBe('Shipyard apprenticeships');
  // The age group select moves it to another group.
  await pickEditable(line().getByTestId('line-group'), '30-50');
  await expect(group('30-50').locator(`.cu-line[data-id="${id}"]`)).toBeVisible();
  await expect(group('18-30').locator(`.cu-line[data-id="${id}"]`)).toHaveCount(0);
  await expect.poll(async () => (await entry()).demographic).toBe('30-50');
  // The decade select moves it out of this decade entirely.
  await pickEditable(line().getByTestId('line-unit'), '2050');
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
  await expect(line().getByTestId('line-note-text')).toHaveText('Union jobs.');
  await fillRich(line().getByTestId('line-note'), 'Union jobs for the first time since the flood.');
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
  await expect(line().getByTestId('line-text-text')).toHaveText('Apprenticeships at the shipyard');
  await page.keyboard.press('Meta+z');
  await expect(line()).toHaveCount(0);
});

test('A42 a community is added, renamed, and removed with its lines, and Undo brings them back', async () => {
  // IP-8: the select's Add new makes the community (the separate New community box is gone).
  await culture().getByLabel('Community', { exact: true }).selectOption('Add new...');
  await culture().getByLabel('Name of the new item for Communities').fill('San Francisco');
  await page.keyboard.press('Enter');
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
    await expect(group('all').locator('.cu-line').filter({ hasText: t })).toHaveCount(1);
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

const listLabels = async (listId: string) =>
  (await invoke('lists.get', {})).lists.find((l) => l._id === listId)!.items.map((i) => i.label);

test('IP-8 the Community select offers Add new, which creates the community as one undo step and picks it', async () => {
  await rail(page, 'Cultural data').click();
  const select = culture().getByLabel('Community', { exact: true });
  await select.selectOption({ label: 'Guangzhou' });
  await expect(select).toHaveValue('guangzhou');
  await expect(select.locator('option').last()).toHaveText('Add new...');
  // Escape puts the select back and adds nothing.
  await select.selectOption('Add new...');
  const name = culture().getByLabel('Name of the new item for Communities');
  await expect(name).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(select).toBeFocused();
  await expect(select).toHaveValue('guangzhou');
  // Enter adds Jinan to the list and picks it.
  await select.selectOption('Add new...');
  await name.fill('Jinan');
  await name.press('Enter');
  await expect(select).toHaveValue('jinan');
  await expect(select).toBeFocused();
  await expect(culture().getByTestId('culture-heading')).toContainText('Jinan in the');
  await expect.poll(() => listLabels('communities')).toContain('Jinan');
  await expect((await changes(page)).locator('li').first()).toHaveText(
    'Added Jinan to Communities',
  );
  await page.keyboard.press('Escape');
  // One Cmd+Z removes it, and the select goes back to Guangzhou.
  await leaveFields();
  await page.keyboard.press('Meta+z');
  await expect.poll(() => listLabels('communities')).not.toContain('Jinan');
  await expect(select).toHaveValue('guangzhou');
  await expect(select).not.toContainText('Jinan');
});

test('IP-8 GL-1 the romanization system select on Cultural data offers Add new, and the new system shows in Settings too', async () => {
  await rail(page, 'Romanization').click();
  const view = page.getByTestId('romanization-view');
  const field = view.getByTestId('romanization-systems-cantonese');
  const text = view.getByTestId('romanization-systems-cantonese-text');
  await expect(text).toHaveText('Jyutping');
  await openEditable(field);
  await field.locator('select').selectOption('Add new...');
  const name = field.getByLabel('Name of the new item for Romanization system for Cantonese');
  await name.fill('Yale');
  await name.press('Enter');
  await expect(text).toHaveText('Yale');
  const cantonese = async () =>
    (await invoke('romanization.get', {})).languages.find((l) => l.id === 'cantonese')?.systemId;
  const yaleId = async () =>
    (await invoke('lists.get', {})).lists
      .find((l) => l._id === 'romanizationSystems')!
      .items.find((i) => i.label === 'Yale')?.id;
  const yale = await yaleId();
  expect(yale).toBeTruthy();
  await expect.poll(cantonese).toBe(yale);
  await expect(view.getByTestId('romanization-no-checker')).toHaveText(
    'No checker for this system; terms are not flagged',
  );
  // The add and the pick are one undo step.
  await expect((await changes(page)).locator('li').first()).toHaveText(
    'Changed the romanization system for Cantonese',
  );
  await page.keyboard.press('Escape');
  // Settings draws the same choice.
  await rail(page, 'Settings').click();
  const inSettings = page.getByTestId('settings-romanization-cantonese-text');
  await expect(inSettings).toHaveText('Yale');
  // One Cmd+Z takes back both: Jyutping again, and Yale gone from the list.
  await leaveFields();
  await page.keyboard.press('Meta+z');
  await expect.poll(cantonese).toBe('cantonese');
  await expect.poll(() => listLabels('romanizationSystems')).not.toContain('Yale');
  await expect(inSettings).toHaveText('Jyutping');
  // One Shift+Cmd+Z puts both back, under the same item ID.
  await leaveFields();
  await page.keyboard.press('Meta+Shift+z');
  await expect.poll(yaleId).toBe(yale);
  await expect.poll(cantonese).toBe(yale);
  await expect(inSettings).toHaveText('Yale');
  // Back to Jyutping for the rows that follow.
  await leaveFields();
  await page.keyboard.press('Meta+z');
  await expect.poll(cantonese).toBe('cantonese');
  await rail(page, 'Romanization').click();
  await expect(text).toHaveText('Jyutping');
  await expect(view.getByTestId('romanization-no-checker')).toHaveCount(0);
});

const unitShown = () => culture().getByTestId('culture-unit');
const settingsUnit = async () => (await invoke('settings.get', {})).cultureUnit;

test("IP-10 the stepper starts at the story year's unit and moves by a decade, five years, and one year without moving the story year", async () => {
  await invoke('storyTime.set', { time: { year: 2047 } });
  await rail(page, 'Cultural data').click();
  await culture().getByLabel('Community', { exact: true }).selectOption({ label: 'Portland' });
  // A decade, from the story year's.
  await expect(unitShown()).toHaveText('2040s');
  await expect(culture().getByTestId('culture-heading')).toHaveText('Portland in the 2040s');
  await expect(culture().getByTestId('culture-to-story')).toHaveCount(0);
  await culture().getByRole('button', { name: 'Next: 2050s' }).click();
  await expect(unitShown()).toHaveText('2050s');
  await expect(culture().getByTestId('culture-heading')).toHaveText('Portland in the 2050s');
  await expect(page.getByTestId('status-time')).toContainText('Story time 2047');
  expect((await invoke('storyTime.get', {})).time?.year).toBe(2047);
  await culture().getByTestId('culture-prev').click();
  await culture().getByTestId('culture-prev').click();
  await expect(unitShown()).toHaveText('2030s');
  await expect(lineOf('CU3')).toBeVisible();
  await culture().getByTestId('culture-to-story').click();
  await expect(unitShown()).toHaveText('2040s');
  // After a step, a new story year does not move the stepper; Back to the story year goes to it.
  await culture().getByTestId('culture-next').click();
  await expect(unitShown()).toHaveText('2050s');
  await invoke('storyTime.set', { time: { year: 2063 } });
  await expect(page.getByTestId('status-time')).toContainText('Story time 2063');
  await expect(culture().getByTestId('culture-to-story')).toHaveText(
    'Back to the story year, 2060s',
  );
  await expect(unitShown()).toHaveText('2050s');
  await culture().getByTestId('culture-to-story').click();
  await expect(unitShown()).toHaveText('2060s');
  await expect(culture().getByTestId('culture-to-story')).toHaveCount(0);
  await invoke('storyTime.set', { time: { year: 2047 } });
  await expect(unitShown()).toHaveText('2040s');

  // Five years: the unit is a setting of the bible, chosen here, one undo step.
  await pickEditable(culture().getByTestId('culture-step-by'), 'five');
  await expect.poll(settingsUnit).toBe('five');
  await expect(unitShown()).toHaveText('2045 to 2049');
  await expect(culture().getByTestId('culture-heading')).toHaveText('Portland in 2045 to 2049');
  await culture().getByTestId('culture-next').click();
  await expect(unitShown()).toHaveText('2050 to 2054');
  await culture().getByTestId('culture-prev').click();
  await culture().getByTestId('culture-prev').click();
  await expect(unitShown()).toHaveText('2040 to 2044');
  // A line added here covers this unit only.
  const add = group('all').getByLabel('New line for everyone in 2040 to 2044');
  await add.fill('Water rationing posters');
  await add.press('Enter');
  const made = async () =>
    (await invoke('entry.list', { collection: 'culturalEntries', trash: 'exclude' })).entries.find(
      (e) => e.entry.title === 'Water rationing posters',
    )?.entry;
  await expect.poll(made).toMatchObject({ startYear: 2040, endYear: 2044 });
  await culture().getByTestId('culture-to-story').click();
  await expect(unitShown()).toHaveText('2045 to 2049');

  // One year.
  await pickEditable(culture().getByTestId('culture-step-by'), 'one');
  await expect.poll(settingsUnit).toBe('one');
  await expect(unitShown()).toHaveText('2047');
  await expect(culture().getByTestId('culture-heading')).toHaveText('Portland in 2047');
  await culture().getByTestId('culture-next').click();
  await expect(unitShown()).toHaveText('2048');
  await culture().getByTestId('culture-prev').click();
  await culture().getByTestId('culture-prev').click();
  await expect(unitShown()).toHaveText('2046');
  await expect(page.getByTestId('status-time')).toContainText('Story time 2047');

  // Each unit change is one step: Cmd+Z goes back to five years, then takes the
  // line out (the step between), then goes back to a decade.
  await leaveFields();
  await page.keyboard.press('Meta+z');
  await expect.poll(settingsUnit).toBe('five');
  await page.keyboard.press('Meta+z');
  await expect.poll(made).toBeUndefined();
  await page.keyboard.press('Meta+z');
  await expect.poll(settingsUnit).toBe('decade');
  await expect(unitShown()).toHaveText('2040s');
});

test('IP-10 IP-1 the age groups come from the list: a new item is a new group, a rename shows, and Add new on a line makes one in one step', async () => {
  await expect(culture().getByTestId('culture-heading')).toHaveText('Portland in the 2040s');
  const headings = () => culture().locator('section[data-demographic] h4');
  await invoke('lists.addItem', {
    listId: 'ageGroups',
    label: 'Ages 80 and over',
    parentId: null,
  });
  await expect(headings()).toHaveText([
    'Everyone',
    'Ages 0 to 18',
    'Ages 18 to 30',
    'Ages 30 to 50',
    'Ages 50 to 70',
    'Ages 70 and over',
    'Ages 80 and over',
  ]);
  await invoke('lists.rename', { listId: 'ageGroups', itemId: 'all', label: 'All ages' });
  await expect(headings().first()).toHaveText('All ages');
  // The line's age group select lists the same items, and Add new makes one.
  const line = lineOf('CU4');
  await openEditable(line.getByTestId('line-group'));
  const select = line.getByTestId('line-group').locator('select');
  await expect(select.locator('option')).toContainText(['All ages', 'Ages 80 and over']);
  await select.selectOption({ label: 'Add new...' });
  const name = line.getByLabel(`Name of the new item for Age group of Flood memorial walk`);
  await name.fill('Students');
  await name.press('Enter');
  const ageGroups = async () =>
    (await invoke('lists.get', {})).lists
      .find((l) => l._id === 'ageGroups')!
      .items.map((i) => i.label);
  await expect.poll(ageGroups).toContain('Students');
  const students = (await invoke('lists.get', {})).lists
    .find((l) => l._id === 'ageGroups')!
    .items.find((i) => i.label === 'Students')!.id;
  await expect
    .poll(
      async () =>
        (await invoke('entry.get', { collection: 'culturalEntries', id: 'CU4' })).entry.demographic,
    )
    .toBe(students);
  await expect(group(students).locator('.cu-line[data-id="CU4"]')).toBeVisible();
  // One Cmd+Z takes back the pick and the new item together.
  await leaveFields();
  await page.keyboard.press('Meta+z');
  await expect.poll(ageGroups).not.toContain('Students');
  await expect(group('all').locator('.cu-line[data-id="CU4"]')).toBeVisible();
  await invoke('lists.rename', { listId: 'ageGroups', itemId: 'all', label: 'Everyone' });
});

test('IP-6 IP-10 Add a note opens the note box on the line, and the note is one undo step', async () => {
  const add = group('50-70').getByLabel('New line for ages 50 to 70 in the 2040s');
  await add.fill('Night markets by the levee');
  await add.press('Enter');
  const made = async () =>
    (await invoke('entry.list', { collection: 'culturalEntries', trash: 'exclude' })).entries.find(
      (e) => e.entry.title === 'Night markets by the levee',
    )?.entry;
  await expect.poll(made).toBeTruthy();
  const id = (await made())!._id;
  const line = lineOf(id);
  await expect(line.getByTestId('line-note')).toHaveCount(0);
  // Away from the pane's bottom edge, where the browser brings a caret into view.
  await line.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  const before = await line.boundingBox();
  await line.getByRole('button', { name: 'Add a note to Night markets by the levee' }).click();
  const box = line.getByTestId('line-note').getByRole('textbox');
  await expect(box).toBeFocused();
  // Opening the note moves nothing above it.
  expect((await line.boundingBox())!.y).toBe(before!.y);
  await box.fill('Started when the shops closed at six.');
  await box.press('Meta+Enter');
  await expect.poll(async () => (await made())?.body).toBe('Started when the shops closed at six.');
  await expect(line.getByTestId('line-note-text')).toHaveText(
    'Started when the shops closed at six.',
  );
  await expect(line.getByTestId('line-add-note')).toHaveCount(0);
  // One step: Cmd+Z takes the note out and Add a note is back; the line stays.
  await leaveFields();
  await page.keyboard.press('Meta+z');
  await expect.poll(async () => (await made())?.body ?? '').toBe('');
  await expect(line.getByTestId('line-add-note')).toBeVisible();
  await expect(line).toBeVisible();
  // Escape on an empty note box closes it with nothing saved.
  await line.getByTestId('line-add-note').click();
  await line.getByTestId('line-note').getByRole('textbox').press('Escape');
  await expect(line.getByTestId('line-note')).toHaveCount(0);
  await invoke('entry.delete', { collection: 'culturalEntries', id });
});

test('IP-13 the Places tab is the place tree: New place adds one, a name renames in place as one step, and Edit opens the rest', async () => {
  await screenTab(page, 'Cultural data', 'Places');
  const view = page.getByTestId('cultural-data').getByTestId('places-view');
  await expect(view.getByRole('heading', { name: 'Places' })).toBeVisible();
  await expect(view.locator('li[data-place="PLC2"]')).toHaveAttribute('data-depth', '1');
  await view.getByPlaceholder('Name of a new place').fill('Harbor Market');
  await view.getByRole('button', { name: 'New place' }).click();
  const placeId = async () =>
    (await invoke('entry.list', { collection: 'places', trash: 'exclude' })).entries.find((e) =>
      String(e.entry.title).startsWith('Harbo'),
    )?.entry._id;
  await expect.poll(placeId).toBeTruthy();
  const id = (await placeId())!;
  const row = view.locator(`li[data-place="${id}"]`);
  await expect(row.getByTestId('place-name-text')).toHaveText('Harbor Market');
  await fillEditable(row.getByTestId('place-name'), 'Harbour Market');
  await expect
    .poll(async () => (await invoke('entry.get', { collection: 'places', id })).entry.title)
    .toBe('Harbour Market');
  await leaveFields();
  await page.keyboard.press('Meta+z');
  await expect(row.getByTestId('place-name-text')).toHaveText('Harbor Market');
  // Edit opens the full editor under the row, for the parent and the descriptions.
  await row.getByRole('button', { name: 'Edit Harbor Market' }).click();
  await expect(row.getByTestId('place-editor')).toBeVisible();
  await row.getByTestId('place-editor').getByRole('button', { name: 'Close', exact: true }).click();
  await expect(row.getByTestId('place-editor')).toHaveCount(0);
  // Cmd+Z again takes the new place back out.
  await leaveFields();
  await page.keyboard.press('Meta+z');
  await expect(row).toHaveCount(0);
});

test('IP-13 the Glossary tab is the glossary table: New term adds one, and term, romanization, language and meaning edit in place', async () => {
  await screenTab(page, 'Cultural data', 'Glossary');
  const table = page.getByTestId('cultural-data').getByTestId('glossary-table');
  await expect(table.getByRole('heading', { name: 'Glossary' })).toBeVisible();
  await table.getByPlaceholder('Characters of a new term').fill('饺子');
  await table.getByRole('button', { name: 'New term' }).click();
  const term = async () =>
    (await invoke('entry.list', { collection: 'glossaryTerms', trash: 'exclude' })).entries.find(
      (e) => e.entry.title === '饺子' || e.entry.title === '水饺',
    )?.entry;
  await expect.poll(term).toBeTruthy();
  const id = (await term())!._id;
  const row = table.locator(`tr[data-term="${id}"]`);
  await expect(row.getByTestId('term-characters-text').locator('.zh-chars')).toHaveText('饺子');
  await fillEditable(row.getByTestId('term-romanization'), 'jiǎozi');
  await fillRich(row.getByTestId('term-meaning'), 'Dumplings, folded for the new year.');
  await fillEditable(row.getByTestId('term-characters'), '水饺');
  await expect.poll(term).toMatchObject({
    characters: '水饺',
    title: '水饺',
    romanization: 'jiǎozi',
    meaning: 'Dumplings, folded for the new year.',
  });
  // An existing term edits the same way: its romanization, and Cmd+Z puts it back.
  const gl3 = table.locator('tr[data-term="GL3"]');
  await fillEditable(gl3.getByTestId('term-romanization'), 'tuan2yuan2');
  await expect
    .poll(
      async () =>
        (await invoke('entry.get', { collection: 'glossaryTerms', id: 'GL3' })).entry.romanization,
    )
    .toBe('tuan2yuan2');
  await leaveFields();
  await page.keyboard.press('Meta+z');
  await expect(gl3.getByTestId('term-romanization-text')).toHaveText('tuányuán');
  await invoke('entry.delete', { collection: 'glossaryTerms', id });
  await screenTab(page, 'Cultural data', 'Communities');
});

test('NF-2 IP-10 the stepper and a line work from the keyboard, and the labels are in the primary text colour in both themes', async () => {
  await expect(culture().getByTestId('culture-heading')).toHaveText('Portland in the 2040s');
  // The stepper: Tab reaches Next, Enter steps.
  await culture().getByTestId('culture-prev').focus();
  await page.keyboard.press('Tab');
  await expect(culture().getByTestId('culture-next')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(unitShown()).toHaveText('2050s');
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Enter');
  await expect(unitShown()).toHaveText('2040s');
  // A line's text: focus, F2 opens it, type, Enter saves and the focus comes back.
  const text = lineOf('CU4').getByTestId('line-text').locator('.editable-text');
  await text.focus();
  await page.keyboard.press('F2');
  await page.keyboard.press('Meta+a');
  await page.keyboard.type('Flood memorial walks');
  await page.keyboard.press('Enter');
  await expect
    .poll(
      async () =>
        (await invoke('entry.get', { collection: 'culturalEntries', id: 'CU4' })).entry.title,
    )
    .toBe('Flood memorial walks');
  await expect(text).toBeFocused();
  await page.keyboard.press('Meta+z');
  await expect(lineOf('CU4').getByTestId('line-text-text')).toHaveText('Flood memorial walk');
  // Labels, group headings, the unit and every field read in the primary text colour.
  const theme0 = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
    const read = await culture().evaluate((el) => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--fg)';
      document.body.append(probe);
      const fg = getComputedStyle(probe).color;
      probe.remove();
      return {
        fg,
        colors: [
          ...el.querySelectorAll('h4, label, .cu-unit, .editable-text, .editable-label'),
        ].map((n) => getComputedStyle(n).color),
      };
    });
    expect(read.colors.length).toBeGreaterThan(10);
    for (const c of read.colors) expect(c, theme).toBe(read.fg);
  }
  await page.evaluate((t) => {
    if (t === null) document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', t);
  }, theme0);
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
  await expect(forties.getByLabel('What the world is like')).toHaveText(
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

test('BK-4 a page that never answers cannot trap the window: it closes after the two second flush wait', async () => {
  test.setTimeout(120_000);
  await app.close();
  ({ app, page } = await launch(db));
  invoke = invokeVia(page);
  await openBible();
  // Hang the page: its script is busy for longer than the wait, so it cannot answer the flush.
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
  expect(waited).toBeGreaterThanOrEqual(1_900);
  expect(waited).toBeLessThan(7_500);
  ({ app, page } = await launch(db));
  invoke = invokeVia(page);
  await openBible();
});
