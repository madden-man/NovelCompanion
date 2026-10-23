import { expect, test } from '@playwright/test';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import type { Invoke } from '../helpers/t5';
import { readFixture } from '../helpers/loadFixture';
import { field, fileDb, fillEditable, invokeVia, launch, openEditable, rail } from './helpers';
import type { TestDb } from './helpers';

/**
 * KB-6, KB-7 and A48 (CR-6, CR-9) through the interface: Cmd+K (or Add in
 * the status bar) opens the capture box on every screen. Enter runs the
 * capture router: a fact the router places (Route A) shows its chips and its
 * drafts and files without Claude; the rest go to the recorded Claude with
 * hints. Alt+Enter (Send it all to Claude) sends every fact on Route C, the
 * KB-6 capture with tools, which the recordings of MOVE, RECIPE, FERRY and
 * Jinan answer. The proposals show with their diffs, File it approves the
 * ticked ones and writes the ticked drafts as one undo step, Review later
 * leaves proposals in the queue, and without a key or with a failed run the
 * text is saved as an open question.
 */
let db: TestDb;
let app: ElectronApplication;
let page: Page;
let invoke: Invoke;

const KEY = 'sk-ant-api03-e2e-capture-key-0123456789abcdef';
const MOVE = 'Zhou Lan moved to Seattle when Portland started rationing water.';
const RECIPE = 'Meiling and Ruth kept the same recipe box, passed between the families.';
const FERRY = 'The ferry to Macau stopped running in winter.';
const TRAM = 'The tram to the coast was free on Sundays.';
/** A48: lines the router files from the box (Route A) against this bible. */
const MOONCAKES = 'Teenagers in Guangzhou start to eat mooncakes with coffee by the 2050s.';
const YEE_HAW = 'Teenagers in Portland begin to say yee haw ironically starting around 2065.';
const MASKS = 'Teenagers start to wear paper masks by 2060.';
/** Route A as an open question; its words hold the RECIPE recording, so Ask Claude instead reaches it. */
const RECIPE_MAYBE =
  'Meiling and Ruth kept the same recipe box, passed between the families, maybe?';
/** Route B: the fast file's recording answers it with "cannot place". */
const KESSLER = 'The Kessler crowd stops tipping by 2070.';
/** Route B: the fast file's recording holds until Stop. */
const HOLD = 'The Kessler crowd stops tipping HOLD-FAST-UNTIL-STOPPED by 2070.';
const fixture = readFixture();

test.describe.configure({ mode: 'serial' });

function strip(d: Record<string, unknown>): Record<string, unknown> {
  const { createdAt: _c, modifiedAt: _m, ...rest } = d;
  return rest;
}

test.beforeAll(async () => {
  db = fileDb();
  ({ app, page } = await launch(db, {
    // Slow enough to see the proposals arrive one at a time.
    NOVEL_COMPANION_TEST_CLAUDE_STEP_DELAY_MS: '60',
  }));
  invoke = invokeVia(page);
  await invoke('bible.create', { slug: 'capture-fixture', name: 'Capture fixture' });
  await invoke('bible.open', { slug: 'capture-fixture' });
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
    await invoke('test.seed', {
      items: fixture[c]!.map((d) => ({ collection: c as never, data: strip(d) })),
    });
  }
  await invoke('storyTime.set', { time: { year: 2034 } });
  await invoke('claude.setKey', { key: KEY });
  await invoke('claude.acknowledge', {});
});

test.afterAll(async () => {
  await app?.close();
});

const box = () => page.getByTestId('capture-box');
const input = () => box().getByTestId('capture-input');
const cards = () => box().getByTestId('capture-card');

async function send(text: string) {
  await page.keyboard.press('Meta+k');
  await expect(input()).toBeFocused();
  await input().fill(text);
  await input().press('Enter');
}

/** CR-5: Alt+Enter sends every fact to Claude on Route C, the KB-6 capture the recordings answer. */
async function sendAll(text: string) {
  await page.keyboard.press('Meta+k');
  await expect(input()).toBeFocused();
  await input().fill(text);
  await input().press('Alt+Enter');
}

test('KB-6 NF-2 Cmd+K opens the box from Characters and from the tree with the story time; Escape closes it', async () => {
  await expect(page.getByTestId('rail')).toBeVisible();
  await page.keyboard.press('Meta+k');
  await expect(box()).toBeVisible();
  await expect(box().getByRole('heading', { name: 'Add to the bible' })).toBeVisible();
  await expect(box().getByTestId('capture-time')).toContainText('Story time 2034');
  await expect(input()).toBeFocused();
  await expect(box()).toContainText(
    'Enter shows where each sentence goes; nothing is filed before File it. Alt+Enter sends it all to Claude. Shift+Enter for a new line.',
  );
  // Shift+Enter is a new line, and the unsent text is there when the box opens again.
  await input().pressSequentially('First line');
  await input().press('Shift+Enter');
  await input().pressSequentially('second line');
  await expect(input()).toHaveText('First line\nsecond line', { useInnerText: true });
  await page.keyboard.press('Escape');
  await expect(box()).toBeHidden();

  await rail(page, 'Family tree').click();
  await page.keyboard.press('Meta+k');
  await expect(box()).toBeVisible();
  await expect(input()).toHaveText('First line\nsecond line', { useInnerText: true });
  // NF-2: Tab stays inside the box.
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press('Tab');
    expect(await box().evaluate((el) => el.contains(document.activeElement))).toBe(true);
  }
  await input().fill('');
  await page.keyboard.press('Escape');
  await expect(box()).toBeHidden();

  // The status bar Add button is a plain button: Tab and Enter reach it.
  const add = page.getByTestId('status-bar').getByTestId('capture-add');
  await add.focus();
  await page.keyboard.press('Enter');
  await expect(box()).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(add).toBeFocused();
});

