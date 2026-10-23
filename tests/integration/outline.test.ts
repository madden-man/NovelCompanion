import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { Store } from '../../src/main/db';
import { openBibleSession } from '../../src/main/db/session';
import type { OpenBible } from '../../src/main/db/session';
import { freshSlug, localStore } from '../helpers/db';
import { ipcFor } from '../helpers/ipc';
import { loadFixture } from '../helpers/loadFixture';
import type { Invoke } from '../helpers/t5';

let store: Store;
let bible: OpenBible;
let invoke: Invoke;

beforeAll(async () => {
  store = await localStore();
  bible = await openBibleSession(store, (await loadFixture(store, freshSlug('outline'))).id);
  invoke = ipcFor(() => bible);
});
afterAll(async () => {
  await store.close();
});

const chaptersNow = async () =>
  (await invoke('entry.list', { collection: 'chapters', trash: 'exclude' })).entries.map(
    (e) => e.entry,
  );
const order = async () =>
  Object.fromEntries((await chaptersNow()).map((c) => [c._id, c.readingOrder]));
const revs = () => bible.handle.collection('revisions').countDocuments();
const make = async (collection: string, data: Record<string, unknown>) =>
  (await invoke('entry.create', { collection: collection as never, data })).entry;

describe('KB-3 a new chapter from a part heading', () => {
  test('KB-3 outline.newChapter puts the chapter last in its part with one primary strand, and moves later chapters up in one transaction', async () => {
    const before = await order();
    const n = await revs();
    const r = await invoke('outline.newChapter', {
      partId: 'PT1',
      title: '  Low Tide ',
      year: 2050,
    });
    const made = r.entry;
    expect(made).toMatchObject({
      title: 'Low Tide',
      partId: 'PT1',
      readingOrder: 5,
      status: 'idea',
    });
    expect(made.strands).toEqual([
      expect.objectContaining({ label: 'present', startYear: 2050, endYear: null, primary: true }),
    ]);
    // Part two's chapters move up by one; part one keeps its numbers.
    expect(r.changes.map((c) => [c.id, c.before, c.after])).toEqual([
      ['CH5', { readingOrder: 5 }, { readingOrder: 6 }],
      ['CH6', { readingOrder: 6 }, { readingOrder: 7 }],
      ['CH7', { readingOrder: 7 }, { readingOrder: 8 }],
      ['CH8', { readingOrder: 8 }, { readingOrder: 9 }],
    ]);
    const after = await order();
    for (const id of ['CH1', 'CH2', 'CH3', 'CH4']) expect(after[id]).toBe(before[id]);
    expect(new Set(Object.values(after)).size).toBe(Object.keys(after).length);
    expect(await revs()).toBe(n + 5);
    // The grid shows it last in part one, and part one now counts five chapters.
    const grid = await invoke('outline.get', { order: 'reading', cursorYear: null });
    const ids = grid.rows.map((row) => (row.kind === 'chapter' ? row.id : row.kind));
    expect(ids.slice(0, 6)).toEqual(['part', 'CH1', 'CH2', 'CH3', 'CH4', made._id]);
    expect(grid.rows[0]).toMatchObject({ kind: 'part', id: 'PT1', chapterCount: 5 });

    // Undo, as the renderer replays it: the chapter to the trash, the numbers back.
    await invoke('entry.delete', { collection: 'chapters', id: made._id });
    for (const c of r.changes) {
      await invoke('entry.update', { collection: 'chapters', id: c.id, patch: c.before });
    }
    expect(await order()).toEqual(before);
  });

  test('KB-3 outline.newChapter refuses an unknown part and an empty title', async () => {
    await expect(
      invoke('outline.newChapter', { partId: 'nope', title: 'x', year: 2050 }),
    ).rejects.toThrow(/part does not exist/);
    await expect(
      invoke('outline.newChapter', { partId: 'PT1', title: '   ', year: 2050 }),
    ).rejects.toThrow();
  });
});

