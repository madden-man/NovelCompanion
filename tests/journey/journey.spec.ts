import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import ExcelJS from 'exceljs';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { assembleGraph, buildGraph, generations, layoutTree } from '../../src/shared/domain/tree';
import type { TreeGraph } from '../../src/shared/domain/tree';
import {
  ENTRY_COLLECTIONS,
  collectionInfo,
  editableFields,
  entryTitle,
  manifests,
} from '../../src/shared/schema';
import type { EntryCollection } from '../../src/shared/schema';
import { build } from '../helpers/t5';
import type { GenContext, Invoke } from '../helpers/t5';
import { startFakeGoogle } from '../helpers/fakeGoogle';
import type { FakeGoogle } from '../helpers/fakeGoogle';
import { readFixture } from '../helpers/loadFixture';
import {
  field,
  invokeVia,
  launch,
  openListFor,
  rail,
  setField,
  waitSaved,
  withoutSystem,
} from '../e2e/helpers';
import type { UiContext } from '../e2e/helpers';
import { makeJourneyFiles } from './setup';
import type { JourneyFiles } from './setup';

/**
 * T-4: one writer's session through the whole app, in order, against the
 * packaged app in release/ (see playwright.journey.config.ts). Every
 * step asserts what is on screen; the afterEach hook saves a screenshot, and
 * tests/journey/reporter.ts writes test-results/journey/report.md and
 * report.html. Writes go through the interface; `invoke` only reads, to check
 * what a step stored.
 */

let server: MongoMemoryReplSet;
let fake: FakeGoogle;
let files: JourneyFiles;
let app: ElectronApplication;
let page: Page;
let invoke: Invoke;

const KEY = 'sk-ant-api03-journey-key-0123456789abcdef';
const CHAPTER = 'Harbor Lights';

test.describe.configure({ mode: 'serial' });

async function start(): Promise<void> {
  ({ app, page } = await launch(
    server.getUri(),
    {
      // SL-1: the stop prompt is on, as for a person.
      NOVEL_COMPANION_SKIP_STOP_PROMPT: '0',
      // T-3: the recorded Claude with a key held in memory; never the real API or keychain.
      NOVEL_COMPANION_TEST_ANTHROPIC_KEY: KEY,
      NOVEL_COMPANION_TEST_CLAUDE_RECORDINGS: files.recordings,
      // GD-1: Drive is the fake Google on 127.0.0.1.
      NOVEL_COMPANION_TEST_GOOGLE_BASE: fake.base,
      // The files a person would choose in the open and save dialogs.
      NOVEL_COMPANION_TEST_BIBLE_FILE: files.bibleFile,
      NOVEL_COMPANION_TEST_PICK_FILE: files.workbook,
      NOVEL_COMPANION_TEST_PICK_DOCUMENT: files.wedding,
      NOVEL_COMPANION_TEST_SAVE_PATH: files.exportJson,
      NOVEL_COMPANION_TEST_BRIEF_EXPORT_DIR: files.briefDir,
    },
    { packaged: true },
  ));
  invoke = invokeVia(page);
  // T-4: this is the packaged app from release/, not the electron-vite build.
  expect(await app.evaluate(({ app: electron }) => electron.isPackaged)).toBe(true);
}

/** The next Word document the open dialog returns, as a person picking another file. */
async function nextDocument(path: string): Promise<void> {
  await app.evaluate((_e, p) => {
    process.env.NOVEL_COMPANION_TEST_PICK_DOCUMENT = p;
  }, path);
}

test.beforeAll(async () => {
  test.setTimeout(300_000);
  files = await makeJourneyFiles();
  fake = await startFakeGoogle({ email: 'writer@example.com' });
  fake.addFile({
    id: 'folderNovel',
    name: 'Novel',
    mimeType: 'application/vnd.google-apps.folder',
  });
  fake.addFile({
    id: 'docCh3',
    name: 'Chapter 3',
    mimeType: 'application/vnd.google-apps.document',
    parents: ['folderNovel'],
    content: readFileSync(files.wedding),
  });
  server = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  await start();
});

let stepNo = 0;

// Playwright reads the fixtures a hook asks for from this first argument, so it must be a pattern.
// eslint-disable-next-line no-empty-pattern
test.afterEach(async ({}, testInfo) => {
  stepNo += 1;
  const name = `${String(stepNo).padStart(2, '0')}-${testInfo.title
    .slice(0, 60)
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/-+$/, '')}.png`;
  const path = testInfo.outputPath(name);
  // A step not run yet (fixme) has no screen of its own; one that closed the app kept its own.
  if (testInfo.status === 'skipped' || testInfo.attachments.some((a) => a.name === 'screenshot')) {
    return;
  }
  try {
    if (!page.isClosed()) {
      await page.screenshot({ path, timeout: 10_000 });
      testInfo.attachments.push({ name: 'screenshot', path, contentType: 'image/png' });
    }
  } catch {
    // A step that ends with the app closed has no screen to keep.
  }
});

test.afterAll(async () => {
  await app?.evaluate(({ app: electron }) => electron.exit(0)).catch(() => undefined);
  await server?.stop();
  await fake?.close();
});

const dash = () => page.getByTestId('dashboard');
const status = () => page.getByTestId('status-time');
const entryList = () => page.getByTestId('entry-list');
const pick = (name: RegExp | string) => entryList().getByRole('button', { name });

/** The top bar's year box commits on Enter or when it loses focus (M7), not on every digit. */
async function setTopYear(year: string): Promise<void> {
  await page.getByTestId('top-year').fill(year);
  await page.getByTestId('top-year').press('Enter');
}

async function openEntry(section: string, name: RegExp): Promise<void> {
  await rail(page, section).click();
  await pick(name).first().click();
  await expect(page.getByTestId('editor')).toBeVisible();
}

// ---------------------------------------------------------------------------
// Launch and the fixture

test('ARCH-8 a fresh install opens with no bibles, and a new empty bible is made with the New bible form', async () => {
  await expect(page).toHaveTitle('Novel Companion');
  await expect(page.getByTestId('no-bibles')).toHaveText('No bibles yet');
  await page.getByLabel('Name').fill('Scratch');
  await expect(page.getByLabel('ID')).toHaveValue('scratch');
  await page.getByRole('button', { name: 'Create bible' }).click();
  await page.getByRole('button', { name: 'Open Scratch' }).click();
  await expect(page.getByTestId('current-bible')).toHaveText('Scratch');
  await expect(dash()).toBeVisible();
  await expect(dash().getByTestId('launch-panel')).toHaveCount(0);
});

test('BK-3 the fixture novel is loaded through Backups into a new bible, Tide Lines, which opens', async () => {
  await rail(page, 'Backups').click();
  const form = page.locator('form', {
    has: page.getByRole('heading', { name: /Load an exported bible/ }),
  });
  // Wait for the view to settle (its snapshot list loads), so the form keeps what is typed.
  await expect(page.getByTestId('snapshot-row').first()).toBeVisible();
  await form.getByLabel('Name of the new bible').fill('Tide Lines');
  await expect(form.getByLabel('ID')).toHaveValue('tide-lines');
  await form.getByTestId('backup-import').click();
  // Loading writes every collection in one transaction; give it time on a busy machine.
  await expect(page.getByTestId('current-bible')).toHaveText('Tide Lines', { timeout: 60_000 });
  expect(
    (await invoke('entry.list', { collection: 'characters', trash: 'exclude' })).entries,
  ).toHaveLength(13);
});

test('DB-1 SL-1 the dashboard shows the last session note, the story time, the position, and open questions', async () => {
  await rail(page, 'Dashboard').click();
  await expect(dash()).toBeVisible();
  await expect(dash().getByTestId('launch-note')).toHaveText('Margaret blows out the candles.');
  await expect(dash().getByTestId('dash-position')).toContainText('Candles');
  await expect(dash().getByTestId('dash-time')).toContainText('2040');
  await expect(dash().getByTestId('dash-questions').locator('.tile-num')).toHaveText('3');
  await dash().getByTestId('launch-panel').getByRole('button', { name: 'Start working' }).click();
  await expect(dash().getByTestId('launch-panel')).toHaveCount(0);
});

