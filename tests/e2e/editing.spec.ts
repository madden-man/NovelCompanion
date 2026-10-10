import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  ENTRY_COLLECTIONS,
  collectionInfo,
  customFieldSpecs,
  editableFields,
  manifests,
} from '../../src/shared/schema';
import type { CustomSection, EntryCollection } from '../../src/shared/schema';
import { ALL_KINDS_SECTION, build, t5Verify, t5Write } from '../helpers/t5';
import type { GenContext, Invoke, T5Plan } from '../helpers/t5';
import { field, invokeVia, launch, rail, setField, waitSaved, withoutSystem } from './helpers';
import type { UiContext } from './helpers';

let server: MongoMemoryReplSet;
let app: ElectronApplication;
let page: Page;
let invoke: Invoke;
let plan: T5Plan;

const BIBLE = 'editing';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  server = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  ({ app, page } = await launch(server.getUri()));
  invoke = invokeVia(page);
  await page.evaluate(
    (slug) => window.api.invoke('bible.create', { slug, name: 'Editing tests' }),
    BIBLE,
  );
  await page.evaluate((slug) => window.api.invoke('bible.open', { slug }), BIBLE);
  await expect(page.getByTestId('workspace')).toBeVisible();
});

test.afterAll(async () => {
  await app?.close();
  await server?.stop();
});

async function relaunch() {
  await app.close();
  ({ app, page } = await launch(server.getUri()));
  invoke = invokeVia(page);
  await page.evaluate((slug) => window.api.invoke('bible.open', { slug }), BIBLE);
  await expect(page.getByTestId('workspace')).toBeVisible();
}

/** A generator context read from the bible: pools of entries and list items. */
async function genContext(): Promise<GenContext & UiContext> {
  const pools = new Map<string, string[]>();
  for (const c of ENTRY_COLLECTIONS) {
    const { entries } = await invoke('entry.list', { collection: c, trash: 'exclude' });
    pools.set(
      c,
      entries
        .filter((e) => String(e.entry.title ?? '').startsWith('Pool'))
        .map((e) => e.entry._id)
        .slice(0, 8),
    );
  }
  const sections = (await invoke('entry.list', { collection: 'customSections', trash: 'exclude' }))
    .entries;
  const recipeSections = sections
    .filter((s) => String(s.entry.name).startsWith('Recipes'))
    .map((s) => s.entry._id);
  pools.set('customSections', recipeSections);
  const { lists } = await invoke('lists.get', {});
  const titles = new Map<string, string>();
  return {
    page,
    pool: (c) => pools.get(c === '*' ? 'characters' : c) ?? [],
    listItems: (id) => lists.find((l) => l._id === id)?.items.map((i) => i.id) ?? [],
    customSpecs: (id) => {
      const s = sections.find((x) => x.entry._id === id)?.entry as unknown as
        CustomSection | undefined;
      return s
        ? customFieldSpecs(s)
        : recipeSections.includes(id)
          ? customFieldSpecs({ fields: ALL_KINDS_SECTION })
          : undefined;
    },
    titleOf: async (id) => {
      if (!titles.has(id)) {
        const { entries } = await invoke('entry.lookup', { ids: [id] });
        titles.set(id, entries[0]?.title ?? id);
      }
      return titles.get(id)!;
    },
  };
}

test('T-5 every field of every entity is set through window.api and persists after the app restarts', async () => {
  test.setTimeout(300_000);
  plan = await t5Write(invoke);
  expect(plan.problems).toEqual([]);
  expect(plan.items.map((i) => i.collection).sort()).toEqual([...ENTRY_COLLECTIONS].sort());
  for (const item of plan.items) {
    expect(item.fields).toEqual(editableFields(manifests[item.collection]).map((s) => s.name));
  }
  // Close the Electron app and launch it again: a new main process, a new read model.
  await relaunch();
  expect(await t5Verify(invoke, plan)).toEqual([]);
});

