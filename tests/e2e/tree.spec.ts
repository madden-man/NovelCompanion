import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { MongoClient } from 'mongodb';
import { assembleGraph, buildGraph, generations, layoutTree } from '../../src/shared/domain/tree';
import type { TreeGraph } from '../../src/shared/domain/tree';
import type { Invoke } from '../helpers/t5';
import { readFixture } from '../helpers/loadFixture';
import { generatedTree } from '../helpers/generatedTree';
import { decodePng } from '../helpers/png';
import {
  changes,
  field,
  fileDb,
  fillDateBox,
  fillEditable,
  invokeVia,
  launch,
  openEditable,
  rail,
  setStoryYear,
  waitSaved,
  seedFixture,
} from './helpers';
import type { TestDb } from './helpers';

let db: TestDb;
let app: ElectronApplication;
let page: Page;
let invoke: Invoke;

const HAND = 'tree-hand';
const FIX = 'tree-fixture';
const fixture = readFixture();
const fixtureName = (id: string) =>
  String((fixture.characters!.find((c) => c._id === id)!.names as { full: string }).full);

type Tl2 = {
  years: {
    year: number;
    alive: { id: string; age: number; dyingThisYear: boolean }[];
    dead: { id: string; deathYear: number }[];
    unborn: string[];
    unknown: string[];
  }[];
};
const tl2 = JSON.parse(
  readFileSync(join(import.meta.dirname, '../../fixtures/expected/tl2.json'), 'utf8'),
) as Tl2;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  db = fileDb();
  ({ app, page } = await launch(db));
  invoke = invokeVia(page);
  for (const [slug, name] of [
    [HAND, 'Tree by hand'],
    [FIX, 'Fixture novel'],
  ] as const) {
    await invoke('bible.create', { slug, name });
  }
  await openBible(FIX);
  await loadFixtureVia(invoke);
  await openBible(HAND);
  // The two families exist before the tree is built; the tree assigns people to them.
  await seedFixture(
    invoke,
    fixture.families!.map((f) => ({ collection: 'families', data: strip(f) })),
  );
});

test.afterAll(async () => {
  await app?.close();
});

function strip(d: Record<string, unknown>): Record<string, unknown> {
  const { createdAt: _c, modifiedAt: _m, ...rest } = d;
  return rest;
}

/** Load the fixture novel through window.api, collection by collection. */
async function loadFixtureVia(inv: Invoke) {
  const order = ['customSections', ...Object.keys(fixture).filter((c) => c !== 'customSections')];
  for (const c of order) {
    if (c === 'lists' || !fixture[c]?.length) continue;
    await seedFixture(
      inv,
      fixture[c]!.map((d) => ({ collection: c as never, data: strip(d) })),
    );
  }
}

async function openBible(slug: string) {
  await invoke('bible.open', { slug });
  await expect(page.getByTestId('current-bible')).toBeVisible();
  await expect(page.getByTestId('workspace')).toBeVisible();
}

const inspector = () => page.getByTestId('tree-inspector');
const svgEl = () => page.getByTestId('tree-svg');
const node = (name: string) => page.locator(`g.tnode[aria-label^="${name},"]`);
const byId = (id: string) => page.locator(`g.tnode[data-person="${id}"]`);

async function openTree() {
  await rail(page, 'Family tree').click();
  await expect(page.getByTestId('tree-view')).toBeVisible();
}

async function select(name: string) {
  await node(name).dispatchEvent('click');
  await expect(inspector().getByTestId('inspector-name')).toHaveText(name);
}

async function add(
  kind: 'person' | 'parent' | 'child' | 'sibling' | 'partner',
  name: string,
  born: number | null,
  opts: { status?: string; type?: string; coParent?: string } = {},
) {
  // A38: Add person is on the tree toolbar; the relatives are added from the inspector.
  await (kind === 'person' ? page : inspector())
    .getByRole('button', { name: kind === 'person' ? 'Add person' : `Add ${kind}`, exact: true })
    .click();
  const form = inspector().getByTestId('add-form');
  await form.getByLabel('Name').fill(name);
  if (born !== null) await form.getByLabel('Birth year').fill(String(born));
  await form.getByLabel('Status').selectOption(opts.status ?? 'canon');
  if (opts.type && kind === 'partner') await form.getByLabel('Union type').selectOption(opts.type);
  else if (opts.type) await form.getByLabel('Link type').selectOption(opts.type);
  if (opts.coParent !== undefined) {
    await form.getByLabel('Other parent').selectOption({ label: opts.coParent });
  }
  await form.getByRole('button', { name: /^Add the/ }).click();
  await expect(node(name)).toHaveCount(1);
  await expect(inspector().getByTestId('inspector-name')).toHaveText(name);
}

const editor = () => inspector().getByTestId('editor');

/** FT-11: drag one person's node and drop it on another's; the drop menu opens. */
async function dropOn(from: string, onto: string) {
  await page.getByRole('button', { name: 'Fit to window' }).click();
  const a = (await node(from).boundingBox())!;
  const b = (await node(onto).boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 12, a.y + a.height / 2 + 12, { steps: 3 });
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 8 });
  await page.mouse.up();
  const menu = page.getByTestId('tree-drop');
  await expect(menu).toHaveAttribute('aria-label', `${from} dropped on ${onto}`);
  return menu;
}

async function setYearDate(path: 'birth' | 'death', year: number) {
  // The tree inspector is the generic editor, which keeps the composite date control.
  const f = field(editor(), path);
  await f.getByLabel('Kind of date').selectOption('year');
  await f.getByLabel('Year', { exact: true }).fill(String(year));
  await waitSaved(page);
}

async function setFamilies(ids: string[]) {
  const f = field(editor(), 'familyIds');
  const chips = f.locator(':scope > .chips .chip-remove');
  while ((await chips.count()) > 0) await chips.first().click();
  for (const id of ids) await f.locator(':scope > select').selectOption(id);
  await waitSaved(page);
}

async function editLink(withName: string, values: Record<string, string | number>) {
  await inspector()
    .getByRole('button', { name: `Edit the link with ${withName}` })
    .click();
  for (const [path, v] of Object.entries(values)) {
    const input = field(editor(), path).locator(':scope > input');
    await input.fill(String(v));
  }
  await waitSaved(page);
  await inspector()
    .getByRole('button', { name: /^Back to/ })
    .click();
}