test('A27 TM-3 TM-4 SB-10 the top bar: year slider and year box, the Writing picker, and Relevant to Session', async () => {
  await page.getByTestId('top-year-slider').fill('2050');
  await expect(page.getByTestId('top-year')).toHaveValue('2050');
  await expect(status()).toContainText('Story time 2050');
  await setTopYear('2045');
  await expect(page.getByTestId('top-year-slider')).toHaveValue('2045');
  await expect(status()).toContainText('Story time 2045');
  await page
    .getByTestId('top-writing')
    .selectOption({ label: 'Chapter 2: Two Kitchens, backstory (2032)' });
  await expect(page.getByTestId('top-year')).toHaveValue('2032');
  await page
    .getByTestId('top-writing')
    .selectOption({ label: 'Chapter 2: Two Kitchens, present (2045)' });
  await expect(page.getByTestId('top-year')).toHaveValue('2045');
  await page.getByTestId('top-relevant').click();
  const relevant = page.getByTestId('relevant-view');
  await expect(relevant).toBeVisible();
  await expect(page.getByTestId('relevant-label')).toHaveText('Two Kitchens');
  // SB-1: a picked strand is that strand alone.
  await expect(relevant.getByTestId('relevant-strand')).toHaveCount(1);
  await expect(relevant.getByTestId('relevant-strand')).toHaveAttribute(
    'data-strand',
    'CH2-present',
  );
  await expect(relevant.getByTestId('relevant-strand').first()).toContainText('writing now');
});

test('TM-1 TM-2 TM-4 the Story Time dialog: an age anchor gives the year, and the year is set to 2045', async () => {
  await page.keyboard.press('Meta+t');
  const dialog = page.getByTestId('story-time-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Character').selectOption({ label: 'Iris Hale-Zhou' });
  await dialog.getByLabel('Age', { exact: true }).fill('9');
  await dialog.getByRole('button', { name: 'Set year from age' }).click();
  await expect(dialog.getByTestId('time-now')).toHaveText('2040');
  await expect(dialog.getByTestId('time-note')).toContainText('Iris Hale-Zhou is 9 in 2040');
  await expect(
    dialog.getByTestId('time-states').locator('tr[data-person="H2"] [data-state]'),
  ).toHaveText('dead since 2030');
  await dialog.getByTestId('time-year').fill('2045');
  await expect(dialog.getByTestId('time-now')).toHaveText('2045');
  await expect(dialog.getByTestId('time-strands')).toContainText('Two Kitchens, present');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(status()).toContainText('Story time 2045');
});

// ---------------------------------------------------------------------------
// Family tree and time

test('FT-5 FT-1 the tree shows ages for 2045, filters to one family, and the year control redraws it', async () => {
  await rail(page, 'Family tree').click();
  await expect(page.getByTestId('tree-view')).toBeVisible();
  await expect(page.getByTestId('tree-year')).toHaveValue('2045');
  const node = (id: string) => page.locator(`g.tnode[data-person="${id}"]`);
  await expect(node('H5')).toHaveAttribute('data-age', '14');
  await expect(node('H3')).toHaveAttribute('data-age', '60');
  await expect(node('H1')).toHaveAttribute('data-state', 'dead');
  await page.getByLabel('Show').selectOption({ label: 'Zhou only' });
  await expect(page.locator('g.tnode')).toHaveCount(6);
  await page.getByLabel('Show').selectOption({ label: 'All families' });
  await expect(page.locator('g.tnode')).toHaveCount(13);
  await page.getByTestId('tree-year').fill('2075');
  await page.getByTestId('tree-year').press('Enter');
  await expect(page.getByTestId('tree-svg')).toHaveAttribute('data-year', '2075');
  await expect(node('Z5')).toHaveAttribute('data-age', '17');
  await page.getByTestId('tree-year').fill('2045');
  await page.getByTestId('tree-year').press('Enter');
  await expect(page.getByTestId('tree-svg')).toHaveAttribute('data-year', '2045');
});

test('FT-2 FT-10 a child is added to Sam Hale from the tree and appears as a new node', async () => {
  const inspector = page.getByTestId('tree-inspector');
  await page.locator('g.tnode[data-person="H6"]').dispatchEvent('click');
  await expect(inspector.getByTestId('inspector-name')).toHaveText('Sam Hale');
  await inspector.getByRole('button', { name: 'Add child', exact: true }).click();
  const form = inspector.getByTestId('add-form');
  await form.getByLabel('Name').fill('Hope Hale');
  await form.getByLabel('Birth year').fill('2040');
  await form.getByLabel('Status').selectOption('planned');
  await form.getByLabel('Link type').selectOption('biological');
  await form.getByRole('button', { name: /^Add the/ }).click();
  await expect(page.locator('g.tnode[aria-label^="Hope Hale,"]')).toHaveCount(1);
  await expect(inspector.getByTestId('inspector-name')).toHaveText('Hope Hale');
  await expect(page.locator('g.tnode[aria-label^="Hope Hale,"]')).toHaveAttribute('data-age', '5');
});

test('FT-9 the tree exports as a PNG image', async () => {
  const png = join(files.dir, 'tree.png');
  await app.evaluate(({ dialog }, f) => {
    (dialog as unknown as { showSaveDialog: () => Promise<unknown> }).showSaveDialog =
      async () => ({ canceled: false, filePath: f });
  }, png);
  await page.getByRole('button', { name: 'Export PNG' }).click();
  await expect(page.getByTestId('export-note')).toHaveText(`Saved ${png}.`);
  expect([...readFileSync(png).subarray(1, 4)]).toEqual([0x50, 0x4e, 0x47]);
});

// ---------------------------------------------------------------------------
// The fixture tree, built by hand in the empty Scratch bible (T-4)

const fixture = readFixture();
const treeInspector = () => page.getByTestId('tree-inspector');
const treeEditor = () => treeInspector().getByTestId('editor');
const treeNode = (name: string) => page.locator(`g.tnode[aria-label^="${name},"]`);

/** Switch bibles the way a person does: the Bibles screen in the rail, then Open. */
async function openBible(name: string): Promise<void> {
  await rail(page, 'Bibles').click();
  await page.getByRole('button', { name: `Open ${name}`, exact: true }).click();
  await expect(page.getByTestId('current-bible')).toHaveText(name);
  await expect(page.getByTestId('workspace')).toBeVisible();
}

async function selectPerson(name: string): Promise<void> {
  await treeNode(name).dispatchEvent('click');
  await expect(treeInspector().getByTestId('inspector-name')).toHaveText(name);
}

async function addPerson(
  kind: 'person' | 'parent' | 'child' | 'sibling' | 'partner',
  name: string,
  born: number | null,
  opts: { status?: string; type?: string; coParent?: string } = {},
): Promise<void> {
  await (kind === 'person' ? page : treeInspector())
    .getByRole('button', { name: kind === 'person' ? 'Add person' : `Add ${kind}`, exact: true })
    .click();
  const form = treeInspector().getByTestId('add-form');
  await form.getByLabel('Name').fill(name);
  if (born !== null) await form.getByLabel('Birth year').fill(String(born));
  await form.getByLabel('Status').selectOption(opts.status ?? 'canon');
  if (opts.type && kind === 'partner') await form.getByLabel('Union type').selectOption(opts.type);
  else if (opts.type) await form.getByLabel('Link type').selectOption(opts.type);
  if (opts.coParent !== undefined) {
    await form.getByLabel('Other parent').selectOption({ label: opts.coParent });
  }
  await form.getByRole('button', { name: /^Add the/ }).click();
  await expect(treeNode(name)).toHaveCount(1);
  await expect(treeInspector().getByTestId('inspector-name')).toHaveText(name);
}

async function setLifeYear(path: 'birth' | 'death', year: number): Promise<void> {
  const f = field(treeEditor(), path);
  await f.getByLabel('Kind of date').selectOption('year');
  await f.getByLabel('Year', { exact: true }).fill(String(year));
  await waitSaved(page);
}

/** The families a person belongs to, picked by name as a person would. */
async function setFamilies(titles: string[]): Promise<void> {
  const f = field(treeEditor(), 'familyIds');
  const chips = f.locator(':scope > .chips .chip-remove');
  while ((await chips.count()) > 0) await chips.first().click();
  for (const label of titles) await f.locator(':scope > select').selectOption({ label });
  await waitSaved(page);
}

async function editLink(withName: string, values: Record<string, string | number>): Promise<void> {
  await treeInspector()
    .getByRole('button', { name: `Edit the link with ${withName}` })
    .click();
  for (const [path, v] of Object.entries(values)) {
    await field(treeEditor(), path).locator(':scope > input').fill(String(v));
  }
  await waitSaved(page);
  await treeInspector()
    .getByRole('button', { name: /^Back to/ })
    .click();
}

/**
 * People, unions, and links by name, so the tree built here compares with the
 * fixture whatever IDs the app gave them; families by name for the same reason.
 */
function signature(g: TreeGraph, familyName: (id: string) => string) {
  const n = (id: string) => g.byId.get(id)!.name;
  const yr = (d: unknown) =>
    d && typeof d === 'object' && 'year' in d ? (d as { year: number }).year : null;
  const gen = generations(g);
  return {
    people: g.people
      .map((p) => [
        p.name,
        yr(p.birth),
        yr(p.death),
        p.familyIds.map(familyName).sort().join('+'),
        p.status,
        gen.get(p.id),
      ])
      .sort(),
    unions: g.unions
      .map((u) => [n(u.a), n(u.b), u.type, u.startYear, u.endYear, u.endReason])
      .sort(),
    links: g.links.map((l) => [n(l.parentId), n(l.childId), l.type, l.startYear]).sort(),
  };
}

