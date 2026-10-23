import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { MongoClient } from 'mongodb';
import {
  ENTRY_COLLECTIONS,
  collectionInfo,
  editableFields,
  fieldByName,
  manifests,
} from '../../src/shared/schema';
import type { EntryCollection } from '../../src/shared/schema';
import { build, t5Verify, t5Write } from '../helpers/t5';
import type { GenContext, Invoke, T5Plan } from '../helpers/t5';
import {
  changes,
  field,
  fileDb,
  fillDateBox,
  fillEditable,
  invokeVia,
  launch,
  openEditable,
  openListFor,
  rail,
  sectionList,
  setField,
  waitSaved,
  withoutSystem,
} from './helpers';
import type { TestDb } from './helpers';
import type { UiContext } from './helpers';

let db: TestDb;
let app: ElectronApplication;
let page: Page;
let invoke: Invoke;
let plan: T5Plan;

const BIBLE = 'editing';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  db = fileDb();
  ({ app, page } = await launch(db));
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
});

async function relaunch() {
  await app.close();
  ({ app, page } = await launch(db));
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
  const { lists } = await invoke('lists.get', {});
  const titles = new Map<string, string>();
  return {
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
    const { newButton, preset } = await openListFor(page, ctx, c, a);
    await page.getByRole('button', { name: newButton, exact: true }).click();
    const form = page.getByTestId('new-entry');
    if (c === 'characters') {
      // SM-1: a new character asks for the full name only.
      const names = a.names as { full: string };
      await field(form, 'names.full').locator('input').fill(names.full);
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
    const fields = c === 'characters' ? CHARACTER_PAGE_FIELDS : editableFields(manifest);
    if (c === 'characters') {
      // SM-1, IP-1: the name and the Chinese name are fields in the heading.
      const names = b.names as { full: string; chinese: string };
      await fillEditable(field(editor, 'names.full'), names.full);
      await fillEditable(field(editor, 'names.chinese'), names.chinese);
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
  }
  expect(failures).toEqual([]);
});

/**
 * SM-1: the fields the character page edits. The rest (provenance, source
 * note and location, tags, links) are set by the app and edited through the
 * IPC layer, which the T-5 test above covers. The title follows the full name.
 */
const CHARACTER_PAGE_FIELDS = [
  'names',
  'birth',
  'death',
  'status',
  'familyIds',
  'role',
  'body',
  'backstory',
].map((name) => fieldByName(manifests.characters, name)!);

async function openSection(collection: EntryCollection) {
  await (collection === 'characters'
    ? rail(page, 'Characters').click()
    : sectionList(page, collectionInfo[collection].plural));
}

async function newCharacter(name: string, birthYear = 1958) {
  await openSection('characters');
  await page.getByRole('button', { name: 'New character', exact: true }).click();
  const form = page.getByTestId('new-entry');
  await field(form, 'names.full').locator('input').fill(name);
  await form.getByRole('button', { name: 'Create character' }).click();
  const editor = page.getByTestId('editor');
  await expect(editor.getByTestId('char-heading').getByRole('heading', { name })).toBeVisible();
  await waitSaved(page);
  await fillDateBox(field(editor, 'birth'), String(birthYear));
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
  const input = field(editor, 'role').getByRole('textbox');
  await input.fill('San Francisco');
  const typed = Date.now();
  await expect(editor.getByTestId('autosave')).toHaveText('Saving soon');
  await expect(editor.getByTestId('autosave')).toHaveText('Saved', { timeout: 1000 });
  const elapsed = Date.now() - typed;
  expect(elapsed).toBeLessThan(1000);
  expect((await currentEntry('characters', 'Ada Sullivan')).role).toBe('San Francisco');
});

test('ED-2 continuous typing still saves within one second of the first change', async () => {
  const editor = page.getByTestId('editor');
  const input = field(editor, 'backstory').getByRole('textbox');
  await input.click();
  const start = Date.now();
  // Type for longer than the debounce; the first save still lands within a second.
  const text = 'She kept every letter the family ever sent.';
  let saw = false;
  for (const ch of text) {
    await input.press(ch === ' ' ? 'Space' : ch);
    if (!saw && (await currentEntry('characters', 'Ada Sullivan')).backstory) {
      saw = true;
      expect(Date.now() - start).toBeLessThan(1000);
    }
  }
  await waitSaved(page);
  expect((await currentEntry('characters', 'Ada Sullivan')).backstory).toBe(text);
});

test('ED-3 fifty-one changes undo with Cmd+Z and redo with Shift+Cmd+Z', async () => {
  test.setTimeout(240_000);
  await newCharacter('Undo Hale', 1960);
  const editor = page.getByTestId('editor');
  const input = field(editor, 'role').getByRole('textbox');
  // A43: the Undo button in the top bar names the step it takes back.
  const undoButton = page.getByTestId('top-undo');
  for (let n = 1; n <= 51; n++) {
    await input.fill(`Place ${n}`);
    await waitSaved(page);
    await expect(undoButton).toHaveAttribute(
      'title',
      'Undo Changed In the story on Undo Hale (Cmd Z)',
    );
    await expect
      .poll(async () => (await currentEntry('characters', 'Undo Hale')).role)
      .toBe(`Place ${n}`);
  }
  expect((await currentEntry('characters', 'Undo Hale')).role).toBe('Place 51');
  await expect((await changes(page)).locator('li').first()).toHaveText(
    'Changed In the story on Undo Hale',
  );
  // Out of every text field (the page centre now falls on a text box), so Cmd+Z steps the app history.
  await page.keyboard.press('Escape');
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  for (let n = 0; n < 50; n++) await page.keyboard.press('Meta+z');
  await expect(page.getByTestId('undo-notice').first()).toHaveText(
    /^Undid: Changed In the story on Undo Hale$/,
  );
  await expect
    .poll(async () => (await currentEntry('characters', 'Undo Hale')).role)
    .toBe('Place 1');
  await expect(input).toHaveText('Place 1');
  await page.keyboard.press('Meta+z');
  await expect.poll(async () => (await currentEntry('characters', 'Undo Hale')).role).toBe('');
  await page.keyboard.press('Shift+Meta+z');
  await page.keyboard.press('Shift+Meta+z');
  await expect
    .poll(async () => (await currentEntry('characters', 'Undo Hale')).role)
    .toBe('Place 2');
  await expect(input).toHaveText('Place 2');
  // Redo walks every remaining step forward to the last change.
  for (let n = 0; n < 49; n++) await page.keyboard.press('Shift+Meta+z');
  await expect(page.getByTestId('undo-notice').first()).toHaveText(
    'Redid: Changed In the story on Undo Hale',
  );
  await expect
    .poll(async () => (await currentEntry('characters', 'Undo Hale')).role)
    .toBe('Place 51');
  await expect(input).toHaveText('Place 51');
  await page.keyboard.press('Shift+Meta+z');
  await expect(page.getByTestId('undo-notice').first()).toHaveText('Nothing to redo.');
  expect((await currentEntry('characters', 'Undo Hale')).role).toBe('Place 51');
});