/** People, unions, and links by name, so two graphs built differently can be compared. */
function signature(g: TreeGraph) {
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
        [...p.familyIds].sort().join('+'),
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

test('FT-2 FT-4 building the fixture tree by hand through tree actions gives the fixture graph and layout', async () => {
  test.setTimeout(300_000);
  await openTree();
  await expect(page.getByTestId('no-tree-warnings')).toBeVisible();

  await add('person', 'Margaret Hale', 1958);
  await setYearDate('death', 2041);
  await setFamilies(['FAM-HALE']);
  await add('partner', 'Peter Hale', 1956, { type: 'married' });
  await setYearDate('death', 2030);
  await setFamilies(['FAM-HALE']);
  await editLink('Margaret Hale', { startYear: 1982, endYear: 2030, endReason: 'death' });

  await select('Margaret Hale');
  await add('child', 'Daniel Hale', 1985, { type: 'biological', coParent: 'Peter Hale' });
  await select('Margaret Hale');
  await add('child', 'Ruth Hale', 1990, { type: 'biological', coParent: 'Peter Hale' });
  await setYearDate('death', 2067);

  await select('Daniel Hale');
  await add('partner', 'Zhou Lan', 1988, { type: 'married' });
  await setFamilies(['FAM-ZHOU']);
  await editLink('Daniel Hale', { startYear: 2029 });
  await add('parent', 'Zhou Meiling', 1962, { type: 'biological' });
  await setYearDate('death', 2050);
  await add('partner', 'Zhou Wei', 1960, { type: 'partnered' });
  await setYearDate('death', 2055);
  await setFamilies(['FAM-ZHOU']);
  // Link the existing Zhou Wei as Zhou Lan's other parent: drop Wei on Lan (FT-11).
  const linksBefore = (await invoke('tree.get', {})).links.length;
  const menu = await dropOn('Zhou Wei', 'Zhou Lan');
  await menu.getByRole('button', { name: 'Make Zhou Wei a parent of Zhou Lan' }).click();
  await expect(menu).toHaveCount(0);
  await expect.poll(async () => (await invoke('tree.get', {})).links.length).toBe(linksBefore + 1);
  await select('Zhou Lan');
  await add('sibling', 'Zhou Jun', 1993, { type: 'biological', status: 'planned' });
  await setYearDate('death', 2070);

  await select('Daniel Hale');
  await add('child', 'Iris Hale-Zhou', 2031, { type: 'biological', coParent: 'Zhou Lan' });
  await setFamilies(['FAM-HALE', 'FAM-ZHOU']);
  await select('Ruth Hale');
  await add('child', 'Sam Hale', 2012, { type: 'adoptive' });
  await editLink('Ruth Hale', { startYear: 2015 });
  await select('Iris Hale-Zhou');
  await add('partner', 'Tomas Reyes', 2030, { type: 'partnered', status: 'planned' });
  await editLink('Iris Hale-Zhou', { startYear: 2056, endYear: 2064, endReason: 'separated' });
  await select('Iris Hale-Zhou');
  await add('child', 'Noor Zhou', 2058, {
    type: 'biological',
    coParent: 'Tomas Reyes',
    status: 'planned',
  });
  await setFamilies(['FAM-ZHOU']);
  await add('person', 'The Archivist', null, { status: 'idea' });

  await expect(page.locator('g.tnode')).toHaveCount(13);
  const t = await invoke('tree.get', {});
  const built = assembleGraph(t.people, t.unions, t.links);
  const expected = buildGraph(fixture.characters!, fixture.unions!, fixture.parentLinks!);
  expect(signature(built)).toEqual(signature(expected));
  // The same graph lays out the same way, whatever order it was entered in.
  expect(layoutByName(built)).toEqual(layoutByName(expected));
  // Entered one at a time, people were placed without moving anyone, so Tidy layout
  // runs the full layout once; after a confirm, the screen draws exactly that layout.
  await page.getByRole('button', { name: 'Tidy layout' }).click();
  await page
    .getByRole('dialog', { name: 'Tidy layout' })
    .getByRole('button', { name: 'Tidy layout' })
    .click();
  await expect(page.getByRole('dialog', { name: 'Tidy layout' })).toHaveCount(0);
  await expect
    .poll(async () => (await invoke('tree.get', {})).positions?.[t.people[0]!.id])
    .toEqual({
      x: layoutByName(built)[t.people[0]!.name]![0],
      y: layoutByName(built)[t.people[0]!.name]![1],
    });
  const shown = await page
    .locator('g.tnode')
    .evaluateAll((els) =>
      els.map((e) => [e.getAttribute('aria-label')!.split(',')[0], e.getAttribute('transform')]),
    );
  const want = layoutByName(built);
  for (const [name, transform] of shown) {
    const [x, y] = want[name!]!;
    expect(transform, name!).toBe(`translate(${x},${y})`);
  }
  expect(t.warnings).toEqual([]);
});

test('FT-4 links and unions are drawn by type, ended unions carry their end year, and people with no family or no known parents render', async () => {
  const types = await page
    .locator('path.tlink')
    .evaluateAll((els) => els.map((e) => e.getAttribute('class')));
  expect(types.filter((c) => c === 'tlink biological')).toHaveLength(6);
  expect(types.filter((c) => c === 'tlink adoptive')).toHaveLength(1);
  const unions = await page
    .locator('path.tunion')
    .evaluateAll((els) => els.map((e) => e.getAttribute('class')!.split(' ')[1]));
  expect(unions.sort()).toEqual(['married', 'married', 'partnered', 'partnered']);
  await expect(page.locator('text.tunion-end')).toHaveText(['ended 2030', 'ended 2064']);
  // Different dash patterns for each kind of link.
  const dash = (cls: string) =>
    page.evaluate((c) => {
      const el = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      el.setAttribute('class', c);
      document.querySelector('[data-testid="tree-svg"]')!.appendChild(el);
      const v = getComputedStyle(el).strokeDasharray;
      el.remove();
      return v;
    }, cls);
  const patterns = await Promise.all(
    [
      'tlink biological',
      'tlink adoptive',
      'tlink step',
      'tlink guardian',
      'tunion married',
      'tunion partnered',
    ].map(dash),
  );
  expect(patterns[0]).toBe('none');
  expect(patterns[4]).toBe('none');
  expect(new Set(patterns.slice(0, 4)).size).toBe(4);
  expect(patterns[5]).not.toBe('none');
  // Tomas has no family and no known parents; the Archivist has neither and an unknown birth.
  await expect(node('Tomas Reyes').locator('rect.tnode-fam')).toHaveAttribute(
    'data-family',
    'none',
  );
  await expect(node('The Archivist')).toHaveAttribute('aria-label', /born unknown/);
  await expect(node('Sam Hale').locator('rect.tnode-fam')).toHaveAttribute(
    'data-family',
    'series-1',
  );
  await expect(node('Iris Hale-Zhou').locator('rect.tnode-fam')).toHaveCount(2);
});

test('FT-5 A45 the tree follows the story year: every node for 2040, 2041, and 2075 as in the TL-2 answers, and the unions', async () => {
  // A45: the tree has no year control of its own; the story year is set from the status bar.
  await expect(page.getByTestId('tree-year')).toHaveCount(0);
  await expect(page.getByLabel('Year slider')).toHaveCount(0);
  for (const y of tl2.years) {
    await setStoryYear(page, y.year);
    await expect(svgEl()).toHaveAttribute('data-year', String(y.year));
    for (const a of y.alive) {
      const n = node(fixtureName(a.id));
      await expect(n, `${a.id} in ${y.year}`).toHaveAttribute(
        'data-state',
        a.dyingThisYear ? 'dying' : 'alive',
      );
      await expect(n).toHaveAttribute('data-age', String(a.age));
      await expect(n.getByTestId('node-state')).toHaveText(
        a.dyingThisYear ? `dies at ${a.age}` : `age ${a.age}`,
      );
    }
    for (const d of y.dead) {
      const n = node(fixtureName(d.id));
      await expect(n, `${d.id} in ${y.year}`).toHaveAttribute('data-state', 'dead');
      await expect(n.getByTestId('node-state')).toHaveText(`d. ${d.deathYear}`);
    }
    for (const id of y.unborn) {
      await expect(node(fixtureName(id))).toHaveAttribute('data-state', 'unborn');
      await expect(node(fixtureName(id)).getByTestId('node-state')).toHaveText('unborn');
    }
    for (const id of y.unknown) {
      await expect(node(fixtureName(id))).toHaveAttribute('data-state', 'unknown');
      await expect(node(fixtureName(id)).getByTestId('node-state')).toHaveText('age unknown');
    }
  }
  // Unions: in 2040 Margaret and Peter's has ended and Iris and Tomas's has not begun; in 2060 it is active.
  await setStoryYear(page, 2040);
  await expect(page.locator('g[data-union][data-state="ended"]')).toHaveCount(1);
  await expect(page.locator('g[data-union][data-state="future"]')).toHaveCount(1);
  await setStoryYear(page, 2060);
  await expect(svgEl()).toHaveAttribute('data-year', '2060');
  await expect(page.locator('g[data-union][data-state="future"]')).toHaveCount(0);
  await expect(page.locator('g[data-union][data-state="active"]')).toHaveCount(3);
  // The tree's year is the story time, which persists.
  await expect.poll(async () => (await invoke('storyTime.get', {})).time?.year).toBe(2060);
  await setStoryYear(page, 2040);
  await expect(svgEl()).toHaveAttribute('data-year', '2040');
  await expect.poll(async () => (await invoke('storyTime.get', {})).time?.year).toBe(2040);
});

test('FT-7 FT-3 a click opens the character in the inspector without leaving the tree, and an edit there redraws the node', async () => {
  await page.getByRole('button', { name: 'Fit to window' }).click();
  await node('Zhou Jun').click();
  await expect(page.getByTestId('tree-view')).toBeVisible();
  await expect(inspector().getByTestId('inspector-name')).toHaveText('Zhou Jun');
  await expect(node('Zhou Jun')).toHaveAttribute('aria-pressed', 'true');
  // Name, years, and status on the node.
  await expect(node('Zhou Jun').locator('text.tnode-name')).toHaveText('Zhou Jun');
  await expect(node('Zhou Jun').locator('text.tnode-years')).toHaveText('1993 to 2070');
  await expect(node('Zhou Jun').locator('text.tchip-text')).toHaveText('planned');
  await setYearDate('birth', 1995);
  await expect(node('Zhou Jun').locator('text.tnode-years')).toHaveText('1995 to 2070');
  await expect(node('Zhou Jun')).toHaveAttribute('data-age', '45');
  // The same data on the character page.
  await rail(page, 'Characters').click();
  await page
    .getByTestId('entry-list')
    .getByRole('button', { name: /Zhou Jun/ })
    .click();
  const line = page.getByTestId('character-page').getByTestId('char-line');
  await expect(field(line, 'birth').locator('.editable-text')).toHaveText('1995');
  await expect(field(line, 'death').locator('.editable-text')).toHaveText('2070');
  // An edit on the character page shows in the tree.
  await fillDateBox(field(page.getByTestId('editor'), 'birth'), '1993');
  await waitSaved(page);
  await openTree();
  await expect(node('Zhou Jun').locator('text.tnode-years')).toHaveText('1993 to 2070');
  await expect(node('Zhou Jun')).toHaveAttribute('data-age', '47');
});

test('FT-2 change a link type, remove a link and undo it, and delete and restore a person through the trash', async () => {
  await select('Sam Hale');
  const group = (kind: string) => inspector().locator(`[data-group="${kind}"]`);
  const row = group('parent').getByTestId('link-list').locator('li', { hasText: 'Ruth Hale' });
  await row.getByRole('combobox').selectOption('guardian');
  await expect(page.locator('path.tlink.guardian')).toHaveCount(1);
  await expect(page.locator('path.tlink.adoptive')).toHaveCount(0);
  await row.getByRole('combobox').selectOption('adoptive');
  await expect(page.locator('path.tlink.adoptive')).toHaveCount(1);
  // Change a union type.
  await select('Iris Hale-Zhou');
  const urow = group('partner').getByTestId('link-list').locator('li', { hasText: 'Tomas Reyes' });
  await urow.getByRole('combobox').selectOption('married');
  await expect(page.locator('path.tunion.married')).toHaveCount(3);
  await urow.getByRole('combobox').selectOption('partnered');
  await expect(page.locator('path.tunion.partnered')).toHaveCount(2);
  // Remove Sam's only parent link: Sam now has no known parent. Undo brings it back.
  await select('Sam Hale');
  await inspector().getByRole('button', { name: 'Remove the link with Ruth Hale' }).click();
  await expect(page.locator('path.tlink.adoptive')).toHaveCount(0);
  await expect(inspector().getByTestId('link-list')).toHaveCount(0);
  await expect(group('parent')).toContainText('None yet.');
  await page.locator('body').click({ position: { x: 2, y: 2 } });
  await page.keyboard.press('Meta+z');
  await expect(page.locator('path.tlink.adoptive')).toHaveCount(1);

  // Delete a person through the ED-5 flow: the links are listed, then it goes to the trash.
  await select('Noor Zhou');
  await inspector().getByRole('button', { name: 'Remove Noor Zhou' }).click();
  const dialog = inspector().getByRole('dialog', { name: 'Move to trash' });
  await expect(dialog.getByTestId('linked-count')).toHaveText(/2 entries link here/);
  await dialog.getByRole('button', { name: 'Move to trash' }).click();
  await expect(node('Noor Zhou')).toHaveCount(0);
  const raw = await new MongoClient(db.uri).connect();
  try {
    const stored = await raw
      .db(db.name)
      .collection(`${HAND}.characters`)
      .findOne({ title: 'Noor Zhou' });
    expect(stored?.deletedAt).toBeTruthy();
  } finally {
    await raw.close();
  }
  await inspector().getByRole('button', { name: 'Restore from trash' }).click();
  await expect(node('Noor Zhou')).toHaveCount(1);
  const t = await invoke('tree.get', {});
  const noor = t.people.find((p) => p.name === 'Noor Zhou')!;
  expect(t.links.filter((l) => l.childId === noor.id)).toHaveLength(2);
});

test('FT-6 A45 warnings show in the inspector behind the toolbar count and never block; a person cannot become their own ancestor', async () => {
  const count = page.getByTestId('tree-warn-count');
  await expect(count).toHaveText('No warnings');
  await select('Noor Zhou');
  await setYearDate('birth', 2040);
  // The count clears the selection, so the inspector shows the warnings.
  const warnings = inspector().getByTestId('tree-warnings');
  await expect(count).toHaveText(/^\d+ warnings$/);
  await expect(warnings).toHaveCount(0);
  await count.click();
  await expect(inspector().getByTestId('inspector-name')).toHaveCount(0);
  await expect(warnings).toContainText(
    'Iris Hale-Zhou would be 9 when Noor Zhou is born, under 12.',
  );
  await expect(warnings).toContainText('Tomas Reyes would be 10 when Noor Zhou is born, under 12.');
  const shown = Number((await count.textContent())!.split(' ')[0]);
  await expect(warnings.locator('li')).toHaveCount(shown);
  // It saved anyway.
  const t = await invoke('tree.get', {});
  expect(t.people.find((p) => p.name === 'Noor Zhou')!.birth).toEqual({ year: 2040 });
  // Show <name> on a warning selects that person.
  await warnings
    .getByRole('button', { name: /^Show / })
    .first()
    .click();
  await expect(inspector().getByTestId('inspector-name')).toHaveCount(1);
  await select('Noor Zhou');
  await setYearDate('birth', 2058);
  await expect(count).toHaveText('No warnings');
  await count.click();
  await expect(inspector().getByTestId('no-tree-warnings')).toBeVisible();

  // Self-ancestry is refused in plain words, and nothing is written.
  const before = (await invoke('tree.get', {})).links.length;
  const menu = await dropOn('Margaret Hale', 'Iris Hale-Zhou');
  await menu.getByRole('button', { name: 'Make Margaret Hale a child of Iris Hale-Zhou' }).click();
  await expect(menu.getByRole('alert')).toHaveText(
    'This link was not made: Margaret Hale is already an ancestor of Iris Hale-Zhou, so it would make someone their own ancestor.',
  );
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  // The write path refuses it too, whoever asks.
  const ids = Object.fromEntries(t.people.map((p) => [p.name, p.id]));
  await expect(
    invoke('entry.create', {
      collection: 'parentLinks',
      data: {
        title: 'Loop',
        status: 'idea',
        parentId: ids['Iris Hale-Zhou'],
        childId: ids['Margaret Hale'],
        type: 'biological',
      },
    }),
  ).rejects.toThrow(/would make someone their own ancestor/);
  expect((await invoke('tree.get', {})).links.length).toBe(before);
});

test('FT-1 A45 one tree shows every family together, with no family or lineage filter', async () => {
  await expect(page.getByLabel('Show', { exact: true })).toHaveCount(0);
  await expect(page.locator('g.tnode')).toHaveCount(13);
  const names = (
    await page
      .locator('g.tnode')
      .evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')!.split(',')[0]))
  ).sort();
  // Both families and the people who join them, Iris Hale-Zhou among them.
  for (const n of ['Margaret Hale', 'Zhou Wei', 'Iris Hale-Zhou', 'Tomas Reyes'])
    expect(names).toContain(n);
});

test('FT-7 FT-2 A45 the inspector edits Name, In the story, Description, Birth, Death and Families, links to Backstory, and lists the family from the top down', async () => {
  await select('Daniel Hale');
  const ed = editor();
  // The fields, in order; status, provenance, source, tags, links and the backstory box are gone.
  const fields = await ed
    .locator('form.editor-fields > fieldset > [data-field]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-field')));
  expect(fields).toEqual([
    'names.full',
    'names.chinese',
    'role',
    'body',
    'birth',
    'death',
    'familyIds',
  ]);
  await expect(field(ed, 'names.full').locator('label')).toHaveText('Name');
  await expect(field(ed, 'body').locator('label')).toHaveText('Description');
  await expect(field(ed, 'role').locator('label')).toHaveText('In the story');
  for (const gone of ['title', 'status', 'provenance', 'sourceNote', 'sourceRef', 'tags', 'links'])
    await expect(field(ed, gone)).toHaveCount(0);
  await expect(field(ed, 'backstory')).toHaveCount(0);
  // Name sets the title too, so the node follows it.
  await field(ed, 'names.full').locator('input').fill('Daniel J. Hale');
  await waitSaved(page);
  await expect(node('Daniel J. Hale')).toHaveCount(1);
  const t = await invoke('tree.get', {});
  const dan = t.people.find((p) => p.name === 'Daniel J. Hale')!;
  const stored = (await invoke('entry.get', { collection: 'characters', id: dan.id })).entry;
  expect(stored.title).toBe('Daniel J. Hale');
  expect((stored.names as { full: string }).full).toBe('Daniel J. Hale');
  await field(ed, 'names.full').locator('input').fill('Daniel Hale');
  await waitSaved(page);
  await expect(node('Daniel Hale')).toHaveCount(1);

  // The family sits below the fields, from the top down, each group with its own Add.
  const groups = inspector().locator('[data-group]');
  expect(await groups.evaluateAll((els) => els.map((e) => e.getAttribute('data-group')))).toEqual([
    'parent',
    'partner',
    'sibling',
    'child',
  ]);
  const group = (kind: string) => inspector().locator(`[data-group="${kind}"]`);
  await expect(group('parent').getByTestId('link-list').locator('li')).toHaveText([
    /Peter Hale|Margaret Hale/,
    /Peter Hale|Margaret Hale/,
  ]);
  await expect(group('partner')).toContainText('Zhou Lan');
  await expect(group('sibling')).toContainText('Ruth Hale');
  await expect(group('child')).toContainText('Iris Hale-Zhou');
  for (const kind of ['parent', 'partner', 'sibling', 'child'])
    await expect(
      group(kind).getByRole('button', { name: `Add ${kind}`, exact: true }),
    ).toBeVisible();
  // A sibling follows from the shared parents: it selects, and has no type or Remove.
  await expect(group('sibling').getByRole('combobox')).toHaveCount(0);
  await expect(group('sibling').getByRole('button', { name: /^Remove/ })).toHaveCount(0);
  const edBox = (await ed.boundingBox())!;
  const famBox = (await inspector().getByRole('heading', { name: 'Family' }).boundingBox())!;
  expect(famBox.y).toBeGreaterThan(edBox.y + edBox.height - 1);
  // The add form opens under its own group.
  await group('child').getByRole('button', { name: 'Add child', exact: true }).click();
  await expect(group('child').getByTestId('add-form')).toBeVisible();
  await group('child').getByTestId('add-form').getByRole('button', { name: 'Cancel' }).click();
  await group('sibling').getByRole('button', { name: 'Ruth Hale' }).click();
  await expect(inspector().getByTestId('inspector-name')).toHaveText('Ruth Hale');

  // Backstory is a link to the Backstory screen on this person.
  await select('Daniel Hale');
  await editor().getByRole('button', { name: 'Open in Backstory' }).click();
  await expect(page.getByTestId('backstory-view')).toBeVisible();
  await expect(page.getByTestId('backstory-view').getByTestId('picked-person')).toContainText(
    'Daniel Hale',
  );
  await openTree();
});