test('KB-6 NF-2 Cmd+K does nothing while another dialog holds focus', async () => {
  await page.keyboard.press('Meta+t');
  const story = page.getByTestId('story-time-dialog');
  await expect(story).toBeVisible();
  await page.keyboard.press('Meta+k');
  await expect(box()).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(story).toBeHidden();
});

test('KB-6 SM-3 Enter shows two proposal cards with diffs; unticking one and Cmd+Enter files the other; the Filed link opens it', async () => {
  const lanBefore = (await invoke('entry.get', { collection: 'characters', id: 'Z3' })).entry;
  await sendAll(MOVE);
  await expect(box()).toHaveAttribute('data-phase', 'running');
  await expect(box().getByTestId('capture-sent')).toHaveText(MOVE);
  await expect(cards()).toHaveCount(2);
  await expect(box()).toHaveAttribute('data-phase', 'routed');
  await expect(box().getByTestId('capture-answer')).toContainText(
    'I proposed a moment for Zhou Lan, Lives in Seattle from 2034',
  );
  // SM-3: where a character lives is a Lives in moment.
  await expect(cards().nth(0)).toContainText('New moment Lives in Seattle');
  await expect(cards().nth(0).getByTestId('proposal-diff')).toContainText('Z3');
  await expect(cards().nth(0).getByTestId('proposal-diff')).toContainText('2034');
  await expect(cards().nth(1)).toContainText('New world event Portland rations water');
  await expect(cards().nth(1).getByTestId('proposal-diff')).toContainText('2034');
  // AI-3: nothing is written yet.
  expect((await invoke('entry.get', { collection: 'characters', id: 'Z3' })).entry).toEqual(
    lanBefore,
  );

  // NF-2: every control takes focus by Tab, and focus stays in the box. IP-17: each
  // proposed value is a field too, so the round through the box is longer.
  const reached = new Set<string>();
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press('Tab');
    const id = await page.evaluate(
      () =>
        document.activeElement?.getAttribute('data-testid') ??
        document.activeElement?.textContent?.trim() ??
        '',
    );
    reached.add(id);
    expect(await box().evaluate((el) => el.contains(document.activeElement))).toBe(true);
  }
  for (const id of ['capture-tick', 'capture-file', 'capture-later', 'Close']) {
    expect([...reached], id).toContain(id);
  }

  // Untick the moment; File it names how many.
  await cards().nth(0).getByTestId('capture-tick').uncheck();
  await expect(box().getByTestId('capture-file')).toContainText('File 1 of 2');
  await page.keyboard.press('Meta+Enter');
  const filed = box().getByTestId('capture-filed');
  await expect(filed).toContainText('Filed');
  const link = filed.getByRole('button', { name: 'Portland rations water' });
  await expect(link).toBeVisible();
  await expect(filed.getByRole('button', { name: 'Add another' })).toBeVisible();

  const events = await invoke('entry.list', { collection: 'worldEvents', trash: 'exclude' });
  const made = events.entries.find((e) => e.entry.title === 'Portland rations water')!.entry;
  expect(made).toMatchObject({ status: 'idea', start: { year: 2034 } });
  expect(String(made.sourceNote)).toMatch(/^From a capture on /);
  const moments = await invoke('entry.list', { collection: 'moments', trash: 'exclude' });
  expect(moments.entries.some((e) => e.entry.title === 'Lives in Seattle')).toBe(false);
  expect((await invoke('entry.get', { collection: 'characters', id: 'Z3' })).entry).toEqual(
    lanBefore,
  );

  await link.click();
  await expect(box()).toBeHidden();
  await expect(field(page.getByTestId('editor'), 'title').locator('input')).toHaveValue(
    'Portland rations water',
  );
});

test('KB-6 ED-3 Cmd+Z undoes the filing in one step', async () => {
  await page.getByTestId('status-bar').click();
  await page.keyboard.press('Meta+z');
  await expect
    .poll(async () => {
      const list = await invoke('entry.list', { collection: 'worldEvents', trash: 'exclude' });
      return list.entries.some((e) => e.entry.title === 'Portland rations water');
    })
    .toBe(false);
  await page.keyboard.press('Shift+Meta+z');
  await expect
    .poll(async () => {
      const list = await invoke('entry.list', { collection: 'worldEvents', trash: 'exclude' });
      return list.entries.some((e) => e.entry.title === 'Portland rations water');
    })
    .toBe(true);
});

