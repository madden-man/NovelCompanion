import { join } from 'node:path';
import { listBibles } from '../db';
import type { Store } from '../db';
import { createBibleWithDefaults, openBibleForApp } from '../db/session';
import type { OpenBible } from '../db/session';
import { checkExternalUrl } from '../links';
import type { BackupDeps } from './backupHandlers';
import type { SessionDeps } from './sessionHandlers';
import { registerSessionClaude } from '../session/claude';
import {
  ALLOW_TEST_URI_ENV,
  MemoryMongoUriStore,
  TEST_URI_ENV,
  testDatabaseName,
  testMongoUri,
  testDatabaseHonoured,
  testSeamsHonoured,
} from '../host/uri';
import type { Host } from '../host/types';
import { ConnectionManager } from '../connection';
import { openSnapshotReadOnly } from '../db/readOnly';
import { FileAppSettingsStore, MemoryAppSettingsStore } from '../appSettings';
import type { AppSettingsStore } from '../appSettings';
import { guardHandler } from './offline';
import type { Channel } from '../../shared/ipc';
import type { EventName, EventPayload, Response } from '../../shared/ipc';
import { claudeContract } from '../../shared/claude';
import { exportTree } from './exportTree';
import { lookupWords } from '../words/datamuse';
import { BIBLE_CHANNELS, bibleHandlers, testHandlers } from './bibleHandlers';
import type { BibleChannel } from './bibleHandlers';
import { setHandler } from './validate';
import type { Handler, HandlerTable } from './validate';
import type { ClaudeChannel } from '../claude/handlers';
import { BridgeService } from '../bridge/service';
import { BridgeStore } from '../db/bridge';
import { worldForBible } from '../../shared/bridge';
import { EntryMoved } from '../db/repository';

/**
 * A58: the host this table was built for: the Electron main process, or a
 * process with no Electron at all. Set by `registerHandlers`.
 */
