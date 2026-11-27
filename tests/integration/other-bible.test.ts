import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createBible } from '../../src/main/db';
import type { Store } from '../../src/main/db';
import { openBibleSession } from '../../src/main/db/session';
import type { OpenBible } from '../../src/main/db/session';
import { exportBibleJson, importBibleJson } from '../../src/main/backup/json';
import { bibleHandlers } from '../../src/main/ipc/bibleHandlers';
import type { BibleChannel } from '../../src/main/ipc/bibleHandlers';
import { guardHandler } from '../../src/main/ipc/offline';
import { runHandler } from '../../src/main/ipc/validate';
import type { Handler } from '../../src/main/ipc/validate';
import { OTHER_BIBLE_MESSAGE, OtherBibleError } from '../../src/shared/ipcApp';
import type { CallContext, Channel, Request, Response } from '../../src/shared/ipc';
import { freshSlug, localStore } from '../helpers/db';
import { loadFixture } from '../helpers/loadFixture';

let store: Store;
let original: OpenBible;
let copy: OpenBible;
/** The bible main has open, as `current` in `src/main/ipc/handlers.ts`. */
let open: OpenBible | null = null;

beforeAll(async () => {
  store = await localStore();
  const handle = await loadFixture(store, freshSlug('a57-original'));
  original = await openBibleSession(store, handle.id);
  // An imported copy keeps every _id, so a write meant for one would fit the other.
  const target = await createBible(store, freshSlug('a57-copy'), 'Imported copy');
  await importBibleJson(target, (await exportBibleJson(original.handle)).text);
  copy = await openBibleSession(store, target.id);
});
afterAll(async () => {
  await store.close();
});

/** The bible channels as main registers them, with the context the preload sends beside a request. */
function ipc() {
  const handlers = bibleHandlers(() => open, {});
  const guard = {
    readOnly: () => false,
    lost: () => undefined,
    openBible: () => open?.handle.id ?? null,
  };
  return async <C extends Channel>(
    channel: C,
    request: Request<C>,
    context?: CallContext | unknown,
  ): Promise<Response<C>> => {
    const handler = handlers[channel as BibleChannel] as Handler<C> | undefined;
    if (!handler) throw new Error(`No bible handler for ${channel}`);
    const wire = JSON.parse(JSON.stringify(request)) as unknown;
    const response = await runHandler(
      channel,
      guardHandler(channel, handler, guard),
      wire,
      context,
    );
    return JSON.parse(JSON.stringify(response)) as Response<C>;
  };
}

/** What MongoDB holds for a bible, read past the read model. */
async function storedRole(bible: OpenBible, id: string): Promise<unknown> {
  const doc = await store.db
    .collection<{ _id: string; role?: unknown }>(`${bible.handle.id}.characters`)
    .findOne({ _id: id });
  return doc?.role;
}

describe('A57 main refuses a write made in another bible than the open one', () => {
  test('A57 ED-2 a write carrying another bible ID is refused with a typed error and writes nothing; reads and the right ID go through', async () => {
    const call = ipc();
    const before = await storedRole(copy, 'H1');
    const outlineBefore = copy.repo.sceneOutline();
    open = original;
    // Typed in the original, while it is open: stored there.
    await call(
      'entry.update',
      { collection: 'characters', id: 'H1', patch: { role: 'Typed in the original' } },
      { bible: original.handle.id },
    );
    expect(await storedRole(original, 'H1')).toBe('Typed in the original');

    // The imported copy opens; a late autosave from the original arrives.
    open = copy;
    const late = call(
      'entry.update',
      { collection: 'characters', id: 'H1', patch: { role: 'Late autosave' } },
      { bible: original.handle.id },
    );
    await expect(late).rejects.toBeInstanceOf(OtherBibleError);
    await expect(late).rejects.toThrow(OTHER_BIBLE_MESSAGE);
    expect(await storedRole(copy, 'H1')).toBe(before);
    expect(copy.model.get('characters', 'H1')?.role).toBe(before);
    expect(await storedRole(original, 'H1')).toBe('Typed in the original');

    // Reads carry no refusal.
    const read = await call(
      'entry.get',
      { collection: 'characters', id: 'H1' },
      { bible: original.handle.id },
    );
    expect(read.entry.role).toBe(before);

    // The copy's own write, carrying its ID, is stored in the copy.
    await call(
      'entry.update',
      { collection: 'characters', id: 'H1', patch: { role: 'Typed in the copy' } },
      { bible: copy.handle.id },
    );
    expect(await storedRole(copy, 'H1')).toBe('Typed in the copy');
    expect(await storedRole(original, 'H1')).toBe('Typed in the original');
    expect(copy.repo.sceneOutline()).toEqual(outlineBefore);
  });

  test("A57 PL-5 the Outline's whole-document write on leaving cannot replace another bible's scene outline", async () => {
    const call = ipc();
    open = copy;
    const outlineBefore = copy.repo.sceneOutline();
    const late = call(
      'sceneOutline.set',
      { text: 'Written on leaving the original', breaks: {} },
      { bible: original.handle.id },
    );
    await expect(late).rejects.toBeInstanceOf(OtherBibleError);
    expect(copy.repo.sceneOutline()).toEqual(outlineBefore);
    const reopened = await openBibleSession(store, copy.handle.id);
    expect(reopened.repo.sceneOutline()).toEqual(outlineBefore);
  });

  test('A57 a context that is not a bible ID is refused as an invalid request', async () => {
    const call = ipc();
    open = copy;
    await expect(
      call(
        'entry.update',
        { collection: 'characters', id: 'H1', patch: { role: 'X' } },
        {
          bible: 'Not An ID!',
        },
      ),
    ).rejects.toThrow(/request context is not valid/);
    expect(await storedRole(copy, 'H1')).toBe('Typed in the copy');
  });
});
