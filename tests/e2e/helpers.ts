import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { collectionInfo } from '../../src/shared/schema';
import type { EntryCollection, FieldSpec } from '../../src/shared/schema';
import type { Channel, Request, Response } from '../../src/shared/ipc';
import { isPlainObject } from '../../src/shared/domain/paths';
import { dateText } from '../../src/shared/domain/dates';
import type { Invoke } from '../helpers/t5';
import { readFixture } from '../helpers/loadFixture';
import { EXECUTABLE } from '../package/paths';
import { connect } from '../../src/main/db';
import type { Store } from '../../src/main/db';
import { E2E_URI_ENV } from './globalSetup';

const ROOT = join(import.meta.dirname, '../..');

/** A test database: a local MongoDB address and the database the app uses on it. */
export interface TestDb {
  uri: string;
  /** In place of `novel_companion`, through NOVEL_COMPANION_TEST_DB_NAME. */
  name: string;
}

/**
 * This spec file's own database on the run's one replica set, which
 * tests/e2e/globalSetup.ts starts. The name comes from the file name
 * (`tree.spec.ts` is `e2e_tree`), so files on parallel workers never meet.
 * Call it inside a hook or a test.
 */
export function fileDb(): TestDb {
  const uri = process.env[E2E_URI_ENV];
  if (!uri) throw new Error(`${E2E_URI_ENV} is not set; run through playwright.config.ts.`);
  const file = basename(test.info().file).replace(/\.spec\.ts$/, '');
  return { uri, name: `e2e_${file.replace(/[^A-Za-z0-9]/g, '_')}` };
}

/** Connect to a test database as the app would, for seeding and raw reads. The caller closes it. */
export function connectTo(db: TestDb): Promise<Store> {
  return connect(db.uri, {}, db.name);
}

/**
 * Start the built app against a local MongoDB: a spec file's own database
 * (`fileDb()`), or a bare address, where the app uses `novel_companion`. Each
 * launch has its own data folder unless the test names one.
 *
 * With `packaged`, the packaged app in release/ starts instead (T-4), under the
 * one documented exception, NOVEL_COMPANION_ALLOW_TEST_URI=1 with the local
 * test database, which is also what lets it honour the recorded Claude and
 * the pickers named here.
 */
/**
 * The app runs hidden under test (no dock icon, no window on screen, offscreen
 * rendering) so a run never steals the focus; NOVEL_COMPANION_E2E_SHOW=1 shows it.
 */
export const HIDDEN_ENV = {
  NOVEL_COMPANION_HIDDEN: process.env.NOVEL_COMPANION_E2E_SHOW === '1' ? '0' : '1',
};

