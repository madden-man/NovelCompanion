import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import type { Invoke } from '../helpers/t5';
import { readFixture } from '../helpers/loadFixture';
import { field, fileDb, invokeVia, launch, rail, screenTab } from './helpers';
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
const inspector = () => page.getByTestId('inspector');
const saved = () => expect(inspector().getByTestId('autosave')).toHaveText('Saved');

test('OQ-1 SM-11 on Sessions, an open question is made, marked decided, warns until it has a decision, and filters by state', async () => {
  await rail(page, 'Sessions').click();
  await expect(sessions().getByTestId('questions-empty')).toHaveText('No questions yet.');
  for (const title of ['Who wrote the second letter?', 'Does Iris go back to Guangzhou?']) {
    await sessions().getByRole('button', { name: 'New question', exact: true }).click();
    const form = inspector().getByTestId('new-entry');
    await field(form, 'title').locator(':scope > input').fill(title);
    await form.getByRole('button', { name: 'Create open question' }).click();
    // The new question opens in the inspector, beside the list.
    await expect(
      inspector().getByTestId('editor').getByRole('heading', { name: title }),
    ).toBeVisible();
    await saved();
  }
  await pick(/Who wrote/).click();
  const editor = inspector().getByTestId('editor');
  await expect(pick(/Who wrote/)).toHaveAttribute('aria-current', 'true');
  await field(editor, 'state').locator(':scope > select').selectOption('decided');
  await saved();
  await expect(field(editor, 'decision')).toContainText('marked decided, but no decision');
  await field(editor, 'decision').locator(':scope > textarea').fill('Peter wrote it in 2029.');
  await saved();
  await expect(field(editor, 'decision')).not.toContainText('marked decided, but no decision');
  const show = sessions().getByLabel('Show questions');
  await expect(pick(/Who wrote/)).toContainText('decided');
  await expect(show.locator('option')).toHaveText(['All (2)', 'Open (1)', 'Decided (1)']);
  await show.selectOption('open');
  await expect(questions().getByRole('button')).toHaveCount(1);
  await expect(pick(/Does Iris go back/)).toBeVisible();
  await show.selectOption('decided');
  await expect(questions().getByRole('button')).toHaveCount(1);
  await expect(pick(/Who wrote/)).toBeVisible();
  await show.selectOption('all');
  await expect(questions().getByRole('button')).toHaveCount(2);
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
  // A log opens in the inspector, where its chapter, stop point and notes are edited.
  await rows.last().click();
  const editor = inspector().getByTestId('editor');
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

test('CU-1 SM-11 Cultural data lists every cultural entry by community with its years, the ones covering the year marked, and a row opens in the inspector', async () => {
  await invoke('storyTime.set', { time: { year: 2030 } });
  await expect(page.getByTestId('status-time')).toContainText('Story time 2030');
  await rail(page, 'Cultural data').click();
  await expect(page.getByRole('tab', { name: 'Communities' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  // The year starts at the story year.
  await expect(culture().getByLabel('Year')).toHaveValue('2030');
  const groups = culture().getByTestId('culture-communities').locator('section[data-community]');
  await expect(groups.locator('h4')).toHaveText(['Portland', 'Guangzhou']);
  const row = (id: string) => culture().locator(`.culture-row[data-id="${id}"]`);
  await expect(groups.nth(0).locator('.culture-row')).toHaveCount(2);
  await expect(row('CU3')).toContainText('Sunday ferry picnics');
  await expect(row('CU3')).toContainText('2000 to 2034');
  await expect(row('CU4')).toContainText('2035 to 2100');
  // Covering 2030: CU1 and CU3, marked; the others not.
  for (const [id, on] of [
    ['CU1', 'true'],
    ['CU2', 'false'],
    ['CU3', 'true'],
    ['CU4', 'false'],
  ] as const) {
    await expect(row(id)).toHaveAttribute('data-applies', on);
  }
  await expect(row('CU1')).toContainText('in 2030');
  await culture().getByLabel('Year').fill('2050');
  await expect(row('CU1')).toHaveAttribute('data-applies', 'false');
  await expect(row('CU2')).toHaveAttribute('data-applies', 'true');
  await row('CU4').click();
  await expect(inspector().getByTestId('editor')).toHaveAttribute('data-entry-id', 'CU4');
});

test('CU-2 SM-11 a community and a year list the cultural entries that apply', async () => {
  await culture().getByLabel('Community').selectOption({ label: 'Guangzhou' });
  await culture().getByLabel('Year').fill('2020');
  const results = culture().getByTestId('culture-results');
  await expect(results.locator('[data-entry]')).toHaveCount(1);
  await expect(results.locator('[data-entry="CU1"]')).toContainText('1980 to 2039');
  await culture().getByLabel('Year').fill('2045');
  await expect(results.locator('[data-entry]')).toHaveCount(1);
  await expect(results.locator('[data-entry="CU2"]')).toBeVisible();
  // Only Guangzhou is listed below while it is picked.
  await expect(culture().locator('section[data-community]')).toHaveCount(1);
  await culture().getByLabel('Year').fill('1900');
  await expect(culture().getByTestId('culture-empty')).toBeVisible();
  // Every community: what applies to each.
  await culture().getByLabel('Community').selectOption({ label: 'Every community' });
  await culture().getByLabel('Year').fill('2045');
  await expect(results.locator('[data-entry]')).toHaveCount(2);
  await results.getByRole('button', { name: 'Edit Flood memorial walk' }).click();
  await expect(inspector().getByTestId('editor')).toHaveAttribute('data-entry-id', 'CU4');
});

test('CU-1 SM-11 New entry on Cultural data makes a cultural entry for the community picked, open in the inspector', async () => {
  await culture().getByLabel('Community').selectOption({ label: 'Portland' });
  await culture().getByRole('button', { name: 'New entry', exact: true }).click();
  const form = inspector().getByTestId('new-entry');
  // The community is already decided, so the form does not ask for it.
  await expect(field(form, 'communityId')).toHaveCount(0);
  await field(form, 'title').locator(':scope > input').fill('Rooftop gardens');
  await form.getByRole('button', { name: 'Create cultural entry' }).click();
  const editor = inspector().getByTestId('editor');
  await expect(editor.getByRole('heading', { name: 'Rooftop gardens' })).toBeVisible();
  await field(editor, 'startYear').locator(':scope > input').fill('2040');
  await saved();
  const made = (
    await invoke('entry.list', { collection: 'culturalEntries', trash: 'exclude' })
  ).entries.find((e) => e.entry.title === 'Rooftop gardens')!;
  expect(made.entry).toMatchObject({ communityId: 'portland', startYear: 2040 });
  await expect(culture().locator(`.culture-row[data-id="${made.entry._id}"]`)).toContainText(
    'from 2040',
  );
});

test('SM-11 WE-2 the Eras tab lists the era states, edits one in place as one undo step, flags a gap, and New era adds one', async () => {
  await screenTab(page, 'Cultural data', 'Eras');
  const eras = page.getByTestId('eras-view');
  const rows = eras.locator('li[data-era]');
  await expect(rows).toHaveCount(8);
  await expect(eras.getByTestId('era-coverage-ok')).toBeVisible();
  const forties = eras.locator('li[data-era="ERA-2040"]');
  await expect(forties.getByLabel('Era name')).toHaveValue('The forties');
  await expect(forties.getByLabel('Start year')).toHaveValue('2040');
  await expect(forties.getByLabel('End year')).toHaveValue('2049');
  await expect(forties.getByLabel('What the world is like')).toHaveValue(
    /Grid batteries everywhere\./,
  );
  // The era of the story year (2030, set above) is marked.
  await expect(eras.locator('li[data-era="ERA-2030"]')).toHaveAttribute('aria-current', 'date');
  // Name and body are saved through the write path when the field is left.
  await forties.getByLabel('Era name').fill('The battery forties');
  await forties.getByLabel('What the world is like').focus();
  await expect
    .poll(
      async () => (await invoke('entry.get', { collection: 'eraStates', id: 'ERA-2040' })).entry,
    )
    .toMatchObject({ name: 'The battery forties', title: 'The battery forties' });
  await expect(page.getByTestId('undo-history').locator('li').first()).toHaveText(
    'Era name on The battery forties',
  );
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect
    .poll(
      async () =>
        (await invoke('entry.get', { collection: 'eraStates', id: 'ERA-2040' })).entry.name,
    )
    .toBe('The forties');
  await expect(eras.locator('li[data-era="ERA-2040"]').getByLabel('Era name')).toHaveValue(
    'The forties',
  );
  // WE-2: an end year that leaves a gap is flagged and still saved.
  const sixties = eras.locator('li[data-era="ERA-2060"]');
  await sixties.getByLabel('End year').fill('2065');
  await sixties.getByLabel('End year').press('Enter');
  await expect(eras.getByTestId('era-coverage')).toContainText('No era covers 2066 to 2069.');
  expect(
    (await invoke('entry.get', { collection: 'eraStates', id: 'ERA-2060' })).entry.endYear,
  ).toBe(2065);
  await invoke('entry.update', {
    collection: 'eraStates',
    id: 'ERA-2060',
    patch: { endYear: 2069 },
  });
  await expect(eras.getByTestId('era-coverage-ok')).toBeVisible();
  // New era starts after the last one, with its name ready to type.
  await eras.getByRole('button', { name: 'New era', exact: true }).click();
  await expect(rows).toHaveCount(9);
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
  await expect(page.getByTestId('undo-history').locator('li').nth(0)).toHaveText(
    'Start year on After the century',
  );
  await expect(page.getByTestId('undo-history').locator('li').nth(1)).toHaveText(
    'Era name on After the century',
  );
  await expect(page.getByTestId('undo-history').locator('li').nth(2)).toHaveText('Created New era');
});

test('SM-11 WE-2 a new bible shows its seeded default eras on the Eras tab', async () => {
  await invoke('bible.create', { slug: 'knowledge-eras', name: 'Knowledge eras' });
  await invoke('bible.open', { slug: 'knowledge-eras' });
  await expect(page.getByTestId('workspace')).toBeVisible();
  const seeded = (await invoke('entry.list', { collection: 'eraStates', trash: 'exclude' }))
    .entries;
  expect(seeded.length).toBeGreaterThan(0);
  await screenTab(page, 'Cultural data', 'Eras');
  const rows = page.getByTestId('eras-view').locator('li[data-era]');
  await expect(rows).toHaveCount(seeded.length);
  const first = [...seeded].sort(
    (a, b) => Number(a.entry.startYear) - Number(b.entry.startYear),
  )[0]!;
  await expect(rows.first().getByLabel('Era name')).toHaveValue(String(first.entry.name));
  await expect(page.getByTestId('eras-view').getByTestId('era-coverage-ok')).toBeVisible();
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
