import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { Invoke } from '../helpers/t5';
import { readFixture } from '../helpers/loadFixture';
import { readSupplement } from '../helpers/briefFixture';
import { invokeVia, launch, rail } from './helpers';

let server: MongoMemoryReplSet;
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
  ({ app, page } = await launch(server.getUri(), {
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
  server = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
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
  const order = ['customSections', ...Object.keys(fixture).filter((c) => c !== 'customSections')];
  for (const c of order) {
    if (c === 'lists' || !fixture[c]?.length) continue;
    await invoke('entry.createMany', {
      items: fixture[c]!.map((d) => ({ collection: c as never, data: strip(d) })),
    });
  }
  // The M7 brief supplement: arcs, beats, themes, questions, session logs, and communities.
  for (const c of ['arcs', 'plotBeats', 'themes', 'openQuestions', 'knowledgeRecords']) {
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
  for (const c of ['customEntries', 'sessionLogs']) {
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
  await server?.stop();
});

const writing = () => page.getByTestId('top-writing');
const relevant = () => page.getByTestId('relevant-view');
const strand = (id: string) =>
  relevant().locator(`[data-testid="relevant-strand"][data-strand="${id}"]`);
const groupIds = (scope: ReturnType<Page['locator']>, kind: string) =>
  scope.locator(`[data-testid="sel-group"][data-kind="${kind}"] [data-testid="sel-item"]`);

test('DB-1 the app opens on the dashboard: last note, story time, position, open questions, rewrite tasks, two controls', async () => {
  await page.reload();
  await expect(page.getByTestId('workspace')).toBeVisible();
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
  await expect(dash.getByRole('button', { name: 'Start session' })).toBeVisible();
  await dash.getByRole('button', { name: 'Check alignment' }).click();
  await expect(page.getByRole('heading', { name: 'Continuity findings', level: 2 })).toBeVisible();
  await rail(page, 'Dashboard').click();
  await expect(page.getByTestId('dashboard')).toBeVisible();
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
  for (const screen of ['Family tree', 'Timeline', 'Lists', 'Characters']) {
    await rail(page, screen).click();
    await page.getByTestId('top-relevant').click();
    await expect(relevant()).toBeVisible();
  }
  await expect(page.getByTestId('relevant-label')).toHaveText('Chapter 2: Two Kitchens');
  const strands = relevant().getByTestId('relevant-strand');
  await expect(strands).toHaveCount(2);
  await expect(strands.nth(0)).toHaveAttribute('data-strand', 'CH2-present');
  await expect(strands.nth(1)).toHaveAttribute('data-strand', 'CH2-backstory');
  await expect(strand('CH2-present')).toContainText('writing now');
  await expect(groupIds(strand('CH2-present'), 'characters')).toHaveText([
    /Daniel Hale.*alive, age 60/,
    /Zhou Lan.*alive, age 57/,
    /Iris Hale-Zhou.*alive, age 14/,
  ]);
  await expect(groupIds(strand('CH2-backstory'), 'characters')).toHaveText([
    /Zhou Lan.*alive, age 44/,
    /Zhou Meiling.*alive, age 70/,
    /Iris Hale-Zhou.*alive, age 1/,
  ]);

  // The view follows the Writing picker live.
  await writing().selectOption({ label: 'Chapter 6: The Letter, present (2045)' });
  await expect(page.getByTestId('relevant-label')).toHaveText('Chapter 6: The Letter');
  const s = strand('CH6-present');
  await expect(groupIds(s, 'era')).toHaveAttribute('data-id', 'ERA-2040');
  await expect(groupIds(s, 'culture')).toHaveAttribute('data-id', 'CU4');
  await expect(groupIds(s, 'plannedAhead')).toHaveAttribute('data-id', 'E9');
  await expect(groupIds(s, 'povUnknown')).toContainText(
    'Daniel Hale knows; Iris Hale-Zhou does not',
  );
  const shared = relevant();
  const ids = async (kind: string) =>
    groupIds(shared, kind).evaluateAll((els) => els.map((e) => e.getAttribute('data-id')));
  await expect.poll(() => ids('beats')).toEqual(['B4', 'B1', 'B7', 'B3']);
  await expect.poll(() => ids('previousChapters')).toEqual(['CH1', 'CH3', 'CH4', 'CH5']);
  await expect.poll(() => ids('themes')).toEqual(['TH1', 'TH2']);
  await expect.poll(() => ids('openQuestions')).toEqual(['Q1', 'Q4']);
  await expect.poll(() => ids('sessionNote')).toEqual(['SL2']);

  // A change anywhere in the bible shows at once.
  const th3 = (await invoke('entry.get', { collection: 'themes', id: 'TH3' })).entry;
  const apps = th3.appearances as { chapterId: string; note: string }[];
  await invoke('entry.update', {
    collection: 'themes',
    id: 'TH3',
    patch: { appearances: [...apps, { chapterId: 'CH6', note: 'Dinner' }] },
  });
  await expect.poll(() => ids('themes')).toEqual(['TH3', 'TH1', 'TH2']);
  await invoke('entry.update', { collection: 'themes', id: 'TH3', patch: { appearances: apps } });
  await expect.poll(() => ids('themes')).toEqual(['TH1', 'TH2']);

  // Each item opens its entry.
  await groupIds(s, 'culture').getByRole('button', { name: 'Flood memorial walk' }).click();
  await expect(page.getByTestId('editor')).toBeVisible();
  await expect(page.getByTestId('editor')).toContainText('Flood memorial walk');
  await rail(page, 'Relevant to Session').click();
  await expect(relevant()).toBeVisible();
});

let briefId = '';

test('DB-2 DB-3 SB-7 Start session from the top bar: the selection, a structured brief, a session log, the story time', async () => {
  await rail(page, 'Lists').click();
  await page.getByTestId('top-start-session').click();
  const view = page.getByTestId('start-session');
  await expect(view).toBeVisible();
  await expect(view.getByTestId('start-chapter')).toHaveValue('CH6');
  await expect(view.getByTestId('claude-unavailable')).toBeVisible();
  await expect(view).toContainText('What the bible selects: Chapter 6: The Letter');
  const logsBefore = (await invoke('entry.list', { collection: 'sessionLogs', trash: 'exclude' }))
    .entries.length;
  await view.getByTestId('start-session-go').click();
  const brief = page.getByTestId('brief-view');
  await expect(brief).toBeVisible();
  await expect(brief.getByTestId('brief-model')).toHaveText('Structured brief, no synthesis');
  await expect(brief.getByTestId('brief-body').locator('h2')).toHaveText([
    '1. Characters and their ages',
    '2. World events ongoing',
    '3. Cultural expectations',
    '4. Places',
    '5. Who knows what',
    '6. Previous chapters',
    '7. Beats',
    '8. Glossary, themes, and open questions',
    '9. Custom entries',
    '10. Last session note',
    'Planned ahead (after 2045)',
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
    .locator('[data-testid="sel-item"][data-id="E4"]')
    .first()
    .getByRole('button', { name: /^Remove/ })
    .click();
  await sel.getByPlaceholder('Add an entry to the selection').fill('Zhou Jun');
  await sel.getByRole('option').filter({ hasText: 'Zhou Jun' }).first().click();
  await expect(brief.getByTestId('brief-pending')).toContainText('To add: Z4');
  await expect(brief.getByTestId('brief-pending')).toContainText('To remove: E4');
  await brief.getByTestId('brief-regenerate').click();
  await expect(brief.getByTestId('brief-note')).toBeVisible();
  const saved = (await invoke('entry.get', { collection: 'briefs', id: briefId })).entry;
  expect(saved.entryIds).toContain('Z4');
  expect(saved.entryIds).not.toContain('E4');
  await expect(brief.getByTestId('brief-body')).toContainText('11. Added by you');
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
  const md = join(exportDir, 'Brief Chapter 6 The Letter.md');
  await expect(brief.getByTestId('brief-note')).toHaveText(`Saved to ${md}`);
  expect(readFileSync(md, 'utf8')).toBe(text);
  await brief.getByRole('button', { name: 'Export PDF' }).click();
  const pdf = join(exportDir, 'Brief Chapter 6 The Letter.pdf');
  await expect(brief.getByTestId('brief-note')).toHaveText(`Saved to ${pdf}`);
  expect(readFileSync(pdf).subarray(0, 5).toString()).toBe('%PDF-');
});

test('SB-4 DB-4 with Claude available the brief is written by the brief model from the selection', async () => {
  await app.evaluate(({ app: electron }) => electron.exit(0)).catch(() => undefined);
  await start({ NOVEL_COMPANION_TEST_FAKE_CLAUDE: '1' });
  await openBible();
  await page.getByTestId('top-start-session').click();
  const view = page.getByTestId('start-session');
  await view.getByTestId('start-chapter').selectOption('CH2');
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

test('MS-1 MS-2 MS-3 MS-4 MS-5 import a chapter from Word, mark it written, approve the summary, promote, and re-import with a diff', async () => {
  await rail(page, 'Manuscript').click();
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
  await expect(draft).toHaveValue(/^The Letter: /);
  expect((await invoke('entry.get', { collection: 'chapters', id: 'CH6' })).entry.summary).toBe(
    'Iris starts asking questions.',
  );
  await draft.fill('Iris finds the letter in the attic.');
  await flow.getByRole('button', { name: 'Approve summary' }).click();
  await expect(flow.getByTestId('summary-done')).toHaveText('Summary saved.');
  await expect(ch.getByTestId('summary-stale')).toHaveCount(0);
  const list = flow.getByTestId('promote-list');
  await expect(list.locator('label')).toHaveText([
    'Iris finds the letter (a beat of this chapter)',
    "Peter's letter (a fact in play)",
  ]);
  await list.getByLabel('Iris finds the letter (a beat of this chapter)').check();
  await flow.getByRole('button', { name: 'Promote checked to canon' }).click();
  await expect(list.locator('label')).toHaveText(["Peter's letter (a fact in play)"]);
  expect((await invoke('entry.get', { collection: 'plotBeats', id: 'B4' })).entry.status).toBe(
    'canon',
  );
  expect((await invoke('entry.get', { collection: 'facts', id: 'F2' })).entry.status).toBe(
    'planned',
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
  await rail(page, 'Manuscript').click();
  const ms = page.getByTestId('manuscript-view');
  await ms.locator('[data-chapter="CH6"]').click();
  await ms.getByRole('button', { name: 'Summary and promotions' }).click();
  const flow = ms.getByTestId('written-flow');
  await expect(flow.getByLabel('Summary to approve')).toHaveValue(
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
