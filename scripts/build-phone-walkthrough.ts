import { execFileSync, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, devices, webkit } from '@playwright/test';
import type { Browser, ElectronApplication, Locator, Page } from '@playwright/test';
import { importSource } from './import-source.ts';
import type * as Deps from './walkthrough-deps.ts';

/**
 * `npm run walkthrough:phone`: the phone client's walkthrough (A58, PLAN-PWA
 * 3.10), rebuilt by one command. Builds `dist/web`, starts a local replica set
 * with a freshly seeded fixture novel, serves the build and `/rpc` through
 * `scripts/serve-web.ts` on a free port, and drives the real client in
 * headless WebKit at iPhone size (390 by 844, scale 2, touch) through the
 * journey, capturing each step's screen light and dark. The Mac's tray is
 * captured from the built desktop app on the same database. Writes the
 * captures and one self-contained `design/phone/walkthrough.html`.
 *
 * Never Netlify, Atlas or the keychain: the local memory replica set only
 * (`NC_TEST_RAM_DISK=0`). Shared machine: it takes one of the seven e2e slots
 * (`~/dev/.e2e-lock`, `-2` to `-7`) and runs one browser at a time.
 *
 *   npm run walkthrough:phone                  everything
 *   npm run walkthrough:phone -- --no-build    reuse dist/web and out/
 *   npm run walkthrough:phone -- --page-only   rewrite the page from the captures
 *   npm run walkthrough:phone -- --u6          also refresh docs/phone-screens/u6/01-backstory
 */

const ROOT = join(import.meta.dirname, '..');
const OUT = join(ROOT, 'design/phone');
const PAGE = join(OUT, 'walkthrough.html');
const KEY = 'local-phone-key';
const SLUG = 'fixture-novel';
const DB = 'novel_companion_walkthrough';
const EXAMPLE = 'Fixture novel (example data)';
const VIEW = { width: 390, height: 844 };
const DESK = { width: 1280, height: 800 };
const CLAUDE_KEY = 'sk-ant-api03-example-key-not-real-0123456789abcdef';

// ---------------------------------------------------------------- the steps

interface Step {
  id: string;
  title: string;
  line: string;
  /** The Mac's window instead of the phone. */
  desk?: boolean;
  built: [string, string][];
}