test('FT-8 pan by drag, zoom with the buttons and the wheel, collapse and expand a branch, and fit to window', async () => {
  const box = async () => (await svgEl().getAttribute('viewBox'))!.split(' ').map(Number);
  await page.getByRole('button', { name: 'Fit to window' }).click();
  const fitted = await box();
  // Drag on the background pans.
  const r = (await svgEl().boundingBox())!;
  await page.mouse.move(r.x + 6, r.y + r.height - 6);
  await page.mouse.down();
  await page.mouse.move(r.x + 106, r.y + r.height - 46, { steps: 5 });
  await page.mouse.up();
  const panned = await box();
  expect(panned[0]).toBeLessThan(fitted[0]!);
  expect(panned[2]).toBeCloseTo(fitted[2]!, 3);
  await page.getByRole('button', { name: 'Zoom in' }).click();
  const zoomed = await box();
  expect(zoomed[2]).toBeCloseTo(panned[2]! * 0.8, 3);
  await page.getByRole('button', { name: 'Zoom out' }).click();
  expect((await box())[2]).toBeCloseTo(panned[2]!, 3);
  await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
  await page.mouse.wheel(0, -300);
  await expect.poll(async () => (await box())[2]!).toBeLessThan(panned[2]!);
  await page.getByRole('button', { name: 'Fit to window' }).click();
  expect(await box()).toEqual(fitted);
  // Collapse Daniel's branch: Iris, her partner, and Noor are hidden; expand brings them back.
  await select('Daniel Hale');
  await inspector().getByRole('button', { name: 'Collapse branch' }).click();
  await expect(page.locator('g.tnode')).toHaveCount(10);
  for (const n of ['Iris Hale-Zhou', 'Tomas Reyes', 'Noor Zhou'])
    await expect(node(n)).toHaveCount(0);
  await expect(node('Daniel Hale')).toHaveClass(/collapsed/);
  await inspector().getByRole('button', { name: 'Expand branch' }).click();
  await expect(page.locator('g.tnode')).toHaveCount(13);
  // Double-click on a node collapses too.
  await node('Ruth Hale').dblclick();
  await expect(node('Sam Hale')).toHaveCount(0);
  await node('Ruth Hale').dblclick();
  await expect(node('Sam Hale')).toHaveCount(1);
});

