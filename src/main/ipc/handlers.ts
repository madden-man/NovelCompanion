import { BrowserWindow, app, shell } from 'electron';
import { connect, createBible, listBibles } from '../db';
import type { Store } from '../db';
import { openBibleSession } from '../db/session';
import type { OpenBible } from '../db/session';
import { checkExternalUrl } from '../links';
import { mongoUri } from '../secrets';
import { wireEvent } from '../../shared/ipc';
import type { EventName, EventPayload, Response } from '../../shared/ipc';
import { handle } from './handle';
import { BIBLE_CHANNELS, bibleHandlers } from './bibleHandlers';
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
  const handle = await createBible(s, slug, name);
  const record = (await listBibles(s)).find((b) => b._id === handle.id);
  broadcast('bibles.changed', { current: currentSummary() });
  return { bible: { id: handle.id, name: record?.name ?? name } };
}

async function bibleOpen(slug: string): Promise<Response<'bible.open'>> {
  const s = await requireStore();
  const record = (await listBibles(s)).find((b) => b._id === slug);
  if (!record) throw new Error(`There is no bible with the ID "${slug}".`);
  const session = await openBibleSession(s, slug);
  current?.unsubscribe();
  const offChange = session.repo.onChange((e) => broadcast('bible.changed', e));
  const offLists = session.repo.onListsChange(() => broadcast('lists.changed', { bible: slug }));
  const unsubscribe = () => {
    offChange();
    offLists();
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

export function registerHandlers(): void {
  handle('app.ping', ({ message }) => ({ message, receivedAt: new Date().toISOString() }));
  handle('app.openExternal', ({ url }) => openExternal(url));
  handle('bible.list', () => bibleList());
  handle('bible.create', ({ slug, name }) => bibleCreate(slug, name));
  handle('bible.open', ({ slug }) => bibleOpen(slug));
  handle('bible.current', () => ({ bible: currentSummary() }));
  const handlers = bibleHandlers(() => current?.session ?? null);
  for (const channel of BIBLE_CHANNELS) {
    handle(channel, handlers[channel] as Handler<BibleChannel>);
  }
}