test('KB-6 Review later leaves the proposal pending in the review queue', async () => {
  await sendAll(RECIPE);
  await expect(cards()).toHaveCount(2);
  await expect(cards().first()).toContainText('New moment Shares a recipe box with Ruth Hale');
  await box().getByTestId('capture-later').click();
  await expect(box()).toBeHidden();
  const { proposals } = await invoke('proposal.list', { state: 'pending' });
  expect(proposals.map((p) => p.proposal.data.title)).toEqual(
    expect.arrayContaining([
      'Shares a recipe box with Ruth Hale',
      'Shares a recipe box with Zhou Meiling',
    ]),
  );
  await rail(page, 'Review queue').click();
  await expect(page.getByTestId('review-queue')).toContainText(
    'Shares a recipe box with Ruth Hale',
  );
  // Reopening starts fresh: the sent text is not put back.
  await page.keyboard.press('Meta+k');
  await expect(input()).toHaveText('');
  await page.keyboard.press('Escape');
});

test('KB-6 Escape in the review leaves the proposals pending, as Review later does', async () => {
  const pending = async () =>
    (await invoke('proposal.list', { state: 'pending' })).proposals.filter(
      (p) => p.proposal.data.title === 'Shares a recipe box with Ruth Hale',
    ).length;
  const before = await pending();
  await sendAll(RECIPE);
  await expect(cards()).toHaveCount(2);
  await expect(box()).toHaveAttribute('data-phase', 'routed');
  await page.keyboard.press('Escape');
  await expect(box()).toBeHidden();
  expect(await pending()).toBe(before + 1);
});

const JINAN = 'Add culture for Jinan, 2045';
const communities = async () =>
  (await invoke('lists.get', {})).lists.find((l) => l._id === 'communities')!.items;
const lineTitled = async (title: string) =>
  (await invoke('entry.list', { collection: 'culturalEntries', trash: 'exclude' })).entries.find(
    (e) => e.entry.title === title,
  )?.entry;
const diffRow = (card: ReturnType<typeof cards>, path: string) =>
  card.getByTestId('proposal-diff').locator(`tr[data-path="${path}"]`);

test('IP-17 KB-6 Add culture for Jinan shows the new community as a field; edited values and the edited name land, the item before the line', async () => {
  await sendAll(JINAN);
  await expect(cards()).toHaveCount(2);
  await expect(box()).toHaveAttribute('data-phase', 'routed');
  const item = cards().nth(0);
  const line = cards().nth(1);
  // The new item is a field of the diff: "Community: + Jinan", ticked like any other.
  await expect(item).toContainText('New list item: Jinan');
  await expect(diffRow(item, 'Community').getByRole('rowheader')).toHaveText('Community');
  await expect(item.getByTestId('proposal-label-text')).toHaveText('+ Jinan');
  await expect(item.getByTestId('capture-tick')).toBeChecked();
  await expect(line).toContainText('Jinan in 2045');
  await expect(diffRow(line, 'communityId').getByTestId('proposed-value-text')).toHaveText(
    '+ Jinan',
  );
  expect((await communities()).some((i) => i.label.startsWith('Jinan'))).toBe(false);

  // The name and the values edit in place before filing; nothing reaches the bible yet (AI-3).
  await fillEditable(item.getByTestId('proposal-label'), 'Jinan City');
  await expect(item.getByTestId('proposal-label-text')).toHaveText('+ Jinan City');
  await expect(diffRow(line, 'communityId').getByTestId('proposed-value-text')).toHaveText(
    '+ Jinan City',
  );
  await fillEditable(diffRow(line, 'title').getByTestId('proposed-value'), 'Jinan street food');
  await fillEditable(diffRow(line, 'endYear').getByTestId('proposed-value'), '2049');
  await expect(diffRow(line, 'endYear').getByTestId('proposed-value-text')).toHaveText('2049');
  expect((await communities()).some((i) => i.label.startsWith('Jinan'))).toBe(false);
  expect(await lineTitled('Jinan street food')).toBeUndefined();

  // NF-2: the fields are reached by Tab like the ticks.
  await item.getByTestId('capture-tick').focus();
  await page.keyboard.press('Tab');
  await expect(item.getByTestId('proposal-label-text')).toBeFocused();

  await page.keyboard.press('Meta+Enter');
  await expect(box().getByTestId('capture-filed')).toContainText('Jinan street food');
  const jinan = (await communities()).find((i) => i.label === 'Jinan City');
  expect(jinan).toBeTruthy();
  expect(await lineTitled('Jinan street food')).toMatchObject({
    communityId: jinan!.id,
    startYear: 2045,
    endYear: 2049,
  });
  await page.keyboard.press('Escape');
  await expect(box()).toBeHidden();
  // One Cmd+Z takes the line and the new community back out.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Meta+z');
  await expect.poll(async () => lineTitled('Jinan street food')).toBeUndefined();
  await expect
    .poll(async () => (await communities()).some((i) => i.label === 'Jinan City'))
    .toBe(false);
});

