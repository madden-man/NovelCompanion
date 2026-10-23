import { expect, test } from '@playwright/test';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { connect } from '../../src/main/db';
import { READ_ONLY_REASON } from '../../src/shared/ipcApp';
import { loadFixture } from '../helpers/loadFixture';
import type { Invoke } from '../helpers/t5';
import { changes, connectTo, field, fileDb, invokeVia, launch, rail } from './helpers';
import type { TestDb } from './helpers';

/**
 * IP-1: the one editing primitive, on the Characters page (the proof) and on
 * the gallery of every kind (`#editable-gallery`), against the fixture novel.
 */

let db: TestDb;
let app: ElectronApplication;
let page: Page;
let invoke: Invoke;

const SLUG = 'editable';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  db = fileDb();
  const store = await connectTo(db);
  await loadFixture(store, SLUG);
  await store.close();
  ({ app, page } = await launch(db));
  invoke = invokeVia(page);
  await invoke('bible.open', { slug: SLUG });
  await expect(page.getByTestId('workspace')).toBeVisible();
});

test.afterAll(async () => {
  await app?.close();
});

const character = async (id: string) =>
  (await invoke('entry.get', { collection: 'characters', id })).entry;

async function openCharacter(name: string): Promise<Locator> {
  await closeGallery();
  await rail(page, 'Characters').click();
  await page
    .getByTestId('entry-list')
    .getByRole('button', { name: new RegExp(`^${name}`) })
    .click();
  const p = page.getByTestId('character-page');
  await expect(p.getByTestId('char-heading')).toContainText(name);
  return p;
}

async function openGallery(): Promise<Locator> {
  await page.evaluate(() => {
    window.location.hash = '#editable-gallery';
  });
  const g = page.getByTestId('editable-gallery');
  await expect(g).toBeVisible();
  return g;
}

async function closeGallery() {
  await page.evaluate(() => {
    if (window.location.hash) window.location.hash = '';
  });
  await expect(page.getByTestId('editable-gallery')).toHaveCount(0);
}

/** The steps Cmd+Z would take back, newest first, from the Changes popover (closed again after). */
async function history(): Promise<string[]> {
  const list = await changes(page);
  const items = await list.locator('li:not(.empty):not(.redo)').allTextContents();
  await page.keyboard.press('Escape');
  return items;
}

const box = async (l: Locator) => {
  const b = await l.boundingBox();
  if (!b) throw new Error(`${String(l)} has no box`);
  return b;
};

function expectSameBox(
  a: { x: number; y: number; width: number; height: number },
  b: typeof a,
  what: string,
) {
  for (const k of ['x', 'y', 'width', 'height'] as const) {
    expect(Math.abs(a[k] - b[k]), `${what} ${k}: ${a[k]} then ${b[k]}`).toBeLessThanOrEqual(1);
  }
}

