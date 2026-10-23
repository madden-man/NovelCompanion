import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { Document, Packer, Paragraph } from 'docx';
import { contrast } from '../helpers/contrast';
import type { Rgba } from '../helpers/contrast';
import type { Invoke } from '../helpers/t5';
import { readFixture } from '../helpers/loadFixture';
import { readSupplement } from '../helpers/briefFixture';
import { fileDb, fillEditable, invokeVia, launch, rail, screenTab, seedFixture } from './helpers';
import type { TestDb } from './helpers';

let db: TestDb;
let app: ElectronApplication;
let page: Page;
let invoke: Invoke;

const SLUG = 'alignment';
const fixture = readFixture();
const supplement = readSupplement();

test.describe.configure({ mode: 'serial' });

function strip(d: Record<string, unknown>): Record<string, unknown> {
  const { createdAt: _c, modifiedAt: _m, ...rest } = d;
  return rest;
}

test.beforeAll(async () => {
  db = fileDb();
  ({ app, page } = await launch(db, {
    // T-3: the recorded Claude, with a key held in memory.
    NOVEL_COMPANION_TEST_ANTHROPIC_KEY: 'sk-ant-api03-e2e-test-key-0123456789abcdef',
  }));
  invoke = invokeVia(page);
  await invoke('bible.create', { slug: SLUG, name: 'Alignment' });
  await invoke('bible.open', { slug: SLUG });
  await expect(page.getByTestId('workspace')).toBeVisible();
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
  const order = ['customSections', ...Object.keys(fixture).filter((c) => c !== 'customSections')];
  for (const c of order) {
    if (c === 'lists' || !fixture[c]?.length) continue;
    await seedFixture(
      invoke,
      fixture[c]!.map((d) => ({ collection: c as never, data: strip(d) })),
    );
  }
  // The M7 supplement gives the chapters arcs and beats, so the stored plot is there to compare.
  for (const c of ['moments']) {
    const docs = supplement.entries[c]!.filter((d) => !d.deletedAt);
    await seedFixture(
      invoke,
      docs.map((d) => ({ collection: c as never, data: strip(d) })),
    );
  }
  for (const [id, patch] of Object.entries(supplement.patches.chapters ?? {})) {
    await invoke('entry.update', { collection: 'chapters', id, patch });
  }
  await page.reload();
  await expect(page.getByTestId('rail')).toBeVisible();
});

test.afterAll(async () => {
  await app?.evaluate(({ app: electron }) => electron.exit(0)).catch(() => undefined);
});

const view = () => page.getByTestId('alignment-view');
const finding = (check: string) => view().locator(`[data-testid="finding"][data-check="${check}"]`);