test('ED-3 undo and redo cover creating, deleting, restoring, and editing links', async () => {
  await newCharacter('Temp Person');
  const tools = page.getByTestId('entry-tools');
  // Delete, then undo the delete.
  await tools.getByRole('button', { name: 'Move to trash' }).click();
  await tools
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
  // Edit links, then undo the link edit. SM-1: the character page has no links box, so an open question carries them.
  await openSection('openQuestions');
  await page.getByRole('button', { name: /^New / }).first().click();
  const form = page.getByTestId('new-entry');
  await field(form, 'title').locator('input').fill('Temp question');
  await form.getByRole('button', { name: /^Create / }).click();
  const editor = page.getByTestId('editor');
  await expect(editor.getByRole('heading', { name: 'Temp question' })).toBeVisible();
  await waitSaved(page);
  const links = field(editor, 'links');
  await links.getByPlaceholder('Find an entry to link').fill('Ada Sullivan');
  await links.getByRole('option').filter({ hasText: 'Ada Sullivan' }).first().click();
  await waitSaved(page);
  await expect
    .poll(async () => (await currentEntry('openQuestions', 'Temp question')).links)
    .toHaveLength(1);
  await page.keyboard.press('Meta+z');
  await expect
    .poll(async () => (await currentEntry('openQuestions', 'Temp question')).links)
    .toHaveLength(0);
  // The step before the link edit is the create itself: undoing it sends the entry to the trash.
  await expect(page.getByTestId('undo-notice').first()).toHaveText(
    'Undid: Changed Links on Temp question',
  );
  await page.keyboard.press('Meta+z');
  await expect(page.getByTestId('undo-notice').first()).toHaveText('Undid: Created Temp question');
  await expect
    .poll(async () => Boolean((await currentEntry('openQuestions', 'Temp question')).deletedAt))
    .toBe(true);
  await page.keyboard.press('Shift+Meta+z');
  await expect
    .poll(async () => Boolean((await currentEntry('openQuestions', 'Temp question')).deletedAt))
    .toBe(false);
});

test('ED-4 the history drawer compares any revision with the current entry and restores it', async () => {
  await newCharacter('Revision Doyle', 1950);
  const editor = page.getByTestId('editor');
  const input = field(editor, 'role').getByRole('textbox');
  await input.fill('Cork');
  await waitSaved(page);
  await input.fill('Boston');
  await waitSaved(page);
  await page.getByTestId('entry-tools').getByRole('button', { name: 'History' }).click();
  const drawer = page.getByTestId('history');
  const revisions = drawer
    .getByRole('list', { name: 'Revisions, newest first' })
    .getByRole('button');
  // SM-1: a character is created from the name, then the birth year is a change of its own.
  await expect(revisions).toHaveCount(4);
  await expect(revisions.nth(0)).toContainText('Changed (current)');
  await expect(revisions.nth(3)).toContainText('Created');
  await revisions.nth(1).click();
  const diff = drawer.getByTestId('revision-diff');
  const row = diff.getByRole('row', { name: /In the story/ });
  await expect(row.getByRole('cell').nth(0)).toHaveText('Cork');
  await expect(row.getByRole('cell').nth(1)).toHaveText('Boston');
  await drawer.getByRole('button', { name: 'Restore this version' }).click();
  await expect(revisions).toHaveCount(5);
  await expect(revisions.nth(0)).toContainText('Restored the version from');
  await drawer.getByRole('button', { name: 'Close' }).click();
  await expect(input).toHaveText('Cork');
  expect((await currentEntry('characters', 'Revision Doyle')).role).toBe('Cork');
  // The restore is undoable like any change.
  await page.keyboard.press('Meta+z');
  await expect
    .poll(async () => (await currentEntry('characters', 'Revision Doyle')).role)
    .toBe('Boston');
});

test('ED-5 deleting lists what links here, moves it to the trash, and restores it with its links', async () => {
  // Link Ada from a new character, so Ada has something linking to her. SM-1: the character
  // page has no links box, so the link is a mention typed in the description.
  await newCharacter('Linker Zhou', 1992);
  const editor = page.getByTestId('editor');
  const desc = field(editor, 'body').getByRole('textbox');
  await desc.click();
  await desc.pressSequentially('Cousin of @Ada');
  await expect(
    field(editor, 'body')
      .getByRole('listbox', { name: 'Matching entries' })
      .getByRole('option')
      .first(),
  ).toContainText('Ada Sullivan');
  await page.keyboard.press('Enter');
  await waitSaved(page);

  await openSection('characters');
  await page
    .getByTestId('entry-list')
    .getByRole('button', { name: /Ada Sullivan/ })
    .click();
  const tools = page.getByTestId('entry-tools');
  await expect(tools.getByTestId('linked-from')).toContainText('Character: Linker Zhou');
  await tools.getByRole('button', { name: 'Move to trash' }).click();
  const dialog = tools.getByRole('dialog', { name: 'Move to trash' });
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
    expect.objectContaining({ title: 'Linker Zhou', kind: 'mention' }),
  );
});

/** The revisions MongoDB holds for one entry. */
async function revisionsInMongo(id: string): Promise<number> {
  const client = new MongoClient(db.uri);
  try {
    await client.connect();
    return await client
      .db(db.name)
      .collection(`${BIBLE}.revisions`)
      .countDocuments({ entryId: id });
  } finally {
    await client.close();
  }
}

/** The labels of the undo history, newest first. */
async function undoLabels(): Promise<string[]> {
  const list = await changes(page);
  const labels = await list.locator('li').allTextContents();
  await page.getByTestId('top-changes').click();
  return labels;
}