test('FT-8 A26 A45 the tree fills the middle column with no page scroll, Full screen sets document.fullscreenElement, Escape leaves it, and every permission but full screen is refused', async () => {
  const sizes = () =>
    page.evaluate(() => {
      const view = document.querySelector<HTMLElement>('[data-testid="tree-view"]')!;
      const main = view.querySelector<HTMLElement>('.tree-main')!;
      const wrap = view.querySelector<HTMLElement>('.tree-wrap')!;
      const inspector = view.querySelector<HTMLElement>('[data-testid="tree-inspector"]')!;
      const pad = getComputedStyle(main);
      const m = main.getBoundingClientRect();
      const w = wrap.getBoundingClientRect();
      return {
        inner: window.innerHeight,
        chrome: parseFloat(pad.getPropertyValue('--ws-chrome')),
        main: m.height,
        // What is left below the tree inside the panel, and beside it.
        below: m.bottom - parseFloat(pad.paddingBottom) - w.bottom,
        side: m.right - parseFloat(pad.paddingRight) - w.right,
        mainRight: m.right,
        inspectorLeft: inspector.getBoundingClientRect().left,
        scroll: document.documentElement.scrollHeight - window.innerHeight,
      };
    });
  const z = await sizes();
  // The panel is the window minus the chrome, and the tree takes all of it below the toolbar.
  expect(Math.abs(z.main - (z.inner - z.chrome))).toBeLessThanOrEqual(2);
  expect(Math.abs(z.below)).toBeLessThanOrEqual(1);
  expect(Math.abs(z.side)).toBeLessThanOrEqual(1);
  // The inspector keeps the right column, and the page itself does not scroll.
  expect(Math.abs(z.inspectorLeft - z.mainRight)).toBeLessThanOrEqual(2);
  expect(z.scroll).toBeLessThanOrEqual(0);
  // The toolbar is one row: Add person, Fit, Tidy, Export, Full screen, and the warning count.
  const bar = page.getByRole('toolbar', { name: 'Family tree tools' });
  await expect(bar.getByRole('button')).toHaveText([
    'Add person',
    'Fit to window',
    'Tidy layout',
    'Export',
    'Full screen',
    /warning/,
  ]);
  const tops = await bar
    .getByRole('button')
    .evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
  expect(new Set(tops).size).toBe(1);
  // No heading, no people count, no legend or warnings under the tree.
  await expect(page.getByTestId('tree-view').getByRole('heading', { level: 2 })).toHaveCount(0);
  await expect(page.getByText(/people shown/)).toHaveCount(0);
  // The legend opens over the tree's bottom left corner and closes again.
  const legend = page.getByRole('region', { name: 'Tree legend' });
  await expect(legend).toHaveCount(0);
  await page.getByRole('button', { name: 'Legend', exact: true }).click();
  await expect(legend).toBeVisible();
  await expect(legend).toContainText('Married');
  const lb = (await legend.boundingBox())!;
  const tb = (await page.locator('.tree-wrap').boundingBox())!;
  expect(lb.x - tb.x).toBeLessThan(20);
  expect(tb.y + tb.height - (lb.y + lb.height)).toBeLessThan(60);
  expect((await sizes()).scroll).toBeLessThanOrEqual(0);
  await page.getByRole('button', { name: 'Hide legend' }).click();
  await expect(legend).toHaveCount(0);

  await page.getByRole('button', { name: 'Full screen' }).click();
  await expect
    .poll(() =>
      page.evaluate(() => document.fullscreenElement?.getAttribute('data-testid') ?? null),
    )
    .toBe('tree-view');
  await expect(page.getByRole('button', { name: 'Exit full screen' })).toBeVisible();
  // Escape only works once the window has finished entering full screen.
  await expect
    .poll(() =>
      app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isFullScreen()),
    )
    .toBe(true);
  // macOS ignores a leave request while its enter animation is still running.
  await page.waitForTimeout(3000);
  await page.keyboard.press('Escape');
  await expect
    .poll(() => page.evaluate(() => document.fullscreenElement === null), { timeout: 15000 })
    .toBe(true);
  await expect(page.getByRole('button', { name: 'Full screen' })).toBeVisible();

  // The session grants full screen and nothing else, to a request or to a check.
  const states = await page.evaluate(async () => {
    const out: Record<string, string> = {};
    for (const name of ['geolocation', 'notifications', 'camera', 'microphone']) {
      try {
        out[name] = (await navigator.permissions.query({ name: name as PermissionName })).state;
      } catch {
        out[name] = 'unsupported';
      }
    }
    return out;
  });
  for (const v of Object.values(states)) expect(v).not.toBe('granted');
});

