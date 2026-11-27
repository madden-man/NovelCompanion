import { join } from 'node:path';
import { BrowserWindow, app, session } from 'electron';
import { applyContentSecurityPolicy } from './csp';
import { testDatabaseHonoured, testSeamsHonoured } from './host/uri';
import { electronHost } from './host/electron';
import { mountHandlers } from './ipc/handle';
import {
  applyStoredAppearance,
  bridgeFocus,
  closeStore,
  freshenOpenBible,
  hasOpenBible,
  onFlushed,
  openExternal,
  registerHandlers,
} from './ipc/handlers';
import { wireEvent } from '../shared/ipc';
import { FRESHEN_EVERY_MS } from '../shared/freshness';

const APP_NAME = 'Novel Companion';

// One fixed data folder, so snapshots are always under
// ~/Library/Application Support/Novel Companion/snapshots/<bible>/. Tests give each run its own;
// a packaged build takes one only on a test database (the NF-4 packaged smoke test).
const testUserData = process.env.NOVEL_COMPANION_USER_DATA;
app.setPath(
  'userData',
  testUserData &&
    (!app.isPackaged || testDatabaseHonoured(process.env, { isPackaged: app.isPackaged }))
    ? testUserData
    : join(app.getPath('appData'), APP_NAME),
);

/** The renderer may load only the bundled app (or the dev server in development). */
function isAllowedUrl(url: string): boolean {
  if (url.startsWith('file://') || url.startsWith('devtools://')) return true;
  const dev = process.env.ELECTRON_RENDERER_URL;
  if (app.isPackaged || dev === undefined) return false;
  // Development only: the Vite dev server and its hot reload socket.
  const target = new URL(url);
  return ['http:', 'ws:'].includes(target.protocol) && target.host === new URL(dev).host;
}

function lockDownSession(): void {
  // ARCH-1: the renderer makes no network requests of its own.
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !isAllowedUrl(details.url) });
  });
  // Every permission is refused except full screen, which the family tree asks for.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) =>
    callback(permission === 'fullscreen'),
  );
  session.defaultSession.setPermissionCheckHandler(
    (_wc, permission) => permission === 'fullscreen',
  );
}

/**
 * Tests run the app hidden: no dock icon, no window on screen, the page
 * rendered offscreen and driven only through the automation protocol, so a
 * test run never takes the focus from whatever the person is doing. This is
 * the rule for every run that drives the app, the packaged one included
 * (under the same exception that lets it take the test database).
 */
const hidden =
  process.env.NOVEL_COMPANION_HIDDEN === '1' &&
  (!app.isPackaged || process.env.NOVEL_COMPANION_ALLOW_TEST_URI === '1');
if (hidden && process.platform === 'darwin') {
  app.dock?.hide();
  app.setActivationPolicy('accessory');
}
let closeApproved = false;
let quitPending = false;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

/** A58 (PH-8): a test run may check more often than every 20 seconds; nothing else can. */
const FRESHEN_ENV = 'NOVEL_COMPANION_TEST_FRESHEN_MS';
function freshenEveryMs(): number {
  const asked = Number(process.env[FRESHEN_ENV]);
  const seams = testSeamsHonoured(process.env, { isPackaged: app.isPackaged });
  return seams && Number.isInteger(asked) && asked > 0 ? asked : FRESHEN_EVERY_MS;
}

/** A58 (PH-8): the open bible is checked for changes made elsewhere; a failure waits for the next check. */
const freshen = () => void freshenOpenBible().catch(() => undefined);
let freshenTimer: ReturnType<typeof setInterval> | null = null;
function stopFreshening(): void {
  if (freshenTimer) clearInterval(freshenTimer);
  freshenTimer = null;
}
/** How long main waits for the page to flush its pending edits before it closes anyway. */
const FLUSH_TIMEOUT_MS = 2000;

