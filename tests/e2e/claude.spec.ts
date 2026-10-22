import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import type { Invoke } from '../helpers/t5';
import { readFixture } from '../helpers/loadFixture';
import { fileDb, fillEditable, invokeVia, launch, rail, seedFixture } from './helpers';
import type { TestDb } from './helpers';

/**
 * M6 through the interface: the question panel from every screen (AI-1,
 * AI-2), the key and models in settings (ARCH-4), the first-use disclosure
 * (AI-6), failures (AI-7), proposals (AI-3), the prose refusal (AI-4), and
 * import proposals (IM-5). Claude is the recorded fake and the key lives in
 * memory (NOVEL_COMPANION_TEST_CLAUDE, set by `launch`).
 */
let db: TestDb;
let app: ElectronApplication;
let page: Page;
let invoke: Invoke;

const SLUG = 'claude-fixture';
const KEY = 'sk-ant-api03-e2e-test-key-0123456789abcdef';
const fixture = readFixture();
const dir = mkdtempSync(join(tmpdir(), 'nc-e2e-claude-'));
const DOCUMENT = join(dir, 'chapter-03.docx');

test.describe.configure({ mode: 'serial' });

function strip(d: Record<string, unknown>): Record<string, unknown> {
  const { createdAt: _c, modifiedAt: _m, ...rest } = d;
  return rest;
}

test.beforeAll(async () => {
  copyFileSync(join(import.meta.dirname, '../../fixtures/files/chapter-03.docx'), DOCUMENT);
  db = fileDb();
  ({ app, page } = await launch(db, {
    NOVEL_COMPANION_TEST_PICK_DOCUMENT: DOCUMENT,
    // Slow enough to watch the answer arrive and to press Stop part way.
    NOVEL_COMPANION_TEST_CLAUDE_STEP_DELAY_MS: '120',
  }));
  invoke = invokeVia(page);
  await invoke('bible.create', { slug: SLUG, name: 'Claude fixture' });
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
    await seedFixture(
      invoke,
      fixture[c]!.map((d) => ({ collection: c as never, data: strip(d) })),
    );
  }
});

test.afterAll(async () => {
  await app?.close();
});

const panel = () => page.getByTestId('claude-panel');
const input = () => panel().getByTestId('claude-input');
const lastTurn = () => panel().getByTestId('claude-turn').last();

async function ask(question: string) {
  await input().fill(question);
  await panel().getByTestId('claude-send').click();
}

test('AI-1 NF-2 the panel opens from every screen with Cmd+J or the status bar button, and Escape closes it', async () => {
  for (const screen of [
    'Family tree',
    'Timeline',
    'Outline',
    'Characters',
    'Review queue',
    'Settings',
  ]) {
    await rail(page, screen).click();
    await page.keyboard.press('Meta+j');
    await expect(panel()).toBeVisible();
    await expect(input()).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(panel()).toBeHidden();
  }
  // The status bar button is a plain button, so Tab and Enter reach it.
  const button = page.getByTestId('ask-claude');
  await button.focus();
  await page.keyboard.press('Enter');
  await expect(panel()).toBeVisible();
  await expect(button).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape');
  await expect(button).toBeFocused();
});

test('AI-6 ARCH-4 AI-7 the first use states what is sent; with no key the question is kept and the message links to settings', async () => {
  await page.getByTestId('ask-claude').click();
  const disclosure = panel().getByTestId('claude-disclosure');
  await expect(disclosure).toContainText('sends the content listed below to Anthropic');
  for (const label of [
    'Question panel',
    'Session briefs',
    'Alignment checks',
    'Chapter summaries',
    'Import proposals',
  ]) {
    await expect(disclosure).toContainText(label);
  }
  await input().fill('How old is Margaret in 2040?');
  await expect(panel().getByTestId('claude-send')).toBeDisabled();
  // The disclosure is a labelled group, names Google Drive, and Cmd+Enter cannot ask before it is confirmed.
  await expect(
    panel().getByRole('group', { name: 'What Claude sends to Anthropic' }),
  ).toBeVisible();
  await expect(disclosure).toContainText('export to Google Drive');
  await input().press('Meta+Enter');
  await expect(panel().getByTestId('claude-turn')).toHaveCount(0);
  await expect(input()).toHaveText('How old is Margaret in 2040?');
  await disclosure.getByRole('button', { name: 'Continue' }).click();
  await expect(disclosure).toBeHidden();
  await panel().getByTestId('claude-send').click();
  const error = lastTurn().getByTestId('claude-error');
  await expect(error).toContainText('Claude needs an Anthropic API key');
  // AI-7: the question is back in the box.
  await expect(input()).toHaveText('How old is Margaret in 2040?');
  await error.getByRole('button', { name: 'Open settings' }).click();
  await expect(page.getByTestId('settings-view')).toBeVisible();
  await expect(panel()).toBeHidden();
});