export async function launch(
  db: TestDb | string,
  env: Record<string, string> = {},
  opts: { packaged?: boolean } = {},
): Promise<{ app: ElectronApplication; page: Page }> {
  const target = typeof db === 'string' ? { uri: db } : db;
  const app = await electron.launch({
    ...(opts.packaged ? { executablePath: EXECUTABLE, args: [] } : { args: [ROOT] }),
    env: {
      ...process.env,
      ...(opts.packaged ? { NOVEL_COMPANION_ALLOW_TEST_URI: '1' } : {}),
      NOVEL_COMPANION_TEST_MONGODB_URI: target.uri,
      ...('name' in target ? { NOVEL_COMPANION_TEST_DB_NAME: target.name } : {}),
      NOVEL_COMPANION_USER_DATA: mkdtempSync(join(tmpdir(), 'nc-e2e-')),
      // T-3: Claude is the recorded fake and the key lives in memory, never the real keychain.
      NOVEL_COMPANION_TEST_CLAUDE: '1',
      ...HIDDEN_ENV,
      ...env,
    },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { app, page };
}

/** `window.api.invoke` from the test, so writes cross the real IPC bridge. */
export function invokeVia(page: Page): Invoke {
  return <C extends Channel>(channel: C, request: Request<C>) =>
    page.evaluate(([c, r]) => window.api.invoke(c as never, r as never), [
      channel,
      request,
    ] as const) as Promise<Response<C>>;
}

/** Locator methods that act on the button, so the App menu opens first for one of its items. */
const RAIL_ACTIONS = new Set([
  'click',
  'dblclick',
  'focus',
  'hover',
  'press',
  'tap',
  'scrollIntoViewIfNeeded',
  'waitFor',
]);

/** SM-6: the nine screens of the rail, in order (A42 added Writing tools). */
export const RAIL_SCREENS = [
  'Characters',
  'Family tree',
  'Outline',
  'World events',
  'Backstory',
  'Continuity checker',
  'Questions',
  'Cultural data',
  'Writing tools',
] as const;

/** SM-6: the App menu's items: the seven utilities, then the reference views. */
export const APP_MENU_ITEMS = [
  'Search and filters',
  'Review queue',
  'Backups',
  'Lists',
  'Trash',
  'Bibles',
  'Settings',
  'Place tree',
  'Romanization',
  'Glossary table',
] as const;

/** Names the specs used before SM-6, while they are renamed. */
const ALIASES: Record<string, string> = { Timeline: 'World events' };

/**
 * A screen in the rail (SM-6), by its name: one of the nine buttons, or an
 * item of the App menu at the rail's foot. Acting on an App menu item (click,
 * focus, press, and the like) opens the menu first. The locator matches the
 * hidden items of a closed menu too, so `count()` and attribute checks work
 * without opening it. "Timeline" still names World events. Any other name
 * throws at once, naming the valid ones, instead of waiting for a button
 * that is not there.
 */
export function rail(page: Page, name: string): Locator {
  const label = ALIASES[name] ?? name;
  const inMenu = (APP_MENU_ITEMS as readonly string[]).includes(label);
  if (!inMenu && !(RAIL_SCREENS as readonly string[]).includes(label)) {
    throw new Error(
      `"${name}" is not in the rail. The rail screens are ${RAIL_SCREENS.join(', ')} ` +
        `("Timeline" still names World events); the App menu items are ${APP_MENU_ITEMS.join(', ')}. ` +
        'A section list opens with sectionList(page, plural).',
    );
  }
  const nav = page.getByRole('navigation', { name: 'Sections' });
  const button = inMenu
    ? nav.getByRole('menuitem', { name: label, exact: true, includeHidden: true })
    : nav.getByTestId('rail-main').getByRole('button', { name: label, exact: true });
  const openMenu = async () => {
    await nav.waitFor();
    if (await button.isVisible()) return;
    const app = nav.getByTestId('app-menu-button');
    if ((await app.getAttribute('aria-expanded')) !== 'true') await app.click();
  };
  if (!inMenu) return button;
  return new Proxy(button, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      const fn = value as (...args: unknown[]) => unknown;
      if (typeof prop === 'string' && RAIL_ACTIONS.has(prop)) {
        return async (...args: unknown[]) => {
          await openMenu();
          return fn.apply(target, args);
        };
      }
      return fn.bind(target);
    },
  });
}

/**
 * SM-6: a section's own list (Chapters, Families, Era states and the rest),
 * which left the rail. It opens from Search and filters: pick the section,
 * then "List every ...".
 */
export async function sectionList(page: Page, plural: string): Promise<void> {
  await rail(page, 'Search and filters').click();
  const view = page.getByTestId('search-view');
  await view.getByLabel('Section').selectOption({ label: plural });
  await view.getByTestId('search-open-section').click();
  await expect(page.getByRole('heading', { name: plural, level: 2 })).toBeVisible();
}