test('IP-16 ED-5 Delete forever asks for the title typed, then the entry and its revisions are gone, and it is not an undo step', async () => {
  const { entry } = await invoke('entry.create', {
    collection: 'places',
    data: { title: 'Purge Wharf', status: 'idea' },
  });
  await invoke('entry.update', {
    collection: 'places',
    id: entry._id,
    patch: { descriptions: [{ startYear: null, endYear: null, text: 'Pilings in the mud.' }] },
  });
  await invoke('entry.delete', { collection: 'places', id: entry._id });
  const stored = await revisionsInMongo(entry._id);
  expect(stored).toBeGreaterThan(1);
  await rail(page, 'Trash').click();
  const row = page.getByTestId('trash-list').locator(`li[data-id="${entry._id}"]`);
  await expect(row).toContainText('Purge Wharf');
  const labels = await undoLabels();
  await row.getByRole('button', { name: 'Delete Purge Wharf forever' }).click();
  const confirm = row.getByTestId('trash-purge-confirm');
  await expect(confirm).toContainText('This is not an undo step.');
  const typed = confirm.getByLabel('Type Purge Wharf to confirm');
  await expect(typed).toBeFocused();
  const go = confirm.getByRole('button', { name: 'Delete Purge Wharf forever' });
  await expect(go).toBeDisabled();
  await typed.fill('Purge');
  await expect(go).toBeDisabled();
  // Escape keeps it.
  await typed.press('Escape');
  await expect(confirm).toHaveCount(0);
  expect(await fromMongo('places', entry._id)).not.toBeNull();
  await row.getByRole('button', { name: 'Delete Purge Wharf forever' }).click();
  await confirm.getByLabel('Type Purge Wharf to confirm').fill('Purge Wharf');
  await confirm.getByRole('button', { name: 'Delete Purge Wharf forever' }).click();
  await expect(page.getByTestId('trash-notice')).toContainText(
    `Deleted Purge Wharf forever, with ${stored} revisions. This is not an undo step.`,
  );
  await expect(row).toHaveCount(0);
  expect(await fromMongo('places', entry._id)).toBeNull();
  expect(await revisionsInMongo(entry._id)).toBe(0);
  // Nothing was added to the undo history.
  expect(await undoLabels()).toEqual(labels);
});

test('IP-16 Empty trash asks for the word empty, shows the count, and is not an undo step', async () => {
  const ids: string[] = [];
  for (const title of ['Empty Dock One', 'Empty Dock Two']) {
    const { entry } = await invoke('entry.create', {
      collection: 'places',
      data: { title, status: 'idea' },
    });
    await invoke('entry.delete', { collection: 'places', id: entry._id });
    ids.push(entry._id);
  }
  await rail(page, 'Lists').click();
  await rail(page, 'Trash').click();
  const count = (await invoke('trash.list', {})).entries.length;
  expect(count).toBeGreaterThanOrEqual(2);
  const labels = await undoLabels();
  await page.getByTestId('trash-empty-all').click();
  const confirm = page.getByTestId('trash-empty-confirm');
  await expect(confirm).toContainText(`${count} entries and every revision of them`);
  const go = confirm.getByRole('button', { name: `Delete all ${count} entries forever` });
  await expect(go).toBeDisabled();
  await confirm.getByLabel('Type empty to confirm').fill('Empty');
  await go.click();
  await expect(page.getByTestId('trash-notice')).toContainText(
    `Emptied the trash: ${count} entries`,
  );
  await expect(page.getByTestId('trash-notice')).toContainText('This is not an undo step.');
  await expect(page.getByTestId('trash-empty')).toHaveText('The trash is empty.');
  expect((await invoke('trash.list', {})).entries).toEqual([]);
  for (const id of ids) {
    expect(await fromMongo('places', id)).toBeNull();
    expect(await revisionsInMongo(id)).toBe(0);
  }
  expect(await undoLabels()).toEqual(labels);
});

test('IP-16 ED-4 History removes revisions older than a date: a dry run shows the count, then confirm, and the list reloads', async () => {
  const doyle = await currentEntry('characters', 'Revision Doyle');
  const stored = await revisionsInMongo(doyle._id);
  expect(stored).toBeGreaterThan(1);
  await openSection('characters');
  await page
    .getByTestId('entry-list')
    .getByRole('button', { name: /Revision Doyle/ })
    .click();
  await page.getByTestId('entry-tools').getByRole('button', { name: 'History' }).click();
  const drawer = page.getByTestId('history');
  const revisions = drawer
    .getByRole('list', { name: 'Revisions, newest first' })
    .getByRole('button');
  await expect(revisions).toHaveCount(stored);
  const prune = drawer.getByTestId('revision-prune');
  const day = prune.getByLabel('Remove revisions older than');
  // A day before any revision: nothing to remove.
  await day.fill('2000-01-01');
  await prune.getByRole('button', { name: 'Count them' }).click();
  await expect(prune.getByTestId('revision-prune-count')).toHaveText(
    'No revisions of Revision Doyle are older than 2000-01-01.',
  );
  // Tomorrow: every revision, counted first, and nothing removed by counting.
  const tomorrow = await page.evaluate(() => {
    const d = new Date(Date.now() + 86_400_000);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  });
  await day.fill(tomorrow);
  await prune.getByRole('button', { name: 'Count them' }).click();
  await expect(prune.getByTestId('revision-prune-count')).toHaveText(
    `${stored} revisions of Revision Doyle are older than ${tomorrow}. Removing them is not an undo step.`,
  );
  expect(await revisionsInMongo(doyle._id)).toBe(stored);
  await expect(prune.getByRole('button', { name: 'Keep them' })).toBeFocused();
  await prune.getByRole('button', { name: `Remove ${stored} revisions` }).click();
  await expect(prune.getByTestId('revision-prune-notice')).toHaveText(
    `Removed ${stored} revisions from before ${tomorrow}. This is not an undo step.`,
  );
  await expect(revisions).toHaveCount(0);
  await expect(drawer).toContainText('No revisions are kept for this entry.');
  expect(await revisionsInMongo(doyle._id)).toBe(0);
  // The entry itself is untouched.
  expect((await currentEntry('characters', 'Revision Doyle')).role).toBe(doyle.role);
  await drawer.getByRole('button', { name: 'Close' }).click();
});

