import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { collectionInfo } from '../../src/shared/schema';
import type { EntryCollection, FieldSpec } from '../../src/shared/schema';
import type { Channel, Request, Response } from '../../src/shared/ipc';
import { isPlainObject } from '../../src/shared/domain/paths';
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

/** Locator methods that act on the button, so the More disclosure opens first (KB-8). */
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

/** The Entries screen's tabs (KB-5), which were rail items before M11. */
const ENTRIES_TABS = new Set(['Culture by year', 'Place tree', 'Romanization', 'Glossary table']);

/**
 * A button in the rail. KB-1 puts everything but the five screens under the
 * "More" disclosure; acting on a button there (click, focus, press, and the
 * like) opens More first when the button is not visible. The locator matches
 * hidden buttons too, so `count()` finds one inside a closed More. A name the
 * rail does not have (Culture by year, Place tree, Romanization, Glossary
 * table: KB-5) is reached as a tab of the Entries screen.
 */
export function rail(page: Page, name: string): Locator {
  const nav = page.getByRole('navigation', { name: 'Sections' });
  const button = nav.getByRole('button', { name, exact: true, includeHidden: true });
  const openMore = async () => {
    await nav.waitFor();
    if (await button.isVisible()) return;
    const more = nav.locator('details.rail-more');
    if (!(await more.count())) return;
    if (!(await more.evaluate((d) => (d as HTMLDetailsElement).open))) {
      await more.locator('summary').click();
    }
  };
  /** The Entries screen's tab for a name the rail lacks, or null. */
  const viaEntries = async (): Promise<Locator | null> => {
    if (!ENTRIES_TABS.has(name)) return null;
    await nav.waitFor();
    if (await button.count()) return null;
    const entries = nav.getByRole('button', { name: 'Entries', exact: true });
    if (!(await entries.count())) return null;
    await entries.click();
    const view = page.getByTestId('entries-view');
    await view.waitFor();
    const tab = view.getByRole('tablist', { name: 'Entries screens' }).getByRole('tab', {
      name,
      exact: true,
    });
    return (await tab.count()) ? tab : null;
  };
  return new Proxy(button, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      const fn = value as (...args: unknown[]) => unknown;
      if (typeof prop === 'string' && RAIL_ACTIONS.has(prop)) {
        return async (...args: unknown[]) => {
          const there = await viaEntries();
          if (there) {
            const act = Reflect.get(there, prop) as (...a: unknown[]) => unknown;
            return act.apply(there, args);
          }
          await openMore();
          return fn.apply(target, args);
        };
      }
      return fn.bind(target);
    },
  });
}

/** Open the rail's More disclosure (KB-1) when it is closed. */
export async function openMore(page: Page): Promise<void> {
  const more = page.getByRole('navigation', { name: 'Sections' }).locator('details.rail-more');
  if (!(await more.evaluate((d) => (d as HTMLDetailsElement).open))) {
    await more.locator('summary').click();
  }
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
 * Every section has a rail item named for it, except custom entries (KB-4):
 * those are listed per custom section, each its own rail item named for the
 * section, and the form on it presets the section.
 */
export async function openListFor(
  page: Page,
  ctx: UiContext,
  collection: EntryCollection,
  entry: Record<string, unknown>,
): Promise<{ newButton: string; preset: Record<string, unknown> }> {
  if (collection === 'customEntries') {
    const section = await ctx.titleOf(String(entry.sectionId));
    await rail(page, section).click();
    return { newButton: `New entry in ${section}`, preset: { sectionId: entry.sectionId } };
  }
  await rail(page, collectionInfo[collection].plural).click();
  return { newButton: `New ${collectionInfo[collection].singular.toLowerCase()}`, preset: {} };
}

export interface UiContext {
  page: Page;
  /** The title of an entry, for typing into a search picker. */
  titleOf(id: string): Promise<string>;
  customSpecs(sectionId: string): FieldSpec[] | undefined;
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
export async function setField(
  ctx: UiContext,
  scope: Locator,
  spec: FieldSpec,
  path: string,
  value: unknown,
  root: Record<string, unknown>,
): Promise<void> {
  const f = field(scope, path);
  switch (spec.kind) {
    case 'text':
    case 'int':
    case 'number':
    case 'year':
    case 'calendarDate':
      await f.locator(':scope > input').fill(value === null ? '' : String(value));
      return;
    case 'longText':
      await f.locator(':scope > textarea').fill(String(value ?? ''));
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
      const kind = f.getByLabel('Kind of date');
      if (d === null) return void (await kind.selectOption('none'));
      if ('unknown' in d) return void (await kind.selectOption('unknown'));
      await kind.selectOption(d.month !== undefined ? 'full' : 'year');
      await f.getByLabel('Year', { exact: true }).fill(String(d.year));
      if (d.month !== undefined) await f.getByLabel('Month').fill(String(d.month));
      if (d.day !== undefined) await f.getByLabel('Day').fill(String(d.day));
      return;
    }
    case 'yearOrAge': {
      const v = value as Record<string, number>;
      const mode = 'age' in v ? 'age' : 'year';
      await f.getByLabel('Stamped by').selectOption(mode);
      await f.getByLabel(mode === 'age' ? 'Age' : 'Year', { exact: true }).fill(String(v[mode]));
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
    case 'customValues': {
      const specs = ctx.customSpecs(String(root.sectionId));
      if (!specs) throw new Error('No section for custom values');
      const v = value as Record<string, unknown>;
      for (const sub of specs) {
        if (!(sub.name in v)) continue;
        await setField(ctx, f, sub, `${path}.${sub.name}`, v[sub.name], root);
      }
      return;
    }
    case 'system':
      return;
  }
}
