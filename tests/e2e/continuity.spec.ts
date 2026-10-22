import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import type { Invoke } from '../helpers/t5';
import { readFixture } from '../helpers/loadFixture';
import { readSupplement } from '../helpers/briefFixture';
import { fileDb, invokeVia, launch, rail } from './helpers';
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
    await invoke('entry.createMany', {
      items: fixture[c]!.map((d) => ({ collection: c as never, data: strip(d) })),
    });
  }
  // The M7 supplement gives the chapters arcs and beats, so the stored plot is there to compare.
  for (const c of ['moments']) {
    const docs = supplement.entries[c]!.filter((d) => !d.deletedAt);
    await invoke('entry.createMany', {
      items: docs.map((d) => ({ collection: c as never, data: strip(d) })),
    });
  }
  for (const [id, patch] of Object.entries(supplement.patches.chapters ?? {})) {
    await invoke('entry.update', { collection: 'chapters', id, patch });
  }
  await page.reload();
  await expect(page.getByTestId('dashboard')).toBeVisible();
});

test.afterAll(async () => {
  await app?.evaluate(({ app: electron }) => electron.exit(0)).catch(() => undefined);
});

const view = () => page.getByTestId('alignment-view');
const finding = (check: string) => view().locator(`[data-testid="finding"][data-check="${check}"]`);

test('CC-1 CC-2 CC-3 CC-5 SM-11 Check alignment on Sessions opens the Continuity checker, which finds S1 and S3 in code and the recorded P1 and P2 by Claude (SM-2: no facts, so no S2)', async () => {
  await page.getByTestId('dashboard').getByRole('button', { name: 'Check alignment' }).click();
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
    'Done. Structural checks: 2 found. Claude read 8 chapters and found 2.',
    { timeout: 30_000 },
  );
  const structural = view().getByTestId('structural-findings').getByTestId('finding');
  await expect(structural).toHaveCount(2);
  await expect(finding('character-present-while-dead')).toContainText(
    'Chapter 4 is set in 2032 and lists Peter Hale (H2) as present. Peter Hale died in 2030.',
  );
  await expect(finding('fact-acted-on-before-learned')).toHaveCount(0);
  await expect(finding('event-linked-as-happened-after-story-year')).toContainText(
    'E10 is dated 2090',
  );
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

test('CC-4 SM-11 Rewrite recommended makes a rewrite task with the lines and what must change, on the Continuity checker, on Sessions, and on the chapter', async () => {
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

  await rail(page, 'Sessions').click();
  await expect(page.getByTestId('dash-task-count').locator('.tile-num')).toHaveText('1');
  const tile = page.getByTestId('dash-tasks');
  await expect(tile.getByTestId('rewrite-task')).toContainText('line 1');
  await expect(tile.getByTestId('rewrite-task')).toContainText('Lan had grown up in Shanghai');
  await tile.getByRole('button', { name: 'Open chapter' }).click();
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
  await rail(page, 'Sessions').click();
  await page.getByTestId('dashboard').getByRole('button', { name: 'Check alignment' }).click();
  await finding('character-present-while-dead').getByRole('button', { name: 'Dismiss' }).click();
  await expect(finding('character-present-while-dead')).toHaveCount(0);
  await expect(view().getByTestId('findings-dismissed')).toContainText(
    '1 dismissed finding is hidden',
  );
  await view().getByTestId('alignment-run').click();
  await expect(view().getByTestId('alignment-status')).toContainText(
    'Done. Structural checks: 2 found, 1 dismissed and unchanged.',
    { timeout: 30_000 },
  );
  await expect(finding('character-present-while-dead')).toHaveCount(0);
  await expect(view().getByTestId('structural-findings').getByTestId('finding')).toHaveCount(1);
  // NF-2: the actions are buttons reached by Tab and pressed with Enter.
  const check = 'event-linked-as-happened-after-story-year';
  const dismiss = finding(check).getByRole('button', { name: 'Dismiss' });
  await dismiss.focus();
  await page.keyboard.press('Enter');
  await expect(finding(check)).toHaveCount(0);
});

test('CC-1 AI-1 Stop ends an alignment run part way: it says Stopped and records no new findings', async () => {
  await rail(page, 'Sessions').click();
  await page.getByTestId('dashboard').getByRole('button', { name: 'Check alignment' }).click();
  const all = view().getByTestId('alignment-findings').getByTestId('finding');
  const before = await all.count();
  // A marker in chapter 8's title (the text is locked, IP-18) selects the recording that waits for Stop.
  const ch8 = (await invoke('entry.get', { collection: 'chapters', id: 'CH8' })).entry;
  const title = String(ch8.title);
  await invoke('entry.update', {
    collection: 'chapters',
    id: 'CH8',
    patch: { title: `${title} E2E-HOLD-UNTIL-STOPPED` },
  });
  await view().getByTestId('alignment-scope').selectOption('CH8');
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