describe('KB-3 parts reorder, each move with a revision', () => {
  test('KB-3 a new part shows as an empty heading, and plot.reorder moves it to the front of the parts', async () => {
    const part = await make('parts', { title: 'Coda', number: 3, status: 'idea' });
    let grid = await invoke('outline.get', { order: 'reading', cursorYear: null });
    expect(grid.rows.at(-1)).toMatchObject({ kind: 'part', id: part._id, chapterCount: 0 });
    expect(grid.rows.filter((row) => row.kind === 'part')).toHaveLength(3);

    const n = await revs();
    const r = await invoke('plot.reorder', {
      kind: 'parts',
      movedId: part._id,
      toIndex: 0,
    });
    expect(r.collection).toBe('parts');
    expect(r.changes.map((c) => [c.id, c.before, c.after])).toEqual([
      [part._id, { number: 3 }, { number: 1 }],
      ['PT1', { number: 1 }, { number: 2 }],
      ['PT2', { number: 2 }, { number: 3 }],
    ]);
    expect(await revs()).toBe(n + 3);
    grid = await invoke('outline.get', { order: 'reading', cursorYear: null });
    expect(grid.rows.filter((row) => row.kind === 'part').map((row) => row.id)).toEqual([
      part._id,
      'PT1',
      'PT2',
    ]);
    // Reading order of the chapters is untouched.
    expect((await order()).CH1).toBe(1);
    for (const c of r.changes) {
      await invoke('entry.update', { collection: 'parts', id: c.id, patch: c.before });
    }
    await invoke('entry.delete', { collection: 'parts', id: part._id });
  });

  test('KB-3 plot.reorder refuses a part that does not exist', async () => {
    await expect(
      invoke('plot.reorder', { kind: 'parts', movedId: 'nope', toIndex: 0 }),
    ).rejects.toThrow(/part does not exist/);
  });
});