test('CC-1 CC-2 CC-3 CC-5 SM-11 the Continuity checker opens on the alignment check, which finds S1 in code and the recorded P1 and P2 by Claude (SM-2: no facts, so no S2; A52: no S3)', async () => {
  await rail(page, 'Continuity checker').click();
  await expect(rail(page, 'Continuity checker')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('tab', { name: 'Alignment check' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByRole('heading', { name: 'Alignment check', level: 2 })).toBeVisible();
  await expect(view().getByTestId('alignment-runner')).toContainText('Model: claude-opus-5-5');
  await view().getByTestId('alignment-run').click();
  // AI-6: the first Claude run in a bible says what is sent, before anything is.
  await page.getByTestId('claude-acknowledge').click();
  await expect(view().getByTestId('alignment-status')).toContainText(
    'Done. Structural checks: 1 found. Claude read 8 chapters and found 2.',
    { timeout: 30_000 },
  );
  const structural = view().getByTestId('structural-findings').getByTestId('finding');
  await expect(structural).toHaveCount(1);
  await expect(finding('character-present-while-dead')).toContainText(
    'Chapter 4 is set in 2032 and lists Peter Hale (H2) as present. Peter Hale died in 2030.',
  );
  await expect(finding('fact-acted-on-before-learned')).toHaveCount(0);
  await expect(finding('event-linked-as-happened-after-story-year')).toHaveCount(0);
  const p1 = finding('age');
  await expect(p1).toContainText('Chapter 5: Candles');
  await expect(p1).toContainText('line 1');
  await expect(p1.getByTestId('finding-quote')).toContainText(
    'Line 1:Ruth counted the candles twice. Her mother was seventy',
  );
  await expect(p1).toContainText('Margaret Hale (H1)');
  const p2 = finding('place');
  await expect(p2).toContainText('Chapter 7: Rain in Guangzhou');
  await expect(p2.getByTestId('finding-quote')).toContainText('Lan had grown up in Shanghai');
  // CC-3: Claude's change to a field that does not exist is shown and never applied; its bad citation was refused.
  await expect(p2.getByTestId('finding-rejected')).toContainText(
    'hometown is not a field of characters',
  );
  await expect(view().getByTestId('alignment-rejected')).toContainText(
    'It cites Z9, which is not in the bible.',
  );
  // AI-2: the entries Claude was given are listed, each one click from its page.
  await expect(view().getByTestId('claude-entries')).toContainText('Margaret Hale');
});

test('CC-4 ED-3 Manuscript wins shows the change set as a diff, applies it, and undoes', async () => {
  const p1 = finding('age');
  await p1.getByRole('button', { name: 'Manuscript wins' }).click();
  const diff = p1.getByTestId('finding-diff');
  await expect(diff.locator('tbody tr')).toHaveText([/Margaret Hale\s*Birth\s*1958\s*1970/]);
  await diff.getByTestId('finding-apply').click();
  await expect(p1).toHaveAttribute('data-state', 'manuscriptWins');
  await expect(p1).toContainText('bible updated');
  await expect
    .poll(
      async () => (await invoke('entry.get', { collection: 'characters', id: 'H1' })).entry.birth,
    )
    .toEqual({ year: 1970 });
  await p1.getByRole('button', { name: 'Undo' }).click();
  await expect
    .poll(
      async () => (await invoke('entry.get', { collection: 'characters', id: 'H1' })).entry.birth,
    )
    .toEqual({ year: 1958 });
  await expect(finding('age')).toHaveAttribute('data-state', 'open');
});

test('CC-4 SM-11 Rewrite recommended makes a rewrite task with the lines and what must change, on the Continuity checker and on the chapter', async () => {
  await finding('place').getByRole('button', { name: 'Rewrite recommended' }).click();
  await expect(finding('place')).toHaveCount(0);
  const task = view().getByTestId('rewrite-task');
  await expect(task).toHaveCount(1);
  await expect(task).toContainText('Chapter 7: Rain in Guangzhou');
  await expect(task).toContainText('Line 1:Lan had grown up in Shanghai');
  await expect(task).toContainText(
    'What must change: The city Lan grew up in must be Guangzhou, as the bible records.',
  );
  // The bible is left as it is: Lan's first Lives in moment still says Guangzhou (SM-3).
  expect((await invoke('entry.get', { collection: 'moments', id: 'Z3-lives-0' })).entry.title).toBe(
    'Lives in Guangzhou',
  );

  await task.getByRole('button', { name: 'Open chapter' }).click();
  const chapter = page.getByTestId('chapter-alignment');
  await expect(chapter.getByTestId('rewrite-task')).toContainText('What must change');
  // CC-1: the chapter page checks just this chapter.
  await expect(chapter.getByTestId('alignment-runner')).toContainText('Scope: this chapter.');
  await chapter.getByTestId('alignment-run').click();
  await expect(chapter.getByTestId('alignment-status')).toContainText(
    'Done. Structural checks: 0 found. Claude read 1 chapter and found 1.',
    { timeout: 30_000 },
  );
  // The rewrite task stands; a re-run adds no duplicate finding.
  await expect(chapter.getByTestId('rewrite-task')).toHaveCount(1);
  await expect(chapter.getByTestId('alignment-findings').getByTestId('finding')).toHaveCount(0);
});

test('CC-4 Dismiss hides a finding, and it stays hidden when the check runs again', async () => {
  await rail(page, 'Continuity checker').click();
  // NF-2: the actions are buttons reached by Tab and pressed with Enter.
  const dismiss = finding('character-present-while-dead').getByRole('button', { name: 'Dismiss' });
  await dismiss.focus();
  await page.keyboard.press('Enter');
  await expect(finding('character-present-while-dead')).toHaveCount(0);
  await expect(view().getByTestId('findings-dismissed')).toContainText(
    '1 dismissed finding is hidden',
  );
  await view().getByTestId('alignment-run').click();
  await expect(view().getByTestId('alignment-status')).toContainText(
    'Done. Structural checks: 1 found, 1 dismissed and unchanged.',
    { timeout: 30_000 },
  );
  await expect(finding('character-present-while-dead')).toHaveCount(0);
  await expect(view().getByTestId('structural-findings').getByTestId('finding')).toHaveCount(0);
});

test('CC-1 AI-1 Stop ends an alignment run part way: it says Stopped and records no new findings', async () => {
  await rail(page, 'Continuity checker').click();
  const all = view().getByTestId('alignment-findings').getByTestId('finding');
  // A marker in chapter 8's title (the text is locked, IP-18) selects the recording that waits for Stop.
  const ch8 = (await invoke('entry.get', { collection: 'chapters', id: 'CH8' })).entry;
  const title = String(ch8.title);
  await invoke('entry.update', {
    collection: 'chapters',
    id: 'CH8',
    patch: { title: `${title} E2E-HOLD-UNTIL-STOPPED` },
  });
  await view().getByTestId('alignment-scope').selectOption('CH8');
  // The findings the list shows for chapter 8 before the run, read from main so the count never races the list.
  const before = (
    await invoke('continuity.findings', { chapterId: 'CH8', states: ['open', 'manuscriptWins'] })
  ).findings.length;
  await expect(all).toHaveCount(before);
  await view().getByTestId('alignment-run').click();
  await expect(view().getByTestId('alignment-status')).toContainText('Claude is reading', {
    timeout: 30_000,
  });
  await view().getByTestId('alignment-stop').click();
  await expect(view().getByTestId('alignment-status')).toContainText('Stopped', {
    timeout: 30_000,
  });
  await expect(view().getByTestId('alignment-stop')).toBeDisabled();
  await expect(all).toHaveCount(before);
  await invoke('entry.update', {
    collection: 'chapters',
    id: 'CH8',
    patch: { title },
  });
});

test('SM-11 MS-1 CC-1 the Continuity checker holds the manuscript it reads as its second tab, reached by the arrow keys', async () => {
  await rail(page, 'Continuity checker').click();
  const alignment = page.getByRole('tab', { name: 'Alignment check' });
  const manuscript = page.getByRole('tab', { name: 'Manuscript' });
  await expect(page.getByRole('tablist', { name: 'Continuity checker' })).toBeVisible();
  await alignment.focus();
  await page.keyboard.press('ArrowRight');
  await expect(manuscript).toHaveAttribute('aria-selected', 'true');
  await expect(manuscript).toBeFocused();
  const view = page.getByTestId('manuscript-view');
  // MS-1: the chapters the check reads, each with the file its text came from.
  await expect(view.getByTestId('ms-chapters').locator('[data-chapter]')).toHaveCount(
    fixture.chapters!.length,
  );
  await view.locator('[data-chapter="CH5"]').click();
  await expect(view.getByTestId('ms-source')).toHaveText('Source: chapter-05.docx');
  await manuscript.focus();
  await page.keyboard.press('Home');
  await expect(alignment).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('alignment-view').getByTestId('alignment-run')).toBeVisible();
});

// IP-7 (a47-continuity): the cards edit the finding.

const entryOf = async (collection: string, id: string) =>
  (await invoke('entry.get', { collection: collection as never, id })).entry as Record<
    string,
    unknown
  >;

/** The stored finding behind a card, by its check. */
async function findingId(check: string): Promise<string> {
  const all = (
    await invoke('continuity.findings', {
      chapterId: null,
      states: ['open', 'manuscriptWins', 'rewrite'],
    })
  ).findings;
  return all.find((f) => f.check === check)!.id;
}

/** IP-1: open a rich `Editable` (the A44 box), replace its text, and save with Cmd+Enter. */
async function fillRich(root: Locator, text: string): Promise<void> {
  await root.locator('.editable-text').click();
  const box = root.locator('[contenteditable="true"]');
  await expect(box).toBeFocused();
  await page.keyboard.press('Meta+a');
  await page.keyboard.type(text);
  await page.keyboard.press('Meta+Enter');
  await expect(box).toHaveCount(0);
}

/** The steps Cmd+Z would take back, newest first, from the Changes popover. */
async function history(): Promise<string[]> {
  const button = page.getByTestId('top-changes');
  if ((await button.getAttribute('aria-expanded')) !== 'true') await button.click();
  const items = await page
    .getByTestId('undo-history')
    .locator('li:not(.empty):not(.redo)')
    .allTextContents();
  await page.keyboard.press('Escape');
  return items;
}

async function alignmentTab(): Promise<void> {
  await screenTab(page, 'Continuity checker', 'Alignment check');
  await expect(view()).toBeVisible();
}

test('IP-7 ED-3 a card edits the finding text, a quoted line and what must change in place, one undo step each, and Undo restores each', async () => {
  await alignmentTab();
  const p1 = finding('age');
  const id = await findingId('age');
  const before = await entryOf('findings', id);

  // The finding text: the A44 box opens in place and saves as one step.
  const text = p1.getByTestId('finding-text');
  await fillRich(text, 'The text calls Margaret seventy; the bible makes her 82 in 2040.');
  await expect
    .poll(async () => (await entryOf('findings', id)).text)
    .toBe('The text calls Margaret seventy; the bible makes her 82 in 2040.');
  await expect(text).toContainText('the bible makes her 82 in 2040.');
  expect((await history())[0]).toMatch(/^Changed Finding on /);
  await text.locator('.editable-text').focus();
  await page.keyboard.press('Meta+z');
  await expect.poll(async () => (await entryOf('findings', id)).text).toBe(before.text);

  // A quoted line: a field in the quote's own monospace label and quote box.
  const line = p1.getByTestId('quote-line-1');
  const quoteBox = p1.getByTestId('finding-quote');
  const boxBefore = await quoteBox.evaluate((el) => getComputedStyle(el).borderLeftStyle);
  // Opening the line moves nothing on the card: the finding text below stays where it was.
  const below = await text.boundingBox();
  await line.locator('.editable-text').click();
  await expect(line.locator('input')).toBeFocused();
  expect(await text.boundingBox()).toEqual(below);
  await page.keyboard.press('Escape');
  // Opening the A44 box of the finding text moves nothing either: what must change stays put.
  const must0 = p1.getByTestId('finding-must-change');
  const mustBefore = await must0.boundingBox();
  await text.locator('.editable-text').click();
  await expect(text.locator('[contenteditable="true"]')).toBeFocused();
  expect(await must0.boundingBox()).toEqual(mustBefore);
  await page.keyboard.press('Escape');
  await expect(text.locator('[contenteditable="true"]')).toHaveCount(0);
  await line.locator('.editable-text').click();
  // The input takes the quote's font, inside the same quote box.
  expect(await quoteBox.evaluate((el) => getComputedStyle(el).borderLeftStyle)).toBe(boxBefore);
  expect(
    await line
      .locator('input')
      .evaluate(
        (el) =>
          getComputedStyle(el).fontFamily ===
          getComputedStyle(el.closest('blockquote')!).fontFamily,
      ),
  ).toBe(true);
  await page.keyboard.press('Escape');
  const quoted = String(before.quote);
  await fillEditable(line, `${quoted} (checked)`);
  await expect.poll(async () => (await entryOf('findings', id)).quote).toBe(`${quoted} (checked)`);
  await expect(quoteBox).toContainText('Line 1:');
  expect((await history())[0]).toMatch(/^Changed Quoted passage on /);
  await line.locator('.editable-text').focus();
  await page.keyboard.press('Meta+z');
  await expect.poll(async () => (await entryOf('findings', id)).quote).toBe(quoted);
  await expect(quoteBox).toContainText(quoted);

  // What must change.
  const must = p1.getByTestId('finding-must-change');
  await fillRich(must, 'Margaret must be 82 here, or her birth year must move.');
  await expect
    .poll(async () => (await entryOf('findings', id)).mustChange)
    .toBe('Margaret must be 82 here, or her birth year must move.');
  expect((await history())[0]).toMatch(/^Changed What must change on /);
  await must.locator('.editable-text').focus();
  await page.keyboard.press('Meta+z');
  await expect.poll(async () => (await entryOf('findings', id)).mustChange).toBe(before.mustChange);
});

test('IP-7 the resolution note saves and shows beside the resolution chips', async () => {
  await alignmentTab();
  const p1 = finding('age');
  const id = await findingId('age');
  const resolution = p1.getByTestId('finding-resolution');
  await expect(resolution).toContainText('not resolved yet');
  await expect(resolution.getByTestId('finding-note')).toContainText('Why you chose this');
  await fillRich(resolution.getByTestId('finding-note'), 'Ruth rounds down on purpose.');
  await expect
    .poll(async () => (await entryOf('findings', id)).resolutionNote)
    .toBe('Ruth rounds down on purpose.');
  await expect(resolution).toContainText('Ruth rounds down on purpose.');
  expect((await history())[0]).toMatch(/^Changed Resolution note on /);
});

test('IP-7 Open on a card goes to the finding page', async () => {
  await alignmentTab();
  const id = await findingId('age');
  await finding('age').getByRole('button', { name: 'Open the finding page' }).click();
  await expect(page.getByTestId('editor')).toHaveAttribute('data-entry-id', id);
  await expect(page.getByTestId('editor')).toContainText('Ruth rounds down on purpose.');
});

test('IP-7 a rewrite task edits its text in place on the Continuity checker, and Done and Open chapter stay', async () => {
  await alignmentTab();
  const task = view().getByTestId('rewrite-task');
  await expect(task).toHaveCount(1);
  const id = await findingId('place');
  const before = String((await entryOf('findings', id)).mustChange);
  // The same A44 box as the card, so a value of several lines is never flattened.
  await expect(task.getByTestId('rewrite-task-text')).toHaveAttribute('data-editable', 'rich');
  await fillRich(
    task.getByTestId('rewrite-task-text'),
    'Lan grew up in Guangzhou, so change the city.',
  );
  await expect
    .poll(async () => (await entryOf('findings', id)).mustChange)
    .toBe('Lan grew up in Guangzhou, so change the city.');
  await expect(task).toContainText(
    'What must change: Lan grew up in Guangzhou, so change the city.',
  );
  await expect(task.getByRole('button', { name: 'Done' })).toBeVisible();
  await expect(task.getByRole('button', { name: 'Open chapter' })).toBeVisible();
  expect((await history())[0]).toMatch(/^Changed What must change on /);
  await task.getByTestId('rewrite-task-text-text').focus();
  await page.keyboard.press('Meta+z');
  await expect.poll(async () => (await entryOf('findings', id)).mustChange).toBe(before);
});

test('IP-7 the approved summary edits on the chapter row as one step, and Not written after all clears the flag as one step', async () => {
  await invoke('entry.update', { collection: 'chapters', id: 'CH5', patch: { written: true } });
  await screenTab(page, 'Continuity checker', 'Manuscript');
  const ms = page.getByTestId('manuscript-view');
  await ms.locator('[data-chapter="CH5"]').click();
  const ch = ms.getByTestId('ms-chapter');
  const summary = ch.getByTestId('ms-summary');
  await expect(summary.locator('.editable-label')).toHaveText('Approved summary');
  // A summary marked out of date: the hand edit approves it, in the same step.
  await invoke('entry.update', {
    collection: 'chapters',
    id: 'CH5',
    patch: { summaryOutOfDate: true },
  });
  await expect(ch.getByTestId('summary-stale')).toBeVisible();
  const summaryBefore = (await entryOf('chapters', 'CH5')).summary;
  await fillRich(summary, 'Ruth counts the candles and gets her mother wrong.');
  await expect
    .poll(async () => (await entryOf('chapters', 'CH5')).summary)
    .toBe('Ruth counts the candles and gets her mother wrong.');
  expect((await entryOf('chapters', 'CH5')).summaryOutOfDate).toBe(false);
  await expect(ch.getByTestId('summary-stale')).toHaveCount(0);
  await expect(summary).toContainText('Ruth counts the candles and gets her mother wrong.');
  const steps = await history();
  expect(steps[0]).toMatch(/^Changed Approved summary on /);
  expect(steps[1]).not.toMatch(/Summary may be out of date/);
  // One undo takes back both: the old summary and the flag.
  await page.getByTestId('top-undo').click();
  await expect.poll(async () => (await entryOf('chapters', 'CH5')).summary).toBe(summaryBefore);
  expect((await entryOf('chapters', 'CH5')).summaryOutOfDate).toBe(true);
  await expect(ch.getByTestId('summary-stale')).toBeVisible();
  await page.getByTestId('top-redo').click();
  await expect
    .poll(async () => (await entryOf('chapters', 'CH5')).summary)
    .toBe('Ruth counts the candles and gets her mother wrong.');
  expect((await entryOf('chapters', 'CH5')).summaryOutOfDate).toBe(false);

  // Not written after all: one step, and Mark as written comes back.
  await ch.getByRole('button', { name: 'Not written after all' }).click();
  await expect.poll(async () => (await entryOf('chapters', 'CH5')).written).toBe(false);
  await expect(ch.getByRole('button', { name: 'Mark as written' })).toBeVisible();
  await expect(ch.getByRole('button', { name: 'Not written after all' })).toHaveCount(0);
  expect((await history())[0]).toMatch(/^Marked as not written on /);
  await page.getByTestId('top-undo').click();
  await expect.poll(async () => (await entryOf('chapters', 'CH5')).written).toBe(true);
  await expect(ch.getByRole('button', { name: 'Not written after all' })).toBeVisible();
  await invoke('entry.update', { collection: 'chapters', id: 'CH5', patch: { written: false } });
});

test('IP-7 IP-18 the manuscript text shows read-only with Re-import beside it, and Re-import replaces it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nc-ip7-'));
  const docPath = join(dir, 'Chapter 9 Tide.docx');
  const write = async (lines: string[]) =>
    writeFileSync(
      docPath,
      await Packer.toBuffer(
        new Document({
          sections: [{ children: lines.map((text) => new Paragraph({ text })) }],
        }),
      ),
    );
  await write(['The tide came in over the seawall.', 'Iris counted the boats.']);
  await seedFixture(invoke, [
    {
      collection: 'chapters',
      // A copy of chapter 8 (its part, strands and status), linked to a Word file.
      data: {
        ...strip(fixture.chapters!.find((c) => c._id === 'CH8')!),
        _id: 'CH9',
        title: 'Tide',
        readingOrder: 9,
        manuscriptText: 'The tide came in over the seawall.\nIris counted the gulls.',
        manuscriptSource: `word:${docPath}`,
        sourceFile: 'Chapter 9 Tide.docx',
      },
    },
  ]);
  await screenTab(page, 'Continuity checker', 'Manuscript');
  const ms = page.getByTestId('manuscript-view');
  await ms.locator('[data-chapter="CH9"]').click();
  const ch = ms.getByTestId('ms-chapter');
  const row = ch.getByTestId('ms-text-row');
  const text = row.getByTestId('ms-text');
  await expect(text.locator('li')).toHaveText([
    'The tide came in over the seawall.',
    'Iris counted the gulls.',
  ]);
  // Read-only: no field, no box, no editable text anywhere in it.
  await expect(
    text.locator('input, textarea, [contenteditable="true"], [data-editable]'),
  ).toHaveCount(0);
  await expect(text).toHaveAttribute(
    'title',
    'The manuscript text is imported, not edited here. Use Re-import.',
  );
  // The write path refuses it too (IP-18).
  await expect(
    invoke('entry.update', { collection: 'chapters', id: 'CH9', patch: { manuscriptText: 'x' } }),
  ).rejects.toThrow('The manuscript text is imported, not edited here. Use Re-import.');
  // Re-import sits with the text, reads the file again and replaces it.
  const re = row.getByTestId('reimport');
  await expect(re).toContainText('Manuscript: Chapter 9 Tide.docx');
  await re.getByRole('button', { name: 'Re-import' }).click();
  const compare = re.getByTestId('reimport-compare');
  await expect(compare.locator('tr[data-kind="added"]')).toHaveText([/Iris counted the boats\./]);
  await compare.getByRole('button', { name: 'Apply' }).click();
  await expect(text.locator('li')).toHaveText([
    'The tide came in over the seawall.',
    'Iris counted the boats.',
  ]);
});

