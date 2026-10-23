import { expect, test } from '@playwright/test';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import type { Invoke } from '../helpers/t5';
import { fileDb, invokeVia, launch, rail, screenTab, waitSaved, seedFixture } from './helpers';
import type { TestDb } from './helpers';

/**
 * A44: long text fields are rich text boxes that store Markdown. These tests
 * drive the era description (the box Tommy named) and a character's text
 * boxes through the real editor: typing shortcuts, the selection toolbar,
 * pasting from a word processor and as Markdown, Cmd+Z across the box and
 * the app, and `@` links.
 */

let db: TestDb;
let app: ElectronApplication;
let page: Page;
let invoke: Invoke;
const errors: string[] = [];

test.describe.configure({ mode: 'serial' });

const ERA_HTML =
  '<h2>Grid batteries</h2><p>Every block has a <strong>battery</strong> in the basement and the <em>old grid</em> hums only at night.</p><ul><li>Rationed air conditioning</li><li>Night markets</li></ul><hr><p>Line one<br>Line two</p>';

const era = async () =>
  (await invoke('entry.get', { collection: 'eraStates', id: 'ERA-A44' })).entry;

test.beforeAll(async () => {
  db = fileDb();
  ({ app, page } = await launch(db));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  invoke = invokeVia(page);
  await invoke('bible.create', { slug: 'richtext', name: 'Rich text' });
  await invoke('bible.open', { slug: 'richtext' });
  await expect(page.getByTestId('workspace')).toBeVisible();
  const seeded = await invoke('entry.list', { collection: 'eraStates', trash: 'exclude' });
  for (const e of seeded.entries) {
    await invoke('entry.delete', { collection: 'eraStates', id: e.entry._id });
  }
  await seedFixture(invoke, [
    {
      collection: 'eraStates',
      data: {
        _id: 'ERA-A44',
        title: 'The battery years',
        name: 'The battery years',
        startYear: 2040,
        endYear: 2049,
        body: ERA_HTML,
      },
    },
  ]);
  await invoke('storyTime.set', { time: { year: 2045 } });
});

test.afterAll(async () => {
  await app?.evaluate(({ app: electron }) => electron.exit(0)).catch(() => undefined);
});

function body(): Locator {
  return page
    .getByTestId('eras-view')
    .locator('li[data-era="ERA-A44"]')
    .getByRole('textbox', { name: 'What the world is like' });
}

/** Put the caret at the very end of a box, as a click after its last word would. */
async function caretAtEnd(box: Locator): Promise<void> {
  await box.click();
  await box.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el.lastElementChild ?? el);
    range.collapse(false);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  });
}

/** The text of the block holding the editor's caret, as the editor sees it. */
function caretBlock(box: Locator): Promise<string | undefined> {
  return box.evaluate(
    (el) =>
      (
        el as unknown as {
          editor?: { state: { selection: { $from: { parent: { textContent: string } } } } };
        }
      ).editor?.state.selection.$from.parent.textContent,
  );
}

/**
 * Click into a block and wait until the editor has the caret there: the
 * editor reads a click's selection a moment later, and a key sent at once
 * would act on the old one.
 */
async function clickInto(box: Locator, target: Locator, text: string): Promise<void> {
  await target.click();
  await expect.poll(() => caretBlock(box)).toContain(text);
}

/**
 * A key that moves the caret natively, then a pause: the editor reads the new
 * selection when the browser reports it, a moment after the key.
 */
async function move(key: string): Promise<void> {
  await page.keyboard.press(key);
  await page.waitForTimeout(60);
}

/** Leave the box so the era row commits what was typed. */
async function leave(): Promise<void> {
  await page
    .getByTestId('eras-view')
    .locator('li[data-era="ERA-A44"]')
    .getByLabel('Era name')
    .focus();
}

test('A44 the era description shows stored HTML as formatting, with no tags, and the built app allows the editor under its CSP', async () => {
  await screenTab(page, 'Cultural data', 'Eras');
  const box = body();
  await expect(box).toBeVisible();
  await expect(box).toHaveAttribute('contenteditable', 'true');
  await expect(box.locator('h2')).toHaveText('Grid batteries');
  await expect(box.locator('strong')).toHaveText('battery');
  await expect(box.locator('em')).toHaveText('old grid');
  await expect(box.locator('li')).toHaveCount(2);
  await expect(box.locator('hr')).toHaveCount(1);
  await expect(box).not.toContainText('<p>');
  await expect(box).not.toContainText('**');
  // Opening the box writes nothing: the stored HTML is only converted when it is edited.
  await box.click();
  await leave();
  expect((await era()).body).toBe(ERA_HTML);
  expect(errors.filter((e) => /Content Security Policy|Refused to/i.test(e))).toEqual([]);
});