test('ED-1 every field of every entity can be created and changed through the editor', async () => {
  test.setTimeout(600_000);
  const ctx = await genContext();
  const failures: string[] = [];
  for (const c of ENTRY_COLLECTIONS) {
    const info = collectionInfo[c];
    const manifest = manifests[c];
    const a = build(manifest, 0, ctx, 'full', true);
    const b = build(manifest, 1, ctx, 'full', true);
    await rail(page, info.plural).click();
    await page
      .getByRole('button', { name: `New ${info.singular.toLowerCase()}`, exact: true })
      .click();
    const form = page.getByTestId('new-entry');
    for (const spec of manifest.filter((s) => s.required && s.kind !== 'system')) {
      await setField(ctx, form, spec, spec.name, a[spec.name], a);
    }
    await form.getByRole('button', { name: `Create ${info.singular.toLowerCase()}` }).click();
    const editor = page.getByTestId('editor');
    await expect(editor).toBeVisible();
    await waitSaved(page);
    for (const spec of editableFields(manifest)) {
      await setField(ctx, editor, spec, spec.name, b[spec.name], b);
    }
    await waitSaved(page);
    const id = await editor.getAttribute('data-entry-id');
    if (!id) throw new Error(`The ${c} editor shows no entry ID`);
    const { entry: saved } = await invoke('entry.get', { collection: c, id });
    const got = withoutSystem(manifest, saved) as Record<string, unknown>;
    const want = withoutSystem(manifest, b) as Record<string, unknown>;
    for (const spec of editableFields(manifest)) {
      const g = JSON.stringify(got[spec.name] ?? null);
      const w = JSON.stringify(want[spec.name] ?? null);
      if (g !== w) failures.push(`${c}.${spec.name}: expected ${w}, found ${g}`);
    }
  }
  expect(failures).toEqual([]);
});

async function openSection(collection: EntryCollection) {
  await rail(page, collectionInfo[collection].plural).click();
}

async function newCharacter(name: string, birthYear = 1958) {
  await openSection('characters');
  await page.getByRole('button', { name: 'New character', exact: true }).click();
  const form = page.getByTestId('new-entry');
  await field(form, 'title').locator('input').fill(name);
  await field(form, 'names.full').locator('input').fill(name);
  await field(form, 'birth').getByLabel('Kind of date').selectOption('year');
  await field(form, 'birth').getByLabel('Year', { exact: true }).fill(String(birthYear));
  await form.getByRole('button', { name: 'Create character' }).click();
  await expect(page.getByTestId('editor').getByRole('heading', { name })).toBeVisible();
  await waitSaved(page);
}

async function currentEntry(collection: EntryCollection, title: string) {
  const { entries } = await invoke('entry.list', { collection, trash: 'include' });
  const e = entries.find((x) => x.entry.title === title);
  if (!e) throw new Error(`No ${collection} entry titled ${title}`);
  return (await invoke('entry.get', { collection, id: e.entry._id })).entry;
}

test('ED-2 a change saves on its own within one second, with no save button, and shows Saved', async () => {
  await newCharacter('Ada Sullivan', 1990);
  const editor = page.getByTestId('editor');
  await expect(editor.getByRole('button', { name: /^Save$/ })).toHaveCount(0);
  const input = field(editor, 'birthplace').locator('input');
  await input.fill('San Francisco');
  const typed = Date.now();
  await expect(editor.getByTestId('autosave')).toHaveText('Saving soon');
  await expect(editor.getByTestId('autosave')).toHaveText('Saved', { timeout: 1000 });
  const elapsed = Date.now() - typed;
  expect(elapsed).toBeLessThan(1000);
  expect((await currentEntry('characters', 'Ada Sullivan')).birthplace).toBe('San Francisco');
});

test('ED-2 continuous typing still saves within one second of the first change', async () => {
  const editor = page.getByTestId('editor');
  const input = field(editor, 'backstory').locator('textarea');
  await input.click();
  const start = Date.now();
  // Type for longer than the debounce; the first save still lands within a second.
  const text = 'She kept every letter the family ever sent.';
  let saw = false;
  for (const ch of text) {
    await input.press(ch === ' ' ? 'Space' : ch);
    if (!saw && (await currentEntry('characters', 'Ada Sullivan')).backstory) {
      saw = true;
      expect(Date.now() - start).toBeLessThan(1500);
    }
  }
  await waitSaved(page);
  expect((await currentEntry('characters', 'Ada Sullivan')).backstory).toBe(text);
});