test('ARCH-4 the key is set in settings, checked, shown masked, and the models come from the live list', async () => {
  const settings = page.getByTestId('claude-settings');
  await expect(settings.getByTestId('claude-key-status')).toContainText('No key is stored');
  await settings.getByTestId('claude-key-input').fill('sk-ant-rejected-key-000000');
  await settings.getByTestId('claude-key-save').click();
  await expect(settings.getByTestId('claude-key-note')).toContainText(
    'Anthropic rejected this key',
  );
  await expect(settings.getByTestId('claude-key-status')).toContainText('No key is stored');
  await settings.getByTestId('claude-key-input').fill(KEY);
  await settings.getByTestId('claude-key-save').click();
  await expect(settings.getByTestId('claude-key-note')).toContainText('Anthropic accepted the key');
  await expect(settings.getByTestId('claude-key-status')).toContainText('sk-ant-…cdef');
  await expect(settings.getByTestId('claude-key-input')).toHaveValue('');
  await expect(page.locator('body')).not.toContainText(KEY);
  // DB-4: Opus for briefs and alignment checks; every feature has its own select.
  await expect(settings.getByTestId('claude-model-briefs')).toHaveValue('claude-opus-5-5');
  await expect(settings.getByTestId('claude-model-alignment')).toHaveValue('claude-opus-5-5');
  await expect(settings.getByTestId('claude-model-panel')).toHaveValue('claude-sonnet-5-5');
  await expect(settings.getByTestId('claude-model-panel').locator('option')).toHaveText([
    'Claude Opus 5.5 (claude-opus-5-5)',
    'Claude Sonnet 5.5 (claude-sonnet-5-5)',
    'Claude Haiku 5.5 (claude-haiku-5-5)',
  ]);
  await settings.getByTestId('claude-model-summaries').selectOption('claude-haiku-5-5');
  expect((await invoke('claude.status', {})).models.summaries).toBe('claude-haiku-5-5');
});

test('AI-1 AI-2 the answer streams in, lists the entries read, and the conversation is saved and reopened', async () => {
  await page.keyboard.press('Meta+j');
  await expect(input()).toHaveText('How old is Margaret in 2040?');
  await panel().getByTestId('claude-send').click();
  const answer = lastTurn().getByTestId('claude-answer');
  // Streaming: the first part shows before the run ends.
  await expect(lastTurn()).toHaveAttribute('data-status', 'running');
  await expect(answer).toContainText('In 2040 Margaret Hale is 82.');
  await expect(lastTurn()).toHaveAttribute('data-status', 'done');
  await expect(answer).toHaveText(
    'In 2040 Margaret Hale is 82. She was born in 1958 and dies in 2041, so she is alive all of that year.',
  );
  const read = lastTurn().getByTestId('claude-entries');
  await expect(read.getByRole('button', { name: /Margaret Hale/ })).toBeVisible();
  await ask('And her husband?');
  await expect(lastTurn()).toHaveAttribute('data-status', 'done');
  await expect(lastTurn().getByTestId('claude-answer')).toContainText(
    'Peter Hale, married 1982 to 2030',
  );
  await expect(panel().getByTestId('claude-turn')).toHaveCount(3);
  // An entry read is one click from its page.
  await read.getByRole('button', { name: /Margaret Hale/ }).click();
  await expect(page.getByTestId('editor')).toBeVisible();
  // Saved: a new conversation, then the old one picked from the history.
  await panel().getByRole('button', { name: 'New conversation' }).click();
  await expect(panel().getByTestId('claude-turn')).toHaveCount(0);
  const history = panel().getByTestId('claude-history');
  await expect(history.locator('option')).toHaveCount(2);
  await history.selectOption({ index: 1 });
  await expect(panel().getByTestId('claude-turn')).toHaveCount(3);
  await expect(panel().getByTestId('claude-turn').nth(1)).toContainText(
    'In 2040 Margaret Hale is 82.',
  );
});

