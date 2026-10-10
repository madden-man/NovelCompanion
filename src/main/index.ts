import { join } from 'node:path';
import { BrowserWindow, app, session } from 'electron';
import { applyContentSecurityPolicy } from './csp';
import {
  closeStore,
  hasOpenBible,
  onCloseDecision,
  openExternal,
  registerHandlers,
} from './ipc/handlers';
import { wireEvent } from '../shared/ipc';

const APP_NAME = 'Novel Companion';

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
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) =>
    callback(false),
  );
}

/** Tests turn the prompt off so closing the app does not wait on a person. */
const skipStopPrompt = !app.isPackaged && process.env.NOVEL_COMPANION_SKIP_STOP_PROMPT === '1';
let closeApproved = false;
let quitPending = false;

function createWindow(): BrowserWindow {
  closeApproved = false;
  const win = new BrowserWindow({
    title: APP_NAME,
    width: 1200,
    height: 800,
    minWidth: 360,
    show: false,
    backgroundColor: '#f3f5f7',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });
  win.once('ready-to-show', () => win.show());
  // SL-1: closing the window or quitting asks "Where did you stop?" first. The
  // page answers through `app.confirmClose`; an empty answer still closes.
  win.on('close', (event) => {
    if (closeApproved || skipStopPrompt || !hasOpenBible()) return;
    const wc = win.webContents;
    if (wc.isDestroyed() || wc.isCrashed() || wc.isLoading()) return;
    event.preventDefault();
    win.webContents.send(wireEvent('app.closeRequested'), { hasBible: true });
  });
  onCloseDecision((proceed) => {
    if (!proceed) {
      quitPending = false;
      return;
    }
    closeApproved = true;
    if (quitPending) app.quit();
    else if (!win.isDestroyed()) win.close();
  });
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
  registerHandlers();
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

app.on('will-quit', () => {
  void closeStore();
});