describe('PL-5 SM-5 the scene outline over IPC', () => {
  test('PL-5 SM-5 empty until set, round-trips text, breaks and years, survives a reopen, and writes no entry or revision', async () => {
    const before = await revs();
    expect(await invoke('sceneOutline.get', {})).toEqual({
      text: '',
      breaks: {},
      years: {},
      modifiedAt: null,
    });
    const text = 'Part one\n- Dawn lands in Jinan\n  - She finds the shrine\n- Mark waits';
    const breaks = { CH1: 1, CH2: 3 };
    const years = { '1': 2075, '3': 2046 };
    const saved = await invoke('sceneOutline.set', { text, breaks, years });
    expect(saved.text).toBe(text);
    expect(saved.breaks).toEqual(breaks);
    expect(saved.years).toEqual(years);
    expect(saved.modifiedAt).toEqual(expect.any(String));
    expect(await invoke('sceneOutline.get', {})).toEqual(saved);
    const reopened = await openBibleSession(store, bible.handle.id);
    expect(reopened.repo.sceneOutline()).toEqual(saved);
    expect(await revs()).toBe(before);
    // SM-5: ranges are no longer stored.
    const meta = await bible.handle
      .collection<{ _id: string }>('meta')
      .findOne({ _id: 'sceneOutline' });
    expect(meta).not.toHaveProperty('ranges');
    expect(meta).toMatchObject({ text, breaks, years });
    // A37, SM-5: a negative break or a year out of range is refused at the door; ranges are refused too.
    await expect(invoke('sceneOutline.set', { text, breaks: { CH1: -1 } })).rejects.toThrow(
      /not valid/,
    );
    await expect(invoke('sceneOutline.set', { text, years: { '1': 20001 } })).rejects.toThrow(
      /not valid/,
    );
    await expect(
      invoke('sceneOutline.set', { text, ranges: { CH1: { from: 1, to: 1 } } } as never),
    ).rejects.toThrow(/not valid/);
    // A save without breaks or years clears them.
    const cleared = await invoke('sceneOutline.set', { text });
    expect([cleared.breaks, cleared.years]).toEqual([{}, {}]);
  });

  test('PL-5 SM-5 versions: saves within the set days of the version opening share it, later saves open another, a restore is a new version that brings back its years', async () => {
    // Its own bible and a clock of its own, later than any real save, so the days rule (default 7) is what is tested.
    let clock = new Date('2030-01-01T09:00:00Z');
    const own = (await loadFixture(store, freshSlug('outline-versions'))).id;
    const timed = await openBibleSession(store, own, { now: () => clock });
    const run = ipcFor(() => timed);
    const versionsBefore = (await run('sceneOutline.versions', {})).versions;
    expect(versionsBefore).toEqual([]);

    await run('sceneOutline.set', { text: '- One' });
    // Six days later lands in the same version.
    clock = new Date('2030-01-07T09:00:00Z');
    await run('sceneOutline.set', {
      text: '- One\n- Two',
      breaks: { CH1: 0 },
      years: { '1': 2040 },
    });
    let versions = (await run('sceneOutline.versions', {})).versions;
    expect(versions.length).toBe(versionsBefore.length + 1);
    expect(versions[0]).toMatchObject({
      at: '2030-01-01T09:00:00.000Z',
      until: '2030-01-07T09:00:00.000Z',
      scenes: 2,
    });

    // Eight days after the version opened (two after its last save), a save opens another.
    clock = new Date('2030-01-09T09:00:00Z');
    await run('sceneOutline.set', {
      text: '- One\n- Two\n- Three',
      breaks: { CH1: 0 },
      years: { '2': 2050 },
    });
    versions = (await run('sceneOutline.versions', {})).versions;
    expect(versions.length).toBe(versionsBefore.length + 2);
    expect(versions[0]).toMatchObject({ at: '2030-01-09T09:00:00.000Z', scenes: 3 });
    expect(versions[1]).toMatchObject({ scenes: 2 });

    // Saving the same state again makes no version; a change of years alone makes a change.
    await run('sceneOutline.set', {
      text: '- One\n- Two\n- Three',
      breaks: { CH1: 0 },
      years: { '2': 2050 },
    });
    expect((await run('sceneOutline.versions', {})).versions.length).toBe(
      versionsBefore.length + 2,
    );
    const yearOnly = await run('sceneOutline.set', {
      text: '- One\n- Two\n- Three',
      breaks: { CH1: 0 },
      years: { '2': 2051 },
    });
    expect(yearOnly.years).toEqual({ '2': 2051 });
    expect((await run('sceneOutline.version', { id: versions[0]!.id })).years).toEqual({
      '2': 2051,
    });

    const old = await run('sceneOutline.version', { id: versions[1]!.id });
    expect(old.text).toBe('- One\n- Two');
    expect(old.breaks).toEqual({ CH1: 0 });
    expect(old.years).toEqual({ '1': 2040 });
    expect(old).not.toHaveProperty('ranges');

    clock = new Date('2030-01-10T09:00:00Z');
    const restored = await run('sceneOutline.restore', { id: versions[1]!.id });
    expect(restored.text).toBe('- One\n- Two');
    expect(restored.breaks).toEqual({ CH1: 0 });
    expect(restored.years).toEqual({ '1': 2040 });
    versions = (await run('sceneOutline.versions', {})).versions;
    expect(versions.length).toBe(versionsBefore.length + 3);
    expect(versions[0]).toMatchObject({ at: '2030-01-10T09:00:00.000Z', scenes: 2 });
    expect((await run('sceneOutline.version', { id: versions[0]!.id })).years).toEqual({
      '1': 2040,
    });
    await expect(run('sceneOutline.version', { id: 'missing' })).rejects.toThrow(/gone/);
  });

  test('PL-5 an outline written before versioning keeps its old state as the first version', async () => {
    const fresh = await openBibleSession(
      store,
      (await loadFixture(store, freshSlug('outline-v0'))).id,
    );
    // The state before any version existed, written straight to meta as the first build did.
    await fresh.handle
      .collection<{ _id: string; text?: string; modifiedAt?: string }>('meta')
      .updateOne(
        { _id: 'sceneOutline' },
        { $set: { text: '- Old scene', modifiedAt: '2026-10-16T10:00:00.000Z' } },
        { upsert: true },
      );
    const again = await openBibleSession(store, fresh.handle.id);
    const run = ipcFor(() => again);
    expect((await run('sceneOutline.get', {})).text).toBe('- Old scene');
    await run('sceneOutline.set', { text: '- New scene' });
    const versions = (await run('sceneOutline.versions', {})).versions;
    expect(versions.map((v) => v.at)).toEqual([expect.any(String), '2026-10-16T10:00:00.000Z']);
    expect((await run('sceneOutline.version', { id: versions[1]!.id })).text).toBe('- Old scene');
  });

  test('SM-5 an old outline and an old version saved with ranges still open, the ranges ignored', async () => {
    const fresh = await openBibleSession(
      store,
      (await loadFixture(store, freshSlug('outline-ranges'))).id,
    );
    const at = '2026-10-17T10:00:00.000Z';
    await fresh.handle.collection<Record<string, unknown> & { _id: string }>('meta').insertOne({
      _id: 'sceneOutline',
      text: '- A\n- B',
      ranges: { CH1: { from: 1, to: 2 } },
      breaks: { CH1: 0 },
      modifiedAt: at,
    });
    await fresh.handle
      .collection<Record<string, unknown> & { _id: string }>('sceneOutlineVersions')
      .insertOne({
        _id: 'OLDVERSION',
        at,
        until: at,
        text: '- A',
        ranges: { CH1: { from: 1, to: 1 } },
      });
    const again = await openBibleSession(store, fresh.handle.id);
    const run = ipcFor(() => again);
    expect(await run('sceneOutline.get', {})).toEqual({
      text: '- A\n- B',
      breaks: { CH1: 0 },
      years: {},
      modifiedAt: at,
    });
    // A37: the version saved with ranges only gets its breaks from them.
    const v = await run('sceneOutline.version', { id: 'OLDVERSION' });
    expect(v).toMatchObject({ text: '- A', breaks: { CH1: 0 }, years: {}, scenes: 1 });
    const restored = await run('sceneOutline.restore', { id: 'OLDVERSION' });
    expect(restored).toMatchObject({ text: '- A', breaks: { CH1: 0 }, years: {} });
    const meta = await again.handle
      .collection<{ _id: string }>('meta')
      .findOne({ _id: 'sceneOutline' });
    expect(meta).not.toHaveProperty('ranges');
  });

  test('SM-5 A37 an outline saved with ranges only, before breaks, opens with breaks derived from its ranges; the next save writes them and drops the ranges', async () => {
    const fresh = await openBibleSession(
      store,
      (await loadFixture(store, freshSlug('outline-a36'))).id,
    );
    await fresh.handle.collection<Record<string, unknown> & { _id: string }>('meta').insertOne({
      _id: 'sceneOutline',
      text: 'Notes\n- A\n  - a detail\n- B\n- C',
      ranges: { CH1: { from: 1, to: 2 }, CH2: { from: 3, to: 3 } },
      modifiedAt: '2026-10-16T10:00:00.000Z',
    });
    const again = await openBibleSession(store, fresh.handle.id);
    const run = ipcFor(() => again);
    const opened = await run('sceneOutline.get', {});
    expect(opened).toMatchObject({ breaks: { CH1: 1, CH2: 4 }, years: {} });
    await run('sceneOutline.set', { text: opened.text, breaks: opened.breaks });
    const meta = await again.handle
      .collection<{ _id: string }>('meta')
      .findOne({ _id: 'sceneOutline' });
    expect(meta).toMatchObject({ breaks: { CH1: 1, CH2: 4 }, years: {} });
    expect(meta).not.toHaveProperty('ranges');
  });
});