test('ED-9 typing @ in a long text field searches, inserts a link, and the target shows Linked from', async () => {
  await openSection('characters');
  await page
    .getByTestId('entry-list')
    .getByRole('button', { name: /Linker Zhou/ })
    .click();
  const editor = page.getByTestId('editor');
  const body = field(editor, 'body').getByRole('textbox');
  await body.click();
  await body.press('End');
  await body.pressSequentially('Compare with @Revi');
  const picker = field(editor, 'body').getByRole('listbox', { name: 'Matching entries' });
  await expect(picker.getByRole('option').first()).toContainText('Revision Doyle');
  await page.keyboard.press('Enter');
  await expect(body).toHaveText(/Compare with @Revision Doyle $/);
  await waitSaved(page);
  const linker = await currentEntry('characters', 'Linker Zhou');
  const doyle = await currentEntry('characters', 'Revision Doyle');
  expect(linker.links).toContainEqual({ targetId: doyle._id, kind: 'mention' });

  await page
    .getByTestId('entry-list')
    .getByRole('button', { name: /Revision Doyle/ })
    .click();
  const linked = page.getByTestId('entry-tools').getByTestId('linked-from');
  await expect(linked).toContainText('Character: Linker Zhou');
  await linked.getByRole('button', { name: 'Character: Linker Zhou' }).click();
  await expect(
    page
      .getByTestId('editor')
      .getByTestId('char-heading')
      .getByRole('heading', { name: 'Linker Zhou' }),
  ).toBeVisible();
});

test('ED-10 a death date before the birth date is flagged at the field in plain words and still saves', async () => {
  await newCharacter('Warned Hale', 2000);
  const editor = page.getByTestId('editor');
  const death = field(editor, 'death');
  await fillDateBox(death, '1990');
  await waitSaved(page);
  await expect(death.getByRole('note')).toHaveText(
    'The death date 1990 is before the birth date 2000. It still saves.',
  );
  expect((await currentEntry('characters', 'Warned Hale')).death).toEqual({ year: 1990 });
  await expect(page.getByTestId('editor').getByTestId('warning-count')).toHaveText(
    '1 field has a warning. It still saved.',
  );
  // Fixing it clears the warning.
  await fillDateBox(death, '2070');
  await waitSaved(page);
  await expect(death.getByRole('note')).toHaveCount(0);
});

test('ED-10 a value the schema cannot store is marked at the field and not sent', async () => {
  const editor = page.getByTestId('editor');
  // IP-1: the name is a field in the heading; an empty one is refused there and nothing is sent.
  const name = field(editor, 'names.full');
  await openEditable(name);
  await name.locator('input').fill('');
  await name.locator('input').press('Enter');
  await expect(name.getByRole('alert')).toHaveText('Not saved: Full name cannot be empty.');
  await expect(name).toHaveAttribute('data-save-state', 'error');
  expect(((await currentEntry('characters', 'Warned Hale')).names as { full: string }).full).toBe(
    'Warned Hale',
  );
  await name.locator('input').press('Escape');
  await expect(name.locator('input')).toHaveCount(0);
  await expect(name).toContainText('Warned Hale');
});

async function listItems(listId: string) {
  const list = (await invoke('lists.get', {})).lists.find((l) => l._id === listId);
  if (!list) throw new Error(`No list ${listId}`);
  return list.items;
}
const listPanel = (listId: string) => page.locator(`[data-list="${listId}"]`);
const itemRow = (listId: string, itemId: string) =>
  listPanel(listId).locator(`[data-item="${itemId}"]`);
/** Cmd+Z with nothing focused that holds text (ED-3). */
async function undoStep() {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Meta+z');
}