let app: Host;
let table: HandlerTable = new Map();
let claudeRuntime: { stopAll(): Promise<void> } | null = null;
let current: {
  session: OpenBible;
  name: string;
  unsubscribe: () => void;
  /** ARCH-6: set when this is a local snapshot open read-only. */
  readOnly?: true;
  /** A55: the phone bridge while this bible is open; none on a read-only snapshot. */
  bridge?: BridgeService;
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
  const lookup = underTest ? testMongoUri(process.env, { isPackaged: app.isPackaged }) : null;
  return new ConnectionManager({
    uris: underTest
      ? new MemoryMongoUriStore(lookup?.ok ? lookup.uri : null)
      : app.secrets.mongoUris(),
    localOnly: underTest,
    database: testDatabaseName(process.env, { isPackaged: app.isPackaged }),
    missingMessage:
      lookup && !lookup.ok ? lookup.message : 'No MongoDB connection string is stored.',
    snapshotRoot: snapshotRoot(),
    lastBibleFile: app.userData ? join(app.userData, 'last-bible.json') : undefined,
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

/** `<userData>/snapshots`, or none on a host with no disk. */
function snapshotRoot(): string | undefined {
  return app.userData ? join(app.userData, 'snapshots') : undefined;
}

function broadcast<E extends EventName>(event: E, payload: EventPayload<E>): void {
  app.broadcast(event, payload);
}

const currentSummary = () =>
  current ? { id: current.session.handle.id, name: current.name } : null;

/** A58: the open bible, for the hosted function's checks before each request. */
export const openSession = (): OpenBible | null => current?.session ?? null;

let flushed: (() => void) | null = null;

/** Main registers what happens when the page says it flushed its pending edits on close. */
export function onFlushed(fn: () => void): void {
  flushed = fn;
}

/** True when a bible is open, so closing the app first lets the page save its pending edits. A read-only snapshot has nothing to save. */
export function hasOpenBible(): boolean {
  return current !== null && !current.readOnly;
}

export async function closeStore(): Promise<void> {
  // Claude runs stop and save as stopped while the store is still open.
  await claudeRuntime?.stopAll();
  // BK-1: the day's snapshot is written in the background after opening; let it
  // finish, so quitting soon after opening still leaves today's snapshot (ARCH-6).
  await current?.session.dailySnapshot;
  current?.unsubscribe();
  current = null;
  await connection?.close();
}

async function bibleList(): Promise<Response<'bible.list'>> {
  // ARCH-6: a snapshot open read-only lists only itself, without waiting on MongoDB.
  if (current?.readOnly) {
    const st = await conn().status();
    return {
      connection: 'unavailable',
      message: st.message ?? undefined,
      bibles: [{ id: current.session.handle.id, name: current.name }],
    };
  }
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
  const { handle } = await createBibleWithDefaults(
    s,
    slug,
    name,
    current?.session.repo.eraDefaults(),
  );
  const record = (await listBibles(s)).find((b) => b._id === handle.id);
  broadcast('bibles.changed', { current: currentSummary() });
  return { bible: { id: handle.id, name: record?.name ?? name } };
}

let launchOpen: Promise<void> | null = null;

/** A57: the first question about the current bible waits until the bible opened last has opened again. */
function launched(): Promise<void> {
  return (launchOpen ??= openLastBible());
}

/**
 * A57: at launch the bible opened last opens again. With none, or when MongoDB
 * cannot be reached, or the bible is gone or will not open, nothing opens and
 * the window shows the bibles.
 */
async function openLastBible(): Promise<void> {
  const slug = conn().lastBible;
  if (!slug || current) return;
  const s = await getStore();
  if (!s.ok) return;
  try {
    if (!(await listBibles(s.store)).some((b) => b._id === slug)) {
      conn().remember(null);
      return;
    }
    await openBibleNow(slug);
  } catch (e) {
    // A log line for the developer console; the window shows the bibles (NF-3).
    console.error('Novel Companion could not open the last bible:', e);
  }
}

async function bibleOpen(slug: string): Promise<Response<'bible.open'>> {
  // An open asked for while the last bible is still opening at launch goes after it.
  await launched();
  return openBibleNow(slug);
}

async function openBibleNow(slug: string): Promise<Response<'bible.open'>> {
  const s = await requireStore();
  const bibles = await listBibles(s);
  const record = bibles.find((b) => b._id === slug);
  if (!record) throw new Error(`There is no bible with the ID "${slug}".`);
  const session = await openBibleForApp(s, slug, {
    snapshotRoot: snapshotRoot(),
    // A58 (PH-19): the hosted function never migrates, and the phone bridge runs on the desk only.
    ...(app.hosted ? { neverMigrate: record.name } : {}),
  });
  if (app.hosted) return adopt(session, record.name, false);
  // A55 (NB-1): the bible is published to the phone under its world ID.
  const bridge = new BridgeService({
    store: new BridgeStore(s.bridge),
    session,
    world: worldForBible(
      slug,
      bibles.map((b) => b._id),
    ),
    name: record.name,
    onError: logBridgeError,
    // A56 (FN-7): each question the phone changed becomes a step in the page's undo history.
    onQuestions: () => broadcast('notebook.questions', { bible: slug }),
  });
  const opened = await adopt(session, record.name, false, bridge);
  // Never holds up opening (NF-1); a failure is quiet and the next pull tries again.
  void bridge.start();
  return opened;
}

/**
 * A55 (NB-3): a failed publish or pull, or a notebook page skipped, is logged
 * and nothing else: the bible works the same and the next run tries again.
 * The error names the page or the driver's failure, never a connection string.
 */
export function logBridgeError(e: unknown): void {
  // A log line for the developer console, never shown to a person (NF-3).
  console.error('Novel Companion bridge:', e);
}

/** A55 (NB-3): the window came to the front, so the phone's pages are pulled. */
export function bridgeFocus(): void {
  void current?.bridge?.focus();
}

/**
 * A58 (PH-7, PH-8): make the open bible fresh. Reads its `rev` (one small
 * read); when it is not a number this process loaded or wrote, the read model
 * and the search index are read again, every view is told (`bible.reloaded`
 * and the change events), the pocket is published again through the bridge's
 * reload, and the answer is `{ moved: true }`. No open bible, or a read-only
 * snapshot, answers `{ moved: false }`.
 */
export async function freshenOpenBible(): Promise<{ moved: boolean }> {
  if (!current || current.readOnly) return { moved: false };
  return { moved: await current.session.repo.freshen() };
}

/** Make an opened bible (or a read-only snapshot of one) the current one, and follow its changes. */
async function adopt(
  session: OpenBible,
  name: string,
  readOnly: boolean,
  bridge?: BridgeService,
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
  const offTree = session.repo.onTreeChange(() => broadcast('tree.changed', { bible: slug }));
  // a47-model: the bible's settings changed.
  const offSettings = session.repo.onSettingsChange(() =>
    broadcast('settings.changed', { bible: slug }),
  );
  const offReload = session.repo.onReload((message, elsewhere) =>
    broadcast('bible.reloaded', { bible: slug, message, ...(elsewhere ? { elsewhere } : {}) }),
  );
  const unsubscribe = () => {
    bridge?.stop();
    offReload();
    offChange();
    offLists();
    offProposals();
    offTime();
    offTree();
    offSettings();
  };
  current = {
    session,
    name,
    unsubscribe,
    ...(readOnly ? { readOnly: true as const } : {}),
    ...(bridge && !readOnly ? { bridge } : {}),
  };
  // A57: a bible opened from MongoDB opens again at the next launch; a snapshot is only remembered for now.
  if (readOnly) conn().lastBible = slug;
  else conn().remember(slug);
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
  const root = snapshotRoot();
  if (!latest || !root) {
    throw new Error(
      'There is no local snapshot on this Mac yet, so there is nothing to open read-only.',
    );
  }
  const opened = await openSnapshotReadOnly(root, latest);
  const { bible } = await adopt(
    opened.session,
    opened.snapshot.name ?? opened.snapshot.bible,
    true,
  );
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
  // A57: with nothing open (MongoDB was out of reach at launch), the bible opened last opens.
  const reopen = current?.session.handle.id ?? c.lastBible;
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

/** A58: said when the host has no system browser to open a link in. */
const NO_BROWSER = 'This link opens only in the desktop app.';

/** A58: said when the host has no file dialogs, so no file can be chosen. */
const NO_DIALOGS = 'Open the desktop app to choose a file.';

const dialogs = () => {
  if (!app.dialogs) throw new Error(NO_DIALOGS);
  return app.dialogs;
};

/** Open an allowlisted link in the system browser. Used by IPC and by the window open handler. */
export async function openExternal(url: string): Promise<Response<'app.openExternal'>> {
  const check = checkExternalUrl(url);
  if (!check.ok) return check;
  if (!app.openExternal) return { ok: false, message: NO_BROWSER };
  await app.openExternal(check.url);
  return { ok: true };
}

/** True when the test seams are honoured (T-4): unpackaged, or packaged under the allow flag with a local test database. */
const seams = (): boolean => testSeamsHonoured(process.env, { isPackaged: app.isPackaged });

/** Test builds may name the file to pick, so no native dialog is needed. */
const testPath = (name: string): string | null =>
  seams() && process.env[name] ? (process.env[name] as string) : null;

const fileDeps: BackupDeps & SessionDeps = {
  async pickFile() {
    const forced = testPath('NOVEL_COMPANION_TEST_PICK_DOCUMENT');
    if (forced) return forced;
    return dialogs().openFile({
      title: 'Choose a Word document',
      filters: [{ name: 'Word documents', extensions: ['docx'] }],
    });
  },
  async pickSavePath(defaultName) {
    const forced = testPath('NOVEL_COMPANION_TEST_SAVE_PATH');
    if (forced) return forced;
    return dialogs().saveFile({
      title: 'Export the whole bible',
      defaultPath: defaultName,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
  },
  async pickBibleFile() {
    const forced = testPath('NOVEL_COMPANION_TEST_BIBLE_FILE');
    if (forced) return forced;
    return dialogs().openFile({
      title: 'Choose an exported bible',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
  },
};

/**
 * A58: the channels only a host with Claude serves (the Agent SDK runs its
 * bundled binary, which a hosted function cannot). Every other channel of
 * the contract is in the table `registerHandlers` returns for any host.
 */
export const ELECTRON_ONLY_CHANNELS = Object.keys(claudeContract) as ClaudeChannel[];

/** Put one channel's handler in the table being built. */
function handle<C extends Channel>(channel: C, handler: Handler<C>): void {
  setHandler(table, channel, handler);
}

/**
 * A58: build the handler table for a host. Nothing here touches `ipcMain`:
 * the Electron main process mounts the table with `mountHandlers`, and an
 * HTTP function can serve the same table. Claude's channels are in it only
 * when the host has Claude (`ELECTRON_ONLY_CHANNELS`).
 */
export function registerHandlers(host: Host): HandlerTable {
  app = host;
  table = new Map();
  handle('app.ping', ({ message }) => ({ message, receivedAt: new Date().toISOString() }));
  handle('app.openExternal', ({ url }) => openExternal(url));
  handle('bible.list', () => bibleList());
  handle(
    'bible.create',
    guard('bible.create', ({ slug, name }) => bibleCreate(slug, name)),
  );
  handle('bible.open', ({ slug }) => bibleOpen(slug));
  handle('bible.current', async () => {
    await launched();
    return { bible: currentSummary() };
  });
  // A56 (FN-7): the page's undo history takes the steps the bridge made for its own bible.
  handle('notebook.claimSteps', ({ bible }) => ({
    steps:
      current && !current.readOnly && current.session.handle.id === bible
        ? (current.bridge?.claimSteps() ?? [])
        : [],
  }));
  handle('tree.export', (req) => exportTree(req, app.dialogs));
  // WT-1: the writing tools read Datamuse from main; nothing in the bible changes.
  handle('words.lookup', (req) => lookupWords(req));
  handle('app.flushed', () => {
    flushed?.();
    return { ok: true as const };
  });
  registerAppHandlers();
  const handlers = bibleHandlers(() => current?.session ?? null, fileDeps);
  for (const channel of BIBLE_CHANNELS) {
    handle(channel, guard(channel, handlers[channel] as Handler<BibleChannel>));
  }
  // Claude (ARCH-4, AI-1 to AI-7), where the host can run it.
  const claudeSetup = app.claude?.attach({
    testSeams: seams(),
    testDatabase: testDatabaseHonoured(process.env, { isPackaged: app.isPackaged }),
    current: () => current?.session ?? null,
    emit: (e) => broadcast('claude.stream', e),
  });
  claudeRuntime = claudeSetup?.runtime ?? null;
  if (claudeSetup) {
    // Chapter summaries (MS-2) run through the same runtime.
    registerSessionClaude(claudeSetup.sessionClaude);
    for (const channel of ELECTRON_ONLY_CHANNELS) {
      handle(channel, guard(channel, claudeSetup.handlers[channel] as Handler<ClaudeChannel>));
    }
  }
  // The proposal seam for tests exists only outside a packaged app.
  if (!app.isPackaged) {
    const tests = testHandlers(() => current?.session ?? null);
    handle('test.propose', guard('test.propose', tests['test.propose']));
    handle('test.seed', guard('test.seed', tests['test.seed']));
  }
  return table;
}

/**
 * ARCH-6: every bible and Claude channel runs through this. A write
 * while a snapshot is open read-only is refused before it runs; a request
 * that fails because MongoDB went away says so and marks the connection lost.
 * A57: a write made in another bible than the open one is refused.
 */
function guard<C extends Channel>(channel: C, handler: Handler<C>): Handler<C> {
  const guarded = guardHandler(channel, handler, {
    readOnly: () => current?.readOnly === true,
    lost: () => conn().lost(),
    openBible: () => current?.session.handle.id ?? null,
  });
  return async (request, context) => {
    try {
      return await guarded(request, context);
    } catch (e) {
      // A58 (PH-11): a write planned against an entry that moved elsewhere: show the newer bible.
      if (e instanceof EntryMoved) void freshenOpenBible().catch(() => undefined);
      throw e;
    }
  };
}

let appSettings: AppSettingsStore | null = null;
const settingsStore = (): AppSettingsStore =>
  (appSettings ??= app.userData
    ? new FileAppSettingsStore(join(app.userData, 'app-settings.json'))
    : new MemoryAppSettingsStore());

/** ST-1: the window follows the appearance too (title bar, scroll bars, and `system`). */
export function applyStoredAppearance(): void {
  app.setTheme(settingsStore().read().appearance);
}

/** ST-1 and ARCH-6: the connection, the connection string, and appearance. */
function registerAppHandlers(): void {
  handle('connection.status', async () => {
    // The first question at launch waits for the first attempt, so the state is never a guess.
    if (!conn().tried) await conn().getStore();
    return conn().status();
  });
  handle('connection.retry', () => retryConnection());
  handle('connection.openSnapshot', () => openLatestSnapshot());
  handle('mongo.status', () => conn().mongoSettings());
  handle('mongo.test', ({ uri }) => conn().test(uri));
  handle('mongo.replace', async ({ uri }) => {
    const reopen = current?.session.handle.id ?? null;
    const r = await conn().replace(uri);
    // Switch over only after the test passed: the open bible opens again on the new connection.
    if (r.switched) await reopenAfterSwitch(reopen);
    return { ok: r.ok, message: r.message, mongo: conn().mongoSettings() };
  });
  handle('appearance.get', () => ({ appearance: settingsStore().read().appearance }));
  handle('appearance.set', ({ appearance }) => {
    const store = settingsStore();
    store.write({ ...store.read(), appearance });
    app.setTheme(appearance);
    return { appearance };
  });
}