test('A44 typing shortcuts format as you go and the stored text is Markdown', async () => {
  const box = body();
  await caretAtEnd(box);
  await page.keyboard.press('Enter');
  await page.keyboard.type('### Night life');
  await page.keyboard.press('Enter');
  await page.keyboard.type('People keep **late** hours and *whisper* on stairs.');
  await page.keyboard.press('Enter');
  await page.keyboard.type('- Rooftop gardens');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('> Nobody sleeps before two.');
  await leave();
  await expect(box.locator('h3')).toHaveText('Night life');
  await expect(box.locator('strong', { hasText: 'late' })).toHaveCount(1);
  await expect(box.locator('em', { hasText: 'whisper' })).toHaveCount(1);
  await expect(box.locator('blockquote')).toHaveText('Nobody sleeps before two.');
  await expect
    .poll(async () => (await era()).body)
    .toBe(
      [
        '## Grid batteries',
        'Every block has a **battery** in the basement and the *old grid* hums only at night.',
        '- Rationed air conditioning\n- Night markets',
        '---',
        'Line one\nLine two',
        '### Night life',
        'People keep **late** hours and *whisper* on stairs.',
        '- Rooftop gardens',
        '> Nobody sleeps before two.',
      ].join('\n\n'),
    );
});

test('A44 the selection toolbar and Cmd+B, Cmd+I and Cmd+Alt+2 format the selected text', async () => {
  const box = body();
  const quote = box.locator('blockquote p');
  await clickInto(box, quote, 'Nobody sleeps');
  await move('Meta+ArrowLeft');
  await move('Shift+Meta+ArrowRight');
  const bar = page.getByRole('toolbar', { name: 'Formatting' });
  await expect(bar).toBeVisible();
  await bar.getByRole('button', { name: 'Strike' }).click();
  await expect(box.locator('blockquote s')).toHaveText('Nobody sleeps before two.');
  await expect(bar.getByRole('button', { name: 'Strike' })).toHaveAttribute('aria-pressed', 'true');
  await bar.getByRole('button', { name: 'Strike' }).click();
  await expect(box.locator('blockquote s')).toHaveCount(0);
  // Keys on the paragraph about late hours.
  const para = box.locator('p', { hasText: 'People keep' });
  await clickInto(box, para, 'People keep');
  await page.keyboard.press('Meta+Alt+2');
  await expect(box.locator('h2', { hasText: 'People keep' })).toHaveCount(1);
  await page.keyboard.press('Meta+Alt+0');
  await expect(box.locator('p', { hasText: 'People keep' })).toHaveCount(1);
  await move('Meta+ArrowRight');
  await page.keyboard.type(' Bold now');
  for (let i = 0; i < 'Bold now'.length; i++) await move('Shift+ArrowLeft');
  await page.keyboard.press('Meta+b');
  await page.keyboard.press('Meta+i');
  await leave();
  await expect
    .poll(async () => (await era()).body)
    .toContain('People keep **late** hours and *whisper* on stairs. ***Bold now***');
});

test('A44 Cmd+Z undoes typing in the box first, then the saved change on the app history', async () => {
  const box = body();
  const before = (await era()).body as string;
  await clickInto(box, box.locator('h3'), 'Night life');
  await move('Meta+ArrowRight');
  await page.keyboard.type(' and dawn');
  await expect(box.locator('h3')).toHaveText('Night life and dawn');
  // Still in the box with unsaved typing: Cmd+Z takes the typing back, nothing is written.
  await page.keyboard.press('Meta+z');
  await expect(box.locator('h3')).toHaveText('Night life');
  await page.keyboard.press('Shift+Meta+z');
  await expect(box.locator('h3')).toHaveText('Night life and dawn');
  await leave();
  await expect.poll(async () => (await era()).body).toContain('### Night life and dawn');
  // Out of the box, Cmd+Z steps the app history: the saved description goes back.
  await page.keyboard.press('Meta+z');
  await expect.poll(async () => (await era()).body).toBe(before);
  await expect(box.locator('h3')).toHaveText('Night life');
});