function layoutByName(g: TreeGraph) {
  const l = layoutTree(g, new Set(g.people.map((p) => p.id)));
  return Object.fromEntries([...l.nodes].map(([id, p]) => [g.byId.get(id)!.name, [p.x, p.y]]));
}

test('ARCH-8 FT-2 the Scratch bible is opened from the Bibles screen, its two families are made, and the Hales are added from the tree', async () => {
  test.setTimeout(300_000);
  await openBible('Scratch');
  for (const f of fixture.families!) {
    await rail(page, 'Families').click();
    await page.getByRole('button', { name: 'New family', exact: true }).click();
    const form = page.getByTestId('new-entry');
    await field(form, 'title').locator(':scope > input').fill(String(f.title));
    await field(form, 'name').locator(':scope > input').fill(String(f.name));
    await form.getByRole('button', { name: 'Create family' }).click();
    await expect(
      page.getByTestId('editor').getByRole('heading', { name: String(f.title) }),
    ).toBeVisible();
    await waitSaved(page);
  }
  await rail(page, 'Family tree').click();
  await expect(page.getByTestId('tree-view')).toBeVisible();
  await expect(page.getByTestId('no-tree-warnings')).toBeVisible();

  await addPerson('person', 'Margaret Hale', 1958);
  await setLifeYear('death', 2041);
  await setFamilies(['Hale family']);
  await addPerson('partner', 'Peter Hale', 1956, { type: 'married' });
  await setLifeYear('death', 2030);
  await setFamilies(['Hale family']);
  await editLink('Margaret Hale', { startYear: 1982, endYear: 2030, endReason: 'death' });
  await selectPerson('Margaret Hale');
  await addPerson('child', 'Daniel Hale', 1985, { type: 'biological', coParent: 'Peter Hale' });
  await selectPerson('Margaret Hale');
  await addPerson('child', 'Ruth Hale', 1990, { type: 'biological', coParent: 'Peter Hale' });
  await setLifeYear('death', 2067);
  await expect(page.locator('g.tnode')).toHaveCount(4);
  await expect(page.locator('text.tunion-end')).toHaveText(['ended 2030']);
});

test('FT-2 FT-4 the Zhou family, the in-laws, and the Archivist complete the tree by hand, and it matches the fixture graph and layout', async () => {
  test.setTimeout(300_000);
  await selectPerson('Daniel Hale');
  await addPerson('partner', 'Zhou Lan', 1988, { type: 'married' });
  await setFamilies(['Zhou family']);
  await editLink('Daniel Hale', { startYear: 2029 });
  await addPerson('parent', 'Zhou Meiling', 1962, { type: 'biological' });
  await setLifeYear('death', 2050);
  await addPerson('partner', 'Zhou Wei', 1960, { type: 'partnered' });
  await setLifeYear('death', 2055);
  await setFamilies(['Zhou family']);
  // Link the existing Zhou Wei as Zhou Lan's other parent.
  await selectPerson('Zhou Lan');
  const linkForm = treeInspector().getByRole('form', { name: 'Link someone already in the tree' });
  await linkForm.getByLabel(/They are/).selectOption('parent');
  await linkForm.getByLabel('Person', { exact: true }).selectOption({ label: 'Zhou Wei' });
  await linkForm.getByLabel('Link type').selectOption('biological');
  await linkForm.getByRole('button', { name: 'Link', exact: true }).click();
  await expect(linkForm.getByTestId('link-message')).toHaveText(/^Linked\./);
  await addPerson('sibling', 'Zhou Jun', 1993, { type: 'biological', status: 'planned' });
  await setLifeYear('death', 2070);

  await selectPerson('Daniel Hale');
  await addPerson('child', 'Iris Hale-Zhou', 2031, { type: 'biological', coParent: 'Zhou Lan' });
  await setFamilies(['Hale family', 'Zhou family']);
  await selectPerson('Ruth Hale');
  await addPerson('child', 'Sam Hale', 2012, { type: 'adoptive' });
  await editLink('Ruth Hale', { startYear: 2015 });
  await selectPerson('Iris Hale-Zhou');
  await addPerson('partner', 'Tomas Reyes', 2030, { type: 'partnered', status: 'planned' });
  await editLink('Iris Hale-Zhou', { startYear: 2056, endYear: 2064, endReason: 'separated' });
  await selectPerson('Iris Hale-Zhou');
  await addPerson('child', 'Noor Zhou', 2058, {
    type: 'biological',
    coParent: 'Tomas Reyes',
    status: 'planned',
  });
  await setFamilies(['Zhou family']);
  await addPerson('person', 'The Archivist', null, { status: 'idea' });

  await expect(page.locator('g.tnode')).toHaveCount(13);
  const t = await invoke('tree.get', {});
  const built = assembleGraph(t.people, t.unions, t.links);
  const expected = buildGraph(fixture.characters!, fixture.unions!, fixture.parentLinks!);
  const families = (await invoke('entry.list', { collection: 'families', trash: 'exclude' }))
    .entries;
  const builtFamily = (id: string) =>
    String(families.find((f) => f.entry._id === id)?.entry.name ?? id);
  const fixtureFamily = (id: string) =>
    String(fixture.families!.find((f) => f._id === id)?.name ?? id);
  // The same people, unions, and parent links as section 7, under the app's own IDs.
  expect(signature(built, builtFamily)).toEqual(signature(expected, fixtureFamily));
  // The same graph lays out the same way, whatever order it was entered in.
  expect(layoutByName(built)).toEqual(layoutByName(expected));
  expect(t.warnings).toEqual([]);
  // Tidy layout draws exactly that layout.
  await page.getByRole('button', { name: 'Tidy layout' }).click();
  await page
    .getByRole('dialog', { name: 'Tidy layout' })
    .getByRole('button', { name: 'Tidy layout' })
    .click();
  await expect(page.getByRole('dialog', { name: 'Tidy layout' })).toHaveCount(0);
  const want = layoutByName(built);
  await expect
    .poll(async () => (await invoke('tree.get', {})).positions?.[t.people[0]!.id])
    .toEqual({ x: want[t.people[0]!.name]![0], y: want[t.people[0]!.name]![1] });
  const shown = await page
    .locator('g.tnode')
    .evaluateAll((els) =>
      els.map((e) => [e.getAttribute('aria-label')!.split(',')[0], e.getAttribute('transform')]),
    );
  for (const [name, transform] of shown) {
    const [x, y] = want[name!]!;
    expect(transform, name!).toBe(`translate(${x},${y})`);
  }
  // FT-4: the adoptive link and both ended unions are drawn as such.
  await expect(page.locator('path.tlink.adoptive')).toHaveCount(1);
  await expect(page.locator('text.tunion-end')).toHaveText(['ended 2030', 'ended 2064']);
});

test('ARCH-8 Tide Lines is opened again from the Bibles screen, with its own tree and its story time still 2045', async () => {
  await openBible('Tide Lines');
  await expect(status()).toContainText('Story time 2045');
  // The bibles share nothing: Tide Lines still has its 13 people and Hope Hale.
  await rail(page, 'Family tree').click();
  await expect(page.getByTestId('tree-view')).toBeVisible();
  await expect(page.locator('g.tnode')).toHaveCount(14);
  await expect(page.getByTestId('tree-year')).toHaveValue('2045');
});

test('SM-8 WE-1 the world events grid shows the rows and a new event, and the category filter narrows the rows', async () => {
  await rail(page, 'Timeline').click();
  const grid = page.getByTestId('world-grid');
  const rows = () =>
    grid.locator('.wg-row').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.row));
  await expect(grid.locator('.wg-marker')).toHaveCount(11);
  await grid.locator('.wg-row[data-row="robotics"] .wg-row-label').click();
  const form = grid.getByTestId('grid-add');
  await form.getByLabel('Title').fill('Harbor robots unload the night ships');
  await form.getByRole('button', { name: 'Save' }).click();
  const made = grid.locator(
    '.wg-row[data-row="robotics"] .wg-marker[aria-label^="Harbor robots unload the night ships"]',
  );
  await expect(made).toHaveAttribute('data-year', '2045');
  expect((await rows()).length).toBeGreaterThan(3);
  const filter = page.getByRole('group', { name: 'Categories' });
  await filter.getByLabel('Category', { exact: true }).selectOption({ label: 'Technology' });
  expect(await rows()).toEqual(['technology', 'robotics', 'energy']);
  await filter.getByLabel('Category', { exact: true }).selectOption({ label: 'All categories' });
});