test('IP-17 ED-7 the review queue shows the new community as a field and its name edits before approval; approving the line adds it first', async () => {
  await sendAll(JINAN);
  await expect(cards()).toHaveCount(2);
  await box().getByTestId('capture-later').click();
  await expect(box()).toBeHidden();
  await rail(page, 'Review queue').click();
  const queue = page.getByTestId('review-queue');
  const pending = (await invoke('proposal.list', { state: 'pending' })).proposals;
  const add = pending.find((p) => p.proposal.listAdd?.label === 'Jinan')!.proposal;
  const made = pending.find(
    (p) => p.proposal.op === 'create' && p.proposal.data.title === 'Jinan in 2045',
  )!.proposal;
  const itemCard = queue.locator(`[data-proposal="${add._id}"]`);
  const lineCard = queue.locator(`[data-proposal="${made._id}"]`);
  await expect(itemCard.getByTestId('proposal-diff')).toContainText('Community');
  await expect(itemCard.getByTestId('proposal-label-text')).toHaveText('+ Jinan');
  await fillEditable(itemCard.getByTestId('proposal-label'), 'Jinan Old Town');
  await expect(itemCard.getByTestId('proposal-label-text')).toHaveText('+ Jinan Old Town');
  await expect(lineCard.getByTestId('proposal-diff')).toContainText('+ Jinan Old Town');
  // A name the list already has is refused at the field, in plain words.
  await openEditable(itemCard.getByTestId('proposal-label'));
  await itemCard.getByTestId('proposal-label').locator('input').fill('Portland');
  await itemCard.getByTestId('proposal-label').locator('input').press('Enter');
  await expect(itemCard.getByRole('alert')).toContainText('already has Portland');
  await itemCard.getByTestId('proposal-label').locator('input').press('Escape');
  // Approving the line approves the new item first.
  await lineCard.getByRole('button', { name: 'Approve' }).click();
  await expect(lineCard).toHaveCount(0);
  await expect(itemCard).toHaveCount(0);
  const oldTown = (await communities()).find((i) => i.label === 'Jinan Old Town');
  expect(oldTown).toBeTruthy();
  expect(await lineTitled('Jinan in 2045')).toMatchObject({ communityId: oldTown!.id });
  await expect(queue).toContainText('Approved after editing');
});

// ---------- A48: capture routing in the box (CR-6, CR-9, CR-10) ----------

const facts = () => box().getByTestId('capture-fact');
const runCount = async (feature: 'capture' | 'captureFast') =>
  (await invoke('claude.runs', { feature })).runs.length;
const chip = (card: Locator, name: string) => card.getByTestId(`chip-${name}`);
async function pick(card: Locator, name: string, value: string) {
  const f = card.getByTestId(`chip-${name}-field`);
  await openEditable(f);
  await f.locator('select').selectOption(value);
  await expect(f.locator('select')).toHaveCount(0);
}

test('CR-6 Enter on a clear cultural line shows chips and a diff and sends nothing; Cmd+Enter files it and the Filed list links it', async () => {
  const before = [await runCount('capture'), await runCount('captureFast')];
  await send(MOONCAKES);
  await expect(box()).toHaveAttribute('data-phase', 'routed');
  await expect(facts()).toHaveCount(1);
  const card = facts().first();
  await expect(card).toHaveAttribute('data-stand', 'local');
  await expect(card).toContainText(
    'New cultural entry Teenagers in Guangzhou start to eat mooncakes with coffee',
  );
  // The chips for cultural data, in one row under the title.
  await expect(chip(card, 'section')).toContainText('Cultural data');
  await expect(chip(card, 'community')).toContainText('Guangzhou');
  await expect(chip(card, 'age')).toContainText('Ages 0 to 18');
  await expect(chip(card, 'year')).toContainText('2050');
  // An open end shows the timeline end it is stored as (CR-2).
  await expect(chip(card, 'end')).toContainText('Open (2100)');
  // The cue labels that placed it, in small text.
  await expect(card.getByTestId('capture-route')).toContainText(
    'Files here, without Claude. Placed by: a group starts to say or do something',
  );
  // The drafts as the ED-7 table, with the status and the source note File it adds.
  const diff = card.getByTestId('draft-diff');
  await expect(diff.getByRole('columnheader')).toHaveText(['Field', 'Now', 'Proposed']);
  await expect(diff.locator('tr[data-path="communityId"]')).toContainText('Guangzhou');
  await expect(diff.locator('tr[data-path="startYear"]')).toContainText('2050');
  await expect(diff.locator('tr[data-path="status"]')).toContainText('Idea');
  await expect(diff.locator('tr[data-path="sourceNote"]')).toContainText('filed without Claude.');
  await expect(card.getByTestId('capture-fact-tick')).toBeChecked();
  // Nothing was sent and nothing written (CR-6, AI-3).
  expect([await runCount('capture'), await runCount('captureFast')]).toEqual(before);
  expect(
    await lineTitled('Teenagers in Guangzhou start to eat mooncakes with coffee'),
  ).toBeUndefined();

  await page.keyboard.press('Meta+Enter');
  const filed = box().getByTestId('capture-filed');
  const link = filed.getByRole('button', {
    name: 'Teenagers in Guangzhou start to eat mooncakes with coffee',
  });
  await expect(link).toBeVisible();
  const made = (await lineTitled('Teenagers in Guangzhou start to eat mooncakes with coffee'))!;
  expect(made).toMatchObject({
    status: 'idea',
    communityId: 'guangzhou',
    demographic: '0-18',
    startYear: 2050,
    endYear: 2100,
    body: MOONCAKES,
  });
  expect(String(made.sourceNote)).toMatch(
    /^From a capture on \d{4}-\d{2}-\d{2}, filed without Claude\.$/,
  );
  expect([await runCount('capture'), await runCount('captureFast')]).toEqual(before);
  // The link opens the entry; its provenance names the capture and says Claude was not used.
  await link.click();
  await expect(box()).toBeHidden();
  const editor = page.getByTestId('editor');
  await expect(field(editor, 'title').locator('input')).toHaveValue(
    'Teenagers in Guangzhou start to eat mooncakes with coffee',
  );
  await expect(field(editor, 'sourceNote')).toContainText('filed without Claude.');
});

