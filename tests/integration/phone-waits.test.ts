import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { Document } from 'mongodb';
import type { Store } from '../../src/main/db';
import { openBibleSession } from '../../src/main/db/session';
import { readRev } from '../../src/main/db/rev';
import { BridgeStore } from '../../src/main/db/bridge';
import { BridgeService } from '../../src/main/bridge/service';
import { BRIDGE_UP, worldIdFor } from '../../src/shared/bridge';
import { factKey } from '../../src/shared/domain/tray';
import { CHANNEL_REACH } from '../../src/shared/ipcPhone';
import { isWriteChannel } from '../../src/shared/ipcApp';
import { PHONE_WAITS_MAX, PHONE_WAITS_META_ID } from '../../src/shared/phoneWaits';
import { NOTEBOOK_COLLECTION } from '../../src/shared/schema';
import { freshSlug, localStore } from '../helpers/db';
import { ipcFor } from '../helpers/ipc';
import { loadFixture } from '../helpers/loadFixture';

/**
 * A58 U5 (PH-28): a sentence the phone cannot file without Claude waits for
 * the desk in the `meta` document `phoneWaits`, over `capture.wait`,
 * `capture.waiting` and `capture.takeBack`. The tray's marks say when the
 * desk has handled one, and the notebook pull never touches them.
 */
let store: Store;
beforeAll(async () => {
  store = await localStore();
});
afterAll(async () => {
  await store.close();
});

const KESSLER = 'The Kessler crowd stops tipping by 2070.';
const TRAM = 'The tram to the coast was free on Sundays.';

