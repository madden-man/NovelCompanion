import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { Invoke } from '../helpers/t5';
import { readFixture } from '../helpers/loadFixture';
import { field, invokeVia, launch, rail, waitSaved } from './helpers';

let server: MongoMemoryReplSet;
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
  server = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  ({ app, page } = await launch(server.getUri()));
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
  const order = ['customSections', ...Object.keys(fixture).filter((c) => c !== 'customSections')];
  for (const c of order) {
    if (c === 'lists' || !fixture[c]?.length) continue;
    await invoke('entry.createMany', {
      items: fixture[c]!.map((d) => ({ collection: c as never, data: strip(d) })),
    });
  }
});

test.afterAll(async () => {
  // Exit directly: a failed SL-1 test may leave the stop prompt open, and close() would wait on it.
  await app?.evaluate(({ app: electron }) => electron.exit(0)).catch(() => undefined);
  await server?.stop();
});

const pick = (name: RegExp | string) =>
  page.getByTestId('entry-list').getByRole('button', { name });

test('KN-1 KN-2 the fact page lists who knows it, and a record before birth saves with a warning', async () => {
  await rail(page, 'Facts').click();
  await pick(/Peter's letter/).click();
  const facts = page.getByTestId('fact-page');
  await expect(facts.getByTestId('fact-knowers')).toContainText('Ruth Hale');
  await expect(facts.getByTestId('fact-knowers')).toContainText('learned in 2041');
  await expect(facts.getByTestId('fact-knowers')).toContainText('Iris Hale-Zhou');
  await expect(facts.getByTestId('fact-knowers')).toContainText(
    'learned in 2060, in Rain in Guangzhou',
  );
  await expect(facts.getByTestId('fact-in-play')).toContainText('The Letter');
  // Sam is born in 2012. Learning it in 2000 is a warning, and the record still saves.
  const form = facts.getByTestId('fact-record-form');
  await form.getByLabel('Character').selectOption({ label: 'Sam Hale' });
  await form.getByLabel('Year learned').fill('2000');
  await form.getByLabel('How they learn it').fill('Overheard at a dinner');
  await form.getByRole('button', { name: 'Record who learned it' }).click();
  await expect(form.getByTestId('fact-record-warning')).toContainText('born in 2012');
  await expect(form.getByTestId('fact-record-warning')).toContainText('It still saved.');
  await expect(facts.getByTestId('fact-knowers')).toContainText('Sam Hale');
  const { entries } = await invoke('entry.list', {
    collection: 'knowledgeRecords',
    trash: 'exclude',
  });
  const saved = entries.find((e) => e.entry.characterId === 'H6')!;
  expect(saved.entry.yearLearned).toBe(2000);
  expect(saved.warnings.map((w) => w.code)).toEqual(['learned-before-birth']);
});

test('KN-1 the character page shows what H5 knows and does not know in 2059 and in 2060', async () => {
  await invoke('storyTime.set', { time: { year: 2059 } });
  await rail(page, 'Characters').click();
  await pick(/Iris Hale-Zhou/).click();
  await expect(page.getByTestId('knowledge-year')).toHaveText('As of 2059.');
  await expect(page.getByTestId('knowledge-empty')).toBeVisible();
  const missing = page.getByTestId('does-not-know');
  await expect(missing.locator('[data-fact="F2"]')).toContainText("Peter's letter");
  await expect(missing.locator('[data-fact="F2"]')).toContainText('not yet in 2059');
  await expect(missing.locator('[data-fact="F2"]')).toContainText('They learn it in 2060.');
  await expect(missing.locator('[data-fact="F1"]')).toContainText('Meiling was engaged before Wei');
  await expect(missing.locator('[data-fact="F1"]')).toContainText('never');

  await invoke('storyTime.set', { time: { year: 2060 } });
  await expect(page.getByTestId('knowledge-year')).toHaveText('As of 2060.');
  const known = page.getByTestId('knowledge');
  await expect(known).toContainText("Peter's letter");
  await expect(known).toContainText('learned 2060');
  await expect(known).toContainText('She finds it in Margaret');
  await expect(page.getByTestId('does-not-know').locator('[data-fact="F2"]')).toHaveCount(0);
  await expect(page.getByTestId('does-not-know').locator('[data-fact="F1"]')).toContainText(
    'never',
  );
  await invoke('storyTime.set', { time: null });
});

test('KN-3 a chapter lists which characters act on which facts, and the outline chapter page shows them', async () => {
  await rail(page, 'Chapters').click();
  await pick(/Candles/).click();
  const editor = page.getByTestId('editor');
  const list = field(editor, 'factsInPlay');
  await list.getByRole('button', { name: 'Add to Facts in play', exact: true }).click();
  await field(editor, 'factsInPlay.0.factId').locator(':scope > select').selectOption('F2');
  await field(editor, 'factsInPlay.0.characterId').locator(':scope > select').selectOption('H4');
  await field(editor, 'factsInPlay.0.note')
    .locator(':scope > input')
    .fill('Ruth keeps the letter hidden.');
  await waitSaved(page);
  const stored = (await invoke('entry.get', { collection: 'chapters', id: 'CH5' })).entry;
  expect(stored.factsInPlay).toEqual([
    { factId: 'F2', characterId: 'H4', note: 'Ruth keeps the letter hidden.' },
  ]);
  await rail(page, 'Outline').click();
  await page
    .getByTestId('outline-grid')
    .locator('[data-chapter="CH5"]')
    .getByTestId('outline-label')
    .click();
  await expect(page.getByTestId('outline-inspector').getByTestId('chapter-facts')).toContainText(
    "Ruth Hale acts on Peter's letter",
  );
});

test('TH-1 a theme gets appearances by chapter, and the chapter page shows the theme', async () => {
  await rail(page, 'Themes and motifs').click();
  await page.getByRole('button', { name: 'New theme', exact: true }).click();
  const form = page.getByTestId('new-entry');
  await field(form, 'title').locator(':scope > input').fill('Letters kept');
  await form.getByRole('button', { name: 'Create theme' }).click();
  const editor = page.getByTestId('editor');
  await expect(editor.getByRole('heading', { name: 'Letters kept' })).toBeVisible();
  await waitSaved(page);
  await field(editor, 'appearances')
    .getByRole('button', { name: 'Add to Appearances', exact: true })
    .click();
  await field(editor, 'appearances.0.chapterId').locator(':scope > select').selectOption('CH3');
  await field(editor, 'appearances.0.note').locator(':scope > input').fill('Lan hides the letters');
  await waitSaved(page);
  const page3 = (await invoke('chapter.page', { id: 'CH3' })).page;
  expect(page3.themes).toMatchObject([{ title: 'Letters kept', note: 'Lan hides the letters' }]);
});

test('TH-1 adding a theme in the chapter Themes field creates an empty appearance, and removing it removes the appearance', async () => {
  const themes = (await invoke('entry.list', { collection: 'themes', trash: 'exclude' })).entries;
  const theme = themes.find((t) => t.entry.title === 'Letters kept')!.entry;
  await rail(page, 'Chapters').click();
  await pick(/Candles/).click();
  const editor = page.getByTestId('editor');
  const themesField = field(editor, 'themeIds');
  await themesField.locator(':scope > select').selectOption(theme._id);
  await waitSaved(page);
  const apps = async () =>
    (
      (await invoke('entry.get', { collection: 'themes', id: theme._id })).entry.appearances as {
        chapterId: string;
        note: string;
      }[]
    ).filter((a) => a.chapterId === 'CH5');
  expect(await apps()).toEqual([{ chapterId: 'CH5', note: '' }]);
  expect((await invoke('chapter.page', { id: 'CH5' })).page.themes).toMatchObject([
    { title: 'Letters kept', note: '' },
  ]);
  await themesField.locator(':scope > .chips .chip-remove').first().click();
  await waitSaved(page);
  expect(await apps()).toEqual([]);
  expect((await invoke('chapter.page', { id: 'CH5' })).page.themes).toEqual([]);
});

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

test('CS-1 CS-2 CS-3 a custom section gets fields and a brief rule, its entries list under its own name and are searchable', async () => {
  await rail(page, 'Custom sections').click();
  await page.getByRole('button', { name: 'New custom section', exact: true }).click();
  const form = page.getByTestId('new-entry');
  await field(form, 'name').locator(':scope > input').fill('Songs');
  await form.getByRole('button', { name: 'Create custom section' }).click();
  const editor = page.getByTestId('editor');
  await expect(editor.getByRole('heading', { name: 'Songs' })).toBeVisible();
  await waitSaved(page);
  await field(editor, 'fields').getByRole('button', { name: 'Add to Fields', exact: true }).click();
  await field(editor, 'fields.0.label').locator(':scope > input').fill('Key');
  await field(editor, 'fields.0.type').locator(':scope > select').selectOption('text');
  await field(editor, 'briefRule').locator(':scope > select').selectOption('storyYear');
  await waitSaved(page);
  const section = (
    await invoke('entry.list', { collection: 'customSections', trash: 'exclude' })
  ).entries
    .map((e) => e.entry)
    .find((e) => e.name === 'Songs')!;
  expect(section.briefRule).toBe('storyYear');
  const fieldId = (section.fields as { id: string }[])[0]!.id;

  // The section has its own place in the rail, and new entries start inside it.
  await rail(page, 'Songs').click();
  await expect(page.getByRole('heading', { name: 'Songs', level: 2 })).toBeVisible();
  await page.getByRole('button', { name: 'New entry in Songs', exact: true }).click();
  const entryForm = page.getByTestId('new-entry');
  await field(entryForm, 'title').locator(':scope > input').fill('Harbor lullaby');
  await field(entryForm, `values.${fieldId}`).locator(':scope > input').fill('D minor');
  await entryForm.getByRole('button', { name: 'Create custom entry' }).click();
  await expect(
    page.getByTestId('editor').getByRole('heading', { name: 'Harbor lullaby' }),
  ).toBeVisible();
  await waitSaved(page);
  const entry = (
    await invoke('entry.list', { collection: 'customEntries', trash: 'exclude' })
  ).entries
    .map((e) => e.entry)
    .find((e) => e.title === 'Harbor lullaby')!;
  expect(entry).toMatchObject({ sectionId: section._id, values: { [fieldId]: 'D minor' } });
  // The Songs list holds only Songs; the fixture's recipes stay under their own section.
  await expect(page.getByTestId('entry-list').getByRole('button')).toHaveCount(1);
  await rail(page, 'Family recipes').click();
  await expect(page.getByTestId('entry-list').getByRole('button')).toHaveCount(2);

  // Search finds it by a value.
  await page.getByRole('searchbox', { name: 'Search the bible' }).fill('minor');
  await expect(page.getByTestId('search-results')).toContainText('Harbor lullaby');
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
  // Picking a result opens the entry.
  await box.fill('Peter');
  await results.locator('[data-hit="F2"]').click();
  await expect(
    page.getByTestId('editor').getByRole('heading', { name: "Peter's letter" }),
  ).toBeVisible();
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
  await expect(results).toContainText("Peter's letter");
  await expect(results).toContainText('The Letter');

  await view.getByLabel('Section').selectOption('facts');
  await expect(results.getByRole('button')).toHaveCount(2);
  await expect(results).not.toContainText('The Letter');
  await view.getByLabel('Section').selectOption('');

  await view.getByLabel('Status').selectOption('planned');
  await expect(results).toContainText("Peter's letter");
  await expect(results).not.toContainText('Meiling was engaged');
  await view.getByLabel('Status').selectOption('');

  await view.getByLabel('Provenance').selectOption('researched');
  await expect(page.getByTestId('search-empty')).toBeVisible();
  await view.getByLabel('Provenance').selectOption('');

  await view.getByLabel('From year').fill('2060');
  await view.getByLabel('To year').fill('2060');
  await expect(results).toContainText('Iris reads');
  await expect(results).not.toContainText('Ruth reads');
  await view.getByLabel('From year').fill('');
  await view.getByLabel('To year').fill('');

  await view.getByLabel('Family').selectOption('FAM-ZHOU');
  // Wait until the list answers the Zhou filter, so stale unfiltered hits cannot satisfy the checks.
  const region = view.getByTestId('search-region');
  await expect(region).toHaveAttribute('data-query-key', /FAM-ZHOU/);
  await expect(region).toHaveAttribute('aria-busy', 'false');
  await expect(results).toContainText('Iris reads');
  await expect(results).not.toContainText('Ruth reads');
  await expect(results).not.toContainText('Meiling was engaged');
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

test('SL-1 closing the app asks where you stopped, saves the note, and the next launch shows it first', async () => {
  test.setTimeout(180_000);
  await app.close();
  ({ app, page } = await launch(server.getUri(), { NOVEL_COMPANION_SKIP_STOP_PROMPT: '0' }));
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

  ({ app, page } = await launch(server.getUri(), { NOVEL_COMPANION_SKIP_STOP_PROMPT: '0' }));
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
  ({ app, page } = await launch(server.getUri()));
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
  ({ app, page } = await launch(server.getUri(), {
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
  ({ app, page } = await launch(server.getUri()));
  invoke = invokeVia(page);
  await openBible();
  expect(await logs()).toBe(before);
});
