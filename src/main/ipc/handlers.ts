import { join } from 'node:path';
import { BrowserWindow, app, dialog, shell } from 'electron';
import { connect, listBibles } from '../db';
import type { Store } from '../db';
import { createBibleWithDefaults, openBibleForApp } from '../db/session';
import type { OpenBible } from '../db/session';
import { checkExternalUrl } from '../links';
import type { ImportBridge, ImportDeps } from './importHandlers';
import { DriveService, setDriveService } from '../drive';
import { GOOGLE_ENDPOINTS, endpointsAt } from '../drive/oauth';
import { keychainStore, memoryStore } from '../drive/secrets';
import { DRIVE_CHANNELS, driveHandlers } from './driveHandlers';
import type { DriveChannel } from './driveHandlers';
import { mongoUri } from '../secrets';
import { wireEvent } from '../../shared/ipc';
import type { EventName, EventPayload, Response } from '../../shared/ipc';
import { handle } from './handle';
import { exportTree } from './exportTree';
import { BIBLE_CHANNELS, bibleHandlers, testHandlers } from './bibleHandlers';
import type { BibleChannel } from './bibleHandlers';
import type { Handler } from './validate';

let store: Store | null = null;
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
 * GD-1: the one Drive service. An unpackaged build may point it at a local
 * fake Google (tests), with tokens held in memory instead of the keychain.
 */
const TEST_GOOGLE_ENV = 'NOVEL_COMPANION_TEST_GOOGLE_BASE';
function makeDriveService(): DriveService {
  const base = testPath(TEST_GOOGLE_ENV);
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
    secrets: keychainStore(),
    endpoints: GOOGLE_ENDPOINTS,
    // The consent page opens in the system browser, never in the app's window.
    openBrowser: (url) => shell.openExternal(url),
  });
}

let importBridge: ImportBridge | null = null;
let onDriveApplied: ((origin: string) => Promise<void>) | null = null;

const importDeps: ImportDeps = {
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
  const dh = driveHandlers(
    () => current?.session ?? null,
    () => drive,
    () => importBridge,
  );
  onDriveApplied = dh.onApplied;
  for (const channel of DRIVE_CHANNELS) {
    handle(channel, dh.handlers[channel] as Handler<DriveChannel>);
  }
  // The proposal seam for tests exists only outside a packaged app.
  if (!app.isPackaged) {
    handle('test.propose', testHandlers(() => current?.session ?? null)['test.propose']);
  }
}