test('TL-7 compare shows Margaret and Iris side by side by year', async () => {
  // KB-2: Compare is a disclosure in the year dialog.
  await page.getByTestId('top-open-year').click();
  const compare = page.getByTestId('story-time-dialog').getByTestId('time-compare');
  await compare.getByText('Compare two characters', { exact: true }).click();
  const view = compare.getByTestId('compare-view');
  await view.getByLabel('First').selectOption({ label: 'Margaret Hale' });
  await view.getByLabel('Second').selectOption({ label: 'Iris Hale-Zhou' });
  await view.getByLabel('From').fill('2030');
  await view.getByLabel('To').fill('2045');
  await expect(view.getByTestId('compare-table').locator('tbody tr')).toHaveCount(4);
  await expect(view.locator('tr[data-year="2040"]')).toContainText('82');
  await expect(view.locator('tr[data-year="2045"]')).toContainText('dead (2041)');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('story-time-dialog')).toHaveCount(0);
});

test('TL-2 TL-5 the year view lists who is alive in 2075 and what Iris lived through', async () => {
  await setTopYear('2075');
  // KB-2: the year view is the Story Time dialog.
  await page.getByTestId('top-open-year').click();
  const dialog = page.getByTestId('story-time-dialog');
  await expect(dialog.getByRole('heading', { name: 'Everyone in 2075' })).toBeVisible();
  const table = dialog.getByTestId('time-states');
  await expect(table.locator('tr[data-person="H3"] [data-testid="year-age"]')).toHaveText('90');
  await expect(table.locator('tr[data-person="H1"] [data-testid="year-age"]')).toHaveText(
    'died 2041',
  );
  const disclosure = dialog.getByTestId('time-lived');
  await disclosure.getByText('Lived through', { exact: true }).click();
  const lived = disclosure.getByTestId('lived-through');
  await lived.getByLabel('Lived through by').selectOption({ label: 'Iris Hale-Zhou' });
  await expect(lived.locator('tr[data-event="E3"]')).toContainText('formative');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await setTopYear('2045');
});

// ---------------------------------------------------------------------------
// Plot, places, culture, glossary, knowledge

const grid = () => page.getByTestId('outline-grid');
const outlineInspector = () => page.getByTestId('outline-inspector');
const readingOrder = async (id: string) =>
  (await invoke('entry.get', { collection: 'chapters', id })).entry.readingOrder;

test('PL-2 PL-3 the plot outline: drag Chapter 2 above Chapter 1, see the order change, and undo it', async () => {
  await rail(page, 'Outline').click();
  await page.getByRole('button', { name: 'Year grid', exact: true }).click();
  await expect(grid()).toBeVisible();
  await expect(grid().getByTestId('outline-label')).toHaveCount(8);
  await grid()
    .locator('[data-chapter="CH2"]')
    .getByTestId('outline-label')
    .dragTo(grid().locator('[data-chapter="CH1"]').getByTestId('outline-label'));
  await expect(grid().getByTestId('outline-label').first()).toContainText('Two Kitchens');
  await expect.poll(() => readingOrder('CH2')).toBe(1);
  await outlineInspector().getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(grid().getByTestId('outline-label').first()).toContainText("The Archivist's Door");
  await expect.poll(() => readingOrder('CH2')).toBe(2);
});

test('PL-4 the chapter page shows strands, ages, and places', async () => {
  await grid().locator('[data-chapter="CH2"]').getByTestId('outline-label').click();
  const chapter = outlineInspector().getByTestId('chapter-page');
  await expect(chapter).toContainText('Two Kitchens');
  await expect(chapter.locator('[data-strand="CH2-present"] [data-character="H5"]')).toContainText(
    'alive, age 14',
  );
  await expect(
    chapter.locator('[data-strand="CH2-present"]').getByTestId('chapter-places'),
  ).toContainText('Portland');
});

test('CU-2 culture by year lists what applies to Guangzhou in 2020', async () => {
  await rail(page, 'Culture by year').click();
  const view = page.getByTestId('culture-view');
  await view.getByLabel('Community').selectOption({ label: 'Guangzhou' });
  await view.getByLabel('Year').fill('2020');
  await expect(view.getByTestId('culture-results')).toContainText('lotus seed mooncakes');
  await view.getByLabel('Year').fill('1900');
  await expect(view.getByTestId('culture-empty')).toBeVisible();
});

test('PC-1 the place tree nests the Hale house inside Portland', async () => {
  await rail(page, 'Place tree').click();
  const view = page.getByTestId('places-view');
  await expect(view.locator('li[data-place="PLC2"]')).toHaveAttribute('data-depth', '1');
  await expect(view.locator('li[data-place="PLC1"]')).toHaveAttribute('data-depth', '0');
});

test('GL-1 GL-3 a glossary term that breaks Pinyin is flagged, and a Chinese name shows its meaning on hover', async () => {
  await rail(page, 'Glossary').click();
  await page.getByRole('button', { name: 'New glossary term', exact: true }).click();
  const form = page.getByTestId('new-entry');
  await field(form, 'title').locator(':scope > input').fill('广东');
  await field(form, 'characters').locator(':scope > input').fill('广东');
  await field(form, 'language').locator(':scope > select').selectOption('mandarin');
  await form.getByRole('button', { name: 'Create glossary term' }).click();
  const editor = page.getByTestId('editor');
  await expect(editor).toHaveAttribute('data-entry-id', /.+/);
  await expect(editor).toContainText('广东');
  await waitSaved(page);
  await field(editor, 'romanization').locator(':scope > input').fill('gwong2dung1');
  await waitSaved(page);
  await expect(field(editor, 'romanization')).toContainText('does not follow Hanyu Pinyin');
  await rail(page, 'Romanization').click();
  await expect(page.getByTestId('romanization-flagged')).toContainText('gwong2dung1');

  await rail(page, 'Glossary table').click();
  const chars = page
    .getByTestId('glossary-table')
    .locator('tr[data-term="GL5"]')
    .getByTestId('zh')
    .first();
  await chars.hover();
  await expect(chars.getByRole('tooltip')).toHaveText('yuèbǐng: mooncake');
  await page.mouse.move(0, 0);
});

test('OQ-1 an open question is marked decided with a decision', async () => {
  await openEntry('Open questions', /Where does Jun live/);
  const editor = page.getByTestId('editor');
  await field(editor, 'state').locator(':scope > select').selectOption('decided');
  await waitSaved(page);
  await expect(field(editor, 'decision')).toContainText('marked decided, but no decision');
  await field(editor, 'decision').locator(':scope > textarea').fill('Guangzhou, near the river.');
  await waitSaved(page);
  await expect(field(editor, 'decision')).not.toContainText('marked decided, but no decision');
  await page.getByLabel('Show questions').selectOption('decided');
  await expect(pick(/Where does Jun live/)).toContainText('decided');
  await page.getByLabel('Show questions').selectOption('all');
});

test('SL-1 a session log entry is written and listed newest first', async () => {
  await rail(page, 'Session log').click();
  await page.getByRole('button', { name: 'New session log', exact: true }).click();
  const form = page.getByTestId('new-entry');
  await field(form, 'title').locator(':scope > input').fill('Journey session');
  await field(form, 'date').locator(':scope > input').fill('2026-10-11');
  await form.getByRole('button', { name: 'Create session log' }).click();
  const editor = page.getByTestId('editor');
  await expect(editor.getByRole('heading', { name: 'Journey session' })).toBeVisible();
  await field(editor, 'stoppedAt').locator(':scope > textarea').fill('Iris at the harbor');
  await waitSaved(page);
  await expect(entryList().getByRole('button').first()).toContainText('Journey session');
});

// ---------------------------------------------------------------------------
// Every section's form and editor (T-4, ED-1)

/** The entries the walk makes, one per collection, for the trash step after it. */
/** `rail` is the rail item the entry is listed under: its section, or for a custom entry its custom section (KB-4). */
const trial: { collection: EntryCollection; id: string; title: string; rail: string }[] = [];

/**
 * What a new entry in Tide Lines can point at, read from the bible: the first
 * entries of each collection, the list items, and the custom section's fields.
 * The people are three whose links can never close a loop, since FT-6 refuses a
 * parent link that would make someone their own ancestor.
 */
async function walkContext(): Promise<{
  ctx: GenContext & UiContext;
  pools: Map<string, string[]>;
}> {
  const pools = new Map<string, string[]>();
  for (const c of ENTRY_COLLECTIONS) {
    const { entries } = await invoke('entry.list', { collection: c, trash: 'exclude' });
    pools.set(c, entries.map((e) => e.entry._id).slice(0, 8));
  }
  pools.set('characters', ['X1', 'U1', 'H6']);
  const { lists } = await invoke('lists.get', {});
  const titles = new Map<string, string>();
  const ctx: GenContext & UiContext = {
    page,
    pool: (c) => pools.get(c === '*' ? 'characters' : c) ?? [],
    listItems: (id) => lists.find((l) => l._id === id)?.items.map((i) => i.id) ?? [],
    titleOf: async (id) => {
      if (!titles.has(id)) {
        const { entries } = await invoke('entry.lookup', { ids: [id] });
        titles.set(id, entries[0]?.title ?? id);
      }
      return titles.get(id)!;
    },
  };
  return { ctx, pools };
}

