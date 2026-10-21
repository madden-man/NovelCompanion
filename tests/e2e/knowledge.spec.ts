import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import type { EntryCollection } from '../../src/shared/schema';
import type { Invoke } from '../helpers/t5';
import { readFixture } from '../helpers/loadFixture';
import { field, fileDb, invokeVia, launch, rail, waitSaved } from './helpers';
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

const pick = (name: RegExp | string) =>
  page.getByTestId('entry-list').getByRole('button', { name });

test('OQ-1 an open question is marked decided, warns until it has a decision, and filters by state', async () => {
  await rail(page, 'Open questions').click();
  for (const title of ['Who wrote the second letter?', 'Does Iris go back to Guangzhou?']) {
    await page.getByRole('button', { name: 'New open question', exact: true }).click();
    const form = page.getByTestId('new-entry');
    await field(form, 'title').locator(':scope > input').fill(title);
    await form.getByRole('button', { name: 'Create open question' }).click();
    await expect(page.getByTestId('editor').getByRole('heading', { name: title })).toBeVisible();
    await waitSaved(page);
  }
  await pick(/Who wrote/).click();
  const editor = page.getByTestId('editor');
  await field(editor, 'state').locator(':scope > select').selectOption('decided');
  await waitSaved(page);
  await expect(field(editor, 'decision')).toContainText('marked decided, but no decision');
  await field(editor, 'decision').locator(':scope > textarea').fill('Peter wrote it in 2029.');
  await waitSaved(page);
  await expect(field(editor, 'decision')).not.toContainText('marked decided, but no decision');
  const show = page.getByLabel('Show questions');
  await expect(pick(/Who wrote/)).toContainText('decided');
  await show.selectOption('open');
  await expect(page.getByTestId('entry-list').getByRole('button')).toHaveCount(1);
  await expect(pick(/Does Iris go back/)).toBeVisible();
  await show.selectOption('decided');
  await expect(page.getByTestId('entry-list').getByRole('button')).toHaveCount(1);
  await expect(pick(/Who wrote/)).toBeVisible();
  await show.selectOption('all');
  await expect(page.getByTestId('entry-list').getByRole('button')).toHaveCount(2);
  // A question links to any entry from the Links field.
  const stored = (
    await invoke('entry.list', { collection: 'openQuestions', trash: 'exclude' })
  ).entries.find((e) => e.entry.title === 'Who wrote the second letter?')!;
  expect(stored.entry).toMatchObject({ state: 'decided', decision: 'Peter wrote it in 2029.' });
});

