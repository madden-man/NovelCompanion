import { join } from 'node:path';
import { BrowserWindow, app, dialog, nativeTheme, shell } from 'electron';
import { listBibles } from '../db';
import type { Store } from '../db';
import { createBibleWithDefaults, openBibleForApp } from '../db/session';
import type { OpenBible } from '../db/session';
import { checkExternalUrl } from '../links';
import type { ImportBridge, ImportDeps } from './importHandlers';
import type { SessionDeps } from './sessionHandlers';
import { printHtmlToPdf } from '../session/pdf';
import { fakeSessionClaude, registerSessionClaude } from '../session/claude';
import { DriveService, setDriveService } from '../drive';
import { GOOGLE_ENDPOINTS, endpointsAt } from '../drive/oauth';
import { keychainStore, memoryStore } from '../drive/secrets';
import { DRIVE_CHANNELS, driveHandlers } from './driveHandlers';
import type { DriveChannel } from './driveHandlers';
import {
  ALLOW_TEST_URI_ENV,
  KEYCHAIN_ACCOUNT,
  KEYCHAIN_SERVICE,
  KeychainMongoUriStore,
  MemoryMongoUriStore,
  TEST_URI_ENV,
  mongoUri,
} from '../secrets';
import { ConnectionManager } from '../connection';
import { openSnapshotReadOnly } from '../db/readOnly';
import { FileAppSettingsStore } from '../appSettings';
import type { AppSettingsStore } from '../appSettings';
import { guardHandler } from './offline';
import type { Channel } from '../../shared/ipc';
import { wireEvent } from '../../shared/ipc';
import type { EventName, EventPayload, Response } from '../../shared/ipc';
import { handle } from './handle';
import { exportTree } from './exportTree';
import { BIBLE_CHANNELS, bibleHandlers, testHandlers } from './bibleHandlers';
import type { BibleChannel } from './bibleHandlers';
import type { Handler } from './validate';
import { claudeDeps } from '../claude';
import type { ClaudeRuntime } from '../claude';
import { CLAUDE_CHANNELS, claudeHandlers } from '../claude/handlers';
import type { ClaudeChannel } from '../claude/handlers';

let claudeRuntime: ClaudeRuntime | null = null;
let current: {
  session: OpenBible;
  name: string;
  unsubscribe: () => void;
  /** ARCH-6: set when this is a local snapshot open read-only. */
  readOnly?: true;
} | null = null;

/**
 * ARCH-5, ST-1: the connection string lives in the keychain. An unpackaged
 * build under test keeps it in memory instead, seeded from the test address,
 * and accepts only local addresses, so a test never reads the keychain or
 * reaches Atlas.
 */
function makeConnection(): ConnectionManager {
  const underTest =
    process.env[TEST_URI_ENV] !== undefined &&
    (!app.isPackaged || process.env[ALLOW_TEST_URI_ENV] === '1');
  // Under test this never reads the keychain: it returns the local test address or refuses it.
  const lookup = underTest ? mongoUri(process.env, { isPackaged: app.isPackaged }) : null;
  return new ConnectionManager({
    uris: underTest
      ? new MemoryMongoUriStore(lookup?.ok ? lookup.uri : null)
      : new KeychainMongoUriStore(),
    localOnly: underTest,
    missingMessage:
      lookup && !lookup.ok
        ? lookup.message
        : `No MongoDB connection string is stored in the keychain (service "${KEYCHAIN_SERVICE}", account "${KEYCHAIN_ACCOUNT}"). Paste one under MongoDB connection, then click Replace connection.`,
    snapshotRoot: join(app.getPath('userData'), 'snapshots'),
    onStatus: (status) => broadcast('connection.changed', status),
  });
}

let connection: ConnectionManager | null = null;
const conn = (): ConnectionManager => (connection ??= makeConnection());

function getStore() {
  return conn().getStore();
}

async function requireStore(): Promise<Store> {
  const s = await getStore();
  if (!s.ok) throw new Error(s.message);
  return s.store;
}

