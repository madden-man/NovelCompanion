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
    expect(ids.slice(0, 7)).toEqual(['book', 'part', 'CH1', 'CH2', 'CH3', 'CH4', made._id]);
    expect(grid.rows[1]).toMatchObject({ kind: 'part', id: 'PT1', chapterCount: 5 });

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

describe('KB-3 parts and books reorder, each move with a revision', () => {
  test('KB-3 a new part shows as an empty heading, and plot.reorder moves it to the front of its book', async () => {
    const part = await make('parts', { title: 'Coda', bookId: 'BK1', number: 3, status: 'idea' });
    let grid = await invoke('outline.get', { order: 'reading', cursorYear: null });
    expect(grid.rows.at(-1)).toMatchObject({ kind: 'part', id: part._id, chapterCount: 0 });
    expect(grid.rows[0]).toMatchObject({ kind: 'book', id: 'BK1', partCount: 3 });

    const n = await revs();
    const r = await invoke('plot.reorder', {
      kind: 'parts',
      groupId: 'BK1',
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

  test('KB-3 plot.reorder moves a book among the books and refuses a part from another book', async () => {
    const book = await make('books', { title: 'Second', number: 2, status: 'idea' });
    const r = await invoke('plot.reorder', { kind: 'books', movedId: book._id, toIndex: 0 });
    expect(r.collection).toBe('books');
    expect(r.changes.map((c) => [c.id, c.after])).toEqual([
      [book._id, { number: 1 }],
      ['BK1', { number: 2 }],
    ]);
    const grid = await invoke('outline.get', { order: 'reading', cursorYear: null });
    expect(grid.rows[0]).toMatchObject({ kind: 'book', id: book._id, partCount: 0 });
    await expect(
      invoke('plot.reorder', { kind: 'parts', groupId: book._id, movedId: 'PT1', toIndex: 0 }),
    ).rejects.toThrow(/not in this book/);
    await expect(
      invoke('plot.reorder', { kind: 'books', movedId: 'nope', toIndex: 0 }),
    ).rejects.toThrow(/book does not exist/);
    for (const c of r.changes) {
      await invoke('entry.update', { collection: 'books', id: c.id, patch: c.before });
    }
    await invoke('entry.delete', { collection: 'books', id: book._id });
  });
});

describe('KB-3 beats move on the chapter page', () => {
  test('KB-3 plot.reorder chapterBeats moves a beat past its neighbour in the arc that orders it', async () => {
    const arc = await make('arcs', {
      title: 'Tide',
      name: 'Tide',
      scope: 'custom',
      status: 'idea',
    });
    await invoke('entry.update', {
      collection: 'chapters',
      id: 'CH3',
      patch: { arcIds: [arc._id] },
    });
    const ids: string[] = [];
    for (const [i, t] of ['first', 'second'].entries()) {
      const b = await make('plotBeats', {
        title: t,
        chapterId: 'CH3',
        arcIds: [arc._id],
        arcOrders: [{ arcId: arc._id, order: i + 1 }],
        status: 'idea',
      });
      ids.push(b._id);
    }
    let page = (await invoke('chapter.page', { id: 'CH3' })).page;
    expect(page.beats.map((b) => [b.title, b.canMoveUp, b.canMoveDown])).toEqual([
      ['first', false, true],
      ['second', true, false],
    ]);
    const r = await invoke('plot.reorder', {
      kind: 'chapterBeats',
      groupId: 'CH3',
      movedId: ids[1]!,
      by: -1,
    });
    expect(r.collection).toBe('plotBeats');
    page = (await invoke('chapter.page', { id: 'CH3' })).page;
    expect(page.beats.map((b) => b.title)).toEqual(['second', 'first']);
    await expect(
      invoke('plot.reorder', { kind: 'chapterBeats', groupId: 'CH3', movedId: ids[1]!, by: -1 }),
    ).rejects.toThrow(/No beat that way/);
    await expect(
      invoke('plot.reorder', { kind: 'chapterBeats', groupId: 'CH2', movedId: ids[0]!, by: 1 }),
    ).rejects.toThrow(/not in this group/);
  });
});