test('CR-6 changing the Section chip re-routes', async () => {
  const before = await runCount('captureFast');
  await send(YEE_HAW);
  const card = facts().first();
  await expect(card).toHaveAttribute('data-stand', 'local');
  await expect(chip(card, 'community')).toContainText('Portland');
  // A world event needs a category picked among many: the card now needs Claude (CR-5).
  await pick(card, 'section', 'worldEvents');
  await expect(chip(card, 'section')).toContainText('World event');
  await expect(chip(card, 'category')).toBeVisible();
  await expect(chip(card, 'community')).toHaveCount(0);
  await expect(card).toHaveAttribute('data-stand', 'unsent');
  await expect(card).not.toHaveAttribute('data-route', 'local');
  await expect(card.getByTestId('capture-route')).toContainText('Needs Claude');
  await expect(card.getByTestId('capture-route')).toContainText('category to choose');
  await expect(card.getByTestId('capture-send-fact')).toBeVisible();
  await expect(card.getByTestId('draft-diff')).toHaveCount(0);
  // Back to cultural data: filed from the box again, with its chips and diff.
  await pick(card, 'section', 'culturalEntries');
  await expect(card).toHaveAttribute('data-stand', 'local');
  await expect(chip(card, 'community')).toContainText('Portland');
  await expect(card.getByTestId('draft-diff')).toContainText('Portland');
  // A chip change sends nothing.
  expect(await runCount('captureFast')).toBe(before);
  await page.keyboard.press('Escape');
  await expect(box()).toBeHidden();
  expect(await lineTitled('Teenagers in Portland begin to say yee haw ironically')).toBeUndefined();
});

test('CR-6 a missing community is a highlighted chip and File it waits for it', async () => {
  await send(MASKS);
  const card = facts().first();
  await expect(card).toHaveAttribute('data-stand', 'local');
  await expect(chip(card, 'community')).toHaveAttribute('data-needed', 'true');
  await expect(chip(card, 'community')).toContainText('Community (needed)');
  await expect(card.getByTestId('capture-needed')).toContainText('Pick the community');
  await expect(card.getByTestId('capture-fact-tick')).toBeDisabled();
  await expect(card.getByTestId('capture-fact-tick')).not.toBeChecked();
  await expect(box().getByTestId('capture-file')).toBeDisabled();
  await expect(box().getByTestId('capture-file-waits')).toBeVisible();
  // Cmd+Enter waits too: nothing is filed.
  await page.keyboard.press('Meta+Enter');
  await expect(box()).toHaveAttribute('data-phase', 'routed');
  expect(await lineTitled('Teenagers start to wear paper masks')).toBeUndefined();

  await pick(card, 'community', 'portland');
  await expect(chip(card, 'community')).not.toHaveAttribute('data-needed', 'true');
  await expect(card.getByTestId('capture-fact-tick')).toBeChecked();
  await expect(box().getByTestId('capture-file')).toBeEnabled();
  await expect(card.getByTestId('draft-diff').locator('tr[data-path="communityId"]')).toContainText(
    'Portland',
  );
  await page.keyboard.press('Meta+Enter');
  await expect(box().getByTestId('capture-filed')).toContainText(
    'Teenagers start to wear paper masks',
  );
  expect(await lineTitled('Teenagers start to wear paper masks')).toMatchObject({
    communityId: 'portland',
    startYear: 2060,
    status: 'idea',
  });
  await page.keyboard.press('Escape');
});