/** A screen of the rail opened on one of its tabs: Continuity checker's Manuscript, Cultural data's Eras. */
export async function screenTab(page: Page, screen: string, tab: string): Promise<void> {
  await rail(page, screen).click();
  await page.getByRole('tab', { name: tab, exact: true }).click();
  await expect(page.getByRole('tab', { name: tab, exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
}

/**
 * TM-1: set the story year as a person does since A45 took the tree's own year
 * box away. The status bar's Story time button opens the dialog, the year box
 * there sets the year as it is typed, and Escape closes the dialog.
 */
export async function setStoryYear(page: Page, year: number | string): Promise<void> {
  await page
    .getByTestId('status-bar')
    .getByRole('button', { name: /^Story time/ })
    .click();
  const dialog = page.getByTestId('story-time-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByTestId('time-year').fill(String(year));
  await expect(dialog.getByTestId('time-now')).toContainText(String(year));
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
}

export function field(scope: Locator, path: string): Locator {
  return scope.locator(`[data-field="${path}"]`);
}

/**
 * ED-3, A43: the session's changes, newest first, in the top bar's Changes
 * popover. Opens the popover when it is closed and returns its list.
 */
export async function changes(page: Page): Promise<Locator> {
  const button = page.getByTestId('top-changes');
  if ((await button.getAttribute('aria-expanded')) !== 'true') await button.click();
  return page.getByTestId('undo-history');
}

/** Wait until every pending change of the open entry is written. */
export async function waitSaved(page: Page): Promise<void> {
  await expect(page.getByTestId('editor').getByTestId('autosave')).toHaveText('Saved');
}

/** Remove nested system fields (item IDs), which the interface makes itself. */
export function withoutSystem(specs: readonly FieldSpec[], value: unknown): unknown {
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const s of specs) {
    if (s.kind === 'system' || !(s.name in value)) continue;
    const v = value[s.name];
    if (s.kind === 'object' && s.fields) out[s.name] = withoutSystem(s.fields, v);
    else if (s.kind === 'objectList' && s.fields && Array.isArray(v)) {
      out[s.name] = v.map((x) => withoutSystem(s.fields!, x));
    } else out[s.name] = v;
  }
  return out;
}

/**
 * Open the list an entry of `collection` is made on, and return the name of
 * its New button and the fields its form presets there and does not show.
 * Characters is a screen of the rail; every other section's list opens from
 * Search and filters (SM-6).
 */
export async function openListFor(
  page: Page,
  _ctx: UiContext,
  collection: EntryCollection,
  _entry: Record<string, unknown>,
): Promise<{ newButton: string; preset: Record<string, unknown> }> {
  if (collection === 'characters') await rail(page, 'Characters').click();
  else await sectionList(page, collectionInfo[collection].plural);
  return { newButton: `New ${collectionInfo[collection].singular.toLowerCase()}`, preset: {} };
}

export interface UiContext {
  page: Page;
  /** The title of an entry, for typing into a search picker. */
  titleOf(id: string): Promise<string>;
}

async function pickBySearch(ctx: UiContext, scope: Locator, id: string, placeholder: RegExp) {
  const title = await ctx.titleOf(id);
  const box = scope.getByPlaceholder(placeholder).last();
  await box.fill(title);
  const option = scope
    .getByRole('option')
    .filter({ has: ctx.page.locator('span', { hasText: new RegExp(`^${escape(title)}$`) }) });
  await option.first().click();
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const anywhere = (s: FieldSpec) => !s.target || s.target[0] === '*';

async function clearChips(f: Locator) {
  const chips = f.locator(':scope > .chips .chip-remove');
  while ((await chips.count()) > 0) await chips.first().click();
}

/**
 * Set one field through the editor the way a person would: typing, picking,
 * adding and removing items (ED-1). Walks into groups and lists by the manifest.
 */
/** A38: open every closed caret section above an element, so it can be seen and used. */
export async function reveal(target: Locator): Promise<void> {
  await target.first().evaluate((el) => {
    for (let d = el.closest('details'); d; d = d.parentElement?.closest('details') ?? null) {
      if (!d.open) d.open = true;
    }
  });
}

/**
 * SM-9, A49: open a moment in its dialog by clicking its marker on the
 * Backstory grid, and return the dialog once it shows that moment.
 */
export async function openMoment(page: Page, id: string): Promise<Locator> {
  await page.getByTestId('backstory-grid').locator(`.wg-marker[data-id="${id}"]`).click();
  const dialog = page.getByTestId('moment-dialog');
  await expect(dialog).toHaveAttribute('data-id', id);
  return dialog;
}

/** IP-1: open an `Editable` (its root, found by `data-field`) by clicking its text. */
export async function openEditable(f: Locator): Promise<void> {
  if ((await f.locator('input, select').count()) === 0) {
    await f.locator('.editable-text').first().click();
  }
}

/**
 * IP-1: type into an `Editable` and save it with Enter (or leave it with
 * `blur`), then wait until it has saved and closed.
 */
export async function fillEditable(f: Locator, text: string, how: 'Enter' | 'blur' = 'Enter') {
  await openEditable(f);
  const input = f.locator('input');
  await input.fill(text);
  if (how === 'Enter') await input.press('Enter');
  else await input.blur();
  await expect(f.locator('input')).toHaveCount(0);
}

/** SM-1, IP-1: type a date into a character page date field ("2045", "2034-05-01", or blank) and leave it. */
export async function fillDateBox(f: Locator, text: string): Promise<void> {
  await fillEditable(f, text, 'blur');
}

export async function setField(
  ctx: UiContext,
  scope: Locator,
  spec: FieldSpec,
  path: string,
  value: unknown,
  root: Record<string, unknown>,
): Promise<void> {
  const f = field(scope, path);
  await reveal(f);
  switch (spec.kind) {
    case 'color':
      await f.locator(':scope > input').fill(String(value));
      return;
    case 'text':
    case 'int':
    case 'number':
    case 'year':
    case 'calendarDate':
      await f.locator(':scope > input').fill(value === null ? '' : String(value));
      return;
    case 'longText': {
      // A44: a single newline is a line break, typed with Shift+Enter (Enter starts a paragraph).
      const box = f.locator(':scope > .rich-text [role="textbox"]');
      const [first = '', ...rest] = String(value ?? '').split('\n');
      await box.fill(first);
      for (const line of rest) {
        await box.press('Shift+Enter');
        await box.pressSequentially(line);
      }
      return;
    }
    case 'boolean':
      await f.locator('input[type="checkbox"]').setChecked(value === true);
      return;
    case 'enum':
    case 'listItem':
      if ((await f.getAttribute('data-editable')) === 'select') {
        await openEditable(f);
        const select = f.locator('select');
        const want = value === null ? '' : String(value);
        if ((await select.inputValue()) === want) await select.press('Escape');
        else await select.selectOption(want);
        await expect(select).toHaveCount(0);
        return;
      }
      await f.locator(':scope > select').selectOption(value === null ? '' : String(value));
      return;
    case 'listItems': {
      await clearChips(f);
      for (const s of value as string[]) await f.locator(':scope > select').selectOption(s);
      return;
    }
    case 'storyDate': {
      const d = value as Record<string, number> | null;
      // SM-1: the character page has one box per date.
      if ((await f.getAttribute('data-editable')) === 'date')
        return fillDateBox(f, dateText(d as never));
      const kind = f.getByLabel('Kind of date');
      if (d === null) return void (await kind.selectOption('none'));
      if ('unknown' in d) return void (await kind.selectOption('unknown'));
      await kind.selectOption(d.month !== undefined ? 'full' : 'year');
      await f.getByLabel('Year', { exact: true }).fill(String(d.year));
      if (d.month !== undefined) await f.getByLabel('Month').fill(String(d.month));
      if (d.day !== undefined) await f.getByLabel('Day').fill(String(d.day));
      return;
    }
    case 'tags':
    case 'strings': {
      await clearChips(f);
      const input = f.locator('.add-row > input');
      for (const s of value as string[]) {
        await input.fill(s);
        await input.press('Enter');
      }
      return;
    }
    case 'ref':
      if (anywhere(spec)) {
        await clearChips(f);
        if (value) await pickBySearch(ctx, f, String(value), /^Find an entry/);
      } else {
        await f.locator(':scope > select').selectOption(value === null ? '' : String(value));
      }
      return;
    case 'refs':
      // IP-1: a chip row adds through its picker; each add or remove saves at once.
      if ((await f.getAttribute('data-editable')) === 'chips') {
        const remove = f.locator('.chip-remove');
        while ((await remove.count()) > 0) {
          const n = await remove.count();
          await remove.first().click();
          await expect(remove).toHaveCount(n - 1);
        }
        for (const id of value as string[]) {
          await f.locator('.editable-add').click();
          await f.locator(`[role="option"][data-value="${id}"]`).click();
          await expect(f.getByRole('combobox')).toHaveCount(0);
        }
        return;
      }
      await clearChips(f);
      for (const id of value as string[]) {
        if (anywhere(spec)) await pickBySearch(ctx, f, id, /^Add to/);
        else await f.locator(':scope > select').selectOption(id);
      }
      return;
    case 'refPair': {
      const [a, b] = value as [string, string];
      const selects = f.locator(':scope > .row > select');
      await selects.nth(0).selectOption(a);
      await selects.nth(1).selectOption(b);
      return;
    }
    case 'links':
      await clearChips(f);
      for (const l of value as { targetId: string; kind: string }[]) {
        await f.getByLabel('Link kind').fill(l.kind);
        await pickBySearch(ctx, f, l.targetId, /^Find an entry to link/);
      }
      return;
    case 'object': {
      const v = value as Record<string, unknown>;
      for (const sub of spec.fields ?? []) {
        if (sub.kind === 'system' || !(sub.name in v)) continue;
        await setField(ctx, f, sub, `${path}.${sub.name}`, v[sub.name], root);
      }
      return;
    }
    case 'objectList': {
      const items = value as Record<string, unknown>[];
      // KB-3, A40: a chapter's strands use the strand cards, not the generic list.
      if ((await f.getByRole('button', { name: 'Add a strand', exact: true }).count()) > 0)
        return setStrands(ctx, f, spec, path, items, root);
      const cards = f.locator(':scope > ol > li.item-card');
      const before = await cards.count();
      for (const [i, item] of items.entries()) {
        await f.getByRole('button', { name: `Add to ${spec.label}`, exact: true }).click();
        const at = `${path}.${before + i}`;
        for (const sub of spec.fields ?? []) {
          if (sub.kind === 'system' || !(sub.name in item)) continue;
          await setField(ctx, f, sub, `${at}.${sub.name}`, item[sub.name], root);
        }
      }
      for (let i = 0; i < before; i++) {
        await cards
          .first()
          .locator(':scope > .item-head')
          .getByRole('button', { name: /^Remove/ })
          .click();
      }
      return;
    }
    case 'system':
      return;
  }
}

/**
 * KB-3, PL-4, ED-1: set a chapter's strands through the strand cards. Adds a
 * card per new strand and fills it (primary is a radio, the characters present
 * and the places are add selects), then removes the cards that were there.
 */
async function setStrands(
  ctx: UiContext,
  f: Locator,
  spec: FieldSpec,
  path: string,
  items: Record<string, unknown>[],
  root: Record<string, unknown>,
): Promise<void> {
  const cards = f.locator('[data-testid="chapter-strand"]');
  const before = await cards.count();
  for (const [i, item] of items.entries()) {
    await f.getByRole('button', { name: 'Add a strand', exact: true }).click();
    await expect(cards).toHaveCount(before + i + 1);
    const at = `${path}.${before + i}`;
    const card = cards.nth(before + i);
    for (const sub of spec.fields ?? []) {
      if (sub.kind === 'system' || !(sub.name in item)) continue;
      const v = item[sub.name];
      if (sub.name === 'primary') {
        if (v === true) await card.getByRole('radio', { name: 'Primary strand' }).check();
      } else if (sub.name === 'characterIds' || sub.name === 'placeIds') {
        const select = field(card, `${at}.${sub.name}`).locator('select');
        for (const id of v as string[]) await select.selectOption(id);
      } else {
        await setField(ctx, f, sub, `${at}.${sub.name}`, v, root);
      }
    }
  }
  for (let i = 0; i < before; i++) {
    await cards
      .first()
      .getByRole('button', { name: /^Remove the strand/ })
      .click();
  }
  await expect(cards).toHaveCount(items.length);
}

/**
 * A47 (IP-8): write the fixture's list items a new bible does not hold yet, so
 * entries seeded with `test.seed` find their items (a region shows as
 * "Oregon", not as an item made from its ID). Items whose ID the list already
 * has are left as they are; parents come before their children in the fixture.
 */
export async function seedFixtureLists(invoke: Invoke): Promise<void> {
  const lists = readFixture().lists ?? [];
  const held = (await invoke('lists.get', {})).lists;
  for (const list of lists) {
    const heldItems = held.find((l) => l._id === list._id)?.items ?? [];
    const have = new Set(heldItems.map((i) => i.id));
    // A spec may have added an item by hand under the same name; a list refuses a second one.
    const names = new Set(heldItems.map((i) => i.label));
    const items = (list.items ?? []) as {
      id: string;
      label: string;
      parentId: string | null;
      color?: string | null;
      extra?: Record<string, string | number>;
    }[];
    for (const i of items) {
      if (have.has(i.id) || names.has(i.label)) continue;
      await invoke('lists.addItem', {
        listId: String(list._id) as never,
        label: i.label,
        id: i.id,
        parentId: i.parentId ?? null,
        ...(i.color ? { color: i.color } : {}),
        ...(i.extra && Object.keys(i.extra).length ? { extra: i.extra } : {}),
      });
      have.add(i.id);
      names.add(i.label);
    }
  }
}

type SeedItems = Request<'test.seed'>['items'];

/**
 * Seed entries the way `test.seed` does, after the fixture's list items
 * (`seedFixtureLists`), so a seeded entry's region, status, provenance or age
 * group shows its label, never its ID. Every spec seeds through this; the
 * lists go first because a write that meets an unknown item ID keeps the ID.
 */
export async function seedFixture(
  invoke: Invoke,
  items: SeedItems,
): Promise<Response<'test.seed'>> {
  await seedFixtureLists(invoke);
  return invoke('test.seed', { items });
}
