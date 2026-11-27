import { BrowserWindow, app, dialog, nativeTheme, shell } from 'electron';
import { wireEvent } from '../../shared/ipc';
import { claudeDeps } from '../claude';
import { claudeHandlers } from '../claude/handlers';
import { runtimeSessionClaude } from '../claude/session';
import { KeychainMongoUriStore } from '../secrets';
import type { Host } from './types';

/**
 * A58: the Electron main process as a host. This is what `ipc/handlers.ts`
 * took from `electron` and the keychain before the seam, moved here unchanged.
 * Make it after `app.setPath('userData', ...)` has run.
 */
export function electronHost(): Host {
  return {
    userData: app.getPath('userData'),
    isPackaged: app.isPackaged,
    secrets: { mongoUris: () => new KeychainMongoUriStore() },
    broadcast(event, payload) {
      for (const win of BrowserWindow.getAllWindows())
        win.webContents.send(wireEvent(event), payload);
    },
    dialogs: {
      async openFile({ title, filters }) {
        const result = await dialog.showOpenDialog({ title, properties: ['openFile'], filters });
        return result.canceled ? null : (result.filePaths[0] ?? null);
      },
      async saveFile({ onWindow, ...options }) {
        const parent = onWindow
          ? (BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0])
          : undefined;
        const result = parent
          ? await dialog.showSaveDialog(parent, options)
          : await dialog.showSaveDialog(options);
        return result.canceled ? null : (result.filePath ?? null);
      },
    },
    openExternal: (url) => shell.openExternal(url),
    setTheme(appearance) {
      nativeTheme.themeSource = appearance;
    },
    claude: {
      attach({ testSeams, testDatabase, current, emit }) {
        const setup = claudeDeps({
          isPackaged: app.isPackaged,
          testSeams,
          testDatabase,
          userData: app.getPath('userData'),
          appRoot: app.getAppPath(),
          env: process.env,
          version: app.getVersion(),
          emit,
        });
        return {
          runtime: setup.runtime,
          handlers: claudeHandlers(current, setup),
          // Chapter summaries (MS-2) run through the same runtime: streamed, stoppable, saved per
          // AI-1, with the models from Claude settings (DB-4). Test builds get the recorded Claude
          // from NOVEL_COMPANION_TEST_CLAUDE, like every other Claude feature.
          sessionClaude: runtimeSessionClaude(setup.runtime, current, setup.keys),
        };
      },
    },
  };
}