/** SM-1: the fields the character page edits; the app sets the rest (T-5 covers them). */
const CHARACTER_PAGE = [
  'names',
  'birth',
  'death',
  'status',
  'familyIds',
  'role',
  'body',
  'backstory',
];

test('ED-1 one entry of every section is created from its form, every field is changed in the editor, and the saved values read back', async () => {
  test.setTimeout(600_000);
  const { ctx, pools } = await walkContext();
  // A section with no entries yet (briefs, before the first session) goes first,
  // so the entry made here is there for the sections that point at it.
  const order = [...ENTRY_COLLECTIONS].sort(
    (a, b) => Number(pools.get(a)!.length > 0) - Number(pools.get(b)!.length > 0),
  );
  const failures: string[] = [];
  for (const c of order) {
    const info = collectionInfo[c];
    const manifest = manifests[c];
    const a = build(manifest, 0, ctx, 'full', true);
    const b = build(manifest, 1, ctx, 'full', true);
    const { newButton, preset } = await openListFor(page, ctx, c, a);
    await page.getByRole('button', { name: newButton, exact: true }).click();
    const form = page.getByTestId('new-entry');
    if (c === 'characters') {
      // SM-1: a new character asks for the full name only.
      await field(form, 'names.full')
        .locator('input')
        .fill((a.names as { full: string }).full);
    } else {
      for (const spec of manifest.filter(
        (s) => s.required && s.kind !== 'system' && !(s.name in preset),
      )) {
        await setField(ctx, form, spec, spec.name, a[spec.name], a);
      }
    }
    await form.getByRole('button', { name: `Create ${info.singular.toLowerCase()}` }).click();
    const editor = page.getByTestId('editor');
    await expect(editor).toBeVisible();
    await waitSaved(page);
    const fields =
      c === 'characters'
        ? editableFields(manifest).filter((s) => CHARACTER_PAGE.includes(s.name))
        : editableFields(manifest);
    if (c === 'characters') {
      const names = b.names as { full: string; chinese: string };
      await editor.getByRole('button', { name: 'Edit name', exact: true }).click();
      await field(editor, 'names.full').locator('input').fill(names.full);
      await field(editor, 'names.chinese').locator('input').fill(names.chinese);
      await editor.getByRole('button', { name: 'Done', exact: true }).click();
    }
    for (const spec of fields.filter((s) => s.name !== 'names')) {
      await setField(ctx, editor, spec, spec.name, b[spec.name], b);
    }
    await waitSaved(page);
    const id = await editor.getAttribute('data-entry-id');
    if (!id) throw new Error(`The ${c} editor shows no entry ID`);
    const { entry: saved } = await invoke('entry.get', { collection: c, id });
    const got = withoutSystem(manifest, saved) as Record<string, unknown>;
    const want = withoutSystem(manifest, b) as Record<string, unknown>;
    for (const spec of fields) {
      const g = JSON.stringify(got[spec.name] ?? null);
      const w = JSON.stringify(want[spec.name] ?? null);
      if (g !== w) failures.push(`${c}.${spec.name}: expected ${w}, found ${g}`);
    }
    trial.push({
      collection: c,
      id,
      title: entryTitle(saved),
      rail: info.plural,
    });
    if (pools.get(c)!.length === 0) pools.get(c)!.push(id);
  }
  expect(failures).toEqual([]);
  expect(trial.map((t) => t.collection).sort()).toEqual([...ENTRY_COLLECTIONS].sort());
});

test('ED-5 the trial entries are moved to the trash from their pages, and the Trash screen lists every one', async () => {
  test.setTimeout(300_000);
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // The fixture already has one entry in the trash (the M7 supplement).
  const before = (await invoke('trash.list', {})).entries.length;
  for (const t of trial) {
    await rail(page, t.rail).click();
    await pick(new RegExp(escape(t.title)))
      .first()
      .click();
    const editor = page.getByTestId('editor');
    await expect(editor).toHaveAttribute('data-entry-id', t.id);
    const inspector = page.getByTestId('inspector');
    await inspector.getByRole('button', { name: 'Move to trash' }).click();
    await inspector
      .getByRole('dialog', { name: 'Move to trash' })
      .getByRole('button', { name: 'Move to trash' })
      .click();
    await expect(editor).toContainText('This entry is in the trash.');
  }
  await rail(page, 'Trash').click();
  const trash = page.getByTestId('trash-list');
  await expect(trash.getByRole('button', { name: /^Restore / })).toHaveCount(before + trial.length);
  for (const t of trial) {
    await expect(
      trash
        .locator('li')
        .filter({ hasText: collectionInfo[t.collection].singular })
        .filter({ hasText: t.title }),
    ).not.toHaveCount(0);
    expect(
      (await invoke('entry.get', { collection: t.collection, id: t.id })).entry.deletedAt,
    ).toBeTruthy();
  }
});

// ---------------------------------------------------------------------------
// Search, lists, history, trash, undo, links

test('SR-1 SR-2 search finds English and Chinese, and the filters narrow it', async () => {
  const box = page.getByRole('searchbox', { name: 'Search the bible' });
  const results = page.getByTestId('search-results');
  await box.fill('letter');
  await expect(results.locator('[data-hit="H5-voice-0"]')).toHaveCount(1);
  await expect(results).toContainText('The Letter');
  const view = page.getByTestId('search-view');
  await view.getByLabel('Section').selectOption('moments');
  await expect(results).not.toContainText('The Letter');
  await expect(results.locator('[data-hit="H5-voice-0"]')).toHaveCount(1);
  await view.getByLabel('Section').selectOption('');
  await box.fill('晓曦');
  await expect(results).toContainText('晓曦');
  await box.fill('tuanyuan');
  await expect(results).toContainText('团圆');
  await box.fill('family reunion');
  await expect(results).toContainText('团圆');
});

test('ED-8 renaming a tag on the Lists screen updates every entry that uses it', async () => {
  for (const name of [/^Zhou Lan/, /^Daniel Hale/]) {
    await openEntry('Characters', name);
    const tags = field(page.getByTestId('editor'), 'tags');
    await tags.locator('.add-row > input').fill('harbor');
    await tags.locator('.add-row > input').press('Enter');
    await waitSaved(page);
  }
  await rail(page, 'Lists').click();
  const panel = page.locator('[data-list="tags"]');
  const row = panel.locator('li', { hasText: 'harbor' });
  await expect(row).toContainText('used 2 times');
  await row.getByRole('button', { name: 'Rename harbor' }).click();
  await panel.getByLabel('New name for harbor').fill('the harbor');
  await panel.getByRole('button', { name: 'Save name' }).click();
  await expect(panel.getByRole('status')).toHaveText('Renamed. 2 entries were updated.');
  for (const id of ['Z3', 'H3']) {
    expect((await invoke('entry.get', { collection: 'characters', id })).entry.tags).toContain(
      'the harbor',
    );
  }
});

test('ED-4 the history drawer compares a revision with the current entry and restores it', async () => {
  await openEntry('Characters', /^Ruth Hale/);
  const input = field(page.getByTestId('editor'), 'role').locator('textarea');
  await input.fill('Astoria');
  await waitSaved(page);
  await input.fill('Seaside');
  await waitSaved(page);
  await page.getByTestId('inspector').getByRole('button', { name: 'History' }).click();
  const drawer = page.getByTestId('history');
  const revisions = drawer
    .getByRole('list', { name: 'Revisions, newest first' })
    .getByRole('button');
  await expect(revisions.nth(0)).toContainText('Changed (current)');
  await revisions.nth(1).click();
  const row = drawer.getByTestId('revision-diff').getByRole('row', { name: /In the story/ });
  await expect(row.getByRole('cell').nth(0)).toHaveText('Astoria');
  await expect(row.getByRole('cell').nth(1)).toHaveText('Seaside');
  await drawer.getByRole('button', { name: 'Restore this version' }).click();
  await expect(revisions.nth(0)).toContainText('Restored the version from');
  await drawer.getByRole('button', { name: 'Close' }).click();
  await expect(input).toHaveValue('Astoria');
});