test('CR-6 KB-7 Review later keeps a fact the box would file as an open question; nothing else is written', async () => {
  await send(YEE_HAW);
  await expect(facts().first()).toHaveAttribute('data-stand', 'local');
  await box().getByTestId('capture-later').click();
  await expect(box().getByTestId('capture-saved')).toContainText('Saved as an open question');
  const list = await invoke('entry.list', { collection: 'openQuestions', trash: 'exclude' });
  expect(list.entries.find((e) => e.entry.title === YEE_HAW)?.entry).toMatchObject({
    question: YEE_HAW,
    tags: ['capture'],
  });
  expect(await lineTitled('Teenagers in Portland begin to say yee haw ironically')).toBeUndefined();
  await page.keyboard.press('Escape');
  await expect(box()).toBeHidden();
});

test('CR-9 CR-7 a two-sentence capture shows two cards; the Route A one files locally and the Route B one streams from the recording', async () => {
  const fastBefore = await runCount('captureFast');
  const fullBefore = await runCount('capture');
  // The recording answers for fact 0, so the fast fact comes first.
  await send(`${KESSLER} ${YEE_HAW}`);
  await expect(facts()).toHaveCount(2);
  const [fast, local] = [facts().nth(0), facts().nth(1)];
  await expect(local).toHaveAttribute('data-stand', 'local');
  await expect(fast).toHaveAttribute('data-route', 'fast');
  // The fast file's recording streams in and says it cannot place the fact, with why (CR-7).
  await expect(fast.getByTestId('capture-run')).toBeVisible();
  await expect(box()).toHaveAttribute('data-phase', 'routed');
  await expect(fast.getByTestId('capture-cannot-place')).toContainText(
    'Claude could not place this. The text names no community the bible has, so the fact needs the full capture.',
  );
  // The fact comes back to the box, with Ask Claude instead (Route C) one click away.
  await expect(fast).toHaveAttribute('data-stand', 'unsent');
  await expect(fast.getByTestId('capture-ask-claude')).toBeVisible();
  expect(await runCount('captureFast')).toBe(fastBefore + 1);
  expect(await runCount('capture')).toBe(fullBefore);
  // File it writes the Route A line and says the other sentence stays behind.
  await expect(box().getByTestId('capture-file')).toContainText('File 1 of 2');
  await expect(box().getByTestId('capture-stays')).toContainText(
    'One sentence needs Claude and was not sent. File it leaves it in the box.',
  );
  await page.keyboard.press('Meta+Enter');
  const filed = box().getByTestId('capture-filed');
  await expect(filed.getByTestId('capture-left')).toContainText(
    'One sentence was not filed and is back in the box.',
  );
  await expect(
    filed.getByRole('button', { name: 'Teenagers in Portland begin to say yee haw ironically' }),
  ).toBeVisible();
  expect(await lineTitled('Teenagers in Portland begin to say yee haw ironically')).toMatchObject({
    communityId: 'portland',
    startYear: 2065,
    endYear: 2100,
  });
  expect(await lineTitled('The Kessler crowd stops tipping')).toBeUndefined();
  // Add another starts from the sentence that was not filed.
  await filed.getByRole('button', { name: 'Add another' }).click();
  await expect(input()).toHaveText(KESSLER);
  await input().fill('');
  await page.keyboard.press('Escape');
});

test('CR-6 Ask Claude instead sends the fact on Route C', async () => {
  const fastBefore = await runCount('captureFast');
  const fullBefore = await runCount('capture');
  await send(`${MOONCAKES} ${RECIPE_MAYBE}`);
  await expect(facts()).toHaveCount(2);
  const [line, recipe] = [facts().nth(0), facts().nth(1)];
  await expect(line).toHaveAttribute('data-stand', 'local');
  await expect(recipe).toHaveAttribute('data-stand', 'local');
  expect(await runCount('capture')).toBe(fullBefore);
  await recipe.getByTestId('capture-ask-claude').click();
  await expect(recipe).toHaveAttribute('data-stand', 'sent');
  await expect(recipe).toHaveAttribute('data-route', 'full');
  await expect(recipe.getByTestId('capture-route')).toContainText('Sent to Claude, full capture.');
  // The chips of a sent fact are the hints that went with the text: read-only.
  await expect(chip(recipe, 'section').locator('.editable')).toHaveClass(/is-disabled/);
  // The full capture's recording streams its proposals into that fact's card.
  await expect(recipe.getByTestId('capture-card')).toHaveCount(2);
  await expect(recipe.getByTestId('capture-card').first()).toContainText(
    'New moment Shares a recipe box with Ruth Hale',
  );
  await expect(box()).toHaveAttribute('data-phase', 'routed');
  // The other fact stays with the box: main skipped it.
  await expect(line).toHaveAttribute('data-stand', 'local');
  expect(await runCount('capture')).toBe(fullBefore + 1);
  expect(await runCount('captureFast')).toBe(fastBefore);
  await expect(box().getByTestId('capture-file')).toContainText('File it');
});

