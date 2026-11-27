import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { field, fillEditable, invokeVia, launch, rail } from '../e2e/helpers';
import {
  SLUG,
  openCharacter,
  openFixture,
  seedFixtureNovel,
  setVisible,
  startWebServer,
  webDb,
} from './server';
import type { WebDb, WebServer } from './server';

/**
 * A58 P4 (PH-38): the Electron app and the web client on one test database.
 * Electron checks `rev` every 300 ms while in front (the test seam); its
 * window "comes to the front" through its `focus` event, as the desk's
 * freshness spec does.
 */
let db: WebDb;
let server: WebServer;
let desk: ElectronApplication;
let deskPage: Page;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  db = webDb();
  await seedFixtureNovel(db);
  server = await startWebServer(db);
  ({ app: desk, page: deskPage } = await launch(db, { NOVEL_COMPANION_TEST_FRESHEN_MS: '300' }));
  await invokeVia(deskPage)('bible.open', { slug: SLUG });
  await expect(deskPage.getByTestId('workspace')).toBeVisible();
});

test.afterAll(async () => {
  await desk?.close();
  await server?.stop();
});

const focusDesk = () =>
  desk.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.emit('focus');
  });
const blurDesk = () =>
  desk.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.emit('blur');
  });

test('PH-38 an edit on the phone shows on the Mac when its window comes to the front, and back', async ({
  page,
}) => {
  await rail(deskPage, 'Characters').click();
  const deskPerson = await openCharacter(deskPage, /^Margaret Hale/);
  await blurDesk();

  // The phone edits; the Mac in the background shows it when its window comes to the front.
  await openFixture(page, server.url);
  const phonePerson = await openCharacter(page, /^Margaret Hale/);
  await fillEditable(field(phonePerson, 'names.full'), 'Margaret Hale from the phone');
  await focusDesk();
  await expect(field(deskPerson, 'names.full')).toContainText('Margaret Hale from the phone');

  // The Mac edits; the phone shows it when it becomes visible.
  await fillEditable(field(deskPerson, 'names.full'), 'Margaret Hale from the Mac');
  await blurDesk();
  await setVisible(page, false);
  await setVisible(page, true);
  await expect(field(phonePerson, 'names.full')).toContainText('Margaret Hale from the Mac');
});