test('ED-5 a character moves to the trash with what links to it, and is restored from the Trash screen', async () => {
  await openEntry('Characters', /^Tomas Reyes/);
  const inspector = page.getByTestId('inspector');
  await inspector.getByRole('button', { name: 'Move to trash' }).click();
  const dialog = inspector.getByRole('dialog', { name: 'Move to trash' });
  await expect(dialog.getByTestId('linked-count')).toBeVisible();
  await dialog.getByRole('button', { name: 'Move to trash' }).click();
  await expect(page.getByTestId('editor')).toContainText('This entry is in the trash.');
  await rail(page, 'Trash').click();
  const trash = page.getByTestId('trash-list');
  await expect(trash).toContainText('Tomas Reyes');
  await trash.getByRole('button', { name: 'Restore Tomas Reyes' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Tomas Reyes is back' })).toBeVisible();
  expect((await invoke('entry.get', { collection: 'characters', id: 'X1' })).entry.deletedAt).toBe(
    undefined,
  );
});

test('ED-3 a change is undone with Cmd+Z and redone with Shift+Cmd+Z', async () => {
  await openEntry('Characters', /^Sam Hale/);
  const input = field(page.getByTestId('editor'), 'role').locator('textarea');
  const before = await input.inputValue();
  await input.fill('Cannon Beach');
  await waitSaved(page);
  await page.locator('body').click();
  await page.keyboard.press('Meta+z');
  await expect(page.getByTestId('undo-notice').first()).toHaveText(
    'Undid: Changed In the story on Sam Hale',
  );
  await expect(input).toHaveValue(before);
  await page.keyboard.press('Shift+Meta+z');
  await expect(page.getByTestId('undo-notice').first()).toHaveText(
    'Redid: Changed In the story on Sam Hale',
  );
  await expect(input).toHaveValue('Cannon Beach');
});

test('ED-9 typing @ in a long text field links an entry, and the target shows Linked from', async () => {
  const editor = page.getByTestId('editor');
  const body = field(editor, 'body').locator('textarea');
  await body.click();
  await body.press('End');
  await body.pressSequentially(' Sam visits @Hope');
  const picker = field(editor, 'body').getByRole('listbox', { name: 'Matching entries' });
  await expect(picker.getByRole('option').first()).toContainText('Hope Hale');
  await page.keyboard.press('Enter');
  await expect(body).toHaveValue(/Sam visits @Hope Hale $/);
  await waitSaved(page);
  await expect(field(editor, 'links')).toContainText('Character: Hope Hale');
  await openEntry('Characters', /^Hope Hale/);
  await expect(page.getByTestId('inspector').getByTestId('linked-from')).toContainText(
    'Character: Sam Hale',
  );
});

// ---------------------------------------------------------------------------
// Import

const importView = () => page.getByTestId('import-view');

async function chooseGrid(): Promise<void> {
  await rail(page, 'Import').click();
  await importView().getByTestId('import-pick-workbook').click();
  await expect(importView().getByTestId('import-workbook')).toBeVisible();
  await importView().getByTestId('import-sheet').selectOption('High Level');
  await expect(importView().getByTestId('import-grid-options')).toBeVisible();
}

test('IM-1 IM-2 IM-3 the fixture workbook is imported: the High Level grid becomes world events, with a snapshot first', async () => {
  await chooseGrid();
  await expect(importView().getByTestId('import-preview-counts')).toContainText('7 rows: 7 ready');
  await importView().getByTestId('import-compare').click();
  await expect(importView().getByTestId('import-summary')).toContainText('7 new');
  await importView().getByTestId('import-apply').click();
  await expect(importView().getByTestId('import-result-counts')).toContainText('Created 7');
  await expect(importView().getByTestId('import-result')).toContainText('Snapshot taken first');
  const events = await invoke('entry.list', { collection: 'worldEvents', trash: 'exclude' });
  expect(events.entries.map((e) => e.entry.sourceRef)).toContain(
    'fixture-workbook.xlsx#High Level!E3',
  );
});

test('IM-1 IM-3 re-importing the changed workbook reuses the saved mapping and shows the change before writing it', async () => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(files.workbook);
  wb.getWorksheet('High Level')!.getCell('E3').value = 'Robot couriers everywhere';
  await wb.xlsx.writeFile(files.workbook);
  await chooseGrid();
  await expect(importView().getByTestId('import-saved-note')).toBeVisible();
  await importView().getByTestId('import-compare').click();
  await expect(importView().getByTestId('import-summary')).toContainText('1 changed');
  const change = importView().getByTestId('import-change');
  await expect(change).toHaveCount(1);
  await expect(change.locator('ins')).toContainText('Robot couriers everywhere');
  await importView().getByTestId('import-apply').click();
  await expect(importView().getByTestId('import-result-counts')).toContainText('updated 1');
});

test('IM-4 a Word document previews with its heading, italics, and scene break, and imports as a note', async () => {
  await nextDocument(files.wedding);
  await rail(page, 'Import').click();
  await importView().getByTestId('import-pick-document').click();
  const preview = importView().getByTestId('import-document-preview');
  await expect(preview.getByRole('heading', { name: 'Chapter 3: Wedding Weather' })).toBeVisible();
  await expect(preview.locator('em')).toHaveText('lucky');
  await expect(preview.locator('hr')).toHaveCount(1);
  await importView().getByTestId('import-kind').selectOption('note');
  await importView().getByLabel('Note title').fill('Wedding notes');
  await importView().getByTestId('import-compare').click();
  await importView().getByTestId('import-apply').click();
  await expect(importView().getByTestId('import-result-counts')).toContainText('Created 1');
});

// ---------------------------------------------------------------------------
// A new chapter, Claude, proposals

test('PL-1 a new chapter is created with two strands, present and backstory', async () => {
  await rail(page, 'Chapters').click();
  await page.getByRole('button', { name: 'New chapter', exact: true }).click();
  const form = page.getByTestId('new-entry');
  await field(form, 'title').locator(':scope > input').fill(CHAPTER);
  await field(form, 'status').locator(':scope > select').selectOption('planned');
  await field(form, 'partId').locator(':scope > select').selectOption('PT2');
  await field(form, 'readingOrder').locator(':scope > input').fill('9');
  const strands = field(form, 'strands');
  for (const [i, s] of [
    { label: 'present', year: '2045', primary: true, pov: 'H5', who: ['H5', 'Z3'] },
    { label: 'backstory', year: '2034', primary: false, pov: 'H3', who: ['H3'] },
  ].entries()) {
    await strands.getByRole('button', { name: 'Add to Strands', exact: true }).click();
    await field(form, `strands.${i}.label`).locator(':scope > input').fill(s.label);
    await field(form, `strands.${i}.startYear`).locator(':scope > input').fill(s.year);
    await field(form, `strands.${i}.primary`)
      .locator('input[type="checkbox"]')
      .setChecked(s.primary);
    await field(form, `strands.${i}.povCharacterId`).locator(':scope > select').selectOption(s.pov);
    for (const id of s.who) {
      await field(form, `strands.${i}.characterIds`).locator(':scope > select').selectOption(id);
    }
  }
  await form.getByRole('button', { name: 'Create chapter' }).click();
  const editor = page.getByTestId('editor');
  await expect(editor).toHaveAttribute('data-entry-id', /.+/);
  await expect(editor).toContainText(CHAPTER);
  await waitSaved(page);
  const id = (await editor.getAttribute('data-entry-id'))!;
  const stored = (await invoke('entry.get', { collection: 'chapters', id })).entry;
  expect((stored.strands as { startYear: number }[]).map((s) => s.startYear)).toEqual([2045, 2034]);
  await rail(page, 'Outline').click();
  await page.getByRole('button', { name: 'Year grid', exact: true }).click();
  await expect(grid().getByTestId('outline-label').filter({ hasText: CHAPTER })).toHaveCount(1);
});

const claudePanel = () => page.getByTestId('claude-panel');
const lastTurn = () => claudePanel().getByTestId('claude-turn').last();

async function ask(question: string): Promise<void> {
  await claudePanel().getByTestId('claude-input').fill(question);
  await claudePanel().getByTestId('claude-send').click();
  await expect(lastTurn()).toHaveAttribute('data-status', 'done');
}

test('AI-1 AI-2 AI-6 the question panel answers who is alive in 2075 and lists the entries it read', async () => {
  await page.keyboard.press('Meta+j');
  await expect(claudePanel()).toBeVisible();
  const disclosure = claudePanel().getByTestId('claude-disclosure');
  await expect(disclosure).toContainText('sends the content listed below to Anthropic');
  await disclosure.getByRole('button', { name: 'Continue' }).click();
  await ask('Who is alive in 2075?');
  await expect(lastTurn().getByTestId('claude-answer')).toHaveText(
    'In 2075 Daniel Hale is 90 and Noor Zhou is 17. Margaret and Peter Hale have died by then.',
  );
  const read = lastTurn().getByTestId('claude-entries');
  await expect(read.getByRole('button', { name: /Daniel Hale/ })).toBeVisible();
  await expect(read.getByRole('button', { name: /Noor Zhou/ })).toBeVisible();
});

test('AI-4 a request for prose gets a one-sentence refusal', async () => {
  await ask('Write the scene where Margaret hears that Peter has died.');
  const text = (await lastTurn().getByTestId('claude-answer').textContent()) ?? '';
  expect(text.match(/[.!?](\s|$)/g)).toHaveLength(1);
  expect(text).toMatch(/don't write prose for the novel/);
});

test('AI-3 ED-7 a change Claude suggests waits in the review queue and is approved', async () => {
  await ask('Add the porch by the river as a place inside the Hale house.');
  const note = lastTurn().getByTestId('claude-proposals');
  await expect(note).toContainText('1 proposal is waiting in the review queue');
  await note.getByRole('button', { name: 'Open the review queue' }).click();
  const queue = page.getByTestId('review-queue');
  const card = queue
    .locator('article, .panel')
    .filter({ hasText: 'The porch by the river' })
    .first();
  await expect(card).toContainText('Claude');
  await card.getByRole('button', { name: 'Approve' }).click();
  await expect(queue).toContainText('Approved');
  const places = (await invoke('entry.list', { collection: 'places', trash: 'exclude' })).entries;
  expect(places.map((p) => p.entry.title)).toContain('The porch by the river');
});

test('IM-5 ED-7 Claude proposes entries from a Word document; one proposal is rejected in the review queue', async () => {
  await nextDocument(files.wedding);
  await rail(page, 'Import').click();
  await importView().getByTestId('import-pick-document').click();
  const box = importView().getByTestId('import-claude');
  await box.getByTestId('import-claude-start').click();
  const result = box.getByTestId('import-claude-result');
  await expect(result).toHaveAttribute('data-status', 'done');
  await expect(result.getByTestId('claude-proposals')).toContainText('2 proposals are waiting');
  await rail(page, 'Review queue').click();
  const queue = page.getByTestId('review-queue');
  const pending = (await invoke('proposal.list', { state: 'pending' })).proposals;
  expect(pending).toHaveLength(2);
  const card = queue.locator(`[data-proposal="${pending[0]!.proposal._id}"]`);
  await card.getByRole('button', { name: 'Reject' }).click();
  await expect(card).toHaveCount(0);
  await expect(queue).toContainText('Rejected');
  expect((await invoke('proposal.list', { state: 'pending' })).proposals).toHaveLength(1);
});

// ---------------------------------------------------------------------------
// The session: brief, manuscript, alignment

test('DB-2 SB-4 SB-7 Start session on the new chapter: Claude writes the brief from the selection', async () => {
  await page.getByTestId('top-start-session').click();
  const view = page.getByTestId('start-session');
  await expect(view).toBeVisible();
  const id = (
    await invoke('entry.list', { collection: 'chapters', trash: 'exclude' })
  ).entries.find((e) => e.entry.title === CHAPTER)!.entry._id;
  await view.getByRole('button', { name: 'A chapter', exact: true }).click();
  await view.getByTestId('start-chapter').selectOption(id);
  await expect(view.getByTestId('start-session-go')).toHaveText(
    'Start session with claude-opus-5-5',
  );
  await view.getByTestId('start-session-go').click();
  // AI-6 was confirmed for this bible in the question panel, so the brief starts at once.
  await expect(view.getByTestId('claude-disclosure')).toHaveCount(0);
  const brief = page.getByTestId('brief-view');
  await expect(brief.getByTestId('brief-model')).toHaveText('Written by claude-opus-5-5');
  await expect(brief.getByTestId('brief-body')).toContainText('Iris Hale-Zhou is 14');
  await expect(brief.getByTestId('brief-body')).toContainText('Daniel Hale is 49');
  await expect(page.getByTestId('status-time')).toContainText('Story time 2045');
});

test('SB-9 an entry is removed from the brief selection and the brief is regenerated', async () => {
  const brief = page.getByTestId('brief-view');
  const sel = brief.getByTestId('brief-selection');
  // Any entry the recorded brief does not cite.
  const target = sel
    .locator('[data-testid="sel-item"]:not([data-id="H5"]):not([data-id="Z3"]):not([data-id="H3"])')
    .first();
  const removedId = (await target.getAttribute('data-id'))!;
  await target.getByRole('button', { name: /^Remove/ }).click();
  await expect(brief.getByTestId('brief-pending')).toContainText(`To remove: ${removedId}`);
  await brief.getByTestId('brief-regenerate').click();
  await expect(brief.getByTestId('brief-note')).toBeVisible();
  await expect(brief.getByTestId('brief-body')).toContainText('removed by you');
});

test('SB-8 the brief exports as Markdown', async () => {
  const brief = page.getByTestId('brief-view');
  await brief.getByRole('button', { name: 'Export Markdown' }).click();
  await expect(brief.getByTestId('brief-note')).toHaveText(/^Saved to .*\.md$/);
  const path = ((await brief.getByTestId('brief-note').textContent()) ?? '').replace(
    'Saved to ',
    '',
  );
  expect(readFileSync(path, 'utf8')).toContain('Iris Hale-Zhou is 14');
});

test('MS-1 MS-2 MS-3 Chapter 6 is read from Word, marked as written, its summary approved, and a moment promoted to canon', async () => {
  await nextDocument(files.letter);
  await rail(page, 'Manuscript').click();
  const view = page.getByTestId('manuscript-view');
  await view.locator('[data-chapter="CH6"]').click();
  const ch = view.getByTestId('ms-chapter');
  await ch.getByRole('button', { name: 'Import from a Word file' }).click();
  const compare = ch.getByTestId('ms-compare');
  await expect(compare.locator('tr[data-kind="added"]')).toHaveCount(4);
  await compare.getByRole('button', { name: 'Apply' }).click();
  await expect(ch.getByTestId('ms-source')).toHaveText('Source: Chapter 6 The Letter.docx');
  await ch.getByRole('button', { name: 'Mark as written' }).click();
  const flow = ch.getByTestId('written-flow');
  const draft = flow.getByLabel('Summary to approve');
  await expect(draft).toHaveValue(
    'Iris finds an envelope under the attic boards. Daniel says nothing at dinner.',
  );
  await flow.getByRole('button', { name: 'Approve summary' }).click();
  await expect(flow.getByTestId('summary-done')).toHaveText('Summary saved.');
  const list = flow.getByTestId('promote-list');
  await list
    .getByLabel('Iris finds the letter (a moment of the point of view in these years)')
    .check();
  await flow.getByRole('button', { name: 'Promote checked to canon' }).click();
  await expect(list.locator('label')).toHaveCount(0);
  expect((await invoke('entry.get', { collection: 'moments', id: 'B4' })).entry.status).toBe(
    'canon',
  );
});

const alignment = () => page.getByTestId('alignment-view');
const finding = (check: string) =>
  alignment().locator(`[data-testid="finding"][data-check="${check}"]`);

test('CC-1 CC-2 CC-3 Check alignment runs on the whole manuscript and lists structural and Claude findings', async () => {
  await rail(page, 'Dashboard').click();
  await dash().getByRole('button', { name: 'Check alignment' }).click();
  await expect(page.getByRole('heading', { name: 'Alignment check', level: 2 })).toBeVisible();
  await expect(alignment().getByTestId('alignment-runner')).toContainText('Model: claude-opus-5-5');
  await alignment().getByTestId('alignment-run').click();
  // AI-6 was confirmed for this bible in the question panel, so the check starts at once.
  await expect(alignment().getByTestId('alignment-status')).toContainText(
    'Done. Structural checks: 3 found. Claude read 8 chapters and found 2.',
    { timeout: 60_000 },
  );
  // S1 to S3, found in code.
  await expect(alignment().getByTestId('structural-findings').getByTestId('finding')).toHaveCount(
    3,
  );
  await expect(finding('character-present-while-dead')).toContainText(
    'Peter Hale (H2) as present. Peter Hale died in 2030.',
  );
  await expect(finding('fact-acted-on-before-learned')).toContainText('K2');
  await expect(finding('event-linked-as-happened-after-story-year')).toContainText(
    'E10 is dated 2090',
  );
  // P1 and P2, the recorded Claude findings, each with its chapter, line, and quote.
  await expect(finding('age')).toContainText('Chapter 5: Candles');
  await expect(finding('age').getByTestId('finding-quote')).toContainText(
    'Ruth counted the candles twice',
  );
  await expect(finding('place')).toContainText('Chapter 7: Rain in Guangzhou');
  await expect(finding('place').getByTestId('finding-quote')).toContainText(
    'Lan had grown up in Shanghai',
  );
  // CC-3: a change to a field that does not exist, and a citation outside the bible, are refused.
  await expect(finding('place').getByTestId('finding-rejected')).toContainText(
    'hometown is not a field of characters',
  );
  await expect(alignment().getByTestId('alignment-rejected')).toContainText(
    'It cites Z9, which is not in the bible.',
  );
});

test('CC-4 one finding is resolved with Manuscript wins, which changes the bible, and the change is undone', async () => {
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

test('CC-4 AI-4 another finding becomes a rewrite task with no prose, listed on the dashboard', async () => {
  await finding('place').getByRole('button', { name: 'Rewrite recommended' }).click();
  await expect(finding('place')).toHaveCount(0);
  const task = alignment().getByTestId('rewrite-task');
  await expect(task).toHaveCount(1);
  await expect(task).toContainText('Chapter 7: Rain in Guangzhou');
  await expect(task).toContainText('Line 1:Lan had grown up in Shanghai');
  // AI-4: the task says what must change; it never writes the replacement prose.
  await expect(task).toContainText(
    'What must change: The city Lan grew up in must be Guangzhou, as the bible records.',
  );
  await rail(page, 'Dashboard').click();
  const tile = dash().getByTestId('dash-tasks');
  await expect(tile).not.toContainText('No open rewrite tasks.');
  await expect(tile.getByTestId('rewrite-task')).toContainText('Lan had grown up in Shanghai');
});

// ---------------------------------------------------------------------------
// Drive

const settings = () => page.getByTestId('settings-view');
const drive = () => page.getByTestId('drive-view');

test('GD-1 Drive connects through the fake Google from Settings, read-only', async () => {
  await rail(page, 'Settings').click();
  const conn = settings().getByTestId('drive-connection');
  await conn.getByLabel('OAuth client ID').fill(fake.clientId);
  await conn.getByLabel('OAuth client secret').fill(fake.clientSecret);
  await conn.getByRole('button', { name: 'Save the client' }).click();
  await expect(conn.getByTestId('drive-state')).toHaveText('Not connected.');
  await conn.getByTestId('drive-connect').click();
  await expect(conn.getByTestId('drive-state')).toContainText('Connected as writer@example.com');
});

test('GD-2 GD-3 a Google Doc is linked, its change on Drive is flagged, and nothing changes until it is reviewed', async () => {
  await rail(page, 'Google Drive').click();
  await drive().getByRole('button', { name: 'Add files or folders from Drive' }).click();
  const browser = drive().getByTestId('drive-browser');
  await browser.getByRole('button', { name: 'Open Novel' }).click();
  await browser.getByRole('checkbox', { name: 'Chapter 3' }).check();
  await browser.getByTestId('drive-link-selected').click();
  const row = drive().getByTestId('drive-file').filter({ hasText: 'Chapter 3' });
  await expect(row).toHaveAttribute('data-state', 'new');
  await row.getByRole('button', { name: 'Mark as reviewed' }).click();
  await expect(row).toHaveAttribute('data-state', 'unchanged');
  fake.touch('docCh3', new Date(Date.now() + 60_000).toISOString());
  await drive().getByTestId('drive-check').click();
  await expect(row).toHaveAttribute('data-state', 'changed');
  await expect(row.getByTestId('drive-review-file')).toHaveText('Review changes');
});

test('GD-4 the bible exports to a new Drive folder as Markdown by section and one JSON file', async () => {
  const exp = drive().getByTestId('drive-export');
  await exp.getByTestId('drive-allow-export').click();
  await exp.getByRole('button', { name: 'Make the folder' }).click();
  await expect(exp.getByLabel('Export folder')).toHaveValue(/.+/);
  await exp.getByTestId('drive-export-now').click();
  await expect(exp.getByTestId('drive-export-done')).toContainText('to Tide Lines');
  expect(fake.uploads.some((u) => u.name === 'tide-lines.json')).toBe(true);
});

test('MS-1 MS-5 a chapter is read from a Google Doc picked in the Drive browser, and Drive is never written', async () => {
  const uploads = fake.uploads.length;
  await rail(page, 'Manuscript').click();
  const view = page.getByTestId('manuscript-view');
  await view.locator('[data-chapter="CH3"]').click();
  const ch = view.getByTestId('ms-chapter');
  await ch.getByRole('button', { name: 'Import from a Google Doc' }).click();
  const browser = ch.getByTestId('drive-picker').getByTestId('drive-browser');
  await browser.getByRole('button', { name: 'Open Novel', exact: true }).click();
  await browser.getByRole('radio', { name: 'Chapter 3' }).check();
  await browser.getByTestId('drive-pick-selected').click();
  const compare = ch.getByTestId('ms-compare');
  await expect(compare).toContainText('Chapter 3 (Google Doc)');
  await compare.getByRole('button', { name: 'Apply' }).click();
  await expect(ch.getByTestId('ms-source')).toHaveText('Source: Chapter 3 (Google Doc)');
  expect(
    (await invoke('entry.get', { collection: 'chapters', id: 'CH3' })).entry.manuscriptText,
  ).toContain('<em>lucky</em>');
  expect(fake.uploads.length).toBe(uploads);
});

// ---------------------------------------------------------------------------
// Backups, settings, close

test('BK-1 BK-2 a snapshot is taken, a character is edited, and restoring the snapshot brings the old value back', async () => {
  await rail(page, 'Backups').click();
  const backups = page.getByTestId('backups-view');
  await backups.getByTestId('snapshot-take').click();
  await expect(backups.getByTestId('backups-message')).toContainText('Snapshot taken');
  const manual = backups
    .getByTestId('snapshot-row')
    .filter({ hasText: 'Taken on request' })
    .first();
  const id = (await manual.getAttribute('data-id'))!;

  await openEntry('Characters', /^Zhou Jun/);
  const input = field(page.getByTestId('editor'), 'role').locator('textarea');
  await input.fill('Shenzhen after the snapshot');
  await waitSaved(page);

  await rail(page, 'Backups').click();
  const target = page.locator(`[data-testid="snapshot-row"][data-id="${id}"]`);
  await target.getByTestId('snapshot-restore').click();
  await target.getByTestId('snapshot-confirm').click();
  await expect(page.getByTestId('reload-notice')).toContainText('Restored the snapshot from');
  await expect
    .poll(
      async () => (await invoke('entry.get', { collection: 'characters', id: 'Z4' })).entry.role,
    )
    .not.toBe('Shenzhen after the snapshot');
  await openEntry('Characters', /^Zhou Jun/);
  await expect(field(page.getByTestId('editor'), 'role').locator('textarea')).not.toHaveValue(
    'Shenzhen after the snapshot',
  );
});

test('BK-3 the whole bible exports to one JSON file', async () => {
  await rail(page, 'Backups').click();
  await page.getByTestId('backup-export').click();
  await expect(page.getByTestId('backups-message')).toContainText(files.exportJson);
  const file = JSON.parse(readFileSync(files.exportJson, 'utf8'));
  expect(file).toMatchObject({ format: 'novel-companion-bible', bible: { name: 'Tide Lines' } });
});

test('ST-1 DB-4 settings: the summary model and the brief budget are changed and kept', async () => {
  await rail(page, 'Settings').click();
  const claude = settings().getByTestId('claude-settings');
  await expect(claude.getByTestId('claude-key-status')).toContainText('sk-ant-…cdef');
  await claude.getByTestId('claude-model-summaries').selectOption('claude-haiku-5-5');
  await expect
    .poll(async () => (await invoke('claude.status', {})).models.summaries)
    .toBe('claude-haiku-5-5');
  const budget = settings().getByTestId('settings-briefs').getByLabel('Size budget (characters)');
  await budget.fill('30000');
  await budget.blur();
  await rail(page, 'Dashboard').click();
  await rail(page, 'Settings').click();
  await expect(settings().getByTestId('claude-model-summaries')).toHaveValue('claude-haiku-5-5');
  await expect(
    settings().getByTestId('settings-briefs').getByLabel('Size budget (characters)'),
  ).toHaveValue('30000');
});

test('SL-1 closing the app asks where you stopped and saves the note', async () => {
  const closing = app.close();
  const prompt = page.getByTestId('stop-prompt');
  await expect(prompt.getByRole('heading', { name: 'Where did you stop?' })).toBeVisible();
  await prompt
    .getByLabel('Where did you stop?', { exact: true })
    .fill('Iris is at the harbor with Lan.');
  const shot = test.info().outputPath(`${String(stepNo + 1).padStart(2, '0')}-stop-prompt.png`);
  await page.screenshot({ path: shot });
  test.info().attachments.push({ name: 'screenshot', path: shot, contentType: 'image/png' });
  await prompt.getByRole('button', { name: 'Save note and quit' }).click();
  await closing;
});

test('SL-1 DB-1 the next launch shows the note first on the dashboard', async () => {
  await start();
  await page
    .getByRole('button', { name: 'Open Tide Lines' })
    .click()
    .catch(() => undefined);
  await expect(page.getByTestId('workspace')).toBeVisible();
  const panel = page.getByTestId('launch-panel');
  await expect(panel.getByTestId('launch-note')).toHaveText('Iris is at the harbor with Lan.');
});
