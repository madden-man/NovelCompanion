import { ENTRY_COLLECTIONS } from '../../shared/schema';
import { NOTEBOOK_COLLECTION } from '../../shared/schema/notebook';
import { CHANNELS } from '../../shared/ipc';
import type { Response } from '../../shared/ipc';
import { PHONE_CHANNELS } from '../../shared/ipcPhone';
import type { OpenBible } from '../db/session';
import type { Host } from '../host/types';
import { MemoryPhoneKeyStore, makePhoneKey, phoneKeyStatus } from '../host/phoneKey';
import type { PhoneKeyStore } from '../host/phoneKey';
import { testDatabaseHonoured } from '../host/uri';
import type { Handler } from './validate';

/**
 * PH-15 under test: where Copy puts the key instead of the system clipboard,
 * beside the store that holds it, on `globalThis` in main so a test reads both back.
 */
export const TEST_PHONE_KEY_SEAM = '__ncPhoneKeySeam';
export interface PhoneKeySeam {
  store: PhoneKeyStore;
  copied: string | null;
}

type PwaChannel =
  'app.capabilities' | 'bible.changes' | 'phoneKey.status' | 'phoneKey.make' | 'phoneKey.copy';

/**
 * A58 P4: the handlers for `src/shared/ipcPwa.ts`. Under test the phone key
 * lives in memory and Copy never reaches the system clipboard, so a test run
 * touches neither the keychain nor the clipboard of the person at the Mac.
 */
export function pwaHandlers(
  host: Host,
  current: () => OpenBible | null,
): { [C in PwaChannel]: Handler<C> } {
  const opts = { isPackaged: host.isPackaged };
  const underTest = testDatabaseHonoured(process.env, opts);
  let seam: PhoneKeySeam | null = null;
  const testSeam = (): PhoneKeySeam => {
    if (!seam) {
      seam = { store: new MemoryPhoneKeyStore(), copied: null };
      (globalThis as Record<string, unknown>)[TEST_PHONE_KEY_SEAM] = seam;
    }
    return seam;
  };
  const store = (): PhoneKeyStore | null =>
    underTest ? testSeam().store : (host.secrets.phoneKey?.() ?? null);
  const copy = (text: string): boolean => {
    if (underTest) {
      testSeam().copied = text;
      return true;
    }
    if (!host.copyText) return false;
    host.copyText(text);
    return true;
  };
  return {
    'app.capabilities': () => ({ channels: host.hosted ? [...PHONE_CHANNELS] : [...CHANNELS] }),
    'bible.changes': ({ since }) => changesSince(current(), since),
    'phoneKey.status': () => phoneKeyStatus(store()?.get() ?? null),
    'phoneKey.make': () => {
      const keys = store();
      if (!keys) throw new Error('This app cannot keep a phone key.');
      if (!keys.get()) keys.set(makePhoneKey());
      return phoneKeyStatus(keys.get());
    },
    'phoneKey.copy': () => {
      const key = store()?.get();
      return { ok: key ? copy(key) : false };
    },
  };
}

/**
 * PH-9: every entry and notebook page of the open bible stored at or after
 * `since`, from the read model the request just made fresh. A page or entry
 * removed for good is not listed; its view finds it gone when next asked.
 */
export function changesSince(session: OpenBible | null, since: string): Response<'bible.changes'> {
  const at = new Date().toISOString();
  if (!session) return { bible: null, at, changes: [] };
  const changes: Response<'bible.changes'>['changes'] = [];
  for (const collection of [...ENTRY_COLLECTIONS, NOTEBOOK_COLLECTION]) {
    for (const doc of session.model.all(collection)) {
      const modified = typeof doc.modifiedAt === 'string' ? doc.modifiedAt : '';
      if (modified < since) continue;
      const deleted = typeof doc.deletedAt === 'string' && doc.deletedAt >= since;
      const created = typeof doc.createdAt === 'string' && doc.createdAt >= since;
      changes.push({
        collection,
        id: String(doc._id),
        op: deleted ? 'softDelete' : created ? 'create' : 'update',
      });
    }
  }
  return { bible: session.handle.id, at, changes: changes.slice(0, 20_000) };
}