test('AI-1 Stop ends a streaming answer and keeps what arrived', async () => {
  await panel().getByRole('button', { name: 'New conversation' }).click();
  await ask('Tell me everything about the Hale family');
  await expect(lastTurn().getByTestId('claude-answer')).toContainText('who married in 1982.');
  await panel().getByTestId('claude-stop').click();
  await expect(lastTurn()).toHaveAttribute('data-status', 'stopped');
  await expect(lastTurn()).toContainText('Stopped before the end.');
  await expect(lastTurn().getByTestId('claude-answer')).toHaveText(
    'The Hale family begins with Margaret and Peter, who married in 1982.',
  );
  await expect(panel().getByTestId('claude-stop')).toBeHidden();
});

test('AI-1 closing the panel mid-answer and reopening it follows the same run: no second question, and Stop still works', async () => {
  await panel().getByRole('button', { name: 'New conversation' }).click();
  await ask('Tell me everything about the Hale family');
  await expect(lastTurn().getByTestId('claude-answer')).toContainText('who married in 1982.');
  await page.keyboard.press('Escape');
  await expect(panel()).toBeHidden();
  await page.keyboard.press('Meta+j');
  await expect(panel()).toBeVisible();
  // The running turn is shown once, still running, with what has streamed.
  await expect(panel().getByTestId('claude-turn')).toHaveCount(1);
  await expect(lastTurn()).toHaveAttribute('data-status', 'running');
  await expect(lastTurn().getByTestId('claude-answer')).toContainText('who married in 1982.');
  await input().fill('How old is Margaret in 2040?');
  await expect(panel().getByTestId('claude-send')).toBeDisabled();
  await panel().getByTestId('claude-stop').click();
  await expect(lastTurn()).toHaveAttribute('data-status', 'stopped');
  // Now a second question in the same conversation is taken, and both turns are kept.
  await panel().getByTestId('claude-send').click();
  await expect(lastTurn()).toHaveAttribute('data-status', 'done');
  await expect(panel().getByTestId('claude-turn')).toHaveCount(2);
  await expect(panel().getByTestId('claude-turn').first()).toHaveAttribute(
    'data-status',
    'stopped',
  );
});