function broadcast<E extends EventName>(event: E, payload: EventPayload<E>): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(wireEvent(event), payload);
}

const currentSummary = () =>
  current ? { id: current.session.handle.id, name: current.name } : null;

let closeDecision: ((proceed: boolean) => void) | null = null;
let closePromptShown: (() => void) | null = null;

/** SL-1: main registers what happens when the page says the stop prompt is showing. */
export function onClosePromptShown(fn: () => void): void {
  closePromptShown = fn;
}

/** SL-1: main registers what happens when the stop prompt is answered or cancelled. */
export function onCloseDecision(fn: (proceed: boolean) => void): void {
  closeDecision = fn;
}

/** True when a bible is open, so closing the app should ask where the writing stopped. A read-only snapshot has nowhere to save the note. */
export function hasOpenBible(): boolean {
  return current !== null && !current.readOnly;
}

export async function closeStore(): Promise<void> {
  // Claude runs stop and save as stopped while the store is still open.
  await claudeRuntime?.stopAll();
  current?.unsubscribe();
  current = null;
  await connection?.close();
}

async function bibleList(): Promise<Response<'bible.list'>> {
  const s = await getStore();
  if (!s.ok) return { connection: 'unavailable', message: s.message, bibles: [] };
  try {
    const bibles = await listBibles(s.store);
    return { connection: 'connected', bibles: bibles.map((b) => ({ id: b._id, name: b.name })) };
  } catch {
    return {
      connection: 'unavailable',
      message:
        'The app reached MongoDB but could not read the list of bibles. Check the account permissions.',
      bibles: [],
    };
  }
}

async function bibleCreate(slug: string, name: string): Promise<Response<'bible.create'>> {
  const s = await requireStore();
  const { handle } = await createBibleWithDefaults(s, slug, name);
  const record = (await listBibles(s)).find((b) => b._id === handle.id);
  broadcast('bibles.changed', { current: currentSummary() });
  return { bible: { id: handle.id, name: record?.name ?? name } };
}

async function bibleOpen(slug: string): Promise<Response<'bible.open'>> {
  const s = await requireStore();
  const record = (await listBibles(s)).find((b) => b._id === slug);
  if (!record) throw new Error(`There is no bible with the ID "${slug}".`);
  const session = await openBibleForApp(s, slug, {
    snapshotRoot: join(app.getPath('userData'), 'snapshots'),
  });
  return adopt(session, record.name, false);
}

/** Make an opened bible (or a read-only snapshot of one) the current one, and follow its changes. */
async function adopt(
  session: OpenBible,
  name: string,
  readOnly: boolean,
): Promise<Response<'bible.open'>> {
  const slug = session.handle.id;
  // A Claude run belongs to the bible it started in: stop it (saved as stopped) before switching.
  await claudeRuntime?.stopAll();
  current?.unsubscribe();
  const offChange = session.repo.onChange((e) => broadcast('bible.changed', e));
  const offLists = session.repo.onListsChange(() => broadcast('lists.changed', { bible: slug }));
  const offProposals = session.repo.onProposalsChange(() =>
    broadcast('proposals.changed', { bible: slug }),
  );
  const offTime = session.repo.onStoryTimeChange(() =>
    broadcast('storyTime.changed', { bible: slug }),
  );
  const offReload = session.repo.onReload((message) =>
    broadcast('bible.reloaded', { bible: slug, message }),
  );
  const unsubscribe = () => {
    offReload();
    offChange();
    offLists();
    offProposals();
    offTime();
  };
  current = { session, name, unsubscribe, ...(readOnly ? { readOnly: true as const } : {}) };
  conn().lastBible = slug;
  const bible = { id: slug, name };
  broadcast('bibles.changed', { current: bible });
  return { bible };
}

/**
 * ARCH-6: open the most recent local snapshot read-only, when MongoDB cannot
 * be reached. Refused while MongoDB is reachable, so a snapshot never stands
 * in for the real bible by mistake.
 */