const parseRgb = (c: string): Rgba => {
  const p = (c.match(/[\d.]+/g) ?? []).map(Number);
  return [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0, p[3] ?? 1];
};

/** Every label and field text in a scope, its colour, the background under it, and the text token. */
async function colours(scope: Locator, selector: string) {
  return scope.evaluate((root, sel) => {
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
      found: [...root.querySelectorAll(sel)].map((el) => ({
        what: `${el.className} ${(el.textContent ?? '').slice(0, 30)}`,
        color: getComputedStyle(el).color,
        bg: bgOf(el),
      })),
    };
  }, selector);
}

test('IP-7 NF-2 the card fields, Open, the summary and Not written after all work by keyboard, with labels in the text colour in both themes', async () => {
  await alignmentTab();
  const p1 = finding('age');
  const id = await findingId('age');
  // Tab from the Open link reaches the quoted line; Enter opens it, Escape leaves it as it was.
  const open = p1.getByRole('button', { name: 'Open the finding page' });
  await open.focus();
  await page.keyboard.press('Tab');
  const line = p1.getByTestId('quote-line-1-text');
  await expect(line).toBeFocused();
  await expect(line).toHaveCSS('outline-style', 'solid');
  await page.keyboard.press('Enter');
  await expect(p1.getByTestId('quote-line-1').locator('input')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(line).toBeFocused();
  // The finding text opens with Enter and saves with Cmd+Enter; the focus comes back to it.
  const text = p1.getByTestId('finding-text-text');
  await text.focus();
  await page.keyboard.press('Enter');
  await expect(p1.getByTestId('finding-text').locator('[contenteditable="true"]')).toBeFocused();
  await page.keyboard.press('End');
  await page.keyboard.type(' Checked.');
  await page.keyboard.press('Meta+Enter');
  await expect
    .poll(async () => String((await entryOf('findings', id)).text))
    .toMatch(/ Checked\.$/);
  await expect(text).toBeFocused();
  await page.keyboard.press('Meta+z');
  await expect
    .poll(async () => String((await entryOf('findings', id)).text))
    .not.toMatch(/Checked/);
  // The resolution note opens from the keyboard too.
  const note = p1.getByTestId('finding-note-text');
  await note.focus();
  await page.keyboard.press('Enter');
  await expect(p1.getByTestId('finding-note').locator('[contenteditable="true"]')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(note).toBeFocused();

  // Labels and fields read in the primary text colour at 4.5:1, in both themes.
  const theme0 = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
    const read = await colours(
      view(),
      '.editable-text, .editable-label, .al-ln, .al-resolution span',
    );
    expect(read.found.length).toBeGreaterThan(8);
    for (const f of read.found) {
      expect(
        contrast(parseRgb(f.color), parseRgb(f.bg)),
        `${f.what} in ${theme}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
    for (const f of read.found.filter((x) => /editable-(label|text)/.test(x.what))) {
      expect(f.color, `${f.what} in ${theme}`).toBe(read.fg);
    }
  }

  // The Manuscript tab: Open the finding by Enter, then the summary and Not written after all.
  await open.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('editor')).toHaveAttribute('data-entry-id', id);
  await invoke('entry.update', { collection: 'chapters', id: 'CH5', patch: { written: true } });
  await screenTab(page, 'Continuity checker', 'Manuscript');
  const ms = page.getByTestId('manuscript-view');
  await ms.locator('[data-chapter="CH5"]').focus();
  await page.keyboard.press('Enter');
  const ch = ms.getByTestId('ms-chapter');
  const summary = ch.getByTestId('ms-summary-text');
  await summary.focus();
  await expect(summary).toHaveCSS('outline-style', 'solid');
  await page.keyboard.press('Enter');
  await expect(ch.getByTestId('ms-summary').locator('[contenteditable="true"]')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(summary).toBeFocused();
  const unmark = ch.getByRole('button', { name: 'Not written after all' });
  await unmark.focus();
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await entryOf('chapters', 'CH5')).written).toBe(false);
  // The read-only text takes focus, so it scrolls from the keyboard.
  await ms.locator('[data-chapter="CH9"]').click();
  await ch.getByTestId('ms-text').focus();
  await expect(ch.getByTestId('ms-text')).toBeFocused();
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
    const read = await colours(ch, '.editable-text, .editable-label, .ms-text li');
    expect(read.found.length).toBeGreaterThan(2);
    for (const f of read.found) {
      expect(
        contrast(parseRgb(f.color), parseRgb(f.bg)),
        `${f.what} in ${theme}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  }
  await page.evaluate((t) => {
    if (t === null) document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', t);
  }, theme0);
});

test('IP-7 ED-7 a re-run keeps a hand-edited finding, the card shows what the check now says, and Take the new text replaces the edit as one undo step', async () => {
  const check = 'character-present-while-dead';
  const death = (await entryOf('characters', 'H2')).death;
  // A change to Peter lifts the dismissal, and the run opens the finding in its own words.
  await invoke('entry.update', {
    collection: 'characters',
    id: 'H2',
    patch: { death: { year: 2031 } },
  });
  await invoke('continuity.check', { chapterId: null });
  await alignmentTab();
  const card = finding(check);
  await expect(card).toContainText('Peter Hale died in 2031.');
  const id = await findingId(check);

  await fillRich(card.getByTestId('finding-text'), 'Peter should not be in this scene.');
  await expect
    .poll(async () => (await entryOf('findings', id)).text)
    .toBe('Peter should not be in this scene.');

  // The check finds new words; the writer's words stay and the card offers the new ones.
  await invoke('entry.update', {
    collection: 'characters',
    id: 'H2',
    patch: { death: { year: 2029 } },
  });
  await invoke('continuity.check', { chapterId: null });
  const proposed = card.getByTestId('finding-proposed');
  await expect(proposed).toContainText('The check now says:');
  await expect(proposed).toContainText('Peter Hale died in 2029.');
  await expect(card.getByTestId('finding-text')).toContainText(
    'Peter should not be in this scene.',
  );
  expect((await entryOf('findings', id)).text).toBe('Peter should not be in this scene.');

  await proposed.getByRole('button', { name: 'Take the new text for Finding' }).click();
  await expect.poll(async () => String((await entryOf('findings', id)).text)).toMatch(/2029/);
  await expect(card.getByTestId('finding-proposed')).toHaveCount(0);
  await expect(card.getByTestId('finding-text')).toContainText('Peter Hale died in 2029.');
  expect((await history())[0]).toMatch(/^Changed Finding on /);
  await page.getByTestId('top-undo').click();
  await expect
    .poll(async () => (await entryOf('findings', id)).text)
    .toBe('Peter should not be in this scene.');
  await expect(card.getByTestId('finding-proposed')).toContainText('Peter Hale died in 2029.');

  await invoke('entry.update', { collection: 'characters', id: 'H2', patch: { death } });
});