const STEPS: Step[] = [
  {
    id: 'key',
    title: 'Paste the key once',
    line: 'One field, then the bible. Nothing asks again.',
    built: [
      ['Files', '<code>src/web/KeyGate.tsx</code>, <code>src/web/transport.ts</code>'],
      [
        'How',
        'Kept in local storage, sent only as the bearer header to <code>/rpc</code>; a changed key signs the phone out.',
      ],
      ['Criteria', 'PH-14, PH-16, PH-17'],
    ],
  },
  {
    id: 'bibles',
    title: 'Pick the bible',
    line: 'Every bible on the Mac is here.',
    built: [
      [
        'Channels',
        '<code>bible.list</code>, <code>bible.open</code> through the Netlify function <code>rpc</code>, the handlers the Mac runs',
      ],
      ['How', 'The one picked is remembered; no New bible on the phone.'],
      ['Criteria', 'PH-1, PH-37'],
    ],
  },
  {
    id: 'people',
    title: 'Everyone, in one list',
    line: 'The bible and the year on top, five tabs under the thumb.',
    built: [
      [
        'Files',
        '<code>workspace/phone/PhoneFrame.tsx</code>, <code>phone/nav.tsx</code>, <code>phone/places.ts</code>',
      ],
      [
        'How',
        'The desk renderer built by <code>vite.web.config.ts</code>; <code>usePhone()</code> switches the layout, never a width.',
      ],
      ['Criteria', 'PH-29, PH-30'],
    ],
  },
  {
    id: 'person',
    title: 'Fix a field with one tap',
    line: 'A person opens as a page; the field opens where it sits.',
    built: [
      [
        'Files',
        '<code>Editable</code>, <code>phone/keyboard.ts</code> (the field held above the keyboard)',
      ],
      [
        'How',
        'Inputs at 16 px so iOS does not zoom; each change is one <code>entry.update</code>, Undo in the top bar.',
      ],
      ['Criteria', 'PH-31, PH-32, PH-35'],
    ],
  },
  {
    id: 'search',
    title: 'Find anyone',
    line: 'Search takes the keyboard at once.',
    built: [
      ['How', 'The desk search as a tab; a hit opens as a page, back returns to the results.'],
      ['Place', 'Kept in the hash (<code>#/search/e:characters:H4</code>), so a reload keeps it.'],
      ['Criteria', 'PH-31'],
    ],
  },
  {
    id: 'year',
    title: 'Move the story year',
    line: 'The year on top opens the dial.',
    built: [
      [
        'Files',
        '<code>phone/YearDial.tsx</code>, <code>phone/Sheet.tsx</code>, <code>phone/YearPage.tsx</code>',
      ],
      [
        'How',
        'One <code>storyTime.set</code>; a tap outside, a swipe down or back closes the sheet.',
      ],
      ['Criteria', 'PH-29'],
    ],
  },
  {
    id: 'outline',
    title: 'The book, scene by scene',
    line: 'Chapters in page order, each line one tap from editing.',
    built: [
      ['Files', '<code>phone/holdLift.ts</code>, <code>phone/hold.ts</code>'],
      [
        'How',
        'One column; line and chapter menus are sheets; a held line lifts and moves, a swipe only scrolls.',
      ],
      ['Criteria', 'PH-31, PH-35'],
    ],
  },
  {
    id: 'relevant',
    title: 'What this chapter needs',
    line: 'Relevant to Session, in one column.',
    built: [
      ['How', 'Opened from the chapter menu; the story year follows the chapter picked.'],
      ['Pages', 'People, events and culture open as pages; back returns here.'],
      ['Criteria', 'PH-31'],
    ],
  },
  {
    id: 'world',
    title: 'The world, year by year',
    line: 'The grid scrolls sideways with the categories held.',
    built: [
      [
        'Files',
        '<code>phone/WorldBar.tsx</code>, <code>phone/grid.css</code>, <code>phone/world.css</code>',
      ],
      ['How', 'First column sticky; Filter and a new event open as sheets.'],
      ['Criteria', 'PH-34, PH-35'],
    ],
  },
  {
    id: 'tree',
    title: 'The family, by touch',
    line: 'Pan, pinch, and tap a person for the rest.',
    built: [
      ['Files', '<code>phone/geometry.ts</code>, <code>phone/holdLift.ts</code>'],
      [
        'How',
        'The desk tree with touch: pan and pinch; a hold lifts a person; Fit and the legend in one bar.',
      ],
      ['Criteria', 'PH-33'],
    ],
  },
  {
    id: 'capture',
    title: 'Catch a sentence before it goes',
    line: '+ reads it and lays out each fact.',
    built: [
      ['Files', '<code>phone/PhoneCapture.tsx</code>, <code>phone/captureDraft.ts</code>'],
      ['How', 'The Capture Router runs on the phone; typing survives a reload as a draft.'],
      ['Criteria', 'PH-10, PH-27'],
    ],
  },
  {
    id: 'waits',
    title: 'The hard ones wait for the Mac',
    line: 'One fact filed now, one kept for Claude on the desk.',
    built: [
      [
        'Channels',
        '<code>capture.wait</code>, <code>capture.waiting</code>, <code>capture.takeBack</code> (<code>src/shared/ipcCapture.ts</code>)',
      ],
      [
        'How',
        'Never sent to Claude from the phone; stored under its own source, so the notebook pull never trashes it.',
      ],
      ['Criteria', 'PH-26, PH-28'],
    ],
  },
  {
    id: 'mac',
    title: 'On the Mac, it is waiting',
    line: 'From the notebook offers it under From the phone.',
    desk: true,
    built: [
      ['Files', '<code>workspace/tray.tsx</code>, <code>src/shared/phoneWaits.ts</code>'],
      [
        'How',
        'Found at the next freshness check; filed, sent or dismissed as any card, and Undo makes it wait again.',
      ],
      ['Criteria', 'PH-8, PH-28, FN-1'],
    ],
  },
  {
    id: 'more',
    title: 'The rest of the bible',
    line: 'Backstory, lists, Trash and Settings sit under its name.',
    built: [
      [
        'How',
        'The bible sheet: the chooser, the sections, then More; each screen opens as a page.',
      ],
      ['Grids', 'Backstory scrolls sideways with the names held; a long name wraps onto a second line.'],
      ['Criteria', 'PH-34, PH-35, PH-37'],
    ],
  },
  {
    id: 'offline',
    title: 'No signal, still readable',
    line: 'Pages opened before read as they did; nothing changes.',
    built: [
      [
        'Files',
        '<code>src/web/readStore.ts</code> (IndexedDB), <code>src/web/sw.ts</code> (the shell)',
      ],
      [
        'How',
        'Every answer is kept; offline, writes are refused and Try again goes live and reads what changed.',
      ],
      ['Criteria', 'PH-24, PH-25'],
    ],
  },
];