test('FT-8 NF-2 the tree works from the keyboard: arrows pan, Shift for larger steps, + and - zoom, F fits, Enter and Space collapse', async () => {
  const box = async () => (await svgEl().getAttribute('viewBox'))!.split(' ').map(Number);
  await page.getByRole('button', { name: 'Fit to window' }).click();
  const fitted = await box();
  await svgEl().focus();
  await page.keyboard.press('ArrowRight');
  let b = await box();
  expect(b[0]).toBeCloseTo(fitted[0]! + fitted[2]! * 0.1, 3);
  await page.keyboard.press('Shift+ArrowDown');
  b = await box();
  expect(b[1]).toBeCloseTo(fitted[1]! + fitted[3]! * 0.4, 3);
  await page.keyboard.press('+');
  expect((await box())[2]).toBeCloseTo(fitted[2]! * 0.8, 3);
  await page.keyboard.press('-');
  expect((await box())[2]).toBeCloseTo(fitted[2]!, 3);
  await page.keyboard.press('f');
  expect(await box()).toEqual(fitted);
  const toggle = page.getByRole('button', { name: 'Collapse the branch of Daniel Hale' });
  await toggle.focus();
  await page.keyboard.press('Enter');
  await expect(node('Iris Hale-Zhou')).toHaveCount(0);
  const expand = page.getByRole('button', { name: 'Expand the branch of Daniel Hale' });
  await expand.focus();
  await page.keyboard.press(' ');
  await expect(node('Iris Hale-Zhou')).toHaveCount(1);
});

test('FT-9 A45 one Export saves the tree as a PNG image through a save dialog, in the light theme', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tree-export-'));
  const stubDialog = (file: string) =>
    app.evaluate(({ dialog }, f) => {
      (dialog as unknown as { showSaveDialog: () => Promise<unknown> }).showSaveDialog =
        async () => ({
          canceled: false,
          filePath: f,
        });
    }, file);
  // The app is in dark mode; exports still use the light theme.
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect
    .poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor))
    .toBe('rgb(15, 21, 28)');
  // A45: one Export button, and no PDF.
  await expect(page.getByRole('button', { name: /^Export (PNG|PDF)$/ })).toHaveCount(0);
  const png = join(dir, 'tree.png');
  await stubDialog(png);
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await expect(page.getByTestId('export-note')).toHaveText(`Saved ${png}.`);
  const bytes = await readFile(png);
  expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  expect(width).toBeGreaterThan(1000);
  expect(height).toBeGreaterThan(500);
  expect((await stat(png)).size).toBeGreaterThan(20_000);
  // Decode it: a light page with nodes drawn on it in many colours, and dark text.
  const img = decodePng(bytes);
  const bg = img.pixel(2, 2);
  expect(Math.min(...bg)).toBeGreaterThan(240);
  const colors = new Set<string>();
  let ink = 0;
  let dark = 0;
  for (let y = 0; y < img.height; y += 2) {
    for (let x = 0; x < img.width; x += 2) {
      const p = img.pixel(x, y);
      colors.add(p.join(','));
      if (Math.abs(p[0] - bg[0]) + Math.abs(p[1] - bg[1]) + Math.abs(p[2] - bg[2]) > 30) ink++;
      if (p[0] + p[1] + p[2] < 200) dark++;
    }
  }
  const sampled = Math.ceil(img.height / 2) * Math.ceil(img.width / 2);
  expect(colors.size).toBeGreaterThan(50);
  expect(ink / sampled).toBeGreaterThan(0.01);
  expect(dark).toBeGreaterThan(500);
  await page.emulateMedia({ colorScheme: 'light' });
  // Cancelling saves nothing.
  await app.evaluate(({ dialog }) => {
    (dialog as unknown as { showSaveDialog: () => Promise<unknown> }).showSaveDialog =
      async () => ({
        canceled: true,
        filePath: '',
      });
  });
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await expect(page.getByTestId('export-note')).toHaveText('Export cancelled. Nothing was saved.');
});

test('ED-3 after a save lands in one field, Cmd+Z in another field with unsaved typing undoes that typing', async () => {
  await select('Ruth Hale');
  // A43: the top bar's Undo names the step it takes back, without taking the focus.
  const undoButton = page.getByTestId('top-undo');
  const place = field(editor(), 'role').getByRole('textbox');
  await place.fill('Astoria, Oregon');
  // Straight into another field before the save of the first one lands.
  await page.getByRole('button', { name: 'Add person', exact: true }).click();
  const name = inspector().getByTestId('add-form').getByLabel('Name');
  await name.pressSequentially('Typed name');
  await waitSaved(page);
  const next = 'Undo Changed In the story on Ruth Hale (Cmd Z)';
  await expect(undoButton).toHaveAttribute('title', next);
  await expect(name).toBeFocused();
  await page.keyboard.press('Meta+z');
  await expect(name).not.toHaveValue('Typed name');
  // The saved change in the first field is untouched.
  await expect(undoButton).toHaveAttribute('title', next);
  const t = await invoke('tree.get', {});
  const ruth = t.people.find((p) => p.name === 'Ruth Hale')!;
  expect((await invoke('entry.get', { collection: 'characters', id: ruth.id })).entry.role).toBe(
    'Astoria, Oregon',
  );
  await inspector().getByTestId('add-form').getByRole('button', { name: 'Cancel' }).click();
  await expect((await changes(page)).locator('li').first()).toHaveText(
    'Changed In the story on Ruth Hale',
  );
  await page.keyboard.press('Escape');
});

test('FT-10 adding a child to Sam leaves every other node where it was', async () => {
  const positions = async () =>
    Object.fromEntries(
      await page
        .locator('g.tnode')
        .evaluateAll((els) =>
          els.map((e) => [
            e.getAttribute('aria-label')!.split(',')[0],
            e.getAttribute('transform'),
          ]),
        ),
    );
  const before = await positions();
  await select('Sam Hale');
  await add('child', 'Hope Hale', 2040, { type: 'biological' });
  const after = await positions();
  for (const [n, t] of Object.entries(before)) expect(after[n], n).toBe(t);
  expect(after['Hope Hale']).toBeDefined();
  // Adding someone on their own moves nobody either.
  await add('person', 'A Stranger', 2000);
  const again = await positions();
  for (const [n, t] of Object.entries(after)) expect(again[n], n).toBe(t);
});

const domPositions = async () =>
  Object.fromEntries(
    await page
      .locator('g.tnode')
      .evaluateAll((els) =>
        els.map((e) => [e.getAttribute('aria-label')!.split(',')[0], e.getAttribute('transform')]),
      ),
  );

test('FT-10 adding a child to Ruth leaves every other node where it was, and stays so after a reload', async () => {
  const before = await domPositions();
  await select('Ruth Hale');
  await add('child', 'Grace Hale', 2020, { type: 'biological' });
  const after = await domPositions();
  for (const [n, t] of Object.entries(before)) expect(after[n], n).toBe(t);
  // Positions are stored per bible: opening the tree again draws the same places.
  await rail(page, 'Characters').click();
  await openTree();
  await expect(node('Grace Hale')).toHaveCount(1);
  expect(await domPositions()).toEqual(after);
});

