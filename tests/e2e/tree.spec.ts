import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { MongoClient } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { assembleGraph, buildGraph, generations, layoutTree } from '../../src/shared/domain/tree';
import type { TreeGraph } from '../../src/shared/domain/tree';
import type { Invoke } from '../helpers/t5';
import { readFixture } from '../helpers/loadFixture';
import { generatedTree } from '../helpers/generatedTree';
import { decodePng, pdfFillColors } from '../helpers/png';
import { field, invokeVia, launch, rail, waitSaved } from './helpers';

let server: MongoMemoryReplSet;
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
  server = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  ({ app, page } = await launch(server.getUri()));
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
  await invoke('entry.createMany', {
    items: fixture.families!.map((f) => ({ collection: 'families', data: strip(f) })),
  });
});

test.afterAll(async () => {
  await app?.close();
  await server?.stop();
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
    await inv('entry.createMany', {
      items: fixture[c]!.map((d) => ({ collection: c as never, data: strip(d) })),
    });
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
  await inspector()
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

async function setYearDate(path: 'birth' | 'death', year: number) {
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
  // Link the existing Zhou Wei as Zhou Lan's other parent.
  await select('Zhou Lan');
  const linkForm = inspector().getByRole('form', { name: 'Link someone already in the tree' });
  await linkForm.getByLabel(/They are/).selectOption('parent');
  await linkForm.getByLabel('Person', { exact: true }).selectOption({ label: 'Zhou Wei' });
  await linkForm.getByLabel('Link type').selectOption('biological');
  await linkForm.getByRole('button', { name: 'Link', exact: true }).click();
  await expect(linkForm.getByTestId('link-message')).toHaveText(/^Linked\./);
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

test('FT-5 the year control redraws every node for 2040, 2041, and 2075 as in the TL-2 answers, and marks unions', async () => {
  const yearInput = page.getByTestId('tree-year');
  for (const y of tl2.years) {
    await yearInput.fill(String(y.year));
    await yearInput.press('Enter');
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
  await yearInput.fill('2040');
  await yearInput.press('Enter');
  await expect(page.locator('g[data-union][data-state="ended"]')).toHaveCount(1);
  await expect(page.locator('g[data-union][data-state="future"]')).toHaveCount(1);
  await page.getByLabel('Year slider').fill('2060');
  await expect(svgEl()).toHaveAttribute('data-year', '2060');
  await expect(page.locator('g[data-union][data-state="future"]')).toHaveCount(0);
  await expect(page.locator('g[data-union][data-state="active"]')).toHaveCount(3);
  // The year control is bound to the story time, which persists.
  await expect.poll(async () => (await invoke('storyTime.get', {})).time?.year).toBe(2060);
  await yearInput.fill('2040');
  await yearInput.press('Enter');
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
  await expect(page.getByTestId('character-page').getByTestId('char-years')).toHaveText(
    '1995 to 2070',
  );
  // An edit on the character page shows in the tree.
  await field(page.getByTestId('editor'), 'birth').getByLabel('Year', { exact: true }).fill('1993');
  await waitSaved(page);
  await openTree();
  await expect(node('Zhou Jun').locator('text.tnode-years')).toHaveText('1993 to 2070');
  await expect(node('Zhou Jun')).toHaveAttribute('data-age', '47');
});

test('FT-2 change a link type, remove a link and undo it, and delete and restore a person through the trash', async () => {
  await select('Sam Hale');
  const row = inspector().getByTestId('link-list').locator('li', { hasText: 'Ruth Hale' });
  await row.getByRole('combobox').selectOption('guardian');
  await expect(page.locator('path.tlink.guardian')).toHaveCount(1);
  await expect(page.locator('path.tlink.adoptive')).toHaveCount(0);
  await row.getByRole('combobox').selectOption('adoptive');
  await expect(page.locator('path.tlink.adoptive')).toHaveCount(1);
  // Change a union type.
  await select('Iris Hale-Zhou');
  const urow = inspector()
    .getByTestId('link-list')
    .locator('li', { hasText: 'Partner: Tomas Reyes' });
  await urow.getByRole('combobox').selectOption('married');
  await expect(page.locator('path.tunion.married')).toHaveCount(3);
  await urow.getByRole('combobox').selectOption('partnered');
  await expect(page.locator('path.tunion.partnered')).toHaveCount(2);
  // Remove Sam's only parent link: Sam now has no known parent. Undo brings it back.
  await select('Sam Hale');
  await inspector().getByRole('button', { name: 'Remove the link with Ruth Hale' }).click();
  await expect(page.locator('path.tlink.adoptive')).toHaveCount(0);
  await expect(inspector().getByTestId('link-list')).toHaveCount(0);
  await page.locator('body').click({ position: { x: 2, y: 2 } });
  await page.keyboard.press('Meta+z');
  await expect(page.locator('path.tlink.adoptive')).toHaveCount(1);

  // Delete a person through the ED-5 flow: the links are listed, then it goes to the trash.
  await select('Noor Zhou');
  await inspector().getByRole('button', { name: 'Move to trash' }).click();
  const dialog = inspector().getByRole('dialog', { name: 'Move to trash' });
  await expect(dialog.getByTestId('linked-count')).toHaveText(/2 entries link here/);
  await dialog.getByRole('button', { name: 'Move to trash' }).click();
  await expect(node('Noor Zhou')).toHaveCount(0);
  const raw = await new MongoClient(server.getUri()).connect();
  try {
    const stored = await raw
      .db('novel_companion')
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

test('FT-6 warnings show beside the tree and never block; a person cannot become their own ancestor', async () => {
  await select('Noor Zhou');
  await setYearDate('birth', 2040);
  const warnings = page.getByTestId('tree-warnings');
  await expect(warnings).toContainText(
    'Iris Hale-Zhou would be 9 when Noor Zhou is born, under 12.',
  );
  await expect(warnings).toContainText('Tomas Reyes would be 10 when Noor Zhou is born, under 12.');
  // It saved anyway.
  const t = await invoke('tree.get', {});
  expect(t.people.find((p) => p.name === 'Noor Zhou')!.birth).toEqual({ year: 2040 });
  await setYearDate('birth', 2058);
  await expect(page.getByTestId('no-tree-warnings')).toBeVisible();

  // Self-ancestry is refused in plain words, and nothing is written.
  await select('Iris Hale-Zhou');
  const before = (await invoke('tree.get', {})).links.length;
  const form = inspector().getByRole('form', { name: 'Link someone already in the tree' });
  await form.getByLabel(/They are/).selectOption('child');
  await form.getByLabel('Person', { exact: true }).selectOption({ label: 'Margaret Hale' });
  await form.getByRole('button', { name: 'Link', exact: true }).click();
  await expect(form.getByRole('alert')).toHaveText(
    'This link was not made: Margaret Hale is already an ancestor of Iris Hale-Zhou, so it would make someone their own ancestor.',
  );
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

test('FT-1 one tree for every family, a filter to one family, and to the ancestors and descendants of one person', async () => {
  const shownNames = async () =>
    (
      await page
        .locator('g.tnode')
        .evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')!.split(',')[0]))
    ).sort();
  const show = page.getByLabel('Show');
  await show.selectOption({ label: 'All families' });
  await expect(page.locator('g.tnode')).toHaveCount(13);
  await show.selectOption({ label: 'Zhou only' });
  await expect(page.locator('g.tnode')).toHaveCount(6);
  expect(await shownNames()).toEqual([
    'Iris Hale-Zhou',
    'Noor Zhou',
    'Zhou Jun',
    'Zhou Lan',
    'Zhou Meiling',
    'Zhou Wei',
  ]);
  await show.selectOption({ label: 'Hale only' });
  expect(await shownNames()).toEqual([
    'Daniel Hale',
    'Iris Hale-Zhou',
    'Margaret Hale',
    'Peter Hale',
    'Ruth Hale',
    'Sam Hale',
  ]);
  await show.selectOption({ label: 'Ancestors and descendants of a person' });
  await page
    .getByLabel('Person', { exact: true })
    .first()
    .selectOption({ label: 'Iris Hale-Zhou' });
  await expect(page.locator('g.tnode')).toHaveCount(9);
  expect(await shownNames()).toEqual([
    'Daniel Hale',
    'Iris Hale-Zhou',
    'Margaret Hale',
    'Noor Zhou',
    'Peter Hale',
    'Tomas Reyes',
    'Zhou Lan',
    'Zhou Meiling',
    'Zhou Wei',
  ]);
  await show.selectOption({ label: 'All families' });
  await expect(page.locator('g.tnode')).toHaveCount(13);
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

test('TM-3 the tree year box sets the story year on Enter or blur, not on every keystroke', async () => {
  const box = page.getByTestId('tree-year');
  await box.fill('');
  await box.pressSequentially('2041', { delay: 20 });
  // Typed but not committed: the tree and the story year are still where they were.
  await expect(svgEl()).not.toHaveAttribute('data-year', '2041');
  await expect(svgEl()).not.toHaveAttribute('data-year', '2');
  await expect(svgEl()).not.toHaveAttribute('data-year', '204');
  expect((await invoke('storyTime.get', {})).time?.year).not.toBe(204);
  await box.press('Enter');
  await expect(svgEl()).toHaveAttribute('data-year', '2041');
  await box.fill('2042');
  await expect(svgEl()).toHaveAttribute('data-year', '2041');
  await box.blur();
  await expect(svgEl()).toHaveAttribute('data-year', '2042');
  await box.fill('2045');
  await box.press('Enter');
  await expect(svgEl()).toHaveAttribute('data-year', '2045');
});

test('FT-8 A26 the tree fills the panel height, Full screen sets document.fullscreenElement, Escape leaves it, and every permission but full screen is refused', async () => {
  const sizes = () =>
    page.evaluate(() => {
      const main = document.querySelector<HTMLElement>('.tree-main')!;
      const stage = document.querySelector<HTMLElement>('.tree-stage')!;
      const pad = getComputedStyle(main);
      const chrome = parseFloat(getComputedStyle(main).getPropertyValue('--ws-chrome'));
      return {
        stage: stage.getBoundingClientRect().height,
        inner: window.innerHeight,
        chrome,
        padding: parseFloat(pad.paddingTop) + parseFloat(pad.paddingBottom),
        main: main.getBoundingClientRect().height,
      };
    });
  const z = await sizes();
  // The panel is the window minus the chrome; the stage is that, less the panel's own padding.
  expect(Math.abs(z.main - (z.inner - z.chrome))).toBeLessThanOrEqual(2);
  expect(Math.abs(z.stage - (z.main - z.padding))).toBeLessThanOrEqual(2);

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

test('FT-9 the tree exports as a PNG image and as a PDF through a save dialog', async () => {
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
  const png = join(dir, 'tree.png');
  await stubDialog(png);
  await page.getByRole('button', { name: 'Export PNG' }).click();
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
  const pdf = join(dir, 'tree.pdf');
  await stubDialog(pdf);
  await page.getByRole('button', { name: 'Export PDF' }).click();
  await expect(page.getByTestId('export-note')).toHaveText(`Saved ${pdf}.`);
  const head = (await readFile(pdf)).subarray(0, 5).toString('latin1');
  expect(head).toBe('%PDF-');
  expect((await stat(pdf)).size).toBeGreaterThan(5_000);
  // The PDF paints with the light theme: light node boxes, never the dark surfaces.
  const fills = pdfFillColors(await readFile(pdf)).map((c) => c.join(','));
  expect(fills).toContain('255,255,255');
  expect(fills).not.toContain('23,31,40');
  expect(fills).not.toContain('26,26,25');
  await page.emulateMedia({ colorScheme: 'light' });
  // Cancelling saves nothing.
  await app.evaluate(({ dialog }) => {
    (dialog as unknown as { showSaveDialog: () => Promise<unknown> }).showSaveDialog =
      async () => ({
        canceled: true,
        filePath: '',
      });
  });
  await page.getByRole('button', { name: 'Export PDF' }).click();
  await expect(page.getByTestId('export-note')).toHaveText('Export cancelled. Nothing was saved.');
});

test('ED-3 after a save lands in one field, Cmd+Z in another field with unsaved typing undoes that typing', async () => {
  await select('Ruth Hale');
  const history = inspector().getByTestId('undo-history').locator('li');
  const place = field(editor(), 'birthplace').locator('input');
  await place.fill('Astoria, Oregon');
  // Straight into another field before the save of the first one lands.
  await inspector().getByRole('button', { name: 'Add person' }).click();
  const name = inspector().getByTestId('add-form').getByLabel('Name');
  await name.pressSequentially('Typed name');
  await waitSaved(page);
  await expect(history.first()).toHaveText('Changed Birthplace on Ruth Hale');
  const before = await history.allTextContents();
  await expect(name).toBeFocused();
  await page.keyboard.press('Meta+z');
  await expect(name).not.toHaveValue('Typed name');
  // The saved change in the first field is untouched.
  expect(await history.allTextContents()).toEqual(before);
  const t = await invoke('tree.get', {});
  const ruth = t.people.find((p) => p.name === 'Ruth Hale')!;
  expect(
    (await invoke('entry.get', { collection: 'characters', id: ruth.id })).entry.birthplace,
  ).toBe('Astoria, Oregon');
  await inspector().getByTestId('add-form').getByRole('button', { name: 'Cancel' }).click();
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

test('FT-4 a person with two unions: both draw, the ended one with its year, each child under its own union, and half-siblings', async () => {
  await select('Zhou Lan');
  await add('partner', 'Chen Bo', 1986, { type: 'married' });
  await editLink('Zhou Lan', { startYear: 2008, endYear: 2020, endReason: 'divorce' });
  await select('Zhou Lan');
  await add('child', 'Kai Chen', 2012, { type: 'biological', coParent: 'Chen Bo' });
  await page.getByTestId('tree-year').fill('2040');
  await page.getByTestId('tree-year').press('Enter');
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
  // The character page shows them as half-siblings.
  await select('Iris Hale-Zhou');
  await inspector().getByRole('button', { name: 'Open the character page' }).click();
  await expect(page.getByTestId('character-page').getByTestId('relatives')).toContainText(
    'Kai Chen (half-sibling)',
  );
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

test('CH-2 CH-3 the character page shows every name, the age at the current position, relatives, a personal timeline, and what they know', async () => {
  await openBible(FIX);
  const p = await openCharacter('Margaret Hale');
  // No story time is set: the age is at the last written chapter, chapter 5 in 2040.
  await expect(p.getByTestId('char-age')).toHaveText(
    'Age at current position (Chapter 5, year 2040): 82',
  );
  const names = p.getByTestId('char-names');
  for (const text of ['Margaret Hale', 'Margaret Doyle', 'Family name last', 'Maggie']) {
    await expect(names).toContainText(text);
  }
  await expect(p.getByTestId('called-by')).toHaveText('Iris Hale-Zhou calls them Gran');
  await expect(p.getByTestId('char-families')).toHaveText('Hale');
  const rel = p.getByTestId('relatives');
  await expect(rel).toContainText('Peter Hale (married, 1982 to 2030, death)');
  await expect(rel).toContainText('Daniel Hale (biological), Ruth Hale (biological)');
  const rows = p.getByTestId('char-timeline').locator('tbody tr');
  await expect(rows.first()).toContainText('1958');
  await expect(rows.last()).toContainText('Dies');
  const event = rows.filter({ hasText: 'Pacific Rim trade accord signed' });
  await expect(event.locator('td').nth(0)).toHaveText('2036');
  await expect(event.locator('td').nth(1)).toHaveText('78');
  await expect(event.locator('td').nth(3)).toHaveText('World event');
  await expect(
    rows
      .filter({ hasText: /^.*Chapter 5/ })
      .locator('td')
      .nth(1),
  ).toHaveText('82');
  // Nothing after her death is in her timeline.
  await expect(rows.filter({ hasText: 'Arctic summer sea ice' })).toHaveCount(0);

  const ruth = await openCharacter('Ruth Hale');
  // Ruth learns the letter in 2041, so at 2040 it is a fact she does not know yet.
  await expect(ruth.getByTestId('knowledge-empty')).toBeVisible();
  const ruthMissing = ruth.getByTestId('does-not-know');
  await expect(ruthMissing).toContainText("Peter's letter");
  await expect(ruthMissing).toContainText('not yet in 2040');
  await expect(ruthMissing).toContainText('They learn it in 2041.');
  await expect(ruthMissing).toContainText('Meiling was engaged before Wei');
  await expect(ruth.getByTestId('relatives')).toContainText('Sam Hale (adoptive)');
  const sam = await openCharacter('Sam Hale');
  await expect(sam.getByTestId('relatives')).toContainText('Ruth Hale (adoptive from 2015)');
  const iris = await openCharacter('Iris Hale-Zhou');
  await expect(iris.getByTestId('relatives')).toContainText(
    'Tomas Reyes (partnered, 2056 to 2064, separated)',
  );
  await expect(iris.getByTestId('char-families')).toHaveText('HaleZhou');
});

test('CH-2 a Chinese name shows as characters, with romanization and meaning on hover and on keyboard focus', async () => {
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
  await expect(z1.getByTestId('char-names')).toContainText('Family name first');
  await expect(z1.getByTestId('char-names').getByTestId('zh').locator('.zh-tip')).toHaveText(
    'Zhōu Měilíng: Zhou Meiling, a personal name',
  );
});

test('CH-4 a character with an unknown birth year is reported as age unknown on the page and in the tree', async () => {
  const p = await openCharacter('The Archivist');
  await expect(p.getByTestId('char-years')).toHaveText('Born: unknown');
  await expect(p.getByTestId('char-age')).toHaveText(
    'Age at current position (Chapter 5, year 2040): age unknown',
  );
  const rows = p.getByTestId('char-timeline').locator('tbody tr');
  await expect(rows.first().locator('td').nth(1)).toHaveText('age unknown');
  await openTree();
  for (const y of ['1900', '2040', '2100']) {
    await page.getByTestId('tree-year').fill(y);
    await page.getByTestId('tree-year').press('Enter');
    await expect(byId('U1').getByTestId('node-state')).toHaveText('age unknown');
  }
});

test('CH-3 the story time drives the ages on character pages', async () => {
  await openTree();
  await page.getByTestId('tree-year').fill('2041');
  await page.getByTestId('tree-year').press('Enter');
  await expect.poll(async () => (await invoke('storyTime.get', {})).time?.year).toBe(2041);
  const p = await openCharacter('Margaret Hale');
  // Both ages: at the current position (the last written chapter) and at the story time.
  await expect(p.getByTestId('char-age')).toHaveText(
    'Age at current position (Chapter 5, year 2040): 82',
  );
  await expect(p.getByTestId('char-age-story')).toHaveText(
    'Age at story time (year 2041): 83, dies this year',
  );
  await expect(byId('H1')).toHaveCount(0);
  await openTree();
  await expect(byId('H1')).toHaveAttribute('data-state', 'dying');
  await page.getByTestId('tree-year').fill('2075');
  await page.getByTestId('tree-year').press('Enter');
  await openCharacter('Margaret Hale');
  await expect(page.getByTestId('char-age-story')).toHaveText(
    'Age at story time (year 2075): dead since 2041',
  );
  await expect(page.getByTestId('char-age')).toHaveText(
    'Age at current position (Chapter 5, year 2040): 82',
  );
  // A timeline row after death reads dead: Peter Hale in chapter 4, set in 2032.
  const peter = await openCharacter('Peter Hale');
  const row = peter.getByTestId('char-timeline').locator('tbody tr', { hasText: 'Chapter 4' });
  await expect(row.locator('td').nth(0)).toHaveText('2032');
  await expect(row.locator('td').nth(1)).toHaveText('dead');
});

test('CH-1 a character is created, edited with zero, one, and several families, and deleted and restored', async () => {
  await rail(page, 'Characters').click();
  await page.getByRole('button', { name: 'New character', exact: true }).click();
  const form = page.getByTestId('new-entry');
  await field(form, 'title').locator('input').fill('Ada Lin');
  await field(form, 'status').locator('select').selectOption('idea');
  await field(form, 'names.full').locator('input').fill('Ada Lin');
  await field(form, 'birth').getByLabel('Kind of date').selectOption('year');
  await field(form, 'birth').getByLabel('Year', { exact: true }).fill('2040');
  await form.getByRole('button', { name: 'Create character' }).click();
  const page_ = page.getByTestId('character-page');
  await expect(page_.getByTestId('char-families')).toHaveText('No family');
  const ed = page.getByTestId('editor');
  await field(ed, 'familyIds').locator(':scope > select').selectOption('FAM-ZHOU');
  await waitSaved(page);
  await expect(page_.getByTestId('char-families')).toHaveText('Zhou');
  await field(ed, 'familyIds').locator(':scope > select').selectOption('FAM-HALE');
  await waitSaved(page);
  await expect(page_.getByTestId('char-families')).toHaveText('ZhouHale');
  await field(ed, 'names').locator('[data-field="names.chinese"] input').fill('林');
  await waitSaved(page);
  await expect(page_.locator('.char-name')).toContainText('林');
  // Delete and restore through the trash.
  await page.getByTestId('inspector').getByRole('button', { name: 'Move to trash' }).click();
  await page
    .getByRole('dialog', { name: 'Move to trash' })
    .getByRole('button', { name: 'Move to trash' })
    .click();
  await expect(
    page.getByTestId('entry-list').getByRole('button', { name: /^Ada Lin/ }),
  ).toHaveCount(0);
  await page.getByTestId('inspector').getByRole('button', { name: 'Restore from trash' }).click();
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
  await invoke('entry.createMany', {
    items: [
      ...characters.map((d) => ({ collection: 'characters' as const, data: strip(d) })),
      ...unions.map((d) => ({ collection: 'unions' as const, data: strip(d) })),
      ...parentLinks.map((d) => ({ collection: 'parentLinks' as const, data: strip(d) })),
    ],
  });
  await openTree();
  await expect(page.locator('g.tnode')).toHaveCount(200);
  const timings: number[] = [];
  for (const year of [1950, 2000, 2030, 2060, 2080]) {
    const ms = await page.evaluate(
      (y) =>
        new Promise<number>((resolve) => {
          const input = document.querySelector<HTMLInputElement>('[data-testid="tree-year"]')!;
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
