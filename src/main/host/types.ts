import type { ClaudeStreamEvent } from '../../shared/claude';
import type { EventName, EventPayload } from '../../shared/ipc';
import type { Appearance } from '../../shared/ipcApp';
import type { ClaudeChannel } from '../claude/handlers';
import type { OpenBible } from '../db/session';
import type { Handler } from '../ipc/validate';
import type { SessionClaude } from '../session/claude';
import type { MongoUriStore } from './uri';

/**
 * A58: everything the process gives the IPC handlers. The Electron main
 * process is one host (`host/electron.ts`); a hosted function is another.
 * The handler table (`registerHandlers` in `ipc/handlers.ts`) reaches the
 * machine only through this, so it loads where Electron cannot.
 */
export interface Host {
  /** The app's data folder (snapshots, settings files, the bible used last); null with no disk. */
  readonly userData: string | null;
  /** A packaged build: the test seams are refused unless the allow flag says otherwise. */
  readonly isPackaged: boolean;
  readonly secrets: HostSecrets;
  /** Send an event to every window (or every client) that listens. */
  broadcast<E extends EventName>(event: E, payload: EventPayload<E>): void;
  /** Native file dialogs; null where there are none. */
  readonly dialogs: HostDialogs | null;
  /** Open an allowlisted https link in the system browser; null where there is none. */
  readonly openExternal: ((url: string) => Promise<void>) | null;
  /** Follow the appearance setting in the window frame (title bar, scroll bars, `system`). */
  setTheme(appearance: Appearance): void;
  /** Claude through the Agent SDK, which needs its bundled binary; null where it cannot run. */
  readonly claude: ClaudeHost | null;
  /** A58: the hosted function, which never migrates a bible and runs no phone bridge. */
  readonly hosted?: boolean;
}

export interface HostSecrets {
  /**
   * Where the MongoDB connection string is kept outside a test run (the
   * keychain on the Mac). Asked for only when it is first needed. The Claude
   * key store belongs to `claude`, since only Claude reads it.
   */
  mongoUris(): MongoUriStore;
}

export interface FileFilter {
  name: string;
  extensions: string[];
}

export interface HostDialogs {
  /** Ask for one file to open; null when the person cancels. */
  openFile(options: { title: string; filters: FileFilter[] }): Promise<string | null>;
  /**
   * Ask where to save a file; null when the person cancels. `onWindow` shows
   * it as a sheet on the app's window when one is open.
   */
  saveFile(options: {
    title: string;
    defaultPath: string;
    filters: FileFilter[];
    onWindow?: boolean;
  }): Promise<string | null>;
}

/** What the table needs from Claude: the handlers, the runtime to stop, and the summary service. */
export interface ClaudeWiring {
  runtime: { stopAll(): Promise<void> };
  handlers: { [C in ClaudeChannel]: Handler<C> };
  /** Chapter summaries (MS-2) through the same runtime. */
  sessionClaude: SessionClaude;
}

export interface ClaudeHost {
  attach(opts: {
    /** T-4: the recorded Claude is honoured only when this is true. */
    testSeams: boolean;
    /** On a test database the key is held in memory, so the keychain is never read. */
    testDatabase: boolean;
    current: () => OpenBible | null;
    emit(event: ClaudeStreamEvent): void;
  }): ClaudeWiring;
}