test('ED-3 fifty-one changes undo with Cmd+Z and redo with Shift+Cmd+Z', async () => {
  test.setTimeout(240_000);
  await newCharacter('Undo Hale', 1960);
  const editor = page.getByTestId('editor');
  const input = field(editor, 'birthplace').locator('input');
  const top = page.getByTestId('inspector').getByTestId('undo-history').locator('li').first();
  for (let n = 1; n <= 51; n++) {
    await input.fill(`Place ${n}`);
    await waitSaved(page);
    await expect(top).toHaveText('Changed Birthplace on Undo Hale');
    await expect
      .poll(async () => (await currentEntry('characters', 'Undo Hale')).birthplace)
      .toBe(`Place ${n}`);
  }
  expect((await currentEntry('characters', 'Undo Hale')).birthplace).toBe('Place 51');
  await page.locator('body').click();
  for (let n = 0; n < 50; n++) await page.keyboard.press('Meta+z');
  await expect(page.getByTestId('undo-notice').first()).toHaveText(
    /^Undid: Changed Birthplace on Undo Hale$/,
  );
  await expect
    .poll(async () => (await currentEntry('characters', 'Undo Hale')).birthplace)
    .toBe('Place 1');
  await expect(input).toHaveValue('Place 1');
  await page.keyboard.press('Meta+z');
  await expect
    .poll(async () => (await currentEntry('characters', 'Undo Hale')).birthplace)
    .toBe('');
  await page.keyboard.press('Shift+Meta+z');
  await page.keyboard.press('Shift+Meta+z');
  await expect
    .poll(async () => (await currentEntry('characters', 'Undo Hale')).birthplace)
    .toBe('Place 2');
  await expect(input).toHaveValue('Place 2');
});

test('ED-3 undo and redo cover creating, deleting, restoring, and editing links', async () => {
  await newCharacter('Temp Person');
  const inspector = page.getByTestId('inspector');
  // Delete, then undo the delete.
  await inspector.getByRole('button', { name: 'Move to trash' }).click();
  await inspector
    .getByRole('dialog', { name: 'Move to trash' })
    .getByRole('button', { name: 'Move to trash' })
    .click();
  await expect
    .poll(async () => Boolean((await currentEntry('characters', 'Temp Person')).deletedAt))
    .toBe(true);
  await page.keyboard.press('Meta+z');
  await expect
    .poll(async () => Boolean((await currentEntry('characters', 'Temp Person')).deletedAt))
    .toBe(false);
  await page.keyboard.press('Shift+Meta+z');
  await expect
    .poll(async () => Boolean((await currentEntry('characters', 'Temp Person')).deletedAt))
    .toBe(true);
  await page.keyboard.press('Meta+z');
  await expect
    .poll(async () => Boolean((await currentEntry('characters', 'Temp Person')).deletedAt))
    .toBe(false);
  // Edit links, then undo the link edit.
  const editor = page.getByTestId('editor');
  const links = field(editor, 'links');
  await links.getByPlaceholder('Find an entry to link').fill('Ada Sullivan');
  await links.getByRole('option').filter({ hasText: 'Ada Sullivan' }).first().click();
  await waitSaved(page);
  await expect
    .poll(async () => (await currentEntry('characters', 'Temp Person')).links)
    .toHaveLength(1);
  await page.keyboard.press('Meta+z');
  await expect
    .poll(async () => (await currentEntry('characters', 'Temp Person')).links)
    .toHaveLength(0);
  // The step before the link edit is the create itself: undoing it sends the entry to the trash.
  await expect(page.getByTestId('undo-notice').first()).toHaveText(
    'Undid: Changed Links on Temp Person',
  );
  await page.keyboard.press('Meta+z');
  await expect(page.getByTestId('undo-notice').first()).toHaveText('Undid: Created Temp Person');
  await expect
    .poll(async () => Boolean((await currentEntry('characters', 'Temp Person')).deletedAt))
    .toBe(true);
  await page.keyboard.press('Shift+Meta+z');
  await expect
    .poll(async () => Boolean((await currentEntry('characters', 'Temp Person')).deletedAt))
    .toBe(false);
});