test('FT-11 ED-3 a person is dragged to a new place and stays there, Alt with an arrow moves them a slot, Cmd+Z takes each move back, and a drop on someone can be just a move', async () => {
  const at = async (name: string) => {
    const m = /translate\(([-\d.]+),([-\d.]+)\)/.exec(
      (await node(name).getAttribute('transform'))!,
    )!;
    return { x: Number(m[1]), y: Number(m[2]) };
  };
  const stored = async (name: string) => {
    const t = await invoke('tree.get', {});
    return t.positions![t.people.find((p) => p.name === name)!.id];
  };
  await page.getByRole('button', { name: 'Fit to window' }).click();
  const before = await at('Grace Hale');
  const others = await domPositions();
  const r = (await node('Grace Hale').boundingBox())!;
  const svg = (await svgEl().boundingBox())!;
  // Drag her well below everyone, into empty space.
  await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
  await page.mouse.down();
  await page.mouse.move(r.x + r.width / 2 + 10, r.y + r.height / 2 + 10, { steps: 3 });
  await page.mouse.move(r.x + r.width / 2 + 40, svg.y + svg.height - 8, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByTestId('tree-drop')).toHaveCount(0);
  const moved = await at('Grace Hale');
  expect(moved.y).toBeGreaterThan(before.y);
  // The row snaps to the generation grid and the move is stored.
  expect(moved.y % 132).toBe(0);
  await expect.poll(() => stored('Grace Hale')).toEqual({ x: moved.x, y: moved.y });
  // Nobody else moved, and a plain click still selects.
  const after = await domPositions();
  for (const [n, t] of Object.entries(others)) if (n !== 'Grace Hale') expect(after[n], n).toBe(t);
  await node('Grace Hale').click();
  await expect(inspector().getByTestId('inspector-name')).toHaveText('Grace Hale');
  // Alt+ArrowRight moves her one slot right; it is stored too.
  await node('Grace Hale').focus();
  await page.keyboard.press('Alt+ArrowRight');
  await expect.poll(async () => (await at('Grace Hale')).x).toBe(moved.x + 194);
  await expect.poll(() => stored('Grace Hale')).toEqual({ x: moved.x + 194, y: moved.y });
  // ED-3: Cmd+Z takes the nudge back, then the drag; Shift+Cmd+Z brings both back.
  await page.keyboard.press('Meta+z');
  await expect.poll(() => stored('Grace Hale')).toEqual({ x: moved.x, y: moved.y });
  await expect.poll(async () => (await at('Grace Hale')).x).toBe(moved.x);
  await page.keyboard.press('Meta+z');
  await expect.poll(() => stored('Grace Hale')).toEqual(before);
  await expect.poll(() => at('Grace Hale')).toEqual(before);
  await page.keyboard.press('Shift+Meta+z');
  await page.keyboard.press('Shift+Meta+z');
  await expect.poll(() => stored('Grace Hale')).toEqual({ x: moved.x + 194, y: moved.y });
  await expect.poll(async () => (await at('Grace Hale')).x).toBe(moved.x + 194);
  // Dropped on someone, "Just move" puts her there without a link.
  const links = (await invoke('tree.get', {})).links.length;
  const menu = await dropOn('Grace Hale', 'Sam Hale');
  await menu.getByRole('button', { name: 'Just move Grace Hale here' }).click();
  await expect(menu).toHaveCount(0);
  expect((await invoke('tree.get', {})).links.length).toBe(links);
  const sam = await at('Sam Hale');
  await expect.poll(async () => (await at('Grace Hale')).y).toBe(sam.y);
  // Back where the layout had her, so the tests after this one see the same tree.
  await invoke('tree.savePositions', {
    positions: {
      ...(await invoke('tree.get', {})).positions!,
      [(await invoke('tree.get', {})).people.find((p) => p.name === 'Grace Hale')!.id]: before,
    },
  });
  await rail(page, 'Characters').click();
  await openTree();
  expect(await at('Grace Hale')).toEqual(before);
});

test('FT-4 a person with two unions: both draw, the ended one with its year, each child under its own union, and half-siblings', async () => {
  await select('Zhou Lan');
  await add('partner', 'Chen Bo', 1986, { type: 'married' });
  await editLink('Zhou Lan', { startYear: 2008, endYear: 2020, endReason: 'divorce' });
  await select('Zhou Lan');
  await add('child', 'Kai Chen', 2012, { type: 'biological', coParent: 'Chen Bo' });
  await setStoryYear(page, 2040);
  const lanUnions = page.locator('g[data-union]');
  await expect(lanUnions).toHaveCount(5);
  await expect(page.locator('text.tunion-end', { hasText: 'ended 2020' })).toHaveCount(1);
  // Lay out again so Lan sits between her two partners, then check where each child hangs.
  await page.getByRole('button', { name: 'Tidy layout' }).click();
  await page
    .getByRole('dialog', { name: 'Tidy layout' })
    .getByRole('button', { name: 'Tidy layout' })
    .click();
  const xOf = async (name: string) =>
    Number(/translate\(([-\d.]+),/.exec((await node(name).getAttribute('transform'))!)![1]);
  await expect.poll(async () => (await xOf('Chen Bo')) - (await xOf('Zhou Lan'))).toBe(194);
  const [dan, lan, bo] = [await xOf('Daniel Hale'), await xOf('Zhou Lan'), await xOf('Chen Bo')];
  const t = await invoke('tree.get', {});
  const id = (n: string) => t.people.find((p) => p.name === n)!.id;
  const startOf = async (child: string) => {
    const linkIds = t.links.filter((l) => l.childId === id(child)).map((l) => l.id);
    expect(linkIds).toHaveLength(2);
    const d = await page
      .locator(`path.tlink[data-links~="${linkIds[0]}"][data-links~="${linkIds[1]}"]`)
      .getAttribute('d');
    return Number(/^M([-\d.]+),/.exec(d!)![1]);
  };
  expect(await startOf('Iris Hale-Zhou')).toBe((dan + 168 + lan) / 2);
  expect(await startOf('Kai Chen')).toBe((lan + 168 + bo) / 2);
  // SM-1: the character page line names parents, partners and children; siblings are left to the tree.
  await select('Iris Hale-Zhou');
  await inspector().getByRole('button', { name: 'Open the character page' }).click();
  const rel = page.getByTestId('character-page').getByTestId('char-relatives');
  await expect(rel).toContainText('Parents: ');
  await expect(rel).toContainText('Zhou Lan');
  await expect(rel).not.toContainText('Kai Chen');
  await openTree();
});

// ---------- the character page, against the fixture novel ----------

async function openCharacter(name: string) {
  await rail(page, 'Characters').click();
  await page
    .getByTestId('entry-list')
    .getByRole('button', { name: new RegExp(`^${name}`) })
    .click();
  await expect(page.getByTestId('character-page')).toBeVisible();
  return page.getByTestId('character-page');
}

test('SM-1 the character page is the name and Chinese name, one line of dates, status, families and age, the relatives, and three text boxes, nothing else', async () => {
  await openBible(FIX);
  const p = await openCharacter('Iris Hale-Zhou');
  const heading = p.getByTestId('char-heading');
  await expect(heading.locator('.char-name')).toContainText('Iris Hale-Zhou');
  await expect(heading.getByTestId('char-chinese').locator('.zh-chars')).toHaveText('晓曦');
  // The page heading is the only name: the editor pane shows no title or kind above it.
  const editorPane = page.getByTestId('editor');
  await expect(editorPane.locator('#editor-title')).toHaveCount(0);
  await expect(editorPane.locator('.editor-head .eyebrow')).toHaveCount(0);
  await expect(editorPane.getByRole('heading', { name: /Iris Hale-Zhou/ })).toHaveCount(1);
  await expect(editorPane.getByTestId('autosave')).toBeVisible();
  // One line: birth, death, status, families, and the age (no story time yet: the current position).
  const line = p.getByTestId('char-line');
  for (const name of ['birth', 'death', 'status', 'familyIds']) {
    await expect(field(line, name), name).toBeVisible();
  }
  await expect(field(line, 'familyIds')).toContainText('Hale');
  await expect(field(line, 'familyIds')).toContainText('Zhou');
  await expect(p.getByTestId('char-age')).toHaveText('Age 9');
  // SM-1 "on one line": at the default window the five sit side by side, the age last.
  expect(
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getSize()),
  ).toEqual([1200, 800]);
  const lineBoxes = await Promise.all(
    [
      field(line, 'birth'),
      field(line, 'death'),
      field(line, 'status'),
      field(line, 'familyIds'),
      p.getByTestId('char-age'),
    ].map(async (l) => (await l.boundingBox())!),
  );
  const tops = lineBoxes.map((b) => b.y);
  expect(Math.max(...tops) - Math.min(...tops), `tops ${tops.join(', ')}`).toBeLessThanOrEqual(4);
  const lefts = lineBoxes.map((b) => b.x);
  expect(lefts).toEqual([...lefts].sort((a, b) => a - b));
  // Families are compact chips; the choice of a family to add shows only when Add family is pressed.
  const fam = field(line, 'familyIds');
  await expect(fam.locator('.chip')).toHaveText(['Hale×', 'Zhou×']);
  await expect(fam.getByLabel('Family to add')).toHaveCount(0);
  // The Characters screen is the list and the page: no inspector column beside it.
  await expect(page.locator('aside.ws-inspector')).toHaveCount(0);
  // Birth and Death are one field each (IP-1); Iris's birth is a full date, her death not recorded.
  await expect(field(line, 'birth').locator('.editable-text')).toHaveText('2031-03-14');
  await expect(field(line, 'death').locator('.editable-text.is-placeholder')).toHaveText(
    'Not recorded',
  );
  // A full date shows whole in its box when the field is open.
  await openEditable(field(line, 'birth'));
  expect(
    await field(line, 'birth')
      .locator('input')
      .evaluate((el) => el.scrollWidth - el.clientWidth),
  ).toBeLessThanOrEqual(0);
  await field(line, 'birth').locator('input').press('Escape');
  // IP-1: every value reads as text until it is picked: no box, no select.
  await expect(line.locator('select, input')).toHaveCount(0);
  // The relatives, read only: parents, partners with the union years, children.
  const rel = p.getByTestId('char-relatives');
  await expect(rel).toContainText('Parents: ');
  await expect(rel).toContainText('Daniel Hale');
  await expect(rel).toContainText('Zhou Lan');
  await expect(rel).toContainText('Partner: Tomas Reyes (partnered 2056 to 2064).');
  await expect(rel).toContainText('Child: Noor Zhou.');
  // Then three text boxes, and nothing else: no carets, no other field.
  const boxes = p.locator('.char-texts [role="textbox"]');
  await expect(boxes).toHaveCount(3);
  for (const label of ['In the story', 'Description', 'Backstory']) {
    await expect(p.getByLabel(label, { exact: true })).toBeVisible();
  }
  await expect(p.locator('details')).toHaveCount(0);
  const fields = await p
    .locator('[data-field]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-field')));
  expect(fields.filter((f) => !String(f).includes('.'))).toEqual([
    'birth',
    'death',
    'status',
    'familyIds',
    'role',
    'body',
    'backstory',
  ]);
  const margaret = await openCharacter('Margaret Hale');
  await expect(margaret.getByTestId('char-relatives')).toHaveText(
    'Partner: Peter Hale (married 1982 to 2030). Children: Daniel Hale, Ruth Hale.',
  );
});

