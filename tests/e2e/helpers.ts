import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect } from '@playwright/test';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import type { FieldSpec } from '../../src/shared/schema';
import type { Channel, Request, Response } from '../../src/shared/ipc';
import { isPlainObject } from '../../src/shared/domain/paths';
import type { Invoke } from '../helpers/t5';

const ROOT = join(import.meta.dirname, '../..');

/**
 * Start the built app against a local MongoDB. The "Where did you stop?" prompt
 * (SL-1) is off unless a test turns it on, so closing the app never waits on a person.
 */
export async function launch(
  uri: string,
  env: Record<string, string> = {},
): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: [ROOT],
    env: {
      ...process.env,
      NOVEL_COMPANION_TEST_MONGODB_URI: uri,
      NOVEL_COMPANION_SKIP_STOP_PROMPT: '1',
      NOVEL_COMPANION_USER_DATA: mkdtempSync(join(tmpdir(), 'nc-e2e-')),
      // T-3: Claude is the recorded fake and the key lives in memory, never the real keychain.
      NOVEL_COMPANION_TEST_CLAUDE: '1',
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

export function rail(page: Page, name: string): Locator {
  return page
    .getByRole('navigation', { name: 'Sections' })
    .getByRole('button', { name, exact: true });
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