test('A44 pasting from a word processor keeps bold, italic, headings and lists and drops the rest; pasted Markdown formats', async () => {
  const box = body();
  await clickInto(box, box.locator('blockquote p'), 'Nobody sleeps');
  await move('Meta+ArrowRight');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  const paste = (data: Record<string, string>) =>
    box.evaluate((el, d) => {
      const dt = new DataTransfer();
      for (const [type, value] of Object.entries(d)) dt.setData(type, value);
      el.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }),
      );
    }, data);
  await paste({
    'text/html':
      '<meta charset="utf-8"><b style="font-weight:normal" id="docs-internal-guid-1"><h1><span style="font-size:20pt;color:#ff0000">Harbour</span></h1><p><span style="font-weight:700">Ships</span> <span style="font-style:italic">rust</span> <u>quietly</u> <span style="font-family:Comic Sans MS">here</span>.</p><ul><li>Tides</li></ul></b>',
    'text/plain': 'Harbour\nShips rust quietly here.\nTides',
  });
  await expect(box.locator('h2', { hasText: 'Harbour' })).toHaveCount(1);
  await expect(box.locator('strong', { hasText: 'Ships' })).toHaveCount(1);
  await expect(box.locator('em', { hasText: 'rust' })).toHaveCount(1);
  await expect(box.locator('u')).toHaveCount(0);
  await expect(box.locator('[style]')).toHaveCount(0);
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await paste({ 'text/plain': '### Markets\n\nFish is **dear**.' });
  await expect(box.locator('h3', { hasText: 'Markets' })).toHaveCount(1);
  await expect(box.locator('strong', { hasText: 'dear' })).toHaveCount(1);
  await leave();
  await expect
    .poll(async () => (await era()).body)
    .toContain('## Harbour\n\n**Ships** *rust* quietly here.\n\n- Tides');
  expect((await era()).body).toContain('### Markets\n\nFish is **dear**.');
});

async function openCharacter(name: string): Promise<Locator> {
  await rail(page, 'Characters').click();
  await page
    .getByTestId('entry-list')
    .getByRole('button', { name: new RegExp(`^${name}`) })
    .click();
  await expect(page.getByTestId('character-page')).toBeVisible();
  return page.getByTestId('character-page');
}

test('A44 ED-9 @ in a character box links an entry, stores @Title, and shows it as a chip', async () => {
  for (const name of ['Wei Li', 'Margaret Hale']) {
    await invoke('entry.create', {
      collection: 'characters',
      data: { title: name, names: { full: name }, birth: { year: 1990 } },
    });
  }
  const p = await openCharacter('Wei Li');
  const box = p.getByRole('textbox', { name: 'Description', exact: true });
  await box.click();
  await page.keyboard.type('Wei writes to @Marg');
  const list = p.getByRole('listbox', { name: 'Matching entries' });
  await expect(list.getByRole('option').first()).toContainText('Margaret Hale');
  await page.keyboard.press('Enter');
  await expect(list).toHaveCount(0);
  await page.keyboard.type('every week.');
  await waitSaved(page);
  const wei = (await invoke('entry.list', { collection: 'characters', trash: 'exclude' })).entries
    .map((e) => e.entry)
    .find((e) => e.title === 'Wei Li')!;
  const margaret = (
    await invoke('entry.list', { collection: 'characters', trash: 'exclude' })
  ).entries
    .map((e) => e.entry)
    .find((e) => e.title === 'Margaret Hale')!;
  expect(wei.body).toBe('Wei writes to @Margaret Hale every week.');
  expect(wei.links).toContainEqual({ targetId: margaret._id, kind: 'mention' });
  await expect(box.locator('.mention-chip')).toHaveText('@Margaret Hale');
  // Escape closes the list and leaves the text as typed.
  await page.keyboard.type(' Also @Wei');
  await expect(list).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(list).toHaveCount(0);
  await expect(box).toContainText('Also @Wei');
});

test('A44 SM-1 the character boxes start tall enough to read, grow with their text, and keep a reading measure', async () => {
  const p = await openCharacter('Margaret Hale');
  const box = p.getByRole('textbox', { name: 'Backstory', exact: true });
  const lineHeight = await box.evaluate((el) => parseFloat(getComputedStyle(el).lineHeight));
  const empty = await box.evaluate((el) => el.clientHeight);
  // About six lines for prose before any text.
  expect(empty).toBeGreaterThanOrEqual(lineHeight * 6);
  await box.click();
  for (let i = 1; i <= 10; i++) {
    await page.keyboard.type(`Paragraph ${i} of a long backstory.`);
    await page.keyboard.press('Enter');
  }
  await waitSaved(page);
  const grown = await box.evaluate((el) => el.clientHeight);
  expect(grown).toBeGreaterThan(empty);
  // It shows all of its text until it reaches about two thirds of the window.
  expect(await box.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(2);
  // A reading measure: about 75 characters, narrower than the page around it.
  const measure = await box.evaluate((el) => {
    const wrap = el.closest('.rich-text') as HTMLElement;
    return {
      width: el.getBoundingClientRect().width,
      max: getComputedStyle(wrap).maxWidth,
    };
  });
  expect(measure.max).toMatch(/px$/);
  expect(measure.width).toBeLessThanOrEqual(parseFloat(measure.max) + 1);
});