test('SL-1 a session log is listed newest first, and each entry has date, chapter, stop point, and notes', async () => {
  await rail(page, 'Session log').click();
  await page.getByRole('button', { name: 'New session log', exact: true }).click();
  const form = page.getByTestId('new-entry');
  await field(form, 'title').locator(':scope > input').fill('Morning session');
  await field(form, 'date').locator(':scope > input').fill('2026-10-01');
  await form.getByRole('button', { name: 'Create session log' }).click();
  const editor = page.getByTestId('editor');
  await expect(editor.getByRole('heading', { name: 'Morning session' })).toBeVisible();
  await waitSaved(page);
  await field(editor, 'chapterId').locator(':scope > select').selectOption('CH2');
  await field(editor, 'stoppedAt').locator(':scope > textarea').fill('Daniel burns the rice');
  await field(editor, 'notes').locator(':scope > textarea').fill('Check the kitchen timeline');
  await waitSaved(page);
  await invoke('entry.create', {
    collection: 'sessionLogs',
    data: {
      title: 'Later session',
      status: 'canon',
      date: '2026-10-05',
      stoppedAt: 'End of chapter 2',
    },
  });
  const rows = page.getByTestId('entry-list').getByRole('button');
  await expect(rows.first()).toContainText('Later session');
  await expect(rows.last()).toContainText('Morning session');
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

const KB5: EntryCollection[] = ['culturalEntries', 'places', 'glossaryTerms', 'openQuestions'];

const entriesView = () => page.getByTestId('entries-view');
const entryRows = () => entriesView().getByTestId('entries-list').locator('.entries-row');
const chip = (name: string) =>
  entriesView().getByRole('group', { name: 'Kinds' }).getByRole('button', { name, exact: true });

async function liveEntries() {
  const out: { collection: EntryCollection; entry: Record<string, unknown> }[] = [];
  for (const collection of KB5) {
    const { entries } = await invoke('entry.list', { collection, trash: 'exclude' });
    for (const e of entries) out.push({ collection, entry: e.entry });
  }
  return out;
}

test('KB-5 the Entries list shows every kind together, newest change first, and a row opens the editor beside it', async () => {
  await rail(page, 'Entries').click();
  await expect(entriesView().getByRole('tab', { name: 'Entries' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  const all = await liveEntries();
  await expect(entryRows()).toHaveCount(all.length);
  // A39: no facts, themes, or custom entries; the fixture has no open questions.
  for (const kind of ['culturalEntries', 'places', 'glossaryTerms']) {
    await expect(entriesView().locator(`.entries-row[data-kind="${kind}"]`).first()).toBeVisible();
  }
  const newest = [...all].sort((a, b) =>
    String(b.entry.modifiedAt).localeCompare(String(a.entry.modifiedAt)),
  )[0]!;
  await expect(entryRows().first()).toHaveAttribute('data-id', String(newest.entry._id));
  // Each row shows kind, title, status, and the first line.
  const picnic = entriesView().locator('.entries-row[data-id="CU3"]');
  await expect(picnic.locator('.entries-kind')).toHaveText('Cultural entry');
  await expect(picnic.locator('.entry-title')).toHaveText('Sunday ferry picnics');
  await expect(picnic.locator('.chip')).toHaveText('Canon');
  await picnic.click();
  await expect(page.getByTestId('editor')).toHaveAttribute('data-entry-id', 'CU3');
  await expect(picnic).toHaveAttribute('aria-current', 'true');
});

test('KB-5 a kind chip hides its kind, and several chips can be off at once', async () => {
  const all = await liveEntries();
  const count = (c: EntryCollection) => all.filter((r) => r.collection === c).length;
  await expect(chip('Glossary')).toHaveAttribute('aria-pressed', 'true');
  await chip('Glossary').click();
  await expect(chip('Glossary')).toHaveAttribute('aria-pressed', 'false');
  await expect(entriesView().locator('.entries-row[data-kind="glossaryTerms"]')).toHaveCount(0);
  await expect(entryRows()).toHaveCount(all.length - count('glossaryTerms'));
  await chip('Places').click();
  await expect(entriesView().locator('.entries-row[data-kind="places"]')).toHaveCount(0);
  await expect(entryRows()).toHaveCount(all.length - count('glossaryTerms') - count('places'));
  await chip('Glossary').click();
  await chip('Places').click();
  await expect(entryRows()).toHaveCount(all.length);
});

test('KB-5 the status filter and the search box narrow the list', async () => {
  const view = entriesView();
  const all = await liveEntries();
  await view.getByLabel('Show status').selectOption('planned');
  await expect(entryRows()).toHaveCount(all.filter((r) => r.entry.status === 'planned').length);
  for (const status of await entryRows().locator('.chip').allTextContents()) {
    expect(status).toBe('Planned');
  }
  await view.getByLabel('Show status').selectOption('');
  const box = view.getByLabel('Search entries');
  await box.fill('picnics');
  await expect(view.locator('.entries-row[data-id="CU3"]')).toBeVisible();
  await expect(view.locator('.entries-row[data-id="CU1"]')).toHaveCount(0);
  // Body text counts, not only titles: CU1's generation notes were folded into its body (SM-4).
  await box.fill('homemade');
  await expect(entryRows()).toHaveCount(1);
  await expect(entryRows().first()).toHaveAttribute('data-id', 'CU1');
  // Chapter text is not an entry here.
  await box.fill('casseroles');
  await expect(entryRows()).toHaveCount(0);
  await expect(view.getByTestId('entries-empty')).toBeVisible();
  // The search channel finds a glossary term by tone-free romanization (SR-1, GL-2).
  await box.fill('tuanyuan');
  await expect(entryRows()).toHaveCount(1);
  await expect(entryRows().first()).toContainText('团圆');
  await box.fill('');
  await expect(entryRows()).toHaveCount(all.length);
});

test('KB-5 New entry picks a kind on the same screen, and the created entry appears first, open beside the list', async () => {
  const view = entriesView();
  await view.getByRole('button', { name: 'New entry', exact: true }).click();
  const picker = page.getByTestId('kind-picker');
  for (const kind of ['Cultural entry', 'Place', 'Glossary term', 'Open question']) {
    await expect(picker.getByRole('button', { name: kind, exact: true })).toBeVisible();
  }
  await expect(
    picker.getByRole('group', { name: 'Kind of entry' }).getByRole('button'),
  ).toHaveCount(4);
  await picker.getByRole('button', { name: 'Place', exact: true }).click();
  const form = page.getByTestId('new-entry');
  await field(form, 'title').locator(':scope > input').fill('The ferry stops at midnight');
  await form.getByRole('button', { name: 'Create place' }).click();
  const editor = page.getByTestId('editor');
  await expect(editor.getByRole('heading', { name: 'The ferry stops at midnight' })).toBeVisible();
  await expect(entryRows().first()).toContainText('The ferry stops at midnight');
  await expect(entryRows().first()).toHaveAttribute('aria-current', 'true');
  await expect(entryRows().first()).toHaveAttribute('data-kind', 'places');
});

test('KB-5 the four tabs render their views, answer the keyboard, and the tab is remembered for the bible', async () => {
  const tabs = entriesView().getByRole('tablist', { name: 'Entries screens' });
  const tab = (name: string) => tabs.getByRole('tab', { name, exact: true });
  await tab('Entries').focus();
  await page.keyboard.press('ArrowRight');
  await expect(tab('Culture by year')).toHaveAttribute('aria-selected', 'true');
  await expect(tab('Culture by year')).toBeFocused();
  await expect(page.getByTestId('culture-view')).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('places-view')).toBeVisible();
  await page.getByTestId('places-view').getByRole('button', { name: 'Portland' }).first().click();
  await expect(page.getByTestId('inspector').getByTestId('editor')).toContainText('Portland');
  // A term that breaks the Mandarin system, so Romanization lists one to open.
  const flagged = await invoke('entry.create', {
    collection: 'glossaryTerms',
    data: {
      title: '广东',
      characters: '广东',
      language: 'mandarin',
      romanization: 'gwong2dung1',
      status: 'canon',
    },
  });
  await tab('Place tree').focus();
  await page.keyboard.press('ArrowRight');
  const roman = page.getByTestId('romanization-view');
  await expect(roman).toBeVisible();
  await roman.getByTestId('romanization-flagged').getByRole('button', { name: '广东' }).click();
  await expect(page.getByTestId('inspector').getByTestId('editor')).toHaveAttribute(
    'data-entry-id',
    flagged.entry._id,
  );
  await tab('Romanization').focus();
  await page.keyboard.press('End');
  await expect(tab('Glossary table')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('glossary-table')).toBeVisible();
  await page.getByRole('button', { name: 'Edit 团圆' }).click();
  await expect(page.getByTestId('inspector').getByTestId('editor')).toContainText('团圆');

  // Remembered: another screen and back, and a reload, keep the Glossary table.
  await rail(page, 'Characters').click();
  await rail(page, 'Entries').click();
  await expect(tab('Glossary table')).toHaveAttribute('aria-selected', 'true');
  await page.reload();
  await expect(page.getByTestId('workspace')).toBeVisible();
  await rail(page, 'Entries').click();
  await expect(tab('Glossary table')).toHaveAttribute('aria-selected', 'true');
  await tab('Glossary table').focus();
  await page.keyboard.press('Home');
  await expect(tab('Entries')).toHaveAttribute('aria-selected', 'true');
  await expect(entriesView().getByTestId('entries-list')).toBeVisible();
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