test('ED-8 renaming a tag on the Lists screen updates every entry that uses it', async () => {
  // SM-1: the character page has no tags box, so two open questions carry the tag.
  await openSection('openQuestions');
  await page.getByRole('button', { name: /^New / }).first().click();
  const form = page.getByTestId('new-entry');
  await field(form, 'title').locator('input').fill('Second question');
  await form.getByRole('button', { name: /^Create / }).click();
  await waitSaved(page);
  for (const name of ['Temp question', 'Second question']) {
    await openSection('openQuestions');
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
  // The row by its item ID: the open field holds the name as a value, not as text.
  const tagId = (await listItems('tags')).find((i) => i.label === 'harbor')!.id;
  const row = panel.locator(`[data-item="${tagId}"]`);
  await expect(row).toContainText('used 2 times');
  // IP-8: the name is a field; Enter renames.
  await fillEditable(row.getByTestId('item-name'), 'the harbor');
  await expect(panel.locator('p[role="status"]')).toHaveText('Renamed. 2 entries were updated.');
  for (const name of ['Temp question', 'Second question']) {
    expect((await currentEntry('openQuestions', name)).tags).toContain('the harbor');
    expect((await currentEntry('openQuestions', name)).tags).not.toContain('harbor');
  }
  // The rename is undoable.
  await page.keyboard.press('Meta+z');
  await expect
    .poll(async () => (await currentEntry('openQuestions', 'Temp question')).tags)
    .toContain('harbor');
});

test('ED-8 renaming a union type changes the name every union shows', async () => {
  await rail(page, 'Lists').click();
  const panel = page.locator('[data-list="unionTypes"]');
  const partnered = (await listItems('unionTypes')).find((i) => i.label === 'Partnered')!.id;
  await fillEditable(
    panel.locator(`[data-item="${partnered}"]`).getByTestId('item-name'),
    'Domestic partners',
  );
  await expect(panel).toContainText('Domestic partners');
  await openSection('unions');
  await page.getByTestId('entry-list').getByRole('button').first().click();
  await expect(
    field(page.getByTestId('editor'), 'type').locator('select option', {
      hasText: 'Domestic partners',
    }),
  ).toHaveCount(1);
});

test('IP-8 a list item moves up and down by its buttons and by drag, each move one undo step, and selects show the stored order', async () => {
  await rail(page, 'Lists').click();
  const ids = async () => (await listItems('parentLinkTypes')).map((i) => i.id);
  const start = await ids();
  expect(start.length).toBeGreaterThanOrEqual(3);
  const [a, b, c] = start as [string, string, string];
  const second = (await listItems('parentLinkTypes'))[1]!;
  await itemRow('parentLinkTypes', b)
    .getByRole('button', { name: `Move ${second.label} up` })
    .click();
  await expect.poll(ids).toEqual([b, a, ...start.slice(2)]);
  // The focus stays with the item: at the top its Up is off, so Down has it.
  await expect(
    itemRow('parentLinkTypes', b).getByRole('button', { name: `Move ${second.label} down` }),
  ).toBeFocused();
  // By keyboard: Enter on Down moves it back.
  await page.keyboard.press('Enter');
  await expect.poll(ids).toEqual(start);
  await undoStep();
  await expect.poll(ids).toEqual([b, a, ...start.slice(2)]);
  await undoStep();
  await expect.poll(ids).toEqual(start);

  // By drag: the first item dropped on the third takes its place.
  await itemRow('parentLinkTypes', a)
    .getByTestId('drag-handle')
    .dragTo(itemRow('parentLinkTypes', c));
  await expect.poll(ids).toEqual([b, c, a, ...start.slice(3)]);
  // A select over the list shows the stored order (the new parent link form).
  const labels = (await listItems('parentLinkTypes')).map((i) => i.label);
  await openSection('parentLinks');
  await page.getByRole('button', { name: /^New / }).first().click();
  const form = page.getByTestId('new-entry');
  const options = await field(form, 'type').locator('select option').allTextContents();
  expect(options.filter((o) => labels.includes(o))).toEqual(labels);
  expect(options.at(-1)).toBe('Add new...');
  await form.getByRole('button', { name: 'Cancel' }).click();
  await undoStep();
  await expect.poll(ids).toEqual(start);
});

test('IP-8 an event category takes a parent in place, never one under itself, and Add new makes the parent in the same step', async () => {
  const harbor = (
    await invoke('lists.addItem', { listId: 'eventCategories', label: 'Harbor works' })
  ).item;
  const cranes = (await invoke('lists.addItem', { listId: 'eventCategories', label: 'Cranes' }))
    .item;
  const parentOf = async (id: string) =>
    (await listItems('eventCategories')).find((i) => i.id === id)?.parentId ?? null;
  await rail(page, 'Lists').click();
  const row = itemRow('eventCategories', cranes.id);
  const under = row.getByTestId('item-parent');
  await expect(row.getByTestId('item-parent-text')).toHaveText('At the top');
  await openEditable(under);
  await under.locator('select').selectOption(harbor.id);
  await expect.poll(() => parentOf(cranes.id)).toBe(harbor.id);
  await expect(row.getByTestId('item-parent-text')).toHaveText('under Harbor works');
  await expect(row.getByTestId('item-name-text')).toHaveText('Harbor works > Cranes');
  // Harbor works cannot go under Cranes, which sits under it.
  const harborUnder = itemRow('eventCategories', harbor.id).getByTestId('item-parent');
  await openEditable(harborUnder);
  await expect(harborUnder.locator(`select option[value="${cranes.id}"]`)).toHaveCount(0);
  await harborUnder.locator('select').press('Escape');
  await undoStep();
  await expect.poll(() => parentOf(cranes.id)).toBeNull();

  // Add new from the Under select: the new item and the move are one step.
  await openEditable(under);
  await under.locator('select').selectOption({ label: 'Add new...' });
  await under.locator('input').fill('Ports');
  await under.locator('input').press('Enter');
  await expect(row.getByTestId('item-parent-text')).toHaveText('under Ports');
  const ports = (await listItems('eventCategories')).find((i) => i.label === 'Ports');
  expect(ports).toBeDefined();
  expect(await parentOf(cranes.id)).toBe(ports!.id);
  await undoStep();
  await expect.poll(() => parentOf(cranes.id)).toBeNull();
  await expect
    .poll(async () => (await listItems('eventCategories')).some((i) => i.label === 'Ports'))
    .toBe(false);
});

test('IP-9 statuses and provenance recolour in place, a status changes kind, and a new status takes its kind when added', async () => {
  await rail(page, 'Lists').click();
  const item = async (listId: string, id: string) =>
    (await listItems(listId)).find((i) => i.id === id);
  await itemRow('statuses', 'idea').getByTestId('item-colour').fill('#aa3300');
  await expect.poll(async () => (await item('statuses', 'idea'))?.color).toBe('#aa3300');
  // An entry's chip shows the new colour on its edge and dot; its text stays in the text colour.
  await invoke('entry.create', {
    collection: 'openQuestions',
    data: { title: 'Who paints the harbor wall?', status: 'idea' },
  });
  await openSection('openQuestions');
  const chip = page
    .getByTestId('entry-list')
    .getByRole('button', { name: /Who paints the harbor wall\?/ })
    .locator('.chip[data-list="statuses"][data-item="idea"]');
  await expect(chip).toHaveCSS('border-top-color', 'rgb(170, 51, 0)');
  await expect(chip.locator('.dot')).toHaveCSS('background-color', 'rgb(170, 51, 0)');
  const fg = await chip.evaluate((el) => getComputedStyle(el).color);
  expect(fg).not.toBe('rgb(170, 51, 0)');
  await rail(page, 'Lists').click();
  await undoStep();
  await expect.poll(async () => (await item('statuses', 'idea'))?.color).toBe('#7a611b');
  await itemRow('provenance', 'invented').getByTestId('item-colour').fill('#225588');
  await expect.poll(async () => (await item('provenance', 'invented'))?.color).toBe('#225588');

  const panel = listPanel('statuses');
  await panel.getByLabel(/^New item for /).fill('Draft');
  await panel.getByLabel('Kind', { exact: true }).selectOption('planned');
  await panel.getByRole('button', { name: /^Add to / }).click();
  await expect
    .poll(async () => (await listItems('statuses')).find((i) => i.label === 'Draft')?.extra.kind)
    .toBe('planned');
  const draft = (await listItems('statuses')).find((i) => i.label === 'Draft')!;
  const kind = itemRow('statuses', draft.id).getByTestId('item-kind');
  await expect(itemRow('statuses', draft.id).getByTestId('item-kind-text')).toHaveText(
    'kind planned',
  );
  await openEditable(kind);
  await kind.locator('select').selectOption('canon');
  await expect.poll(async () => (await item('statuses', draft.id))?.extra.kind).toBe('canon');
  await undoStep();
  await expect.poll(async () => (await item('statuses', draft.id))?.extra.kind).toBe('planned');
  // The last status of a kind cannot change kind away: the reason shows at the field.
  const ideaKind = itemRow('statuses', 'idea').getByTestId('item-kind');
  await openEditable(ideaKind);
  await ideaKind.locator('select').selectOption('canon');
  await expect(ideaKind.getByRole('alert')).toContainText('idea');
  await ideaKind.locator('select').press('Escape');
  expect((await item('statuses', 'idea'))?.extra.kind).toBe('idea');
});

test('IP-9 removing a status in use is refused on the Lists screen with the reason', async () => {
  await rail(page, 'Lists').click();
  const used = (await listItems('statuses')).find((i) => i.id === 'idea')!;
  expect(used.usage).toBeGreaterThan(0);
  await itemRow('statuses', 'idea')
    .getByRole('button', { name: `Remove ${used.label}` })
    .click();
  const note = listPanel('statuses').locator('p[role="status"]');
  await expect(note).toContainText(new RegExp(`(entry uses|entries use) ${used.label}\\.`));
  await expect(note).toContainText('Change them first, or rename the item instead.');
  expect((await listItems('statuses')).some((i) => i.id === 'idea')).toBe(true);
});

test('IP-9 A51 the Moment kinds list on the Lists screen recolours a kind, changes its weight to Large marker as one step, and shows the contrast note for a colour under 3:1', async () => {
  await rail(page, 'Lists').click();
  const kind = async (id: string) => (await listItems('momentKinds')).find((i) => i.id === id);
  const move = itemRow('momentKinds', 'move');
  // A seeded colour is checked on the dark grid by the hex its token draws there.
  await expect(itemRow('momentKinds', 'work').getByTestId('item-contrast-ratios')).toHaveText(
    'Light 8.3:1, Dark 5.6:1',
  );
  await expect(itemRow('momentKinds', 'work').getByTestId('item-contrast-note')).toHaveCount(0);
  await expect(move.getByTestId('item-contrast-ratios')).toHaveText('Light 4.8:1, Dark 3.5:1');
  // Voice has no colour, so no readout.
  await expect(itemRow('momentKinds', 'voice').getByTestId('item-contrast')).toHaveCount(0);

  await move.getByTestId('item-colour').fill('#f0f0f0');
  await expect.poll(async () => (await kind('move'))?.color).toBe('#f0f0f0');
  await expect(move.getByTestId('item-contrast-note')).toHaveText([
    'Hard to see on the light grid',
  ]);
  await expect(move.getByTestId('item-contrast-ratios')).toHaveText(
    /^Light 1\.\d:1, Dark \d+\.\d:1$/,
  );
  // The readout is in the text tokens, never the kind colour.
  const ink = await move
    .getByTestId('item-contrast-ratios')
    .evaluate((el) => getComputedStyle(el).color);
  expect(ink).not.toBe('rgb(240, 240, 240)');

  const weight = move.getByTestId('item-weight');
  await expect(move.getByTestId('item-weight-text')).toHaveText('Plain marker');
  await openEditable(weight);
  await weight.locator('select').selectOption('big');
  await expect.poll(async () => (await kind('move'))?.extra.weight).toBe('big');
  await expect(move.getByTestId('item-weight-text')).toHaveText('Large marker');
  await undoStep();
  await expect.poll(async () => (await kind('move'))?.extra.weight).toBeUndefined();
  await expect(move.getByTestId('item-weight-text')).toHaveText('Plain marker');
  expect((await kind('move'))?.color).toBe('#f0f0f0');
  await undoStep();
  await expect.poll(async () => (await kind('move'))?.color).toBe('#008300');
  await expect(move.getByTestId('item-contrast-note')).toHaveCount(0);
});

test('IP-9 A51 removing a moment kind in use is refused on the Lists screen with the reason', async () => {
  const { entry: who } = await invoke('entry.create', {
    collection: 'characters',
    data: {
      title: 'Ada Kind',
      status: 'canon',
      names: { full: 'Ada Kind' },
      birth: { year: 2001 },
    },
  });
  await invoke('entry.create', {
    collection: 'moments',
    data: { title: 'Marries Ben', characterId: who._id, year: 2030, kind: 'life', status: 'canon' },
  });
  await rail(page, 'Lists').click();
  const life = (await listItems('momentKinds')).find((i) => i.id === 'life')!;
  // Earlier tests may have given other moments this kind too.
  expect(life.usage).toBeGreaterThan(0);
  await expect(itemRow('momentKinds', 'life').locator('.vocab-usage')).toHaveText(
    life.usage === 1 ? 'used once' : `used ${life.usage} times`,
  );
  await itemRow('momentKinds', 'life')
    .getByRole('button', { name: `Remove ${life.label}` })
    .click();
  const note = listPanel('momentKinds').locator('p[role="status"]');
  await expect(note).toContainText(new RegExp(`(entry uses|entries use) ${life.label}\\.`));
  await expect(note).toContainText('Change them first, or rename the item instead.');
  expect((await listItems('momentKinds')).some((i) => i.id === 'life')).toBe(true);
});

test('IP-8 renaming a region on the Lists screen renames it on every event that names it', async () => {
  const cat = (await invoke('lists.addItem', { listId: 'eventCategories', label: 'Sea walls' }))
    .item;
  const { entry } = await invoke('entry.create', {
    collection: 'worldEvents',
    data: {
      title: 'The harbor wall rises',
      start: { year: 2041 },
      categoryId: cat.id,
      regions: ['Harbor Coast'],
      status: 'canon',
    },
  });
  const region = (await listItems('regions')).find((i) => i.label === 'Harbor Coast');
  expect(region).toBeDefined();
  expect(entry.regions).toEqual([region!.id]);
  await rail(page, 'Lists').click();
  await fillEditable(itemRow('regions', region!.id).getByTestId('item-name'), 'Harbour Coast');
  await expect
    .poll(async () => (await listItems('regions')).find((i) => i.id === region!.id)?.label)
    .toBe('Harbour Coast');
  const after = (await invoke('entry.get', { collection: 'worldEvents', id: entry._id })).entry;
  expect(after.regions).toEqual([region!.id]);
  await openSection('worldEvents');
  await page
    .getByTestId('entry-list')
    .getByRole('button', { name: /The harbor wall rises/ })
    .click();
  await expect(field(page.getByTestId('editor'), 'regions')).toContainText('Harbour Coast');
});

test('IP-10 an age group edits its from and to ages in place, one step each', async () => {
  const ages = async () => (await listItems('ageGroups')).find((i) => i.id === '18-30')?.extra;
  const was = await ages();
  await rail(page, 'Lists').click();
  const row = itemRow('ageGroups', '18-30');
  await fillEditable(row.getByTestId('item-from'), '19');
  await expect.poll(async () => (await ages())?.from).toBe(19);
  await fillEditable(row.getByTestId('item-to'), '31');
  await expect.poll(async () => (await ages())?.to).toBe(31);
  await expect(row.getByTestId('item-to-text')).toHaveText('to 31');
  await undoStep();
  await expect.poll(async () => (await ages())?.to).toBe(was?.to);
  await undoStep();
  await expect.poll(async () => (await ages())?.from).toBe(was?.from);
});

test('IP-12 families take a colour and eras their years on the Lists screen', async () => {
  const { entry: fam } = await invoke('entry.create', {
    collection: 'families',
    data: { title: 'Pierce', name: 'Pierce', color: '#2a78d6', status: 'canon' },
  });
  await rail(page, 'Lists').click();
  await itemRow('families', fam._id).getByTestId('item-colour').fill('#336699');
  await expect
    .poll(
      async () => (await invoke('entry.get', { collection: 'families', id: fam._id })).entry.color,
    )
    .toBe('#336699');
  const [era] = await listItems('eraRanges');
  if (!era) throw new Error('No eras in the bible');
  const start = Number(
    (await invoke('entry.get', { collection: 'eraStates', id: era.id })).entry.startYear,
  );
  await fillEditable(itemRow('eraRanges', era.id).getByTestId('era-start'), String(start + 1));
  await expect
    .poll(
      async () =>
        (await invoke('entry.get', { collection: 'eraStates', id: era.id })).entry.startYear,
    )
    .toBe(start + 1);
  await undoStep();
  await expect
    .poll(
      async () =>
        (await invoke('entry.get', { collection: 'eraStates', id: era.id })).entry.startYear,
    )
    .toBe(start);
});

test('ED-6 generated content and imported content are edited like any other field', async () => {
  const cases: [EntryCollection, string][] = [
    ['chapters', 'summary'],
    // IP-18: the manuscript text is locked; only Re-import changes it.
    ['briefs', 'content'],
    ['findings', 'text'],
  ];
  for (const [c, name] of cases) {
    await openSection(c);
    await page.getByTestId('entry-list').getByRole('button').first().click();
    const box = field(page.getByTestId('editor'), name).getByRole('textbox');
    const text = `Edited by hand: ${c} ${name}.`;
    await box.fill(text);
    await waitSaved(page);
    const title = await page.getByTestId('editor').getByRole('heading', { level: 2 }).textContent();
    expect((await currentEntry(c, title ?? ''))[name]).toBe(text);
  }
});

/** Read a stored document straight from MongoDB, not through the app. */
async function fromMongo(collection: string, id: string) {
  const client = new MongoClient(db.uri);
  try {
    await client.connect();
    return await client
      .db(db.name)
      .collection(`${BIBLE}.${collection}`)
      .findOne({ _id: id as never });
  } finally {
    await client.close();
  }
}

test('ED-3 tree edits undo to the start and redo to the end: a union and a parent link, their types, and deleting the union', async () => {
  const ids = await page.evaluate(async () => {
    const make = async (name: string, year: number) =>
      (
        await window.api.invoke('entry.create', {
          collection: 'characters',
          data: { title: name, status: 'canon', names: { full: name }, birth: { year } },
        })
      ).entry._id;
    return {
      mother: await make('Tree Mother', 1955),
      father: await make('Tree Father', 1953),
      child: await make('Tree Child', 1982),
    };
  });
  // Create the union through the editor.
  await openSection('unions');
  await page.getByRole('button', { name: 'New union', exact: true }).click();
  let form = page.getByTestId('new-entry');
  await field(form, 'title').locator('input').fill('Tree union');
  const partners = field(form, 'partnerIds').locator('select');
  await partners.nth(0).selectOption(ids.mother);
  await partners.nth(1).selectOption(ids.father);
  await field(form, 'type').locator('select').selectOption('married');
  await form.getByRole('button', { name: 'Create union' }).click();
  await waitSaved(page);
  const unionId = (await page.getByTestId('editor').getAttribute('data-entry-id'))!;
  // Create the parent link.
  await openSection('parentLinks');
  await page.getByRole('button', { name: 'New parent link', exact: true }).click();
  form = page.getByTestId('new-entry');
  await field(form, 'title').locator('input').fill('Tree parent link');
  await field(form, 'parentId').locator('select').selectOption(ids.mother);
  await field(form, 'childId').locator('select').selectOption(ids.child);
  await field(form, 'type').locator('select').selectOption('biological');
  await form.getByRole('button', { name: 'Create parent link' }).click();
  await waitSaved(page);
  const linkId = (await page.getByTestId('editor').getAttribute('data-entry-id'))!;
  const start = {
    union: await fromMongo('unions', unionId),
    link: await fromMongo('parentLinks', linkId),
  };
  // Change the parent-link type, then the union type, then delete the union.
  await field(page.getByTestId('editor'), 'type').locator('select').selectOption('adoptive');
  await waitSaved(page);
  await openSection('unions');
  await page
    .getByTestId('entry-list')
    .getByRole('button', { name: /Tree union/ })
    .click();
  await field(page.getByTestId('editor'), 'type').locator('select').selectOption('partnered');
  await waitSaved(page);
  const tools = page.getByTestId('entry-tools');
  await tools.getByRole('button', { name: 'Move to trash' }).click();
  await tools
    .getByRole('dialog', { name: 'Move to trash' })
    .getByRole('button', { name: 'Move to trash' })
    .click();
  await expect(page.getByTestId('editor')).toContainText('This entry is in the trash.');
  const end = {
    union: await fromMongo('unions', unionId),
    link: await fromMongo('parentLinks', linkId),
  };
  expect(end.union!.deletedAt).toBeDefined();
  expect([end.union!.type, end.link!.type]).toEqual(['partnered', 'adoptive']);

  // Five steps back: delete, union type, link type, link create, union create.
  await page.locator('body').click();
  for (let i = 0; i < 5; i++) await page.keyboard.press('Meta+z');
  await expect(page.getByTestId('undo-notice').first()).toHaveText('Undid: Created Tree union');
  const atStart = {
    union: await fromMongo('unions', unionId),
    link: await fromMongo('parentLinks', linkId),
  };
  expect([atStart.union!.type, atStart.link!.type]).toEqual(['married', 'biological']);
  expect([Boolean(atStart.union!.deletedAt), Boolean(atStart.link!.deletedAt)]).toEqual([
    true,
    true,
  ]);
  for (const k of ['partnerIds', 'parentId', 'childId', 'title', 'startYear'] as const) {
    expect(atStart.union![k]).toEqual(start.union![k]);
    expect(atStart.link![k]).toEqual(start.link![k]);
  }

  // Five steps forward to the end.
  for (let i = 0; i < 5; i++) await page.keyboard.press('Shift+Meta+z');
  await expect(page.getByTestId('undo-notice').first()).toHaveText(
    'Redid: Moved Tree union to the trash',
  );
  const atEnd = {
    union: await fromMongo('unions', unionId),
    link: await fromMongo('parentLinks', linkId),
  };
  expect([atEnd.union!.type, atEnd.link!.type]).toEqual(['partnered', 'adoptive']);
  expect([Boolean(atEnd.union!.deletedAt), Boolean(atEnd.link!.deletedAt)]).toEqual([true, false]);
});

test('ED-3 Cmd+Z in a text field with unsaved typing undoes the typing, not the last saved change', async () => {
  await openSection('characters');
  await page
    .getByTestId('entry-list')
    .getByRole('button', { name: /Ada Sullivan/ })
    .click();
  const editor = page.getByTestId('editor');
  const input = field(editor, 'role').getByRole('textbox');
  await input.fill('Saved city');
  await waitSaved(page);
  const history = (await changes(page)).locator('li');
  await expect(history.first()).toHaveText('Changed In the story on Ada Sullivan');
  const historyBefore = await history.allTextContents();
  await input.fill('Unsaved typing');
  await page.keyboard.press('Meta+z');
  await expect(input).toHaveText('Saved city');
  await waitSaved(page);
  expect((await currentEntry('characters', 'Ada Sullivan')).role).toBe('Saved city');
  expect(await (await changes(page)).locator('li').allTextContents()).toEqual(historyBefore);
  // Back in the field, so the next Cmd+Z is not a text undo of another control.
  await input.focus();
  // With nothing unsaved in the field, Cmd+Z steps back through saved changes again.
  await page.keyboard.press('Meta+z');
  await expect
    .poll(async () => (await currentEntry('characters', 'Ada Sullivan')).role)
    .not.toBe('Saved city');
});

test('ED-7 a proposal waits in the review queue with its diff; approve writes it, reject leaves MongoDB unchanged', async () => {
  const ada = await currentEntry('characters', 'Ada Sullivan');
  const before = await fromMongo('characters', ada._id);
  const propose = (data: Record<string, unknown>, reason: string) =>
    page.evaluate(
      ([id, d, r]) =>
        window.api.invoke('test.propose', {
          source: 'import',
          op: 'update',
          collection: 'characters',
          targetId: id,
          data: d,
          reason: r,
        }),
      [ada._id, data, reason] as const,
    );
  const approveMe = await propose({ role: 'Sacramento' }, 'The workbook says Sacramento.');
  const rejectMe = await propose(
    { backstory: 'A proposed backstory.' },
    'The workbook has a backstory.',
  );

  await rail(page, 'Review queue').click();
  const queue = page.getByTestId('review-queue');
  const card = queue.locator(`[data-proposal="${approveMe.proposal._id}"]`);
  await expect(card).toContainText('The workbook says Sacramento.');
  const cells = (c: typeof card) =>
    c
      .getByTestId('proposal-diff')
      .getByRole('row', { name: /In the story/ })
      .getByRole('cell');
  await expect(cells(card).nth(0)).toHaveText(String(before!.role || 'Blank'));
  await expect(cells(card).nth(1)).toHaveText('Sacramento');
  // Nothing is written before approval: MongoDB still holds the old document.
  expect(await fromMongo('characters', ada._id)).toEqual(before);

  // Edit the proposed value, then approve.
  await card.getByRole('button', { name: 'Edit' }).click();
  await field(card, 'role').getByRole('textbox').fill('Davis');
  await card.getByRole('button', { name: 'Save proposed values' }).click();
  await expect(cells(card).nth(1)).toHaveText('Davis');
  expect((await fromMongo('characters', ada._id))!.role).toBe(before!.role);
  await card.getByRole('button', { name: 'Approve' }).click();
  await expect(card).toHaveCount(0);
  expect((await fromMongo('characters', ada._id))!.role).toBe('Davis');
  await expect(queue).toContainText('Approved after editing');

  const rejectCard = queue.locator(`[data-proposal="${rejectMe.proposal._id}"]`);
  await expect(rejectCard.getByTestId('proposal-diff')).toContainText('A proposed backstory.');
  const beforeReject = await fromMongo('characters', ada._id);
  await rejectCard.getByRole('button', { name: 'Reject' }).click();
  await expect(rejectCard).toHaveCount(0);
  expect(await fromMongo('characters', ada._id)).toEqual(beforeReject);
  await expect(queue).toContainText('Rejected');
});

test('ED-7 a proposal whose entry changed since is refused until compared again', async () => {
  const ada = await currentEntry('characters', 'Ada Sullivan');
  const { proposal } = await page.evaluate(
    (id) =>
      window.api.invoke('test.propose', {
        source: 'claude',
        op: 'update',
        collection: 'characters',
        targetId: id,
        data: { role: 'Modesto' },
      }),
    ada._id,
  );
  await invoke('entry.update', {
    collection: 'characters',
    id: ada._id,
    patch: { role: 'Stockton' },
  });
  await rail(page, 'Lists').click();
  await rail(page, 'Review queue').click();
  const card = page.locator(`[data-proposal="${proposal._id}"]`);
  await expect(card.getByRole('status')).toContainText(
    'This entry changed after the proposal was made',
  );
  await expect(card.getByRole('button', { name: 'Approve' })).toBeDisabled();
  await card.getByRole('button', { name: 'Compare again' }).click();
  await expect(
    card
      .getByTestId('proposal-diff')
      .getByRole('row', { name: /In the story/ })
      .getByRole('cell')
      .nth(0),
  ).toHaveText('Stockton');
  await card.getByRole('button', { name: 'Approve' }).click();
  await expect(card).toHaveCount(0);
  expect((await fromMongo('characters', ada._id))!.role).toBe('Modesto');
});