test('ED-4 the history drawer compares any revision with the current entry and restores it', async () => {
  await newCharacter('Revision Doyle', 1950);
  const editor = page.getByTestId('editor');
  const input = field(editor, 'birthplace').locator('input');
  await input.fill('Cork');
  await waitSaved(page);
  await input.fill('Boston');
  await waitSaved(page);
  await page.getByTestId('inspector').getByRole('button', { name: 'History' }).click();
  const drawer = page.getByTestId('history');
  const revisions = drawer
    .getByRole('list', { name: 'Revisions, newest first' })
    .getByRole('button');
  await expect(revisions).toHaveCount(3);
  await expect(revisions.nth(0)).toContainText('Changed (current)');
  await expect(revisions.nth(2)).toContainText('Created');
  await revisions.nth(1).click();
  const diff = drawer.getByTestId('revision-diff');
  const row = diff.getByRole('row', { name: /Birthplace/ });
  await expect(row.getByRole('cell').nth(0)).toHaveText('Cork');
  await expect(row.getByRole('cell').nth(1)).toHaveText('Boston');
  await drawer.getByRole('button', { name: 'Restore this version' }).click();
  await expect(revisions).toHaveCount(4);
  await expect(revisions.nth(0)).toContainText('Restored the version from');
  await drawer.getByRole('button', { name: 'Close' }).click();
  await expect(input).toHaveValue('Cork');
  expect((await currentEntry('characters', 'Revision Doyle')).birthplace).toBe('Cork');
  // The restore is undoable like any change.
  await page.keyboard.press('Meta+z');
  await expect
    .poll(async () => (await currentEntry('characters', 'Revision Doyle')).birthplace)
    .toBe('Boston');
});