test('IP-1 a text field opens on click, saves on Enter, reverts on Escape, and the page does not move', async () => {
  const p = await openCharacter('Zhou Jun');
  const name = field(p, 'names.full');
  const input = name.getByRole('textbox', { name: 'Full name', exact: true });
  const next = p.getByTestId('char-chinese');
  const line = p.getByTestId('char-line');
  // It reads as text: no box until it is picked.
  await expect(name.locator('input')).toHaveCount(0);
  await expect(name.locator('.editable-text')).toHaveText('Zhou Jun');
  const before = { next: await box(next), line: await box(line), name: await box(name) };

  // Open: the field takes the text's place and size, and nothing around it moves.
  await name.locator('.editable-text').click();
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('Zhou Jun');
  expectSameBox(before.next, await box(next), 'Chinese name while open');
  expectSameBox(before.line, await box(line), 'the line below while open');
  expectSameBox(before.name, await box(name), 'the name while open');
  expect(await page.evaluate(() => document.scrollingElement?.scrollTop ?? 0)).toBe(0);

  // Escape puts the old value back and writes nothing.
  // Typed from the keyboard: Playwright's fill scrolls the pane itself.
  await page.keyboard.press('End');
  await page.keyboard.type('ior');
  await expect(input).toHaveValue('Zhou Junior');
  await input.press('Escape');
  await expect(input).toHaveCount(0);
  await expect(name.locator('.editable-text')).toHaveText('Zhou Jun');
  await expect(name.locator('.editable-text')).toBeFocused();
  expectSameBox(before.next, await box(next), 'Chinese name after Escape');
  expectSameBox(before.line, await box(line), 'the line below after Escape');
  expect((await character('Z4')).names).toEqual({ full: 'Zhou Jun', chinese: '周军' });

  // Enter saves as one step; the title follows the name; a tick shows briefly.
  await name.locator('.editable-text').click();
  await page.keyboard.press('End');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await page.keyboard.type('.');
  await page.keyboard.press('Enter');
  await expect(input).toHaveCount(0);
  await expect(name).toHaveAttribute('data-save-state', 'saved');
  await expect(name.locator('.editable-tick')).toBeVisible();
  await expect(name).toHaveAttribute('data-save-state', 'idle', { timeout: 3000 });
  await expect(name.locator('.editable-text')).toHaveText('Zhou J.');
  expect(await character('Z4')).toMatchObject({
    title: 'Zhou J.',
    names: { full: 'Zhou J.', chinese: '周军' },
  });
  expect((await history())[0]).toBe('Changed Full name on Zhou J.');
  expectSameBox(before.line, await box(line), 'the line below after the save');

  // Cmd+Z after the save undoes the save.
  await name.locator('.editable-text').focus();
  await page.keyboard.press('Meta+z');
  await expect.poll(async () => (await character('Z4')).title).toBe('Zhou Jun');
  await expect(name.locator('.editable-text')).toHaveText('Zhou Jun');

  // Cmd+Z inside the open field undoes the typing, not the app's history (ED-3).
  // Last, with no box measured after it, so nothing here leans on the scroll hold.
  await name.locator('.editable-text').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Junior');
  await expect(input).toHaveValue('Zhou Jun Junior');
  await page.keyboard.press('Meta+z');
  await expect(input).toHaveValue('Zhou Jun');
  await expect.poll(async () => (await character('Z4')).title).toBe('Zhou Jun');
  await input.press('Escape');
  await expect(input).toHaveCount(0);
});

test('IP-1 ED-3 a name saved in the heading while a box holds unsaved typing keeps the typing and undoes the name alone', async () => {
  const p = await openCharacter('Zhou Wei');
  const desc = p.getByLabel('Description', { exact: true });
  const name = field(p, 'names.full');
  // Typing waits in the box (the autosave is half a second away) when the name is saved.
  await desc.click();
  await page.keyboard.type('Quiet and kind.');
  await name.locator('.editable-text').click();
  await page.keyboard.press('Meta+a');
  await page.keyboard.type('Zhou Wei Sr');
  await page.keyboard.press('Enter');
  await expect(name.locator('input')).toHaveCount(0);
  await expect.poll(async () => (await character('Z2')).title).toBe('Zhou Wei Sr');
  await expect(desc).toHaveText('Quiet and kind.');
  expect((await character('Z2')).body).toBe('Quiet and kind.');
  // More typing after the name lands is a step of its own that leaves the name alone.
  await desc.click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Always early.');
  await expect(page.getByTestId('editor').getByTestId('autosave')).toHaveText('Saved');
  await expect.poll(async () => (await character('Z2')).body).toBe('Quiet and kind. Always early.');
  expect((await history()).slice(0, 3)).toEqual([
    'Changed Body on Zhou Wei Sr',
    'Changed Full name on Zhou Wei Sr',
    'Changed Body on Zhou Wei',
  ]);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Meta+z');
  await expect.poll(async () => (await character('Z2')).body).toBe('Quiet and kind.');
  expect((await character('Z2')).title).toBe('Zhou Wei Sr');
  await page.keyboard.press('Meta+z');
  await expect.poll(async () => (await character('Z2')).title).toBe('Zhou Wei');
  expect(await character('Z2')).toMatchObject({
    body: 'Quiet and kind.',
    names: { full: 'Zhou Wei', chinese: '周伟' },
  });
  await expect(desc).toHaveText('Quiet and kind.');
});