test('SM-1 ED-2 each text box saves on its own and grows with its text', async () => {
  const p = await openCharacter('Ruth Hale');
  const box = (label: string) => p.getByLabel(label, { exact: true });
  const before = await box('Backstory').evaluate((el) => el.clientHeight);
  await box('In the story').fill('Ruth keeps the family letters.');
  await waitSaved(page);
  await box('Description').fill('A nurse in Portland.');
  await waitSaved(page);
  await box('Backstory').fill('One.\nTwo.\nThree.\nFour.\nFive.\nSix.\nSeven.\nEight.');
  await waitSaved(page);
  const after = await box('Backstory').evaluate((el) => el.clientHeight);
  expect(after).toBeGreaterThan(before);
  // The box shows all its text: nothing scrolls inside it.
  expect(
    await box('Backstory').evaluate((el) => el.scrollHeight - el.clientHeight),
  ).toBeLessThanOrEqual(2);
  const ruth = (await invoke('entry.get', { collection: 'characters', id: 'H4' })).entry;
  expect(ruth).toMatchObject({
    role: 'Ruth keeps the family letters.',
    body: 'A nurse in Portland.',
    // A44: each line filled in is a paragraph of the rich text box.
    backstory: 'One.\n\nTwo.\n\nThree.\n\nFour.\n\nFive.\n\nSix.\n\nSeven.\n\nEight.',
  });
});

test('SM-1 TL-3 Birth is one box: a month and a full date save on Enter as one undo step, and a bad value writes nothing', async () => {
  const p = await openCharacter('Ruth Hale');
  // IP-1: Birth reads as text and opens as one box.
  const f = field(p, 'birth');
  const shown = f.locator('.editable-text');
  const birth = f.getByRole('textbox', { name: 'Birth', exact: true });
  const ruth = async () =>
    (await invoke('entry.get', { collection: 'characters', id: 'H4' })).entry;
  await expect(shown).toHaveText('1990');
  await shown.click();
  await expect(birth).toHaveValue('1990');
  await birth.fill('1990-3');
  await birth.press('Enter');
  await expect(birth).toHaveCount(0);
  await expect(shown).toHaveText('1990-03');
  expect((await ruth()).birth).toEqual({ year: 1990, month: 3 });
  const history = (await changes(page)).locator('li');
  await expect(history.first()).toHaveText('Changed Birth on Ruth Hale');
  await page.keyboard.press('Escape');
  // A value it cannot read is refused at the box, and nothing is written.
  await shown.click();
  await birth.fill('March 1990');
  await birth.press('Enter');
  await expect(f.getByRole('alert')).toHaveText(
    'Not saved: March 1990 is not a date. Write a year (1990), a year and month (1990-03), or a full date (1990-03-14).',
  );
  expect((await ruth()).birth).toEqual({ year: 1990, month: 3 });
  await birth.fill('1990-03-14');
  await birth.blur();
  await expect(birth).toHaveCount(0);
  await expect(f.getByRole('alert')).toHaveCount(0);
  expect((await ruth()).birth).toEqual({ year: 1990, month: 3, day: 14 });
  // One commit is one undo step.
  await page.locator('body').click();
  await page.keyboard.press('Meta+z');
  await expect.poll(async () => (await ruth()).birth).toEqual({ year: 1990, month: 3 });
  await expect(shown).toHaveText('1990-03');
  await page.keyboard.press('Meta+z');
  await expect.poll(async () => (await ruth()).birth).toEqual({ year: 1990 });
});

test('SM-1 IP-1 the name and the Chinese name are fields in the heading, and the title follows the name', async () => {
  const p = await openCharacter('Sam Hale');
  await fillEditable(field(p, 'names.full'), 'Samuel Hale');
  await fillEditable(field(p, 'names.chinese'), '山');
  await expect(p.getByTestId('char-heading').locator('.char-name')).toContainText('Samuel Hale');
  await expect(p.getByTestId('char-chinese').locator('.zh-chars')).toHaveText('山');
  const sam = (await invoke('entry.get', { collection: 'characters', id: 'H6' })).entry;
  expect(sam).toMatchObject({
    title: 'Samuel Hale',
    names: { full: 'Samuel Hale', chinese: '山' },
  });
  await fillEditable(field(p, 'names.full'), 'Sam Hale');
  await fillEditable(field(p, 'names.chinese'), '');
  await expect(p.getByTestId('char-chinese').locator('.editable-text.is-placeholder')).toHaveText(
    'Add a Chinese name',
  );
});

test('SM-1 FT-7 the relatives line opens the family tree on that person', async () => {
  const p = await openCharacter('Ruth Hale');
  await p.getByTestId('char-relatives').click();
  await expect(page.getByTestId('tree-view')).toBeVisible();
  await expect(page.getByTestId('tree-inspector').getByTestId('inspector-name')).toHaveText(
    'Ruth Hale',
  );
});

test('SM-1 GL-3 a Chinese name shows as characters, with romanization and meaning on hover and on keyboard focus', async () => {
  const p = await openCharacter('Iris Hale-Zhou');
  const run = p.locator('.char-name').getByTestId('zh').first();
  await expect(run.locator('.zh-chars')).toHaveText('晓曦');
  const tip = run.getByRole('tooltip');
  await expect(tip).toBeHidden();
  await run.hover();
  await expect(tip).toBeVisible();
  await expect(tip).toHaveText('xiǎoxī: dawn light');
  await page.mouse.move(0, 0);
  await expect(tip).toBeHidden();
  await run.focus();
  await expect(tip).toBeVisible();
  const z1 = await openCharacter('Zhou Meiling');
  await expect(z1.getByTestId('char-chinese').getByTestId('zh').locator('.zh-tip')).toHaveText(
    'Zhōu Měilíng: Zhou Meiling, a personal name',
  );
});

test('CH-4 a character with an unknown birth year is reported as age unknown on the page and in the tree', async () => {
  const p = await openCharacter('The Archivist');
  // A blank Birth is an unknown birth.
  await expect(field(p, 'birth').locator('.editable-text.is-placeholder')).toHaveText('Unknown');
  await expect(p.getByTestId('char-age')).toHaveText('Unknown age');
  await openTree();
  for (const y of ['1900', '2040', '2100']) {
    await setStoryYear(page, y);
    await expect(byId('U1').getByTestId('node-state')).toHaveText('age unknown');
  }
});

test('CH-3 SM-1 the story time drives the age on character pages', async () => {
  await openTree();
  await setStoryYear(page, 2041);
  await expect.poll(async () => (await invoke('storyTime.get', {})).time?.year).toBe(2041);
  const p = await openCharacter('Margaret Hale');
  await expect(p.getByTestId('char-age')).toHaveText('Dies this year, age 83');
  const noor = await openCharacter('Noor Zhou');
  await expect(noor.getByTestId('char-age')).toHaveText('Not yet born (2058)');
  await expect(byId('H1')).toHaveCount(0);
  await openTree();
  await expect(byId('H1')).toHaveAttribute('data-state', 'dying');
  await setStoryYear(page, 2075);
  await openCharacter('Margaret Hale');
  await expect(page.getByTestId('char-age')).toHaveText('Dead since 2041');
  await openCharacter('Noor Zhou');
  await expect(page.getByTestId('char-age')).toHaveText('Age 17');
});