test('CR-6 CR-9 ED-3 Cmd+Z undoes a mixed filing in one step', async () => {
  // The box from the row above: one Route A line and two proposals from the full capture.
  await expect(facts()).toHaveCount(2);
  const title = 'Teenagers in Guangzhou start to eat mooncakes with coffee';
  const linesBefore = (
    await invoke('entry.list', { collection: 'culturalEntries', trash: 'exclude' })
  ).entries.filter((e) => e.entry.title === title).length;
  const recipeMoments = async () =>
    (await invoke('entry.list', { collection: 'moments', trash: 'exclude' })).entries.filter((e) =>
      String(e.entry.title).startsWith('Shares a recipe box with'),
    ).length;
  const momentsBefore = await recipeMoments();
  const lines = async () =>
    (
      await invoke('entry.list', { collection: 'culturalEntries', trash: 'exclude' })
    ).entries.filter((e) => e.entry.title === title).length;

  await page.keyboard.press('Meta+Enter');
  const filed = box().getByTestId('capture-filed');
  await expect(filed.getByRole('button', { name: title })).toBeVisible();
  await expect(
    filed.getByRole('button', { name: 'Shares a recipe box with Ruth Hale' }),
  ).toBeVisible();
  await expect(
    filed.getByRole('button', { name: 'Shares a recipe box with Zhou Meiling' }),
  ).toBeVisible();
  expect(await lines()).toBe(linesBefore + 1);
  expect(await recipeMoments()).toBe(momentsBefore + 2);

  await page.keyboard.press('Escape');
  await expect(box()).toBeHidden();
  await page.getByTestId('status-bar').click();
  await page.keyboard.press('Meta+z');
  await expect.poll(lines).toBe(linesBefore);
  await expect.poll(recipeMoments).toBe(momentsBefore);
  await page.keyboard.press('Shift+Meta+z');
  await expect.poll(lines).toBe(linesBefore + 1);
  await expect.poll(recipeMoments).toBe(momentsBefore + 2);
});

test('CR-9 plain Enter sends a full-route fact to Claude with hints, and main runs only that fact; a failed run hands its sentence back, and Escape puts the unfiled sentences back in the box', async () => {
  const before = await runCount('capture');
  // The router sends TRAM to Route C (nothing scores); the fake has no recording for it, so the run fails.
  await send(`${MOONCAKES} ${TRAM}`);
  await expect(facts()).toHaveCount(2);
  const tram = facts().nth(1);
  await expect(facts().nth(0)).toHaveAttribute('data-stand', 'local');
  await expect(tram).toHaveAttribute('data-route', 'full');
  await expect(tram.getByTestId('claude-error')).toBeVisible();
  await expect(tram).toHaveAttribute('data-stand', 'unsent');
  await expect(tram.getByTestId('capture-ask-claude')).toBeVisible();
  // One full capture ran, and main filed only the fact the hints left to it.
  expect(await runCount('capture')).toBe(before + 1);
  const newest = (await invoke('claude.runs', { feature: 'capture' })).runs[0]!;
  const { run } = await invoke('claude.run', { id: newest.id });
  const routing = (
    run.input as { routing: { facts: { index: number; route: string; text: string }[] } }
  ).routing;
  expect(routing.facts.map((f) => [f.index, f.route, f.text])).toEqual([[1, 'full', TRAM]]);
  await expect(box().getByTestId('capture-file')).toContainText('File 1 of 2');
  // Escape writes nothing and keeps both sentences in the box.
  await page.keyboard.press('Escape');
  await expect(box()).toBeHidden();
  await page.keyboard.press('Meta+k');
  await expect(input()).toHaveText(`${MOONCAKES} ${TRAM}`);
  await input().fill('');
  await page.keyboard.press('Escape');
  await expect(box()).toBeHidden();
});

test('KB-7 AI-7 CR-9 a mixed capture whose Claude run fails still files its Route A fact and puts the failed sentence back in the box', async () => {
  await send(`${MOONCAKES} ${FERRY}`);
  await expect(facts()).toHaveCount(2);
  const ferry = facts().nth(1);
  await expect(ferry).toHaveAttribute('data-stand', 'unsent');
  // Route C with the recording: no network, so the run fails and the sentence stays.
  await ferry.getByTestId('capture-ask-claude').click();
  await expect(ferry.getByTestId('claude-error').last()).toContainText('could not reach Anthropic');
  await expect(box()).toHaveAttribute('data-phase', 'routed');
  await expect(ferry).toHaveAttribute('data-stand', 'unsent');
  // Nothing was saved as a question: the box still holds the sentence.
  const questions = async () =>
    (await invoke('entry.list', { collection: 'openQuestions', trash: 'exclude' })).entries.filter(
      (e) => e.entry.title === FERRY,
    ).length;
  const questionsBefore = await questions();
  await expect(box().getByTestId('capture-file')).toContainText('File 1 of 2');
  await page.keyboard.press('Meta+Enter');
  const filed = box().getByTestId('capture-filed');
  await expect(
    filed.getByRole('button', {
      name: 'Teenagers in Guangzhou start to eat mooncakes with coffee',
    }),
  ).toBeVisible();
  await expect(filed.getByTestId('capture-left')).toBeVisible();
  expect(await questions()).toBe(questionsBefore);
  await filed.getByRole('button', { name: 'Add another' }).click();
  await expect(input()).toHaveText(FERRY);
  await input().fill('');
  await page.keyboard.press('Escape');
});