describe('PH-28 sentences that wait for the desk', () => {
  let slug: string;
  let session: Awaited<ReturnType<typeof openBibleSession>>;
  let invoke: ReturnType<typeof ipcFor>;

  beforeAll(async () => {
    slug = freshSlug('ph28');
    await loadFixture(store, slug);
    session = await openBibleSession(store, slug);
    invoke = ipcFor(() => session);
  });

  const stored = () =>
    store.db.collection(`${slug}.meta`).findOne({ _id: PHONE_WAITS_META_ID as never });

  test('PH-28 the three channels work on the phone; keeping and taking back are writes', () => {
    expect(CHANNEL_REACH['capture.waiting']).toBe('phone');
    expect(CHANNEL_REACH['capture.wait']).toBe('phone');
    expect(CHANNEL_REACH['capture.takeBack']).toBe('phone');
    expect(isWriteChannel('capture.wait')).toBe(true);
    expect(isWriteChannel('capture.takeBack')).toBe(true);
    expect(isWriteChannel('capture.waiting')).toBe(false);
    // The desk tray's own channels stay on the desk.
    expect(CHANNEL_REACH['tray.mark']).toBe('desk');
    expect(CHANNEL_REACH['tray.state']).toBe('desk');
  });

  test('PH-28 capture.wait keeps a sentence with its own ID, year and time, raises rev, and it is there after a reopen', async () => {
    expect(await invoke('capture.waiting', {})).toEqual({ lines: [] });
    const before = await readRev(session.handle);
    const { lines } = await invoke('capture.wait', {
      lines: [{ text: ` ${KESSLER} `, year: 2034 }],
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ text: KESSLER, year: 2034, handled: false });
    expect(lines[0]!.id).toMatch(/\S/);
    expect(Number.isNaN(Date.parse(lines[0]!.at))).toBe(false);
    expect(await readRev(session.handle)).toBe(before + 1);
    expect(await stored()).toEqual({
      _id: PHONE_WAITS_META_ID,
      lines: [{ id: lines[0]!.id, text: KESSLER, year: 2034, at: lines[0]!.at }],
    });
    const again = await openBibleSession(store, slug);
    expect(again.repo.phoneWaits()).toEqual([
      { id: lines[0]!.id, text: KESSLER, year: 2034, at: lines[0]!.at },
    ]);
  });

  test('PH-28 a line given back with its ID returns in place, never twice; capture.takeBack takes it out', async () => {
    const first = (await invoke('capture.waiting', {})).lines[0]!;
    const { lines: two } = await invoke('capture.wait', { lines: [{ text: TRAM, year: 2040 }] });
    expect(two.map((l) => l.text)).toEqual([KESSLER, TRAM]);
    const back = await invoke('capture.takeBack', { ids: [first.id] });
    expect(back.lines.map((l) => l.text)).toEqual([TRAM]);
    const restored = await invoke('capture.wait', {
      lines: [{ id: first.id, text: first.text, year: first.year, at: first.at }],
    });
    expect(restored.lines.map((l) => l.text)).toEqual([TRAM, KESSLER]);
    const redo = await invoke('capture.wait', {
      lines: [{ id: first.id, text: first.text, year: first.year, at: first.at }],
    });
    expect(redo.lines).toEqual(restored.lines);
    expect(redo.lines.find((l) => l.id === first.id)).toEqual({ ...first, handled: false });
  });

  test('PH-28 a fact of the line marked filed, dismissed or sent in the tray is handled; clearing the mark makes it wait again', async () => {
    const { lines } = await invoke('capture.waiting', {});
    const kessler = lines.find((l) => l.text === KESSLER)!;
    const key = factKey(kessler.id, kessler.text, 0);
    for (const mark of ['filed', 'dismissed', 'sent'] as const) {
      await invoke('tray.mark', { keys: [key], mark });
      const now = (await invoke('capture.waiting', {})).lines;
      expect(now.find((l) => l.id === kessler.id)?.handled, mark).toBe(true);
      expect(now.find((l) => l.text === TRAM)?.handled).toBe(false);
    }
    await invoke('tray.mark', { keys: [key], mark: null });
    const after = (await invoke('capture.waiting', {})).lines;
    expect(after.find((l) => l.id === kessler.id)?.handled).toBe(false);
    // A mark on a line with other words (the same ID, edited) is not this line's.
    await invoke('tray.mark', { keys: [factKey(kessler.id, 'Other words.', 0)], mark: 'filed' });
    expect(
      (await invoke('capture.waiting', {})).lines.find((l) => l.id === kessler.id)?.handled,
    ).toBe(false);
  });

  test('PH-28 more sentences than may wait at once is refused in plain words and keeps what was there', async () => {
    const have = (await invoke('capture.waiting', {})).lines;
    const many = Array.from({ length: PHONE_WAITS_MAX }, (_, i) => ({
      text: `Line ${i}.`,
      year: 2034,
    }));
    await expect(invoke('capture.wait', { lines: many })).rejects.toThrow(/waiting for the Mac/);
    expect((await invoke('capture.waiting', {})).lines).toEqual(have);
  });

  test('PH-28 capture.takeBack refuses a line the desk has handled, and keeps it for the desk', async () => {
    const { lines } = await invoke('capture.wait', {
      lines: [{ text: 'Handled already.', year: 2034 }],
    });
    const line = lines.find((l) => l.text === 'Handled already.')!;
    const key = factKey(line.id, line.text, 0);
    await invoke('tray.mark', { keys: [key], mark: 'filed' });
    await expect(invoke('capture.takeBack', { ids: [line.id] })).rejects.toThrow(
      'The Mac has already handled this sentence.',
    );
    const after = (await invoke('capture.waiting', {})).lines.find((l) => l.id === line.id);
    expect(after).toMatchObject({ text: 'Handled already.', handled: true });
    // Undo on the desk clears the mark: it waits again and can be taken back.
    await invoke('tray.mark', { keys: [key], mark: null });
    const back = await invoke('capture.takeBack', { ids: [line.id] });
    expect(back.lines.some((l) => l.id === line.id)).toBe(false);
  });

  test('PH-28 only unhandled lines count toward the limit; the oldest handled lines make room', async () => {
    const own = freshSlug('ph28cap');
    await loadFixture(store, own);
    const s = await openBibleSession(store, own);
    const call = ipcFor(() => s);
    const first = await call('capture.wait', {
      lines: Array.from({ length: PHONE_WAITS_MAX }, (_, i) => ({ text: `Old ${i}.`, year: 2034 })),
    });
    // The desk files every one of them.
    await call('tray.mark', {
      keys: first.lines.map((l) => factKey(l.id, l.text, 0)),
      mark: 'filed',
    });
    // Nothing waits, so the phone can keep another, and the store stays at the limit.
    const next = await call('capture.wait', { lines: [{ text: 'New one.', year: 2034 }] });
    expect(next.lines.filter((l) => !l.handled).map((l) => l.text)).toEqual(['New one.']);
    expect(next.lines).toHaveLength(PHONE_WAITS_MAX);
    expect(next.lines.some((l) => l.text === 'Old 0.')).toBe(false);
    expect(next.lines.some((l) => l.text === `Old ${PHONE_WAITS_MAX - 1}.`)).toBe(true);
    // Unhandled lines past the limit are still refused, in words that are true.
    await expect(
      call('capture.wait', {
        lines: Array.from({ length: PHONE_WAITS_MAX }, (_, i) => ({
          text: `More ${i}.`,
          year: 2034,
        })),
      }),
    ).rejects.toThrow(
      `No more than ${PHONE_WAITS_MAX} sentences can be waiting for the Mac at once.`,
    );
  });

  test('PH-28 the notebook pull, which trashes pages its rows no longer make, leaves the waiting sentences alone', async () => {
    const world = worldIdFor(slug)!;
    const service = new BridgeService({
      store: new BridgeStore(store.bridge),
      session,
      world,
      name: 'Fixture novel',
      publishAfterMs: 20,
      pullEveryMs: 60 * 60 * 1000,
    });
    try {
      const waits = (await invoke('capture.waiting', {})).lines;
      const metaBefore = await stored();
      const at = Date.parse('2026-11-25T21:00:00.000Z');
      const row = (rev: number, deleted: boolean) => ({
        world,
        table: 'messages',
        id: 'K9',
        rev,
        deleted,
        row: deleted
          ? null
          : {
              id: 'K9',
              at,
              updatedAt: at,
              text: 'Daniel moves to Guangzhou in 2033.',
              wise: false,
              kept: true,
              kind: 'kept',
              date: at,
              year: 2033,
              chips: { characterIds: [], placeIds: [] },
            },
        at: rev,
      });
      const up = store.bridge.collection(BRIDGE_UP);
      await up.replaceOne({ _id: `${world}:messages:K9` } as Document, row(1, false), {
        upsert: true,
      });
      await service.pull();
      await up.replaceOne({ _id: `${world}:messages:K9` } as Document, row(2, true), {
        upsert: true,
      });
      await service.pull();
      const pages = await store.db.collection(`${slug}.${NOTEBOOK_COLLECTION}`).find({}).toArray();
      // The pull made and then trashed its own page, and no page is a waiting line.
      expect(pages.map((p) => [p._id, Boolean(p.deletedAt)])).toEqual([['K9', true]]);
      for (const w of waits) expect(pages.some((p) => String(p._id) === w.id)).toBe(false);
      expect(await stored()).toEqual(metaBefore);
      expect((await invoke('capture.waiting', {})).lines).toEqual(waits);
    } finally {
      service.stop();
    }
  });
});
