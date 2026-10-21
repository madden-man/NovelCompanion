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
 * (`fileDb()`), or a bare address, where the app uses `novel_companion`. The
 * "Where did you stop?" prompt (SL-1) is off unless a test turns it on, so
 * closing the app never waits on a person. Each launch has its own data folder
 * unless the test names one.
 *
 * With `packaged`, the packaged app in release/ starts instead (T-4), under the
 * one documented exception, NOVEL_COMPANION_ALLOW_TEST_URI=1 with the local
 * test database, which is also what lets it honour the recorded Claude, the
 * fake Google, and the pickers named here. A packaged app ignores the skip
 * flag for the stop prompt, so its tests exit the app rather than close it.
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
      NOVEL_COMPANION_SKIP_STOP_PROMPT: '1',
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
  'Sessions',
  'Cultural data',
  'Writing tools',
] as const;

/** SM-6: the App menu's items: the nine utilities, then the reference views. */
export const APP_MENU_ITEMS = [
  'Search and filters',
  'Review queue',
  'Import',
  'Backups',
  'Google Drive',
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

export function field(scope: Locator, path: string): Locator {
  return scope.locator(`[data-field="${path}"]`);
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

/** SM-1: type a date into a character page date box ("2045", "2034-05-01", or blank) and leave it. */
export async function fillDateBox(f: Locator, text: string): Promise<void> {
  await f.locator('input').fill(text);
  await f.locator('input').blur();
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
    case 'text':
    case 'int':
    case 'number':
    case 'year':
    case 'calendarDate':
      await f.locator(':scope > input').fill(value === null ? '' : String(value));
      return;
    case 'longText':
      await f.locator(':scope > .rich-text [role="textbox"]').fill(String(value ?? ''));
      return;
    case 'boolean':
      await f.locator('input[type="checkbox"]').setChecked(value === true);
      return;
    case 'enum':
    case 'listItem':
      await f.locator(':scope > select').selectOption(value === null ? '' : String(value));
      return;
    case 'storyDate': {
      const d = value as Record<string, number> | null;
      // SM-1: the character page has one box per date.
      if ((await f.getAttribute('data-kind')) === 'dateText')
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
      await clearChips(f);
      // SM-1: the character page's families are added through Add family.
      if ((await f.getAttribute('data-kind')) === 'familyChips') {
        for (const id of value as string[]) {
          await f.getByRole('button', { name: 'Add family' }).click();
          await f.getByLabel('Family to add').selectOption(id);
        }
        return;
      }
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