// ---------------------------------------------------------------- the machine

/** The first free e2e slot of seven, held by this process (the shared Mac's rule). */
function takeSlot(): string {
  const dev = join(homedir(), 'dev');
  const slots = ['.e2e-lock', ...[2, 3, 4, 5, 6, 7].map((n) => `.e2e-lock-${n}`)];
  for (const name of slots) {
    const dir = join(dev, name);
    try {
      mkdirSync(dir);
    } catch {
      continue;
    }
    writeFileSync(join(dir, 'owner'), String(process.pid));
    return dir;
  }
  throw new Error('All seven e2e slots are taken: wait a few minutes and run again.');
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

/** `scripts/serve-web.ts` on a free port, on the walkthrough's database. */
async function serve(uri: string): Promise<{ url: string; stop(): Promise<void> }> {
  const port = await freePort();
  const child: ChildProcess = spawn(
    process.execPath,
    ['scripts/serve-web.ts', '--port', String(port), '--host', '127.0.0.1'],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        NC_PHONE_KEY: KEY,
        NOVEL_COMPANION_TEST_MONGODB_URI: uri,
        NOVEL_COMPANION_ALLOW_TEST_URI: '1',
        NOVEL_COMPANION_TEST_DB_NAME: DB,
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
    child.stdout?.on('data', (c: Buffer) => {
      output += c.toString();
      if (output.includes('web server on')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr?.on('data', (c: Buffer) => (output += c.toString()));
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`serve-web exited with ${code}:\n${output}`));
    });
  });
  return {
    url: `http://127.0.0.1:${port}`,
    stop: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve();
        child.once('exit', () => resolve());
        child.kill('SIGTERM');
      }),
  };
}

// ---------------------------------------------------------------- capturing

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(what: string, check: () => Promise<boolean>, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check().catch(() => false)) return;
    await sleep(150);
  }
  throw new Error(`Timed out waiting for ${what}.`);
}

const visible = (l: Locator) => l.isVisible();
/** Page-side snippets, as strings: this file is checked without the DOM's types. */
const TO_TOP = 'window.scrollTo(0, 0)';
const FRAMES = 'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))';

class Capture {
  private page: Page;
  constructor(page: Page) {
    this.page = page;
  }

  async step(id: string): Promise<void> {
    const n = STEPS.findIndex((s) => s.id === id) + 1;
    if (n === 0) throw new Error(`No step ${id}.`);
    for (const theme of ['light', 'dark'] as const) {
      await this.page.emulateMedia({ colorScheme: theme });
      await this.page.evaluate(FRAMES);
      await sleep(350);
      const buf = await this.page.screenshot({ type: 'jpeg', quality: 72, caret: 'initial' });
      writeFileSync(join(OUT, shotName(n, id, theme)), buf);
    }
    await this.page.emulateMedia({ colorScheme: 'light' });
    console.log(`step ${n} ${id}`);
  }
}

const shotName = (n: number, id: string, theme: 'light' | 'dark') =>
  `${String(n).padStart(2, '0')}-${id}-${theme}.jpg`;

// ---------------------------------------------------------------- the journey on the phone

const top = (page: Page) => page.locator('[data-testid="phone-page"]:visible');

async function more(page: Page, label: string): Promise<Locator> {
  await page.getByTestId('bible-menu-button').tap();
  await page.getByTestId('phone-more').getByRole('button', { name: label, exact: true }).tap();
  await page.getByTestId('bible-sheet').waitFor({ state: 'detached' });
  return top(page);
}

/** The outline the writer keeps: chapter breaks after the lines named (as phone-outline.spec.ts). */
const OUTLINE = [
  '- Iris and Noor at the archive door',
  '  - the door is locked; the Archivist is late',
  '- Dinner at the Hales, 2045',
  '- Meiling meets the baby',
  '- Rain on the wedding',
  '- The house after the funeral',
  "- Margaret's candles",
  '- The letter arrives',
  '  - Iris reads it twice',
];
const BREAKS = { CH1: 0, CH2: 2, CH3: 4, CH4: 5, CH5: 6, CH6: 7, CH7: 9, CH8: 9 };