test('CH-1 SM-1 a character is created from the full name, edited with zero, one, and several families, and deleted and restored', async () => {
  await rail(page, 'Characters').click();
  await page.getByRole('button', { name: 'New character', exact: true }).click();
  const form = page.getByTestId('new-entry');
  // SM-1: the form asks for the full name only.
  await expect(form.locator('input, select, textarea')).toHaveCount(1);
  await field(form, 'names.full').locator('input').fill('Ada Lin');
  await form.getByRole('button', { name: 'Create character' }).click();
  const page_ = page.getByTestId('character-page');
  await expect(page_.getByTestId('char-heading').locator('.char-name')).toContainText('Ada Lin');
  const ed = page.getByTestId('editor');
  await waitSaved(page);
  const ada = async () =>
    (await invoke('entry.list', { collection: 'characters', trash: 'exclude' })).entries.find(
      (e) => e.entry.title === 'Ada Lin',
    )!.entry;
  expect(await ada()).toMatchObject({ status: 'idea', familyIds: [], birth: { unknown: true } });
  // IP-1: the families are a chip row; Add family turns into a picker in its place.
  const fam = field(ed, 'familyIds');
  const families = async () => (await ada()).familyIds;
  await fam.getByRole('button', { name: 'Add family' }).click();
  await fam.locator('[role="option"][data-value="FAM-ZHOU"]').click();
  await expect.poll(families).toEqual(['FAM-ZHOU']);
  await expect(fam.getByLabel('Family to add')).toHaveCount(0);
  // NF-2: Add family from the keyboard: Enter shows the picker, Enter picks, Escape puts it away.
  await fam.getByRole('button', { name: 'Add family' }).focus();
  await page.keyboard.press('Enter');
  await expect(fam.getByLabel('Family to add')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(fam.getByLabel('Family to add')).toHaveCount(0);
  await expect(fam.getByRole('button', { name: 'Add family' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(fam.getByRole('option')).toHaveText(['Hale', 'Add new...']);
  await page.keyboard.press('Enter');
  await expect.poll(families).toEqual(['FAM-ZHOU', 'FAM-HALE']);
  // Every family is on the chips; the picker offers only Add new.
  await fam.getByRole('button', { name: 'Add family' }).click();
  await expect(fam.getByRole('option')).toHaveText(['Add new...']);
  await page.keyboard.press('Escape');
  await fam.getByRole('button', { name: 'Remove Hale from Families' }).click();
  await expect.poll(families).toEqual(['FAM-ZHOU']);
  await fam.getByRole('button', { name: 'Add family' }).click();
  await fam.locator('[role="option"][data-value="FAM-HALE"]').click();
  await expect.poll(families).toEqual(['FAM-ZHOU', 'FAM-HALE']);
  await fillDateBox(field(ed, 'birth'), '2040');
  await openEditable(field(ed, 'status'));
  await field(ed, 'status').locator('select').selectOption('planned');
  await expect.poll(ada).toMatchObject({ birth: { year: 2040 }, status: 'planned' });
  // Delete and restore through the trash.
  await page.getByTestId('entry-tools').getByRole('button', { name: 'Move to trash' }).click();
  await page
    .getByRole('dialog', { name: 'Move to trash' })
    .getByRole('button', { name: 'Move to trash' })
    .click();
  await expect(
    page.getByTestId('entry-list').getByRole('button', { name: /^Ada Lin/ }),
  ).toHaveCount(0);
  await page.getByTestId('entry-tools').getByRole('button', { name: 'Restore from trash' }).click();
  await expect(
    page.getByTestId('entry-list').getByRole('button', { name: /^Ada Lin/ }),
  ).toHaveCount(1);
});

// ---------- performance: 200 people across six generations ----------

test('FT-8 a tree of 200 people across six generations redraws in under 500 ms in the renderer', async () => {
  test.setTimeout(180_000);
  await invoke('bible.create', { slug: 'tree-perf', name: 'Two hundred people' });
  await openBible('tree-perf');
  const { characters, unions, parentLinks } = generatedTree(200, 6);
  await seedFixture(invoke, [
    ...characters.map((d) => ({ collection: 'characters' as const, data: strip(d) })),
    ...unions.map((d) => ({ collection: 'unions' as const, data: strip(d) })),
    ...parentLinks.map((d) => ({ collection: 'parentLinks' as const, data: strip(d) })),
  ]);
  await openTree();
  await expect(page.locator('g.tnode')).toHaveCount(200);
  const timings: number[] = [];
  for (const year of [1950, 2000, 2030, 2060, 2080]) {
    const ms = await page.evaluate(
      (y) =>
        new Promise<number>((resolve) => {
          // A45: the tree has no year box; the top bar's year box commits on Enter the same way.
          const input = document.querySelector<HTMLInputElement>('[data-testid="top-year"]')!;
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
          const start = performance.now();
          setter.call(input, String(y));
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
          const check = () => {
            const svg = document.querySelector('[data-testid="tree-svg"]')!;
            if (svg.getAttribute('data-year') === String(y)) {
              // Two frames: the browser has laid out and painted the new tree.
              requestAnimationFrame(() =>
                requestAnimationFrame(() => resolve(performance.now() - start)),
              );
            } else requestAnimationFrame(check);
          };
          check();
        }),
      year,
    );
    timings.push(ms);
  }
  // Every node shows the new year's state.
  const states = await page
    .locator('g.tnode')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-state')));
  expect(states.filter((s) => s === 'alive').length).toBeGreaterThan(0);
  for (const ms of timings) expect(ms).toBeLessThan(500);
  // Filtering and collapsing redraw as fast.
  const collapse = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const n = document.querySelector('g.tnode[data-person="P000"]')!;
        const start = performance.now();
        n.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        const check = () => {
          if (document.querySelectorAll('g.tnode').length < 200) {
            requestAnimationFrame(() =>
              requestAnimationFrame(() => resolve(performance.now() - start)),
            );
          } else requestAnimationFrame(check);
        };
        check();
      }),
  );
  expect(collapse).toBeLessThan(500);
});

test('GL-3 a tree node with a Chinese name shows a visible card with the meaning on keyboard focus and on hover', async () => {
  await openBible(FIX);
  await openTree();
  const iris = byId('H5');
  const card = page.getByTestId('tree-card');
  await expect(card).toHaveCount(0);
  await iris.focus();
  await expect(card).toBeVisible();
  await expect(card).toHaveText('晓曦 xiǎoxī: dawn light');
  await iris.blur();
  await expect(card).toHaveCount(0);
  // A name with Chinese but no glossary term says so.
  const meiling = byId('Z4');
  await meiling.focus();
  await expect(card).toHaveText('周军: not in the glossary yet');
  // A person with no Chinese name shows no card.
  await byId('H1').focus();
  await expect(card).toHaveCount(0);
  await byId('H1').blur();
  await iris.hover();
  await expect(card).toHaveText('晓曦 xiǎoxī: dawn light');
});

test('IP-12 IP-14 the legend renames a family in place and recolours it with any hex, the tree redraws, and the link labels come from the templates', async () => {
  await openBible(FIX);
  await openTree();
  const hale = fixture.families!.find((f) => f.name === 'Hale')!;
  const id = String(hale._id);
  const family = async () => (await invoke('entry.get', { collection: 'families', id })).entry;
  await invoke('settings.set', { templates: { linkTypeLabels: { married: 'Wed' } } });
  await page.getByRole('button', { name: 'Legend', exact: true }).click();
  const legend = page.getByRole('region', { name: 'Tree legend' });
  await expect(legend).toContainText('Wed');
  const row = legend.locator(`[data-family-id="${id}"]`);
  const stripe = node('Sam Hale').locator('rect.tnode-fam');
  await expect(stripe).toHaveAttribute('data-family', 'series-1');

  // Any hex, not only the four series colours, and the node draws it.
  await row.getByTestId('legend-colour').fill('#c03a8e');
  await expect.poll(async () => (await family()).color).toBe('#c03a8e');
  await expect(stripe).toHaveAttribute('data-family', '#c03a8e');
  expect(await stripe.evaluate((el) => getComputedStyle(el).fill)).toBe('rgb(192, 58, 142)');

  // The name renames in place, by keyboard: Enter opens it, Enter saves.
  const name = row.getByTestId('legend-family-name-text');
  await name.focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Meta+a');
  await page.keyboard.type('Hale-Ashby');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await family()).name).toBe('Hale-Ashby');
  await expect(name).toHaveText('Hale-Ashby');
  await expect(name).toBeFocused();

  // Each was one step.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Meta+z');
  await expect.poll(async () => (await family()).name).toBe('Hale');
  await page.keyboard.press('Meta+z');
  await expect.poll(async () => (await family()).color).toBe('#2a78d6');
  await expect(stripe).toHaveAttribute('data-family', 'series-1');
  await page.getByRole('button', { name: 'Hide legend' }).click();
  await invoke('settings.set', { templates: { linkTypeLabels: { married: 'Married' } } });
});