test('IP-1 rich, select and date fields open in place: the line after each does not move', async () => {
  const g = await openGallery();
  const dt = (t: string) => g.locator('dt', { hasText: new RegExp(`^${t}$`) });
  for (const c of [
    { id: 'g-rich', next: 'Select' },
    { id: 'g-select', next: 'Chips' },
    { id: 'g-date', next: 'Read only' },
  ]) {
    const f = g.getByTestId(c.id);
    const before = await box(dt(c.next));
    await f.locator('.editable-text').click();
    await expect(f).toHaveClass(/is-open/);
    expectSameBox(before, await box(dt(c.next)), `${c.next} while ${c.id} is open`);
    await page.keyboard.press('Escape');
    await expect(f).not.toHaveClass(/is-open/);
    expectSameBox(before, await box(dt(c.next)), `${c.next} after ${c.id} closed`);
  }
});

test('IP-1 a character list row renames in place with F2 or a double-click, and Enter saves', async () => {
  await openCharacter('Zhou Lan');
  const list = page.getByTestId('entry-list');
  const row = list.getByRole('button', { name: /^Zhou Lan/ });
  await row.focus();
  await page.keyboard.press('F2');
  const rename = list.getByTestId('row-rename').getByRole('textbox', { name: 'Full name' });
  await expect(rename).toBeFocused();
  await expect(rename).toHaveValue('Zhou Lan');
  await page.keyboard.press('Escape');
  await expect(rename).toHaveCount(0);
  await expect(row).toBeFocused();
  await row.dblclick();
  await expect(rename).toBeFocused();
  await rename.fill('Zhou Lan Hale');
  await rename.press('Enter');
  await expect(list.getByRole('button', { name: /^Zhou Lan Hale/ })).toBeVisible();
  await expect.poll(async () => (await character('Z3')).title).toBe('Zhou Lan Hale');
  expect((await history())[0]).toBe('Changed Full name on Zhou Lan Hale');
  await page.locator('body').click();
  await page.keyboard.press('Meta+z');
  await expect.poll(async () => (await character('Z3')).title).toBe('Zhou Lan');
});

test('IP-1 a year field saves on blur as one undo step and Cmd+Z puts the old year back', async () => {
  const g = await openGallery();
  const year = g.getByTestId('g-year');
  const era = async () =>
    (await invoke('entry.get', { collection: 'eraStates', id: 'ERA-2025' })).entry;
  const after = g.getByTestId('g-year-after');
  const at = await box(after);
  await expect(year.locator('.editable-text')).toHaveText('2025');
  await year.locator('.editable-text').click();
  const input = year.getByRole('textbox', { name: 'Era start year' });
  await expect(input).toBeFocused();
  expectSameBox(at, await box(after), 'the words after the year while open');
  // Digits only: anything else is refused at the field.
  await input.fill('20x4');
  await input.press('Enter');
  await expect(year.getByRole('alert')).toHaveText(
    'Not saved: 20x4 is not a year. Write it as digits, for example 2045.',
  );
  await input.fill('2024');
  await g.getByRole('heading', { name: 'Editable fields' }).click();
  await expect(input).toHaveCount(0);
  await expect.poll(async () => (await era()).startYear).toBe(2024);
  await expect(year.locator('.editable-text')).toHaveText('2024');
  const steps = await history();
  expect(steps[0]).toMatch(/^Changed Era start year on /);
  await page.keyboard.press('Meta+z');
  await expect.poll(async () => (await era()).startYear).toBe(2025);
  await expect(year.locator('.editable-text')).toHaveText('2025');
  await expect(page.getByTestId('undo-notice').first()).toHaveText(
    /^Undid: Changed Era start year on /,
  );
});

test('IP-1 a select with Add new creates the list item and picks it', async () => {
  const g = await openGallery();
  const sel = g.getByTestId('g-select');
  const event = async () =>
    (await invoke('entry.get', { collection: 'worldEvents', id: 'E10' })).entry;
  const categories = async () =>
    (await invoke('lists.get', {})).lists
      .find((l) => l._id === 'eventCategories')!
      .items.map((i) => i.label);
  expect((await event()).categoryId).toBe('climate');
  const steps = (await history()).length;
  await sel.locator('.editable-text').click();
  const select = sel.getByRole('combobox', { name: 'Event category' });
  await expect(select).toBeFocused();
  // "Add new..." is the last choice.
  const labels = await select.locator('option').allTextContents();
  expect(labels.at(-1)).toBe('Add new...');
  await select.selectOption({ label: 'Add new...' });
  const name = sel.getByRole('textbox', { name: 'Name of the new item for Event category' });
  await expect(name).toBeFocused();
  await name.fill('Polar');
  await name.press('Enter');
  await expect(name).toHaveCount(0);
  await expect(sel.locator('.editable-text')).toHaveText('Polar');
  expect(await categories()).toContain('Polar');
  const picked = (await event()).categoryId;
  const list = (await invoke('lists.get', {})).lists.find((l) => l._id === 'eventCategories')!;
  expect(list.items.find((i) => i.id === picked)?.label).toBe('Polar');
  // One step from the writer's side: undo takes the category back and the item away.
  const now = await history();
  expect(now.length).toBe(steps + 1);
  expect(now[0]).toBe('Changed Event category on Arctic summer sea ice is gone for good');
  await page.keyboard.press('Meta+z');
  await expect.poll(async () => (await event()).categoryId).toBe('climate');
  await expect.poll(categories).not.toContain('Polar');
});