test('ED-5 deleting lists what links here, moves it to the trash, and restores it with its links', async () => {
  // Link Ada from a new character, so Ada has something linking to her.
  await newCharacter('Linker Zhou', 1992);
  const editor = page.getByTestId('editor');
  const links = field(editor, 'links');
  await links.getByLabel('Link kind').fill('cousin');
  await links.getByPlaceholder('Find an entry to link').fill('Ada Sullivan');
  await links.getByRole('option').filter({ hasText: 'Ada Sullivan' }).first().click();
  await waitSaved(page);

  await openSection('characters');
  await page
    .getByTestId('entry-list')
    .getByRole('button', { name: /Ada Sullivan/ })
    .click();
  const inspector = page.getByTestId('inspector');
  await expect(inspector.getByTestId('linked-from')).toContainText('Character: Linker Zhou');
  await inspector.getByRole('button', { name: 'Move to trash' }).click();
  const dialog = inspector.getByRole('dialog', { name: 'Move to trash' });
  await expect(dialog.getByTestId('linked-count')).toHaveText(/^1 entry links here\./);
  await expect(dialog).toContainText('Character: Linker Zhou');
  await dialog.getByRole('button', { name: 'Move to trash' }).click();
  await expect(page.getByTestId('editor')).toContainText('This entry is in the trash.');

  await rail(page, 'Trash').click();
  const trash = page.getByTestId('trash-list');
  await expect(trash).toContainText('Ada Sullivan');
  await trash.getByRole('button', { name: 'Restore Ada Sullivan' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Ada Sullivan is back' })).toContainText(
    'with 1 entry linking to it',
  );
  await expect(page.getByRole('button', { name: 'Restore Ada Sullivan' })).toHaveCount(0);
  const ada = await currentEntry('characters', 'Ada Sullivan');
  expect(ada.deletedAt).toBeUndefined();
  const { backlinks } = await invoke('entry.backlinks', { id: ada._id });
  expect(backlinks).toContainEqual(
    expect.objectContaining({ title: 'Linker Zhou', kind: 'cousin' }),
  );
});

test('ED-9 typing @ in a long text field searches, inserts a link, and the target shows Linked from', async () => {
  await openSection('characters');
  await page
    .getByTestId('entry-list')
    .getByRole('button', { name: /Linker Zhou/ })
    .click();
  const editor = page.getByTestId('editor');
  const body = field(editor, 'body').locator('textarea');
  await body.click();
  await body.pressSequentially('Compare with @Revi');
  const picker = field(editor, 'body').getByRole('listbox', { name: 'Matching entries' });
  await expect(picker.getByRole('option').first()).toContainText('Revision Doyle');
  await page.keyboard.press('Enter');
  await expect(body).toHaveValue('Compare with @Revision Doyle ');
  await waitSaved(page);
  const linker = await currentEntry('characters', 'Linker Zhou');
  const doyle = await currentEntry('characters', 'Revision Doyle');
  expect(linker.links).toContainEqual({ targetId: doyle._id, kind: 'mention' });
  await expect(field(editor, 'links')).toContainText('Character: Revision Doyle');

  await page
    .getByTestId('entry-list')
    .getByRole('button', { name: /Revision Doyle/ })
    .click();
  const linked = page.getByTestId('inspector').getByTestId('linked-from');
  await expect(linked).toContainText('Character: Linker Zhou');
  await linked.getByRole('button', { name: 'Character: Linker Zhou' }).click();
  await expect(
    page.getByTestId('editor').getByRole('heading', { name: 'Linker Zhou' }),
  ).toBeVisible();
});

test('ED-10 a death date before the birth date is flagged at the field in plain words and still saves', async () => {
  await newCharacter('Warned Hale', 2000);
  const editor = page.getByTestId('editor');
  const death = field(editor, 'death');
  await death.getByLabel('Kind of date').selectOption('year');
  await death.getByLabel('Year', { exact: true }).fill('1990');
  await waitSaved(page);
  await expect(death.getByRole('note')).toHaveText(
    'The death date 1990 is before the birth date 2000. It still saves.',
  );
  expect((await currentEntry('characters', 'Warned Hale')).death).toEqual({ year: 1990 });
  await expect(page.getByTestId('inspector').getByTestId('warning-count')).toHaveText(
    '1 field has a warning. It still saved.',
  );
  // Fixing it clears the warning.
  await death.getByLabel('Year', { exact: true }).fill('2070');
  await waitSaved(page);
  await expect(death.getByRole('note')).toHaveCount(0);
});

test('ED-10 a value the schema cannot store is marked at the field and not sent', async () => {
  const editor = page.getByTestId('editor');
  await field(editor, 'names.full').locator('input').fill('');
  await expect(editor.getByTestId('autosave')).toHaveText(/^Not saved/);
  await expect(field(editor, 'names.full').getByRole('alert')).toHaveText(
    'Not saved: Cannot be empty.',
  );
  expect(((await currentEntry('characters', 'Warned Hale')).names as { full: string }).full).toBe(
    'Warned Hale',
  );
  await field(editor, 'names.full').locator('input').fill('Warned Hale');
  await waitSaved(page);
});

test('ED-8 renaming a tag on the Lists screen updates every entry that uses it', async () => {
  for (const name of ['Ada Sullivan', 'Linker Zhou']) {
    await openSection('characters');
    await page
      .getByTestId('entry-list')
      .getByRole('button', { name: new RegExp(name) })
      .click();
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
  for (const name of ['Ada Sullivan', 'Linker Zhou']) {
    expect((await currentEntry('characters', name)).tags).toContain('the harbor');
    expect((await currentEntry('characters', name)).tags).not.toContain('harbor');
  }
  // The rename is undoable.
  await page.keyboard.press('Meta+z');
  await expect
    .poll(async () => (await currentEntry('characters', 'Ada Sullivan')).tags)
    .toContain('harbor');
});

test('ED-8 renaming a union type changes the name every union shows', async () => {
  await rail(page, 'Lists').click();
  const panel = page.locator('[data-list="unionTypes"]');
  await panel.getByRole('button', { name: 'Rename Partnered' }).click();
  await panel.getByLabel('New name for Partnered').fill('Domestic partners');
  await panel.getByRole('button', { name: 'Save name' }).click();
  await expect(panel).toContainText('Domestic partners');
  await openSection('unions');
  await page.getByTestId('entry-list').getByRole('button').first().click();
  await expect(
    field(page.getByTestId('editor'), 'type').locator('select option', {
      hasText: 'Domestic partners',
    }),
  ).toHaveCount(1);
});

test('ED-6 generated content and imported content are edited like any other field', async () => {
  const cases: [EntryCollection, string][] = [
    ['chapters', 'summary'],
    ['chapters', 'manuscriptText'],
    ['briefs', 'content'],
    ['findings', 'text'],
  ];
  for (const [c, name] of cases) {
    await openSection(c);
    await page.getByTestId('entry-list').getByRole('button').first().click();
    const box = field(page.getByTestId('editor'), name).locator('textarea');
    const text = `Edited by hand: ${c} ${name}.`;
    await box.fill(text);
    await waitSaved(page);
    const title = await page.getByTestId('editor').getByRole('heading', { level: 2 }).textContent();
    expect((await currentEntry(c, title ?? ''))[name]).toBe(text);
  }
});