function createWindow(): BrowserWindow {
  closeApproved = false;
  const win = new BrowserWindow({
    title: APP_NAME,
    width: 1200,
    height: 800,
    minWidth: 360,
    show: false,
    // A hidden run must never reach the screen: macOS would show the window to take it
    // full screen and leave it shown afterwards. The page's own full screen still works.
    fullscreenable: !hidden,
    focusable: !hidden,
    backgroundColor: '#f3f5f7',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      offscreen: hidden,
      backgroundThrottling: !hidden,
    },
  });
  win.once('ready-to-show', () => {
    if (!hidden) win.show();
  });
  if (hidden) {
    // Chromium shows the window when the page asks for full screen. In a hidden run it
    // stays invisible, takes no clicks, and goes straight back off the screen.
    win.setOpacity(0);
    win.setIgnoreMouseEvents(true);
    win.on('show', () => win.hide());
  }
  // Closing the window or quitting first asks the page to save its pending edits. The page
  // answers through `app.flushed`; a page that does not answer within two seconds (it hung
  // or crashed) does not hold the window open.
  const finishClose = () => {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;
    closeApproved = true;
    if (quitPending) app.quit();
    else if (!win.isDestroyed()) win.close();
  };
  win.on('close', (event) => {
    if (closeApproved || !hasOpenBible()) return;
    const wc = win.webContents;
    if (wc.isDestroyed() || wc.isCrashed() || wc.isLoading()) return;
    event.preventDefault();
    if (flushTimer) return; // already flushing
    wc.send(wireEvent('app.closeRequested'), { hasBible: true, quitting: quitPending });
    flushTimer = setTimeout(finishClose, FLUSH_TIMEOUT_MS);
  });
  onFlushed(finishClose);
  // A55 (NB-3): coming to the front pulls what the phone sent. A58 (PH-8): it also checks the
  // bible for changes made elsewhere, and keeps checking while the window stays in front.
  win.on('focus', () => {
    bridgeFocus();
    freshen();
    freshenTimer ??= setInterval(freshen, freshenEveryMs());
  });
  win.on('blur', stopFreshening);
  win.on('closed', stopFreshening);
  // ED-3: undo and redo are the app's own command stacks, replayed through
  // the write path. Catch the keys here, before the page or the Edit menu,
  // so one key press is one app-level undo everywhere, text fields included.
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.alt || !(input.meta || input.control)) return;
    const key = input.key.toLowerCase();
    // TM-1: Cmd+T opens the Story Time dialog from every screen.
    if (key === 't' && !input.shift) {
      event.preventDefault();
      win.webContents.send(wireEvent('app.command'), { command: 'storyTime' });
      return;
    }
    if (key !== 'z') return;
    event.preventDefault();
    win.webContents.send(wireEvent('app.command'), { command: input.shift ? 'redo' : 'undo' });
  });
  // New windows are never created. Allowlisted links open in the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedUrl(url)) event.preventDefault();
  });
  const dev = process.env.ELECTRON_RENDERER_URL;
  if (!app.isPackaged && dev) void win.loadURL(dev);
  else void win.loadFile(join(import.meta.dirname, '../renderer/index.html'));
  return win;
}

app.setName(APP_NAME);

const isDev = !app.isPackaged && process.env.ELECTRON_RENDERER_URL !== undefined;

void app.whenReady().then(() => {
  lockDownSession();
  applyContentSecurityPolicy(isDev);
  // A58: the handler table is built for the Electron host and served on ipcMain.
  mountHandlers(registerHandlers(electronHost()));
  applyStoredAppearance();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  quitPending = true;
});

// Quitting first stops any Claude run and saves it as stopped, then closes the store.
// It waits at most a few seconds, so a store that cannot be reached never holds the app open.
let quitting = false;
app.on('will-quit', (event) => {
  if (quitting) return;
  quitting = true;
  event.preventDefault();
  const limit = new Promise<void>((resolve) => setTimeout(resolve, 3000));
  void Promise.race([closeStore().catch(() => undefined), limit]).finally(() => app.exit(0));
});