test('IP-1 a chip row adds from the picker and removes with its button, one step each', async () => {
  const p = await openCharacter('Zhou Jun');
  const fam = field(p, 'familyIds');
  const ids = async () => (await character('Z4')).familyIds;
  const n0 = (await history()).length;
  await expect(fam.locator('.chip')).toHaveText(['Zhou×']);
  const lineBox = await box(p.getByTestId('char-relatives'));

  // Add from the picker: it opens in place of the button, and nothing below moves.
  await fam.getByRole('button', { name: 'Add family' }).click();
  const picker = fam.getByRole('combobox', { name: 'Family to add' });
  await expect(picker).toBeFocused();
  expectSameBox(lineBox, await box(p.getByTestId('char-relatives')), 'the relatives line');
  await picker.fill('Ha');
  await expect(fam.getByRole('option')).toHaveText(['Hale', 'Add new...']);
  await page.keyboard.press('Enter');
  await expect.poll(ids).toEqual(['FAM-ZHOU', 'FAM-HALE']);
  await expect(fam.getByRole('button', { name: 'Add family' })).toBeFocused();
  let steps = await history();
  expect(steps.length).toBe(n0 + 1);
  expect(steps[0]).toBe('Changed Families on Zhou Jun');

  // Remove with the button on the chip.
  await fam.getByRole('button', { name: 'Remove Hale from Families' }).click();
  await expect.poll(ids).toEqual(['FAM-ZHOU']);
  steps = await history();
  expect(steps.length).toBe(n0 + 2);

  // Add new makes the family and adds it, as one step.
  await fam.getByRole('button', { name: 'Add family' }).click();
  await picker.fill('Okafor');
  await fam.getByRole('option', { name: 'Add new...' }).click();
  const naming = fam.getByRole('textbox', { name: 'Name of the new item for Families' });
  await expect(naming).toHaveValue('Okafor');
  await naming.press('Enter');
  await expect(fam.locator('.chip')).toHaveText(['Zhou×', 'Okafor×']);
  const okafor = (await invoke('entry.list', { collection: 'families', trash: 'exclude' })).entries
    .map((e) => e.entry)
    .find((f) => f.name === 'Okafor');
  expect(okafor).toBeDefined();
  await expect.poll(ids).toEqual(['FAM-ZHOU', okafor!._id]);
  steps = await history();
  expect(steps.length).toBe(n0 + 3);
  // Undo takes the chip off and the new family back out.
  await page.keyboard.press('Meta+z');
  await expect.poll(ids).toEqual(['FAM-ZHOU']);
  await expect
    .poll(
      async () =>
        (await invoke('entry.get', { collection: 'families', id: okafor!._id })).entry.deletedAt,
    )
    .toBeTruthy();
});

test('IP-1 a date field explains what it could not read and keeps the old value', async () => {
  const p = await openCharacter('Zhou Jun');
  const death = field(p, 'death');
  await expect(death.locator('.editable-text')).toHaveText('2070');
  await death.locator('.editable-text').click();
  const input = death.getByRole('textbox', { name: 'Death' });
  await input.fill('soon');
  await input.press('Enter');
  await expect(death.getByRole('alert')).toHaveText(
    'Not saved: soon is not a date. Write a year (1990), a year and month (1990-03), or a full date (1990-03-14).',
  );
  await expect(death).toHaveAttribute('data-save-state', 'error');
  // The field stays open with what was typed; the stored date is untouched.
  await expect(input).toHaveValue('soon');
  await expect(input).toHaveAttribute('aria-invalid', 'true');
  expect((await character('Z4')).death).toEqual({ year: 2070 });
  await input.press('Escape');
  await expect(input).toHaveCount(0);
  await expect(death.getByRole('alert')).toHaveCount(0);
  await expect(death.locator('.editable-text')).toHaveText('2070');
  // A good date then saves, and a death before the birth still saves with the ED-10 note.
  await death.locator('.editable-text').click();
  await input.fill('1980');
  await input.press('Enter');
  await expect.poll(async () => (await character('Z4')).death).toEqual({ year: 1980 });
  await expect(death.getByRole('note')).toContainText('before the birth date');
  await death.locator('.editable-text').click();
  await input.fill('2070');
  await input.press('Enter');
  await expect.poll(async () => (await character('Z4')).death).toEqual({ year: 2070 });
  await expect(death.getByRole('note')).toHaveCount(0);
});

