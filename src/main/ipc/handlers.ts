import { join } from 'node:path';
import { BrowserWindow, app, dialog, shell } from 'electron';
import { connect, listBibles } from '../db';
import type { Store } from '../db';
import { createBibleWithDefaults, openBibleForApp } from '../db/session';
import type { OpenBible } from '../db/session';
import { checkExternalUrl } from '../links';
import type { ImportBridge, ImportDeps } from './importHandlers';
import type { SessionDeps } from './sessionHandlers';
import { printHtmlToPdf } from '../session/pdf';
import { fakeSessionClaude, registerSessionClaude } from '../session/claude';
import { DriveService, fetchDriveFile, setDriveService } from '../drive';
import { gdocSource, registerManuscriptSource } from '../session/sources';
import { runtimeSessionClaude } from '../claude/session';
import { GOOGLE_ENDPOINTS, endpointsAt } from '../drive/oauth';
import { keychainStore, memoryStore } from '../drive/secrets';
import { DRIVE_CHANNELS, driveHandlers } from './driveHandlers';
import type { DriveChannel } from './driveHandlers';
import { TEST_URI_ENV, mongoUri } from '../secrets';
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

let store: Store | null = null;
let claudeRuntime: ClaudeRuntime | null = null;
let current: { session: OpenBible; name: string; unsubscribe: () => void } | null = null;

const UNREACHABLE =
  'The app could not reach the MongoDB deployment. Check your network connection and try again.';

async function getStore(): Promise<{ ok: true; store: Store } | { ok: false; message: string }> {
  if (store) return { ok: true, store };
  const lookup = mongoUri(process.env, { isPackaged: app.isPackaged });
  if (!lookup.ok) return lookup;
  try {
    // connect() closes its own client when it fails, so nothing is left open.
    store = await connect(lookup.uri);
    return { ok: true, store };
  } catch {
    store = null;
    return { ok: false, message: UNREACHABLE };
  }
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

/** True when a bible is open, so closing the app should ask where the writing stopped. */
export function hasOpenBible(): boolean {
  return current !== null;
}

export async function closeStore(): Promise<void> {
  // Claude runs stop and save as stopped while the store is still open.
  await claudeRuntime?.stopAll();
  current?.unsubscribe();
  current = null;
  await store?.close();
  store = null;
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
  current = { session, name: record.name, unsubscribe };
  const bible = { id: slug, name: record.name };
  broadcast('bibles.changed', { current: bible });
  return { bible };
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
  // MS-1: chapters can be read from Google Docs through the same Drive service (read only, MS-5).
  registerManuscriptSource(gdocSource(fetchDriveFile));
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
  // Briefs (SB-4, DB-2) and chapter summaries (MS-2) run through the same runtime: streamed,
  // stoppable, saved per AI-1, with the models from Claude settings (DB-4). T-3: test builds can
  // instead stand M7's synthesizer stand-in in for both.
  registerSessionClaude(
    !app.isPackaged && process.env.NOVEL_COMPANION_TEST_FAKE_CLAUDE === '1'
      ? fakeSessionClaude()
      : runtimeSessionClaude(claudeSetup.runtime, () => current?.session ?? null, claudeSetup.keys),
  );
  const claude = claudeHandlers(() => current?.session ?? null, claudeSetup);
  for (const channel of CLAUDE_CHANNELS) {
    handle(channel, claude[channel] as Handler<ClaudeChannel>);
  }
  // The proposal seam for tests exists only outside a packaged app.
  if (!app.isPackaged) {
    handle('test.propose', testHandlers(() => current?.session ?? null)['test.propose']);
  }
}
