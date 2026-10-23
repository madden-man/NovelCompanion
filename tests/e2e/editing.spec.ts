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
  momentThroughDialog,
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
    if (c === 'moments') {
      // A50: a moment's editor is its Backstory dialog.
      failures.push(...(await momentThroughDialog(page, invoke, a, b)));
      continue;
    }
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
 * SM-1: the fields the character page edits. The title follows the full name.
 */
const CHARACTER_PAGE_FIELDS = [
  'names',
  'birth',
  'death',
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

test('ED-3 undo and redo cover creating, deleting, restoring, and editing what a question is about', async () => {
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
  // Edit what an open question is about, then undo that edit.
  await openSection('openQuestions');
  await page.getByRole('button', { name: /^New / }).first().click();
  const form = page.getByTestId('new-entry');
  await field(form, 'title').locator('input').fill('Temp question');
  await form.getByRole('button', { name: /^Create / }).click();
  const editor = page.getByTestId('editor');
  await expect(editor.getByRole('heading', { name: 'Temp question' })).toBeVisible();
  await waitSaved(page);
  const about = field(editor, 'aboutIds');
  await about.getByPlaceholder('Add to About').fill('Ada Sullivan');
  await about.getByRole('option').filter({ hasText: 'Ada Sullivan' }).first().click();
  await waitSaved(page);
  await expect
    .poll(async () => (await currentEntry('openQuestions', 'Temp question')).aboutIds)
    .toHaveLength(1);
  await page.keyboard.press('Meta+z');
  await expect
    .poll(async () => (await currentEntry('openQuestions', 'Temp question')).aboutIds)
    .toHaveLength(0);
  // The step before the About edit is the create itself: undoing it sends the entry to the trash.
  await expect(page.getByTestId('undo-notice').first()).toHaveText(
    'Undid: Changed About on Temp question',
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

test('ED-5 Move to trash asks once, moves the entry to the trash, and restores it', async () => {
  await openSection('characters');
  await page
    .getByTestId('entry-list')
    .getByRole('button', { name: /Ada Sullivan/ })
    .click();
  const tools = page.getByTestId('entry-tools');
  await tools.getByRole('button', { name: 'Move to trash' }).click();
  const dialog = tools.getByRole('dialog', { name: 'Move to trash' });
  await expect(dialog.locator('strong')).toHaveText('Move Ada Sullivan to the trash?');
  // A52: the confirm is the question and two buttons; no list of what refers to it.
  await expect(dialog.getByRole('button')).toHaveText(['Move to trash', 'Keep it']);
  await expect(dialog.getByRole('listitem')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Keep it' })).toBeFocused();
  await dialog.getByRole('button', { name: 'Keep it' }).click();
  await expect(dialog).toHaveCount(0);
  expect((await currentEntry('characters', 'Ada Sullivan')).deletedAt).toBeUndefined();
  await tools.getByRole('button', { name: 'Move to trash' }).click();
  await dialog.getByRole('button', { name: 'Move to trash' }).click();
  await expect(page.getByTestId('editor')).toContainText(
    'This entry is in the trash. Restore it to bring it back.',
  );
  expect((await currentEntry('characters', 'Ada Sullivan')).deletedAt).toBeTruthy();

  await rail(page, 'Trash').click();
  const trash = page.getByTestId('trash-list');
  await expect(trash).toContainText('Ada Sullivan');
  await trash.getByRole('button', { name: 'Restore Ada Sullivan' }).click();
  await expect(page.getByTestId('trash-notice')).toHaveText('Ada Sullivan is back.');
  await expect(page.getByRole('button', { name: 'Restore Ada Sullivan' })).toHaveCount(0);
  const ada = await currentEntry('characters', 'Ada Sullivan');
  expect(ada.deletedAt).toBeUndefined();
});

test('A52 an entry page shows no status, provenance, source, tags, links or history, and @ types an @ with no picker', async () => {
  const removed = ['status', 'provenance', 'sourceNote', 'sourceRef', 'tags', 'links'];
  const labels = /^(Status|Provenance|Source note|Source location|Tags|Links|Linked from|History)$/;
  // The generic page: an open question.
  await openSection('openQuestions');
  await page
    .getByTestId('entry-list')
    .getByRole('button', { name: /Temp question/ })
    .click();
  const editor = page.getByTestId('editor');
  await expect(editor.getByRole('heading', { name: 'Temp question' })).toBeVisible();
  for (const name of removed) {
    await expect(editor.locator(`[data-field="${name}"]`)).toHaveCount(0);
  }
  await expect(editor.locator('.ed-label, .eyebrow', { hasText: labels })).toHaveCount(0);
  // The foot holds the dates and Move to trash, nothing else.
  const tools = page.getByTestId('entry-tools');
  await expect(tools.locator('dt')).toHaveText(['Created', 'Last changed']);
  await expect(tools.getByRole('button')).toHaveText(['Move to trash']);
  await expect(page.getByTestId('linked-from')).toHaveCount(0);
  await expect(page.getByTestId('history')).toHaveCount(0);

  // `@` types an `@`: nothing opens and nothing is stored behind it.
  const box = field(editor, 'question').getByRole('textbox');
  await box.click();
  await box.pressSequentially('Ask @Ada');
  await expect(box).toHaveText('Ask @Ada');
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await expect(box).not.toHaveAttribute('aria-controls');
  await waitSaved(page);
  const saved = await currentEntry('openQuestions', 'Temp question');
  expect(saved.question).toContain('Ask @Ada');
  expect(saved).not.toHaveProperty('links');

  // Text that already says `@Title` stays as typed, with no chip.
  await invoke('entry.update', {
    collection: 'openQuestions',
    id: saved._id,
    patch: { question: 'Cousin of @Ada Sullivan?' },
  });
  await expect(box).toHaveText('Cousin of @Ada Sullivan?');
  await expect(editor.locator('.mention-chip, [data-mention]')).toHaveCount(0);

  // SM-1: the character page's dates line is birth, death, families and age; its foot the same.
  await openSection('characters');
  await page
    .getByTestId('entry-list')
    .getByRole('button', { name: /Ada Sullivan/ })
    .click();
  const line = page.getByTestId('char-line');
  await expect(line).toBeVisible();
  await expect(line).not.toContainText('Status');
  await expect(line.locator('[data-field="status"]')).toHaveCount(0);
  await expect(page.getByTestId('entry-tools').getByRole('button')).toHaveText(['Move to trash']);

  // IP-16: Settings keeps no revisions to remove.
  await rail(page, 'Settings').click();
  const settings = page.getByTestId('settings-view');
  await expect(settings.getByRole('heading', { name: 'Numbers' })).toBeVisible();
  await expect(settings.getByText('Remove revisions older than')).toHaveCount(0);
  await expect(settings.getByRole('heading', { name: 'Revisions' })).toHaveCount(0);
});

/** The labels of the undo history, newest first. */
async function undoLabels(): Promise<string[]> {
  const list = await changes(page);
  const labels = await list.locator('li').allTextContents();
  await page.getByTestId('top-changes').click();
  return labels;
}

test('IP-16 ED-5 Delete forever asks for the title typed, then the entry is gone, and it is not an undo step', async () => {
  const { entry } = await invoke('entry.create', {
    collection: 'places',
    data: { title: 'Purge Wharf' },
  });
  await invoke('entry.update', {
    collection: 'places',
    id: entry._id,
    patch: { descriptions: [{ startYear: null, endYear: null, text: 'Pilings in the mud.' }] },
  });
  await invoke('entry.delete', { collection: 'places', id: entry._id });
  await rail(page, 'Trash').click();
  const row = page.getByTestId('trash-list').locator(`li[data-id="${entry._id}"]`);
  await expect(row).toContainText('Purge Wharf');
  const labels = await undoLabels();
  await row.getByRole('button', { name: 'Delete Purge Wharf forever' }).click();
  const confirm = row.getByTestId('trash-purge-confirm');
  await expect(confirm).toContainText(
    'Purge Wharf will be deleted forever. This is not an undo step.',
  );
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
    'Deleted Purge Wharf forever. This is not an undo step.',
  );
  await expect(row).toHaveCount(0);
  expect(await fromMongo('places', entry._id)).toBeNull();
  // Nothing was added to the undo history.
  expect(await undoLabels()).toEqual(labels);
});

test('IP-16 Empty trash asks for the word empty, shows the count, and is not an undo step', async () => {
  const ids: string[] = [];
  for (const title of ['Empty Dock One', 'Empty Dock Two']) {
    const { entry } = await invoke('entry.create', {
      collection: 'places',
      data: { title },
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
  await expect(confirm).toContainText(`${count} entries will be deleted forever.`);
  const go = confirm.getByRole('button', { name: `Delete all ${count} entries forever` });
  await expect(go).toBeDisabled();
  await confirm.getByLabel('Type empty to confirm').fill('Empty');
  await go.click();
  await expect(page.getByTestId('trash-notice')).toHaveText(
    `Emptied the trash: ${count} entries deleted forever. This is not an undo step.`,
  );
  await expect(page.getByTestId('trash-notice')).toContainText('This is not an undo step.');
  await expect(page.getByTestId('trash-empty')).toHaveText('The trash is empty.');
  expect((await invoke('trash.list', {})).entries).toEqual([]);
  for (const id of ids) {
    expect(await fromMongo('places', id)).toBeNull();
  }
  expect(await undoLabels()).toEqual(labels);
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

test('ED-8 renaming a community on the Lists screen updates every entry that uses it', async () => {
  const { item } = await invoke('lists.addItem', {
    listId: 'communities',
    label: 'Harbor families',
  });
  for (const title of ['North Pier', 'South Pier']) {
    await invoke('entry.create', {
      collection: 'places',
      data: { title, communityId: item.id },
    });
  }
  await rail(page, 'Lists').click();
  const row = itemRow('communities', item.id);
  await expect(row).toContainText('used 2 times');
  // IP-8: the name is a field; Enter renames.
  await fillEditable(row.getByTestId('item-name'), 'Harbour families');
  await expect(listPanel('communities').locator('p[role="status"]')).toHaveText(
    'Renamed. Every entry shows the new name.',
  );
  const label = async () => (await listItems('communities')).find((i) => i.id === item.id)?.label;
  expect(await label()).toBe('Harbour families');
  // The entries keep the item's ID, so each shows the new name.
  for (const title of ['North Pier', 'South Pier']) {
    expect((await currentEntry('places', title)).communityId).toBe(item.id);
  }
  await openSection('places');
  await page
    .getByTestId('entry-list')
    .getByRole('button', { name: /North Pier/ })
    .click();
  await expect(
    field(page.getByTestId('editor'), 'communityId').locator('select option:checked'),
  ).toHaveText('Harbour families');
  // The rename is undoable.
  await rail(page, 'Lists').click();
  await undoStep();
  await expect.poll(label).toBe('Harbor families');
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
      names: { full: 'Ada Kind' },
      birth: { year: 2001 },
    },
  });
  await invoke('entry.create', {
    collection: 'moments',
    data: { title: 'Marries Ben', characterId: who._id, year: 2030, kind: 'life' },
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
    data: { title: 'Pierce', name: 'Pierce', color: '#2a78d6' },
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
          data: { title: name, names: { full: name }, birth: { year } },
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