/** Route A (filed on the phone) and Route C (waits for the desk), as phone-capture.spec.ts. */
const MOONCAKES = 'Teenagers in Guangzhou start to eat mooncakes with coffee by the 2050s.';
const KESSLER = 'The Kessler crowd stops tipping by 2070.';

async function phone(
  browser: Browser,
  url: string,
  stopServer: () => Promise<void>,
  storedRole: () => Promise<string>,
  u6: boolean,
): Promise<void> {
  const context = await browser.newContext({
    viewport: VIEW,
    screen: VIEW,
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const cap = new Capture(page);
  await page.emulateMedia({ colorScheme: 'light' });

  // 1. The paste screen, the key in it.
  await page.goto(url);
  const input = page.getByTestId('key-input');
  await input.waitFor();
  await input.fill(KEY);
  await cap.step('key');
  await input.press('Enter');

  // 2. The chooser: both bibles on the Mac.
  const open = page.getByRole('button', { name: 'Open Fixture novel' });
  await open.waitFor();
  await sleep(300);
  await cap.step('bibles');
  await open.tap();
  await page.getByTestId('workspace').waitFor();
  await until('the year', async () => /\d/.test(await page.getByTestId('phone-year').innerText()));

  // The writer's outline, through the app's own transport.
  await page.evaluate(`(async () => {
    const { bible } = await window.api.invoke('bible.current', {});
    await window.api.invoke('sceneOutline.set', ${JSON.stringify({ text: OUTLINE.join('\n'), breaks: BREAKS })}, { bible: bible.id });
  })()`);

  // 3. People.
  await page.getByTestId('tab-people').tap();
  await page.getByTestId('entry-list').getByRole('button').first().waitFor();
  await sleep(300);
  await cap.step('people');

  // 4. Ruth Hale's page, In the story opened by one tap and typed into.
  await page
    .getByTestId('entry-list')
    .getByRole('button', { name: /^Ruth Hale/ })
    .tap();
  const person = page.getByTestId('character-page');
  await person.waitFor();
  const role = person.locator('[data-field="role"] .rich-text-input');
  await role.tap();
  await page.keyboard.type('Keeps the letters Margaret left.');
  await sleep(400);
  await cap.step('person');
  await page.getByTestId('phone-back').tap();
  await until('the role saved', async () => (await storedRole()).includes('Keeps the letters'));

  // 5. Search.
  await page.getByTestId('tab-search').tap();
  const search = page.getByTestId('search-view').locator('input[type="search"]');
  await search.waitFor();
  await search.fill('Hale');
  await page.getByTestId('search-results').getByText('Ruth Hale').first().waitFor();
  await sleep(400);
  await cap.step('search');

  // 6. The year sheet, over People.
  await page.getByTestId('tab-people').tap();
  await page.getByTestId('entry-list').waitFor();
  await page.getByTestId('phone-year').tap();
  await page.getByTestId('year-sheet').waitFor();
  await sleep(400);
  await cap.step('year');
  await page.goBack();
  await page.getByTestId('year-sheet').waitFor({ state: 'detached' });

  // 7. The Outline.
  await page.getByTestId('tab-outline').tap();
  await page.getByTestId('outline-view').getByTestId('ph-line').first().waitFor();
  await page.evaluate(TO_TOP);
  await sleep(400);
  await cap.step('outline');

  // 8. Relevant to Session, from The Letter's chapter menu.
  await page
    .locator('[data-testid="chapter-bar"][data-chapter="CH6"]')
    .getByTestId('chapter-more')
    .tap();
  await page.getByTestId('chapter-sheet').getByTestId('ph-chapter-relevant').tap();
  const relevant = page.getByTestId('relevant-view');
  await relevant.getByTestId('relevant-strand').waitFor();
  await page.evaluate(TO_TOP);
  await sleep(500);
  await cap.step('relevant');
  await page.getByTestId('phone-back').tap();

  // 9. World.
  await page.getByTestId('tab-world').tap();
  const grid = page.getByTestId('world-grid');
  await grid.locator('.wg-row').first().waitFor();
  await page.evaluate(TO_TOP);
  await sleep(400);
  await cap.step('world');

  // 10. The family tree, Daniel Hale tapped.
  await more(page, 'Family tree');
  const svg = page.locator('[data-testid="tree-svg"]:visible');
  await svg.locator('.tnode').first().waitFor();
  await sleep(500);
  await svg.locator('.tnode[aria-label^="Daniel Hale"]').tap();
  await page.getByTestId('tree-sheet').waitFor();
  await sleep(400);
  await cap.step('tree');
  await page.goBack();
  await page.getByTestId('phone-back').tap();

  // 11. Capture: two sentences, two facts.
  await page.getByTestId('tab-add').tap();
  const capture = page.locator('[data-testid="phone-capture"]:visible');
  const box = capture.getByTestId('phone-capture-input');
  await box.waitFor();
  await box.fill(`${MOONCAKES} ${KESSLER}`);
  await until('two facts', async () => (await capture.getByTestId('capture-fact').count()) === 2);
  await until(
    'File it',
    async () =>
      (await capture.getByTestId('phone-capture-file').getAttribute('data-current')) === 'true',
  );
  await box.blur();
  await sleep(400);
  await cap.step('capture');

  // 12. Filed: one in the bible, one waiting for the desk.
  await capture.getByTestId('phone-capture-file').tap();
  await page.getByTestId('phone-toast').waitFor();
  await capture.getByTestId('phone-waiting-line').first().waitFor();
  await sleep(300);
  await cap.step('waits');
  await page.getByTestId('phone-toast').waitFor({ state: 'detached', timeout: 15_000 });

  // 14. More: Backstory.
  const backstory = await more(page, 'Backstory');
  await backstory.getByTestId('backstory-grid').waitFor();
  await page.evaluate(TO_TOP);
  await sleep(500);
  await cap.step('more');
  await page.getByTestId('phone-back').tap();

  if (u6) await backstoryRecord(browser, url);

  // 15. No signal: the function is gone; Ruth's page reads from the phone's store.
  await stopServer();
  await page.evaluate("window.dispatchEvent(new Event('offline'))");
  await page.getByTestId('tab-people').tap();
  await page
    .getByTestId('entry-list')
    .getByRole('button', { name: /^Ruth Hale/ })
    .tap();
  await page.getByTestId('character-page').waitFor();
  await until('read-only', () => visible(page.getByTestId('connection-banner')));
  const shown = await page.locator('[data-field="role"]:visible').innerText();
  if (!shown.includes('Keeps the letters')) {
    console.log(`Offline, Ruth's In the story reads "${shown.trim()}", not the edit made online.`);
  }
  await sleep(500);
  await cap.step('offline');

  if (errors.length) console.log(`Page errors while capturing:\n  ${errors.join('\n  ')}`);
  await context.close();
}

/** docs/phone-screens/u6/01-backstory, light and dark, as phone-more.spec.ts saves it (iPhone 15). */
async function backstoryRecord(browser: Browser, url: string): Promise<void> {
  const context = await browser.newContext({ ...devices['iPhone 15'] });
  const page = await context.newPage();
  await page.goto(url);
  await page.getByTestId('key-input').fill(KEY);
  await page.getByTestId('key-input').press('Enter');
  const open = page.getByRole('button', { name: 'Open Fixture novel' });
  const workspace = page.getByTestId('workspace');
  await open.or(workspace).waitFor();
  if (await open.isVisible()) await open.tap();
  await workspace.waitFor();
  const scope = await more(page, 'Backstory');
  await scope.getByTestId('backstory-grid').locator('.bs-row').first().waitFor();
  await sleep(300);
  const path = join(ROOT, 'docs/phone-screens/u6/01-backstory');
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.screenshot({ path: `${path}-${theme}.png` });
  }
  await context.close();
  console.log('docs/phone-screens/u6/01-backstory: light and dark');
}

// ---------------------------------------------------------------- the Mac

async function mac(uri: string): Promise<void> {
  const app: ElectronApplication = await electron.launch({
    args: [ROOT],
    env: {
      ...process.env,
      NOVEL_COMPANION_TEST_MONGODB_URI: uri,
      NOVEL_COMPANION_TEST_DB_NAME: DB,
      NOVEL_COMPANION_USER_DATA: mkdtempSync(join(tmpdir(), 'nc-walk-')),
      NOVEL_COMPANION_TEST_CLAUDE: '1',
      NOVEL_COMPANION_HIDDEN: '1',
    },
  });
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await app.evaluate(({ BrowserWindow }, size) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(size.width, size.height);
    }, DESK);
    await page.setViewportSize(DESK);
    await page.evaluate(`window.api.invoke('bible.open', { slug: ${JSON.stringify(SLUG)} })`);
    await page.getByTestId('workspace').waitFor();
    // An example key in memory (the recorded Claude), so the card offers Send to Claude.
    await page.evaluate(
      `window.api.invoke('claude.setKey', { key: ${JSON.stringify(CLAUDE_KEY)} })`,
    );
    const nav = page.getByRole('navigation', { name: 'Sections' });
    await nav.getByTestId('app-menu-button').click();
    await nav.getByRole('menuitem', { name: 'From the notebook', exact: true }).click();
    const tray = page.getByTestId('notebook-tray');
    await tray.getByTestId('tray-group').filter({ hasText: 'From the phone' }).first().waitFor();
    await sleep(500);
    await new Capture(page).step('mac');
  } finally {
    await app.close();
  }
}