test('IP-16 NF-2 a conversation renames in place as one undo step, and Clear and Delete each ask on one line first', async () => {
  const tools = panel().getByTestId('claude-conversation');
  await expect(tools).toBeVisible();
  const runs = async () => (await invoke('claude.runs', { feature: 'panel' })).runs;
  const id = (await panel().getByTestId('claude-history').inputValue())!;
  const run = async () => (await invoke('claude.run', { id })).run;
  const before = (await run()).title;
  await expect(tools.getByTestId('claude-title-text')).toHaveText(before);

  // Rename in place: the picker follows, and Cmd+Z puts the old title back.
  await fillEditable(tools.getByTestId('claude-title'), 'Hale family, the long version');
  await expect.poll(async () => (await run()).title).toBe('Hale family, the long version');
  await expect(panel().getByTestId('claude-history')).toContainText(
    'Hale family, the long version',
  );
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Meta+z');
  await expect.poll(async () => (await run()).title).toBe(before);
  await expect(tools.getByTestId('claude-title-text')).toHaveText(before);
  await page.keyboard.press('Shift+Meta+z');
  await expect.poll(async () => (await run()).title).toBe('Hale family, the long version');
  await expect(tools.getByTestId('claude-title-text')).toHaveText('Hale family, the long version');

  // Clear: one line asks first, Keep takes the focus, Escape keeps the messages.
  await tools.getByTestId('claude-clear').click();
  const clear = tools.getByTestId('claude-clear-confirm');
  await expect(clear).toContainText('Take every message out of Hale family, the long version?');
  await expect(clear).toContainText('This is not an undo step.');
  await expect(clear.getByRole('button', { name: 'Keep them' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(clear).toHaveCount(0);
  await expect(panel().getByTestId('claude-turn')).toHaveCount(2);
  await tools.getByTestId('claude-clear').click();
  await clear.getByRole('button', { name: 'Clear messages' }).click();
  await expect(panel().getByTestId('claude-turn')).toHaveCount(0);
  await expect.poll(async () => (await run()).turns.length).toBe(0);
  expect((await run()).title).toBe('Hale family, the long version');

  // Delete: the conversation goes, and the panel starts a new one.
  await tools.getByTestId('claude-delete').click();
  const del = tools.getByTestId('claude-delete-confirm');
  await expect(del).toContainText('Delete Hale family, the long version and its messages?');
  await del.getByRole('button', { name: 'Delete conversation' }).click();
  await expect(panel().getByTestId('claude-conversation')).toHaveCount(0);
  await expect.poll(async () => (await runs()).some((r) => r.id === id)).toBe(false);
  await expect(panel().getByTestId('claude-history')).not.toContainText(
    'Hale family, the long version',
  );

  // ED-3: Cmd+Z now reaches the rename of a conversation that is gone. It is skipped
  // with a plain notice, and undo keeps working for the next step.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Meta+z');
  await expect(page.getByTestId('undo-notice')).toHaveText(
    'Undo skipped: this field changed since that step, so nothing was overwritten (the conversation was renamed or deleted since).',
  );
  const history = panel().getByTestId('claude-history');
  await history.selectOption({ index: 1 });
  await expect(history).not.toHaveValue('');
  await expect(panel().getByTestId('claude-conversation')).toBeVisible();
  const other = await history.inputValue();
  const otherTitle = (await invoke('claude.run', { id: other })).run.title;
  await fillEditable(
    panel().getByTestId('claude-conversation').getByTestId('claude-title'),
    'Margaret, at 82',
  );
  await expect
    .poll(async () => (await invoke('claude.run', { id: other })).run.title)
    .toBe('Margaret, at 82');
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Meta+z');
  await expect
    .poll(async () => (await invoke('claude.run', { id: other })).run.title)
    .toBe(otherTitle);
  await expect(page.getByTestId('undo-notice')).toHaveText(
    `Undid: Renamed the conversation ${otherTitle}`,
  );
});

test('AI-4 asking for a scene gets a one-sentence refusal that offers the facts', async () => {
  await panel().getByRole('button', { name: 'New conversation' }).click();
  await ask('Write the scene where Margaret hears that Peter has died.');
  await expect(lastTurn()).toHaveAttribute('data-status', 'done');
  const text = (await lastTurn().getByTestId('claude-answer').textContent()) ?? '';
  expect(text.match(/[.!?](\s|$)/g)).toHaveLength(1);
  expect(text).toMatch(/don't write prose for the novel, but I can list the bible facts/);
});

test('AI-7 a rate limit says what to do and keeps the question', async () => {
  await ask('Am I rate limited?');
  await expect(lastTurn().getByTestId('claude-error')).toContainText(
    'Wait a minute, then try again',
  );
  await expect(lastTurn().getByTestId('claude-error').getByRole('button')).toHaveCount(0);
  await expect(input()).toHaveText('Am I rate limited?');
  await input().fill('');
});

test('AI-3 a change Claude suggests waits in the review queue with the exact change, and is saved only on approval', async () => {
  const places = async () =>
    (await invoke('entry.list', { collection: 'places', trash: 'exclude' })).entries.map(
      (e) => e.entry.title,
    );
  expect(await places()).not.toContain('The porch by the river');
  await ask('Add the porch by the river as a place inside the Hale house.');
  await expect(lastTurn()).toHaveAttribute('data-status', 'done');
  const note = lastTurn().getByTestId('claude-proposals');
  await expect(note).toContainText('1 proposal is waiting in the review queue');
  expect(await places()).not.toContain('The porch by the river');
  await note.getByRole('button', { name: 'Open the review queue' }).click();
  const queue = page.getByTestId('review-queue');
  await expect(queue).toBeVisible();
  const card = queue
    .locator('article, .panel')
    .filter({ hasText: 'The porch by the river' })
    .first();
  await expect(card).toContainText('Claude');
  await card.getByRole('button', { name: 'Approve' }).click();
  await expect.poll(places).toContain('The porch by the river');
});

test('IM-5 AI-6 a Word document in Import can be read by Claude, and its proposals go to the review queue', async () => {
  // The disclosure is per bible: a second bible asks again before the first use there.
  await rail(page, 'Import').click();
  const view = page.getByTestId('import-view');
  await view.getByTestId('import-pick-document').click();
  await expect(view.getByTestId('import-document')).toBeVisible();
  const box = view.getByTestId('import-claude');
  await expect(box).toContainText('Ask Claude to propose entries');
  await box.getByTestId('import-claude-start').click();
  const result = box.getByTestId('import-claude-result');
  await expect(result).toHaveAttribute('data-status', 'done');
  await expect(result).toContainText('A wedding in the rain');
  await expect(result.getByTestId('claude-proposals')).toContainText('2 proposals are waiting');
  await expect(result.getByTestId('claude-rejected')).toContainText(
    'No characters entry has the ID H9.',
  );
  await expect(result.getByTestId('claude-entries')).toContainText('Peter Hale');
  const pending = (await invoke('proposal.list', { state: 'pending' })).proposals.filter(
    (p) => p.proposal.source === 'claude',
  );
  expect(pending.map((p) => [p.proposal.op, p.proposal.collection])).toEqual([
    ['create', 'moments'],
    ['update', 'characters'],
  ]);
  // A second bible: the disclosure comes back before anything is sent.
  await invoke('bible.create', { slug: 'claude-second', name: 'Second' });
  await invoke('bible.open', { slug: 'claude-second' });
  await expect(page.locator('p', { hasText: 'Open bible:' })).toContainText('Second');
  await expect(page.getByTestId('ask-claude')).toBeVisible();
  await page.keyboard.press('Meta+j');
  await expect(panel().getByTestId('claude-disclosure')).toBeVisible();
  await panel().getByTestId('claude-disclosure').getByRole('button', { name: 'Not now' }).click();
  await expect(panel()).toBeHidden();
});

test('AI-1 switching bibles mid-answer stops the run and saves it as stopped in its own bible', async () => {
  await invoke('bible.open', { slug: SLUG });
  await expect(page.locator('p', { hasText: 'Open bible:' })).toContainText('Claude fixture');
  // The reopened workspace must hold the panel's shortcut before Cmd+J is pressed.
  await expect(page.getByTestId('ask-claude')).toBeVisible();
  await page.keyboard.press('Meta+j');
  await panel().getByRole('button', { name: 'New conversation' }).click();
  await ask('Tell me everything about the Hale family');
  await expect(lastTurn().getByTestId('claude-answer')).toContainText('who married in 1982.');
  await invoke('bible.open', { slug: 'claude-second' });
  await expect(page.locator('p', { hasText: 'Open bible:' })).toContainText('Second');
  await invoke('bible.open', { slug: SLUG });
  const { runs } = await invoke('claude.runs', { feature: 'panel' });
  expect(runs[0]).toMatchObject({
    title: 'Tell me everything about the Hale family',
    status: 'stopped',
  });
  const { run, active } = await invoke('claude.run', { id: runs[0]!.id });
  expect(active).toEqual([]);
  expect(run.turns.at(-1)).toMatchObject({
    status: 'stopped',
    answer: 'The Hale family begins with Margaret and Peter, who married in 1982.',
  });
});
