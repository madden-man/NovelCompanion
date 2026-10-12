import { join } from 'node:path';
import { BrowserWindow, app, session } from 'electron';
import { applyContentSecurityPolicy } from './csp';
import { resetOnNavigation } from './promptReset';
import {
  applyStoredAppearance,
  closeStore,
  hasOpenBible,
  onCloseDecision,
  onClosePromptShown,
  openExternal,
  registerHandlers,
} from './ipc/handlers';
import { STOP_PROMPT_TIMEOUT_MS, stopPromptOutcome } from '../shared/domain/sessionLog';
import { wireEvent } from '../shared/ipc';

const APP_NAME = 'Novel Companion';

// One fixed data folder, so snapshots are always under
// ~/Library/Application Support/Novel Companion/snapshots/<bible>/. Tests give each run its own.
app.setPath(
  'userData',
  !app.isPackaged && process.env.NOVEL_COMPANION_USER_DATA
    ? process.env.NOVEL_COMPANION_USER_DATA
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
}

/** Tests turn the prompt off so closing the app does not wait on a person. */
const skipStopPrompt = !app.isPackaged && process.env.NOVEL_COMPANION_SKIP_STOP_PROMPT === '1';
let closeApproved = false;
let quitPending = false;
let stopTimer: ReturnType<typeof setTimeout> | null = null;
/** True while the page is showing the stop prompt and a person is answering it. */
let promptShown = false;

/**
 * SL-1: how long to wait for the page to show the stop prompt. Tests may
 * shorten it; a packaged app always waits the full 10 seconds.
 */
const stopPromptTimeout = (() => {
  const raw = Number(process.env.NOVEL_COMPANION_STOP_PROMPT_TIMEOUT_MS);
  return !app.isPackaged && Number.isFinite(raw) && raw > 0 ? raw : STOP_PROMPT_TIMEOUT_MS;
})();

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
    if (stopTimer || promptShown) return; // already asking
    win.webContents.send(wireEvent('app.closeRequested'), {
      hasBible: true,
      quitting: quitPending,
    });
    // A page that never shows the prompt cannot trap the window: close without a log.
    const asked = Date.now();
    stopTimer = setTimeout(() => {
      stopTimer = null;
      const outcome = stopPromptOutcome(
        { shown: false, decision: null, elapsedMs: Date.now() - asked },
        stopPromptTimeout,
      );
      if (outcome === 'close') finishClose();
    }, stopPromptTimeout);
  });
  const clearStopTimer = () => {
    if (stopTimer) clearTimeout(stopTimer);
    stopTimer = null;
  };
  const finishClose = () => {
    closeApproved = true;
    if (quitPending) app.quit();
    else if (!win.isDestroyed()) win.close();
  };
  // A reload or navigation removes the prompt, so the flag must not outlive it.
  resetOnNavigation(win.webContents, () => {
    promptShown = false;
  });
  onClosePromptShown(() => {
    promptShown = true;
    clearStopTimer();
  });
  onCloseDecision((proceed) => {
    promptShown = false;
    clearStopTimer();
    if (!proceed) {
      quitPending = false;
      return;
    }
    finishClose();
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