test('IP-1 NF-2 every kind works from the keyboard and labels use the primary text colour in both themes', async () => {
  const g = await openGallery();
  const text = (id: string) => g.getByTestId(id).locator('.editable-text');
  const event = async () =>
    (await invoke('entry.get', { collection: 'worldEvents', id: 'E10' })).entry;

  // Text: Enter opens, Enter saves, and the focus comes back to the text.
  await text('g-text').focus();
  await expect(text('g-text')).toHaveCSS('outline-style', 'solid');
  await page.keyboard.press('Enter');
  await page.keyboard.press('End');
  await page.keyboard.type(' at last');
  await page.keyboard.press('Enter');
  await expect
    .poll(async () => (await event()).title)
    .toBe('Arctic summer sea ice is gone for good at last');
  await expect(text('g-text')).toBeFocused();
  // Year: Space opens.
  await text('g-year').focus();
  await page.keyboard.press(' ');
  await page.keyboard.press('Meta+a');
  await page.keyboard.type('2026');
  await page.keyboard.press('Enter');
  await expect
    .poll(
      async () =>
        (await invoke('entry.get', { collection: 'eraStates', id: 'ERA-2025' })).entry.startYear,
    )
    .toBe(2026);
  // Number: F2 opens too.
  await text('g-number').focus();
  await page.keyboard.press('F2');
  await page.keyboard.press('Meta+a');
  await page.keyboard.type('1500');
  await page.keyboard.press('Enter');
  await expect(text('g-number')).toHaveText('1500');
  // Rich text: Enter inside a list starts the next item, Cmd+Enter saves.
  await text('g-rich').focus();
  await page.keyboard.press('Enter');
  await page.keyboard.type('- One');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Two');
  await page.keyboard.press('Meta+Enter');
  await expect.poll(async () => (await event()).body).toMatch(/^[-*] One\n[-*] Two$/);
  await expect(text('g-rich')).toBeFocused();
  // Out of the list, Shift+Enter is a new line and Enter saves.
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('The ice is gone.');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('Ships cross the pole.');
  await page.keyboard.press('Enter');
  await expect
    .poll(async () => (await event()).body)
    .toMatch(/^[-*] One\n[-*] Two\n\nThe ice is gone\.[\s\\]+Ships cross the pole\.$/);
  await expect(text('g-rich')).toBeFocused();
  // Select: Enter opens it focused; the arrows pick; the pick saves.
  await text('g-select').focus();
  await page.keyboard.press('Enter');
  const select = g.getByTestId('g-select').locator('select');
  await expect(select).toBeFocused();
  await select.press('Escape');
  await expect(select).toHaveCount(0);
  await expect(text('g-select')).toBeFocused();
  // Chips: Add opens the picker, typing filters, Enter picks.
  await g.getByTestId('g-chips').getByRole('button', { name: 'Add a character' }).focus();
  await page.keyboard.press('Enter');
  await page.keyboard.type('Noor');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await event()).characterIds).toEqual(['Z5']);
  await page.keyboard.press('Tab');
  // Date: Enter opens, Enter saves.
  await text('g-date').focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Meta+a');
  await page.keyboard.type('2091-07');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await event()).start).toEqual({ year: 2091, month: 7 });

  // Labels and placeholders are in the primary text colour, in both themes.
  const theme0 = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
    const read = await page.evaluate(() => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--fg)';
      document.body.append(probe);
      const fg = getComputedStyle(probe).color;
      probe.remove();
      const colors = [
        ...document.querySelectorAll(
          '[data-testid="editable-gallery"] dt, [data-testid="editable-gallery"] .editable-text',
        ),
      ].map((el) => getComputedStyle(el).color);
      return { fg, colors };
    });
    expect(read.colors.length).toBeGreaterThan(8);
    for (const c of read.colors) expect(c, theme).toBe(read.fg);
  }
  await closeGallery();
  const p = await openCharacter('Daniel Hale');
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
    const read = await p.evaluate((el) => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--fg)';
      document.body.append(probe);
      const fg = getComputedStyle(probe).color;
      probe.remove();
      return {
        fg,
        labels: [...el.querySelectorAll('.editable-label')].map((l) => [
          l.textContent,
          getComputedStyle(l).color,
        ]),
        placeholder: getComputedStyle(el.querySelector('.editable-text.is-placeholder')!).color,
      };
    });
    expect(read.labels.map((l) => l[0])).toEqual(['Birth', 'Death', 'Families']);
    for (const [, c] of read.labels) expect(c, theme).toBe(read.fg);
    expect(read.placeholder, theme).toBe(read.fg);
  }
  await page.evaluate((t) => {
    if (t === null) document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', t);
  }, theme0);
});