async function openLatestSnapshot(): Promise<Response<'connection.openSnapshot'>> {
  const c = conn();
  if (!c.readOnly && c.current) {
    const st = await c.status();
    if (st.state === 'connected') {
      throw new Error(
        'MongoDB is connected, so the bible opens as usual. Snapshots open read-only only when MongoDB cannot be reached.',
      );
    }
  }
  const latest = await c.latest();
  if (!latest) {
    throw new Error(
      'There is no local snapshot on this Mac yet, so there is nothing to open read-only. Check your network connection, then click Try again.',
    );
  }
  const opened = await openSnapshotReadOnly(join(app.getPath('userData'), 'snapshots'), latest);
  const { bible } = await adopt(opened.session, opened.snapshot.bible, true);
  c.enterReadOnly(opened.snapshot);
  return { bible, status: await c.status() };
}

/**
 * ARCH-6: try MongoDB again. When it answers, the bible that was open (or the
 * one shown read-only) opens again from MongoDB, so nothing stays read-only
 * and nothing stays tied to the client that was lost.
 */
async function retryConnection(): Promise<Response<'connection.retry'>> {
  const c = conn();
  const reopen = current?.session.handle.id ?? null;
  const r = await c.retry();
  if (r.ok) await reopenAfterSwitch(reopen);
  return c.status();
}

/** After a reconnect or a new connection string, open the same bible again on the new client. */
async function reopenAfterSwitch(slug: string | null): Promise<void> {
  if (!slug) return;
  try {
    await bibleOpen(slug);
  } catch {
    // The bible is not on this deployment: go back to the list of bibles.
    await claudeRuntime?.stopAll();
    current?.unsubscribe();
    current = null;
    broadcast('bibles.changed', { current: null });
  }
}

/** Open an allowlisted link in the system browser. Used by IPC and by the window open handler. */
export async function openExternal(url: string): Promise<Response<'app.openExternal'>> {
  const check = checkExternalUrl(url);
  if (!check.ok) return check;
  await shell.openExternal(check.url);
  return { ok: true };
}

/** Test builds may name the file to pick, so no native dialog is needed. */
const testPath = (name: string): string | null =>
  !app.isPackaged && process.env[name] ? (process.env[name] as string) : null;

/**
 * GD-1: the one Drive service. An unpackaged build under test never reads
 * the keychain (as `mongoUri` skips it for a test database), and may point
 * Drive at a local fake Google.
 */
const TEST_GOOGLE_ENV = 'NOVEL_COMPANION_TEST_GOOGLE_BASE';
function makeDriveService(): DriveService {
  const base = testPath(TEST_GOOGLE_ENV);
  const underTest = base !== null || testPath(TEST_URI_ENV) !== null;
  if (base && /^http:\/\/127\.0\.0\.1:\d+\/?$/.test(base)) {
    return new DriveService({
      secrets: memoryStore(),
      endpoints: endpointsAt(base),
      // The fake consent page redirects straight to the loopback listener.
      openBrowser: async (url) => void (await fetch(url)),
      authTimeoutMs: 10_000,
    });
  }
  return new DriveService({
    secrets: underTest ? memoryStore() : keychainStore(),
    endpoints: GOOGLE_ENDPOINTS,
    // The consent page opens in the system browser, never in the app's window.
    openBrowser: (url) => shell.openExternal(url),
  });
}

let importBridge: ImportBridge | null = null;
let onDriveApplied: ((origin: string) => Promise<void>) | null = null;