// ---------------------------------------------------------------- the page

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const dataUri = (file: string) =>
  `data:image/jpeg;base64,${readFileSync(join(OUT, file)).toString('base64')}`;

function html(): string {
  const total = STEPS.length;
  const sections = STEPS.map((s, i) => {
    const n = i + 1;
    const light = dataUri(shotName(n, s.id, 'light'));
    const dark = dataUri(shotName(n, s.id, 'dark'));
    const size = s.desk ? DESK : VIEW;
    const label = s.id === 'bibles' ? `<p class="example">${EXAMPLE}</p>` : '';
    const rows = s.built
      .map(([k, v]) => `<tr><th scope="row">${k}</th><td>${v}</td></tr>`)
      .join('');
    return `<section class="step" data-step="${s.id}"${i === 0 ? ' data-on' : ''}>
<h2>${esc(s.title)}</h2>
<p class="line">${esc(s.line)}</p>
<div class="${s.desk ? 'desk' : 'phone'}" data-mock><img class="shot-light" src="${light}" width="${size.width}" height="${size.height}" alt="${esc(s.title)}, light"><img class="shot-dark" src="${dark}" width="${size.width}" height="${size.height}" alt="${esc(s.title)}, dark">${label}</div>
<details><summary>How this is built</summary><table>${rows}</table></details>
</section>`;
  }).join('\n');
  const rail = STEPS.map(
    (s, i) =>
      `<li><a href="#${s.id}"><span class="n">${i + 1}</span><span class="t">${esc(s.title)}</span></a></li>`,
  ).join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Novel Companion Phone</title>
<!-- Written by scripts/build-phone-walkthrough.ts (npm run walkthrough:phone). Do not edit by hand. -->
<style>
:root{--bg:#f4f2ee;--panel:#ffffff;--fg:#1d1b18;--line:#cfc9bf;--accent:#7a4a1c;--bezel:#1b1a19;--desk:#d9d5ce;color-scheme:light}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#141311;--panel:#1f1d1a;--fg:#ece8e1;--line:#3c3833;--accent:#e2b07a;--bezel:#000000;--desk:#2c2925;color-scheme:dark}}
:root[data-theme="dark"]{--bg:#141311;--panel:#1f1d1a;--fg:#ece8e1;--line:#3c3833;--accent:#e2b07a;--bezel:#000000;--desk:#2c2925;color-scheme:dark}
*{box-sizing:border-box}
html,body{margin:0;overflow-x:hidden}
body{background:var(--bg);color:var(--fg);font:16px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;padding:16px 16px 40px}
.wrap{max-width:1120px;margin:0 auto;display:grid;grid-template-columns:250px minmax(0,1fr);gap:24px}
header{grid-column:1/-1;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
h1{font-size:22px;margin:0;font-weight:650}
#counter{font-variant-numeric:tabular-nums;font-size:14px}
.themes{margin-left:auto;display:flex;gap:2px;border:1px solid var(--line);border-radius:999px;padding:2px;background:var(--panel)}
.themes button,.ctl button{font:500 14px/1.2 inherit;font-family:inherit;color:var(--fg);background:transparent;border:1px solid transparent;border-radius:999px;padding:6px 12px;min-height:36px;cursor:pointer}
.themes button[aria-pressed="true"]{background:var(--fg);color:var(--bg)}
button:focus-visible,a:focus-visible,summary:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
nav.rail{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:8px;align-self:start;position:sticky;top:12px;min-width:0}
nav.rail ol{list-style:none;margin:0;padding:0;display:grid;gap:2px}
nav.rail a{display:flex;gap:10px;align-items:center;padding:6px 8px;border-radius:8px;color:var(--fg);text-decoration:none;font-size:14px}
nav.rail .n{width:24px;height:24px;border-radius:50%;border:1px solid var(--line);display:grid;place-items:center;font-size:12px;font-variant-numeric:tabular-nums;flex:none}
nav.rail a[aria-current]{background:var(--bg)}
nav.rail a[aria-current] .n{background:var(--fg);color:var(--bg);border-color:var(--fg)}
main{min-width:0}
.step{display:none}
.step[data-on]{display:grid;justify-items:center;gap:12px}
.step h2{font-size:clamp(22px,3vw,28px);margin:0;text-align:center;font-weight:650;text-wrap:balance}
.step .line{margin:-4px 0 0;text-align:center;max-width:46ch}
.phone{width:min(100%,340px);background:var(--bezel);border-radius:44px;padding:10px;box-shadow:0 18px 44px rgba(0,0,0,.25)}
.phone img{display:block;width:100%;height:auto;aspect-ratio:390/844;border-radius:34px}
.desk{width:100%;max-width:820px;background:var(--desk);border:1px solid var(--line);border-radius:12px;padding:26px 8px 8px;position:relative;box-shadow:0 18px 44px rgba(0,0,0,.2)}
.desk::before{content:"";position:absolute;top:9px;left:12px;width:44px;height:10px;background:radial-gradient(circle,#ec6a5e 4px,transparent 5px) 0 0/15px 10px repeat-x}
.desk img{display:block;width:100%;height:auto;aspect-ratio:1280/800;border-radius:6px}
.example{margin:8px 0 0;text-align:center;font-size:13px;color:#ece8e1}
.shot-dark{display:none!important}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]) .shot-light{display:none!important}:root:not([data-theme="light"]) .shot-dark{display:block!important}}
:root[data-theme="dark"] .shot-light{display:none!important}
:root[data-theme="dark"] .shot-dark{display:block!important}
.ctl{display:flex;gap:10px;justify-content:center;margin-top:16px}
.ctl button{border-color:var(--line);background:var(--panel);min-height:44px;padding:9px 20px}
details{width:100%;max-width:560px;border:1px dashed var(--line);border-radius:12px;padding:8px 14px;font-size:14px}
summary{cursor:pointer;font-weight:600}
details table{width:100%;border-collapse:collapse;margin-top:8px;font-size:13px}
details th,details td{padding:6px;border-top:1px solid var(--line);vertical-align:top;text-align:left;overflow-wrap:anywhere}
details th{white-space:nowrap;font-weight:600}
details code{font-size:12px}
@media (max-width:760px){
.wrap{grid-template-columns:minmax(0,1fr);gap:16px}
nav.rail{position:static;padding:6px}
nav.rail ol{display:flex;overflow-x:auto;gap:4px}
nav.rail .t{display:none}
nav.rail a{padding:4px}
nav.rail .n{width:32px;height:32px;font-size:13px}
}
</style>
</head>
<body>
<div class="wrap">
<header><h1>Novel Companion Phone</h1><span id="counter">Step 1 of ${total}</span>
<div class="themes" role="group" aria-label="Theme"><button type="button" data-set="auto" aria-pressed="true">Auto</button><button type="button" data-set="light" aria-pressed="false">Light</button><button type="button" data-set="dark" aria-pressed="false">Dark</button></div></header>
<nav class="rail" aria-label="Steps"><ol id="rail">${rail}</ol></nav>
<main id="main">
${sections}
<div class="ctl"><button type="button" id="prev">Previous</button><button type="button" id="next">Next</button></div>
</main>
</div>
<script>
/* Steps carry data-step, not id, so the browser never jumps to one: the addressed step is shown at the top. */
(function(){
  var steps=[].slice.call(document.querySelectorAll('.step'));
  var links=[].slice.call(document.querySelectorAll('#rail a'));
  var counter=document.getElementById('counter'),rail=document.getElementById('rail'),i=0;
  function go(k){
    i=(k+steps.length)%steps.length;
    steps.forEach(function(s,j){if(j===i)s.setAttribute('data-on','');else s.removeAttribute('data-on');});
    links.forEach(function(a,j){if(j===i)a.setAttribute('aria-current','step');else a.removeAttribute('aria-current');});
    counter.textContent='Step '+(i+1)+' of '+steps.length;
    try{history.replaceState(null,'','#'+steps[i].dataset.step);}catch(e){}
    var a=links[i];if(rail.scrollWidth>rail.clientWidth){rail.scrollLeft+=a.getBoundingClientRect().left-rail.getBoundingClientRect().left-(rail.clientWidth-a.offsetWidth)/2;}
    window.scrollTo(0,0);
  }
  links.forEach(function(a,j){a.addEventListener('click',function(e){e.preventDefault();go(j);});});
  document.getElementById('prev').addEventListener('click',function(){go(i-1);});
  document.getElementById('next').addEventListener('click',function(){go(i+1);});
  document.addEventListener('keydown',function(e){if(e.altKey||e.metaKey||e.ctrlKey)return;if(e.key==='ArrowRight')go(i+1);if(e.key==='ArrowLeft')go(i-1);});
  function fromHash(){var id=decodeURIComponent(location.hash.slice(1));var k=steps.findIndex(function(s){return s.dataset.step===id;});go(k<0?0:k);}
  window.addEventListener('hashchange',fromHash);
  try{history.scrollRestoration='manual';}catch(e){}
  fromHash();
  window.addEventListener('load',function(){window.scrollTo(0,0);});
  var root=document.documentElement,buttons=[].slice.call(document.querySelectorAll('.themes button'));
  function theme(t){if(t==='auto')root.removeAttribute('data-theme');else root.setAttribute('data-theme',t);buttons.forEach(function(b){b.setAttribute('aria-pressed',String(b.dataset.set===t));});try{localStorage.setItem('nc-phone-theme',t);}catch(e){}}
  buttons.forEach(function(b){b.addEventListener('click',function(){theme(b.dataset.set);});});
  var saved=null;try{saved=localStorage.getItem('nc-phone-theme');}catch(e){}
  if(saved==='light'||saved==='dark')theme(saved);
})();
</script>
</body>
</html>
`;
}

function writePage(): void {
  const missing = STEPS.flatMap((s, i) =>
    (['light', 'dark'] as const)
      .map((t) => shotName(i + 1, s.id, t))
      .filter((f) => !existsSync(join(OUT, f))),
  );
  if (missing.length) throw new Error(`No capture for ${missing.join(', ')}.`);
  writeFileSync(PAGE, html());
  const mb = statSync(PAGE).size / 1024 / 1024;
  if (mb > 12) throw new Error(`walkthrough.html is ${mb.toFixed(1)} MB.`);
  console.log(`design/phone/walkthrough.html: ${STEPS.length} steps, ${mb.toFixed(1)} MB`);
}

// ---------------------------------------------------------------- main

async function main(): Promise<void> {
  if (process.argv.includes('--page-only')) {
    writePage();
    return;
  }
  const build = !process.argv.includes('--no-build');
  const u6 = process.argv.includes('--u6');
  if (build) {
    execFileSync('npm', ['run', 'build:web'], { cwd: ROOT, stdio: 'inherit' });
    execFileSync('npx', ['electron-vite', 'build'], { cwd: ROOT, stdio: 'inherit' });
  }
  if (!existsSync(join(ROOT, 'out/main/index.js'))) throw new Error('No out/: build the desk app.');
  for (const f of existsSync(OUT) ? readdirSync(OUT) : []) {
    if (f.endsWith('.jpg')) rmSync(join(OUT, f));
  }
  mkdirSync(OUT, { recursive: true });

  const slot = takeSlot();
  process.env.NC_TEST_RAM_DISK ??= '0';
  const deps = await importSource<typeof Deps>('scripts/walkthrough-deps.ts');
  const mongo = await deps.startTestMongo();
  let server: { url: string; stop(): Promise<void> } | null = null;
  try {
    const store = await deps.connect(mongo.uri, {}, DB);
    await store.db.dropDatabase();
    await deps.seedFixture(store, SLUG, ROOT);
    await deps.createBible(store, 'second-novel', 'Second novel');
    server = await serve(mongo.uri);
    const storedRole = async () => {
      const ruth = await store.db.collection(`${SLUG}.characters`).findOne({ _id: 'H4' as never });
      return String((ruth as { role?: unknown } | null)?.role ?? '');
    };

    const browser = await webkit.launch({ headless: true });
    try {
      await phone(browser, server.url, () => server?.stop() ?? Promise.resolve(), storedRole, u6);
    } finally {
      await browser.close();
    }
    await server.stop();
    server = null;
    await store.close();
    await mac(mongo.uri);
  } finally {
    await server?.stop();
    await mongo.stop();
    rmSync(slot, { recursive: true, force: true });
  }
  writePage();
}

await main();