test('CR-9 AI-1 Stop stops a split capture the fake holds; its sentences come back and the Route A fact still files', async () => {
  // HOLD goes to the fast file, whose recording waits for Stop; TRAM goes to the full capture.
  await send(`${YEE_HAW} ${HOLD} ${TRAM}`);
  await expect(facts()).toHaveCount(3);
  await expect(box()).toHaveAttribute('data-phase', 'running');
  await expect(facts().nth(1)).toHaveAttribute('data-route', 'fast');
  await box().getByTestId('capture-stop').click();
  await expect(box()).toHaveAttribute('data-phase', 'routed');
  await expect(facts().nth(1)).toHaveAttribute('data-stand', 'unsent');
  await expect(facts().nth(2)).toHaveAttribute('data-stand', 'unsent');
  await expect(box().getByTestId('capture-file')).toContainText('File 1 of 3');
  await page.keyboard.press('Meta+Enter');
  const filed = box().getByTestId('capture-filed');
  await expect(filed.getByTestId('capture-left')).toContainText(
    '2 sentences were not filed and are back in the box.',
  );
  await filed.getByRole('button', { name: 'Add another' }).click();
  await expect(input()).toHaveText(`${HOLD} ${TRAM}`);
  await input().fill('');
  await page.keyboard.press('Escape');
});

test('KB-7 AI-7 a failed run saves the text as an open question tagged capture, with a link', async () => {
  await sendAll(FERRY);
  const saved = box().getByTestId('capture-saved');
  await expect(saved).toContainText('Saved as an open question');
  await expect(saved).toContainText('could not reach Anthropic');
  const list = await invoke('entry.list', { collection: 'openQuestions', trash: 'exclude' });
  const q = list.entries.find((e) => e.entry.title === FERRY)!.entry;
  expect(q).toMatchObject({ tags: ['capture'], question: FERRY });
  expect(String(q.body)).toContain('Story time 2034');
  await saved.getByRole('button', { name: FERRY }).click();
  await expect(box()).toBeHidden();
  await expect(field(page.getByTestId('editor'), 'title').locator('input')).toHaveValue(FERRY);
});

test('KB-7 with the key removed, Enter saves an open question and sends nothing', async () => {
  await invoke('claude.clearKey', {});
  const before = (await invoke('claude.runs', { feature: 'capture' })).runs.length;
  await send(TRAM);
  await expect(box().getByTestId('capture-saved')).toContainText('Saved as an open question');
  const list = await invoke('entry.list', { collection: 'openQuestions', trash: 'exclude' });
  expect(list.entries.find((e) => e.entry.title === TRAM)?.entry.tags).toEqual(['capture']);
  expect((await invoke('claude.runs', { feature: 'capture' })).runs).toHaveLength(before);
  // Add another clears the box for the next one.
  await box().getByRole('button', { name: 'Add another' }).click();
  await expect(input()).toHaveText('');
  await expect(input()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(box()).toBeHidden();
});

test('CR-6 KB-7 with no key, the Route A facts still file without Claude and only the rest is saved as the open question; Send it all to Claude waits for a key', async () => {
  // The key was removed in the row above.
  await page.keyboard.press('Meta+k');
  await input().fill(`${MASKS} ${TRAM}`);
  await expect(box().getByTestId('capture-send-all')).toBeDisabled();
  await expect(box().getByTestId('capture-send-all')).toHaveAttribute(
    'title',
    'No Anthropic key is set. Add one in Settings to ask Claude.',
  );
  const tramQuestions = async () =>
    (await invoke('entry.list', { collection: 'openQuestions', trash: 'exclude' })).entries.filter(
      (e) => e.entry.title === TRAM,
    ).length;
  const before = await tramQuestions();
  await input().press('Enter');
  await expect(facts()).toHaveCount(2);
  const card = facts().first();
  await expect(card).toHaveAttribute('data-stand', 'local');
  await expect(facts().nth(1)).toHaveAttribute('data-stand', 'question');
  await expect(box().getByTestId('capture-no-key')).toHaveText(
    'No Anthropic key is set, so these file here without Claude.',
  );
  await expect(box().getByTestId('capture-asked')).toContainText(TRAM);
  expect(await tramQuestions()).toBe(before + 1);
  await expect(card.getByTestId('capture-ask-claude')).toBeDisabled();
  await pick(card, 'community', 'guangzhou');
  await expect(box().getByTestId('capture-file')).toContainText('File it');
  await page.keyboard.press('Meta+Enter');
  await expect(box().getByTestId('capture-filed')).toContainText(
    'Teenagers start to wear paper masks',
  );
  const lines = await invoke('entry.list', { collection: 'culturalEntries', trash: 'exclude' });
  expect(
    lines.entries.some(
      (e) =>
        e.entry.title === 'Teenagers start to wear paper masks' &&
        e.entry.communityId === 'guangzhou',
    ),
  ).toBe(true);
  await page.keyboard.press('Escape');
});