const importDeps: ImportDeps & SessionDeps = {
  bridge: (b) => {
    importBridge = b;
  },
  onApplied: (origin) => onDriveApplied?.(origin),
  async pickFile(kind) {
    const forced = testPath(
      kind === 'workbook' ? 'NOVEL_COMPANION_TEST_PICK_FILE' : 'NOVEL_COMPANION_TEST_PICK_DOCUMENT',
    );
    if (forced) return forced;
    const result = await dialog.showOpenDialog({
      title: kind === 'workbook' ? 'Choose an Excel workbook' : 'Choose a Word document',
      properties: ['openFile'],
      filters:
        kind === 'workbook'
          ? [{ name: 'Excel workbooks', extensions: ['xlsx'] }]
          : [{ name: 'Word documents', extensions: ['docx'] }],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  },
  async pickSavePath(defaultName) {
    const forced = testPath('NOVEL_COMPANION_TEST_SAVE_PATH');
    if (forced) return forced;
    const result = await dialog.showSaveDialog({
      title: 'Export the whole bible',
      defaultPath: defaultName,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    return result.canceled ? null : (result.filePath ?? null);
  },
  /** SB-8: where an exported brief goes. Test builds may name a folder instead of a dialog. */
  async pickExportPath(defaultName, format) {
    const dir = testPath('NOVEL_COMPANION_TEST_BRIEF_EXPORT_DIR');
    if (dir) return join(dir, defaultName);
    const result = await dialog.showSaveDialog({
      title: format === 'pdf' ? 'Export the brief as a PDF' : 'Export the brief as Markdown',
      defaultPath: defaultName,
      filters:
        format === 'pdf'
          ? [{ name: 'PDF', extensions: ['pdf'] }]
          : [{ name: 'Markdown', extensions: ['md'] }],
    });
    return result.canceled ? null : (result.filePath ?? null);
  },
  printPdf: (html) => printHtmlToPdf(html),
  async pickBibleFile() {
    const forced = testPath('NOVEL_COMPANION_TEST_BIBLE_FILE');
    if (forced) return forced;
    const result = await dialog.showOpenDialog({
      title: 'Choose an exported bible',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  },
};

export function registerHandlers(): void {
  // T-3: test builds can stand a recorded-response Claude in for briefs and summaries (M7).
  if (!app.isPackaged && process.env.NOVEL_COMPANION_TEST_FAKE_CLAUDE === '1') {
    registerSessionClaude(fakeSessionClaude());
  }
  handle('app.ping', ({ message }) => ({ message, receivedAt: new Date().toISOString() }));
  handle('app.openExternal', ({ url }) => openExternal(url));
  handle('bible.list', () => bibleList());
  handle('bible.create', ({ slug, name }) => bibleCreate(slug, name));
  handle('bible.open', ({ slug }) => bibleOpen(slug));
  handle('bible.current', () => ({ bible: currentSummary() }));
  handle('tree.export', (req) => exportTree(req));
  handle('app.confirmClose', ({ proceed }) => {
    closeDecision?.(proceed);
    return { ok: true as const };
  });
  handle('app.closePromptShown', () => {
    closePromptShown?.();
    return { ok: true as const };
  });
  const handlers = bibleHandlers(() => current?.session ?? null, importDeps);
  for (const channel of BIBLE_CHANNELS) {
    handle(channel, handlers[channel] as Handler<BibleChannel>);
  }
  // Google Drive (M9).
  const drive = makeDriveService();
  setDriveService(drive);
  const dh = driveHandlers(
    () => current?.session ?? null,
    () => drive,
    () => importBridge,
  );
  onDriveApplied = dh.onApplied;
  for (const channel of DRIVE_CHANNELS) {
    handle(channel, dh.handlers[channel] as Handler<DriveChannel>);
  }

  // Claude (ARCH-4, AI-1 to AI-7, IM-5).
  const claudeSetup = claudeDeps({
    isPackaged: app.isPackaged,
    userData: app.getPath('userData'),
    appRoot: app.getAppPath(),
    env: process.env,
    version: app.getVersion(),
    emit: (e) => broadcast('claude.stream', e),
  });
  claudeRuntime = claudeSetup.runtime;
  const claude = claudeHandlers(() => current?.session ?? null, claudeSetup);
  for (const channel of CLAUDE_CHANNELS) {
    handle(channel, claude[channel] as Handler<ClaudeChannel>);
  }
  // The proposal seam for tests exists only outside a packaged app.
  if (!app.isPackaged) {
    handle('test.propose', testHandlers(() => current?.session ?? null)['test.propose']);
  }
}
