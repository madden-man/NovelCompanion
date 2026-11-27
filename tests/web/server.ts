import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { basename, join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { connect } from '../../src/main/db';
import type { Store } from '../../src/main/db';
import { loadFixture } from '../helpers/loadFixture';

const ROOT = join(import.meta.dirname, '../..');

/** Where tests/web/globalSetup.ts passes the run's one replica set to the workers. */
export const WEB_URI_ENV = 'NC_WEB_MONGODB_URI';
/** The key the local function is started with, unless a test changes it. */
export const TEST_KEY = 'test-phone-key-0123456789abcdef';
/** The fixture novel's bible in each spec file's database. */
export const SLUG = 'fixture-novel';

export interface WebDb {
  uri: string;
  name: string;
}

/** This spec file's own database on the run's replica set: `web_<file>`. */
export function webDb(): WebDb {
  const uri = process.env[WEB_URI_ENV];
  if (!uri) throw new Error(`${WEB_URI_ENV} is not set; run through playwright.web.config.ts.`);
  const file = basename(test.info().file).replace(/\.spec\.ts$/, '');
  return { uri, name: `web_${file.replace(/[^A-Za-z0-9]/g, '_')}` };
}

/** Connect for seeding and raw reads; the caller closes it. */
export function connectTo(db: WebDb): Promise<Store> {
  return connect(db.uri, {}, db.name);
}

/** A fresh fixture novel in the spec file's database. */
export async function seedFixtureNovel(db: WebDb): Promise<void> {
  const store = await connectTo(db);
  try {
    await store.db.dropDatabase();
    await loadFixture(store, SLUG);
  } finally {
    await store.close();
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

export interface WebServer {
  url: string;
  stop(): Promise<void>;
}

/**
 * `scripts/serve-web.ts` on a free local port: `dist/web` at `/` and the
 * function at `/rpc`, on this spec file's database through the documented
 * test seam (the function counts as packaged, so the allow flag is needed).
 */
export async function startWebServer(
  db: WebDb,
  env: Record<string, string> = {},
  port?: number,
): Promise<WebServer> {
  const at = port ?? (await freePort());
  const child: ChildProcess = spawn(
    process.execPath,
    ['scripts/serve-web.ts', '--port', String(at), '--host', '127.0.0.1'],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        NC_PHONE_KEY: TEST_KEY,
        NOVEL_COMPANION_TEST_MONGODB_URI: db.uri,
        NOVEL_COMPANION_ALLOW_TEST_URI: '1',
        NOVEL_COMPANION_TEST_DB_NAME: db.name,
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`serve-web did not start:\n${output}`)),
      60_000,
    );
    const seen = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes('web server on')) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout?.on('data', seen);
    child.stderr?.on('data', (c: Buffer) => (output += c.toString()));
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`serve-web exited with ${code}:\n${output}`));
    });
  });
  return {
    url: `http://127.0.0.1:${at}`,
    stop: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve();
        child.once('exit', () => resolve());
        child.kill('SIGTERM');
      }),
  };
}

/** PH-16: paste the key on the first screen. */
export async function pasteKey(page: Page, key = TEST_KEY): Promise<void> {
  const input = page.getByTestId('key-input');
  await input.fill(key);
  await input.press('Enter');
}

/** From a fresh page: the key, then the fixture novel from the bible chooser, then the workspace. */
export async function openFixture(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await pasteKey(page);
  const open = page.getByRole('button', { name: 'Open Fixture novel' });
  const workspace = page.getByTestId('workspace');
  await expect(open.or(workspace)).toBeVisible();
  if (await open.isVisible()) await open.click();
  await expect(workspace).toBeVisible();
}

/** The character page of one of the fixture's people, from the Characters list. */
export async function openCharacter(page: Page, name: RegExp): Promise<Locator> {
  await page.getByTestId('entry-list').getByRole('button', { name }).click();
  const pageEl = page.getByTestId('character-page');
  await expect(pageEl).toBeVisible();
  return pageEl;
}

/** The phone app goes to the background or comes back: `visibilitychange` as iOS sends it. */
export async function setVisible(page: Page, visible: boolean): Promise<void> {
  await page.evaluate((v) => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => (v ? 'visible' : 'hidden'),
    });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => !v });
    document.dispatchEvent(new Event('visibilitychange'));
  }, visible);
}