test('IP-1 ARCH-6 a read-only field shows the reason and never opens', async () => {
  test.setTimeout(240_000);
  // A field marked read-only by its screen: the reason is its title, and it never opens.
  const g = await openGallery();
  const locked = g.getByTestId('g-locked');
  const lockedText = locked.locator('.editable-text');
  await expect(lockedText).toHaveAttribute('title', 'The app sets this when the entry is made.');
  await expect(lockedText).toHaveAttribute('aria-disabled', 'true');
  // A disabled control: Playwright clicks it only when forced, as a person still can.
  await lockedText.click({ force: true });
  await lockedText.focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press(' ');
  await expect(locked.locator('input')).toHaveCount(0);
  await closeGallery();

  // ARCH-6: a snapshot open read-only, on a server of its own stopped mid-session.
  const own = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });
  try {
    const member = own.servers[0]!;
    const store = await connect(own.getUri());
    await loadFixture(store, 'ro');
    await store.close();
    await app.close();
    ({ app, page } = await launch(own.getUri()));
    invoke = invokeVia(page);
    await invoke('bible.open', { slug: 'ro' });
    await expect(page.getByTestId('workspace')).toBeVisible();
    await invoke('snapshot.take', {});
    const p = await openCharacter('Ruth Hale');
    await member.stop({ doCleanup: false, force: true });
    // The lost connection shows on the next write; the snapshot opens read-only in place.
    const birth = field(p, 'birth');
    await birth.locator('.editable-text').click();
    await birth.locator('input').fill('1991');
    await birth.locator('input').press('Enter');
    await expect(birth.getByRole('alert')).toBeVisible({ timeout: 60_000 });
    await birth.locator('input').press('Escape');
    const banner = page.getByTestId('connection-banner');
    await expect(banner).toHaveAttribute('data-state', 'unavailable', { timeout: 30_000 });
    await banner.getByTestId('open-snapshot').click();
    await expect(banner).toHaveAttribute('data-state', 'readOnly');
    const ro = await openCharacter('Ruth Hale');
    for (const path of ['names.full', 'names.chinese', 'birth', 'death']) {
      const f = field(ro, path);
      const t = f.locator('.editable-text');
      await expect(t, path).toHaveAttribute('title', READ_ONLY_REASON);
      await expect(t, path).toHaveAttribute('aria-disabled', 'true');
      await expect(t, path).toHaveAttribute('aria-describedby', 'read-only-reason');
      await t.click({ force: true });
      await t.press('Enter');
      await expect(f.locator('input, select'), path).toHaveCount(0);
    }
    // The chip row shows its chips with no remove or add buttons.
    const fam = field(ro, 'familyIds');
    await expect(fam.locator('.chip')).toHaveText(['Hale']);
    await expect(fam.getByRole('button')).toHaveCount(0);
    await expect(fam).toHaveAttribute('title', READ_ONLY_REASON);
    // The character list renames nothing.
    const row = page.getByTestId('entry-list').getByRole('button', { name: /^Ruth Hale/ });
    await row.dblclick({ force: true });
    await expect(page.getByTestId('row-rename')).toHaveCount(0);
  } finally {
    await own.stop().catch(() => undefined);
  }
});
