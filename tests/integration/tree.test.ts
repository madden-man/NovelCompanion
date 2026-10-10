import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { Store } from '../../src/main/db';
import { openBibleSession } from '../../src/main/db/session';
import type { OpenBible } from '../../src/main/db/session';
import { assembleGraph, layoutTree } from '../../src/shared/domain/tree';
import { freshSlug, localStore } from '../helpers/db';
import { ipcFor } from '../helpers/ipc';
import { loadFixture } from '../helpers/loadFixture';
import type { Invoke } from '../helpers/t5';

let store: Store;
let bible: OpenBible;
let invoke: Invoke;

beforeAll(async () => {
  store = await localStore();
  bible = await openBibleSession(store, (await loadFixture(store, freshSlug('tree'))).id);
  invoke = ipcFor(() => bible);
});
afterAll(async () => {
  await store.close();
});

const revisions = () => bible.handle.collection('revisions').countDocuments();

describe('FT-1 FT-4 tree queries against the loaded fixture', () => {
  test('FT-1 tree.get returns every person, union, and parent link from the read model', async () => {
    const t = await invoke('tree.get', {});
    expect(t.people.map((p) => p.id).sort()).toEqual(
      ['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'U1', 'X1', 'Z1', 'Z2', 'Z3', 'Z4', 'Z5'].sort(),
    );
    expect(t.unions.map((u) => [u.a, u.b, u.type, u.startYear, u.endYear])).toEqual([
      ['H1', 'H2', 'married', 1982, 2030],
      ['H3', 'Z3', 'married', 2029, null],
      ['H5', 'X1', 'partnered', 2056, 2064],
      ['Z1', 'Z2', 'partnered', null, null],
    ]);
    expect(t.links).toHaveLength(13);
    expect(t.links.find((l) => l.childId === 'H6')).toMatchObject({
      parentId: 'H4',
      type: 'adoptive',
      startYear: 2015,
    });
    expect(t.warnings).toEqual([]);
    // The renderer rebuilds the graph from this and lays it out.
    const g = assembleGraph(t.people, t.unions, t.links);
    const layout = layoutTree(g, new Set(g.people.map((p) => p.id)));
    expect(layout.nodes.get('H5')).toEqual({ x: 309, y: 264, gen: 2 });
  });

  test('FT-1 tree.lineage lists the ancestors and descendants of one person', async () => {
    expect(await invoke('tree.lineage', { id: 'H5' })).toEqual({
      ancestors: ['H1', 'H2', 'H3', 'Z1', 'Z2', 'Z3'],
      descendants: ['Z5'],
    });
    expect(await invoke('tree.lineage', { id: 'U1' })).toEqual({ ancestors: [], descendants: [] });
  });

  test('FT-3 a write through the one write path shows in the next tree.get at once', async () => {
    await invoke('entry.update', {
      collection: 'characters',
      id: 'Z4',
      patch: { birth: { year: 1994 } },
    });
    const t = await invoke('tree.get', {});
    expect(t.people.find((p) => p.id === 'Z4')!.birth).toEqual({ year: 1994 });
    await invoke('entry.update', {
      collection: 'characters',
      id: 'Z4',
      patch: { birth: { year: 1993 } },
    });
  });

  test('FT-6 a warning in the tree arrives with tree.get and the write still saves', async () => {
    await invoke('entry.update', {
      collection: 'characters',
      id: 'H6',
      patch: { birth: { year: 1980 } },
    });
    // Adoptive: no age warning. Make it biological to see one.
    await invoke('entry.update', {
      collection: 'parentLinks',
      id: 'PL-H4-H6',
      patch: { type: 'biological' },
    });
    const t = await invoke('tree.get', {});
    expect(t.warnings.map((w) => w.message)).toEqual([
      'Ruth Hale would be -10 when Sam Hale is born, under 12.',
    ]);
    const stored = await bible.handle
      .collection('parentLinks')
      .findOne({ _id: 'PL-H4-H6' as never });
    expect(stored!.type).toBe('biological');
    await invoke('entry.update', {
      collection: 'parentLinks',
      id: 'PL-H4-H6',
      patch: { type: 'adoptive' },
    });
    await invoke('entry.update', {
      collection: 'characters',
      id: 'H6',
      patch: { birth: { year: 2012 } },
    });
    expect((await invoke('tree.get', {})).warnings).toEqual([]);
  });
});

describe('FT-6 the write path refuses a person as their own ancestor', () => {
  test('FT-6 creating, editing, batching, or restoring a link that closes a loop is refused, and nothing is written', async () => {
    const before = await revisions();
    const msg =
      /Margaret Hale is already an ancestor of Iris Hale-Zhou, so it would make someone their own ancestor/;
    await expect(
      invoke('entry.create', {
        collection: 'parentLinks',
        data: { title: 'Loop', status: 'idea', parentId: 'H5', childId: 'H1', type: 'biological' },
      }),
    ).rejects.toThrow(msg);
    await expect(
      invoke('entry.createMany', {
        items: [
          {
            collection: 'characters',
            data: {
              _id: 'LOOPKID',
              title: 'Loop kid',
              status: 'idea',
              names: { full: 'Loop kid' },
              birth: { unknown: true },
            },
          },
          {
            collection: 'parentLinks',
            data: {
              _id: 'LOOP1',
              title: 'a',
              status: 'idea',
              parentId: 'Z5',
              childId: 'LOOPKID',
              type: 'biological',
            },
          },
          {
            collection: 'parentLinks',
            data: {
              _id: 'LOOP2',
              title: 'b',
              status: 'idea',
              parentId: 'LOOPKID',
              childId: 'H3',
              type: 'biological',
            },
          },
        ],
      }),
    ).rejects.toThrow(/own ancestor/);
    expect(bible.model.get('characters', 'LOOPKID')).toBeUndefined();
    expect(
      await bible.handle.collection('characters').findOne({ _id: 'LOOPKID' as never }),
    ).toBeNull();
    await expect(
      invoke('entry.update', {
        collection: 'parentLinks',
        id: 'PL-H1-H3',
        patch: { parentId: 'Z5' },
      }),
    ).rejects.toThrow(/own ancestor/);
    // A link in the trash cannot come back if the tree changed so that it would close a loop.
    const { entry } = await invoke('entry.create', {
      collection: 'parentLinks',
      data: {
        title: 'X1 parent of U1',
        status: 'idea',
        parentId: 'X1',
        childId: 'U1',
        type: 'guardian',
      },
    });
    await invoke('entry.delete', { collection: 'parentLinks', id: entry._id });
    const back = await invoke('entry.create', {
      collection: 'parentLinks',
      data: {
        title: 'U1 parent of X1',
        status: 'idea',
        parentId: 'U1',
        childId: 'X1',
        type: 'guardian',
      },
    });
    await expect(
      invoke('entry.restore', { collection: 'parentLinks', id: entry._id }),
    ).rejects.toThrow(/own ancestor/);
    await invoke('entry.delete', { collection: 'parentLinks', id: back.entry._id });
    expect(await revisions()).toBe(before + 4);
  });

  test('FT-2 entry.createMany writes a person and their links in one transaction, all or nothing', async () => {
    const items = [
      {
        collection: 'characters' as const,
        data: {
          _id: 'NEWKID',
          title: 'New kid',
          status: 'idea',
          names: { full: 'New kid' },
          birth: { year: 2060 },
        },
      },
      {
        collection: 'parentLinks' as const,
        data: {
          _id: 'NEWL1',
          title: 'Z5 parent of New kid',
          status: 'idea',
          parentId: 'Z5',
          childId: 'NEWKID',
          type: 'biological',
          startYear: 2060,
        },
      },
    ];
    // A duplicate ID in the batch fails the whole batch.
    await expect(
      invoke('entry.createMany', {
        items: [...items, { ...items[1]!, data: { ...items[1]!.data } }],
      }),
    ).rejects.toThrow(/share the ID NEWL1/);
    expect(bible.model.get('characters', 'NEWKID')).toBeUndefined();
    const res = await invoke('entry.createMany', { items });
    expect(res.entries.map((e) => e.entry._id)).toEqual(['NEWKID', 'NEWL1']);
    const t = await invoke('tree.get', {});
    expect(t.links.find((l) => l.id === 'NEWL1')).toMatchObject({
      parentId: 'Z5',
      childId: 'NEWKID',
    });
    expect(
      await bible.handle
        .collection('revisions')
        .countDocuments({ entryId: { $in: ['NEWKID', 'NEWL1'] } }),
    ).toBe(2);
  });
});

describe('FT-10 tree positions are stored per bible', () => {
  test('FT-10 saved positions come back from tree.get and after reopening, and write no revision', async () => {
    const before = await revisions();
    expect((await invoke('tree.get', {})).positions).toBeNull();
    const positions = { H1: { x: 9, y: 0 }, U1: { x: 0, y: -132, loose: true } };
    await invoke('tree.savePositions', { positions });
    expect((await invoke('tree.get', {})).positions).toEqual(positions);
    const again = await openBibleSession(store, bible.handle.id);
    expect((await ipcFor(() => again)('tree.get', {})).positions).toEqual(positions);
    expect(await revisions()).toBe(before);
  });
});

describe('CH-3 the character page and the story time', () => {
  test('CH-3 character.page shows ages at the last written chapter when no story time is set', async () => {
    await invoke('storyTime.set', { time: null });
    const { page } = await invoke('character.page', { id: 'H1' });
    expect(page.current).toMatchObject({
      year: 2040,
      chapterId: 'CH5',
      readingOrder: 5,
      state: { state: 'alive', age: 82, dyingThisYear: false },
    });
    expect(page.storyTime).toBeNull();
    expect(page.relatives.children.map((c) => c.name)).toEqual(['Daniel Hale', 'Ruth Hale']);
    expect(page.names.calledBy).toEqual([
      { characterId: 'H5', characterName: 'Iris Hale-Zhou', name: 'Gran' },
    ]);
  });

  test('CH-3 the story time drives the page age, persists in meta, and writes no entry', async () => {
    const before = await revisions();
    const set = await invoke('storyTime.set', { time: { year: 2041 } });
    expect(set).toEqual({
      time: { year: 2041 },
      position: { year: 2041, source: 'storyTime', chapterId: null },
    });
    const { page } = await invoke('character.page', { id: 'H1' });
    expect(page.storyTime).toEqual({
      year: 2041,
      state: { state: 'alive', age: 83, dyingThisYear: true },
    });
    // The current-position age stays at the last written chapter.
    expect(page.current.state).toEqual({ state: 'alive', age: 82, dyingThisYear: false });
    expect(await revisions()).toBe(before);
    // Reopen the bible: the story time comes back from the meta document.
    const again = await openBibleSession(store, bible.handle.id);
    expect(await ipcFor(() => again)('storyTime.get', {})).toEqual(set);
    await invoke('storyTime.set', { time: null });
  });

  test('CH-4 character.page reports an unknown birth as age unknown', async () => {
    const { page } = await invoke('character.page', { id: 'U1' });
    expect(page.current.state).toEqual({ state: 'unknown' });
    expect(page.years).toBe('unknown');
  });
});

describe('M1 review fix: rejecting a proposal checks it was still pending', () => {
  test('ED-7 a proposal decided elsewhere cannot be rejected; the refusal says it was already decided', async () => {
    const p = await bible.repo.propose({
      source: 'import',
      op: 'update',
      collection: 'characters',
      targetId: 'H2',
      data: { birthplace: 'Salem' },
    });
    // Another writer decides it in MongoDB; the read model still thinks it is pending.
    await bible.handle
      .collection('proposals')
      .updateOne({ _id: p._id as never }, { $set: { state: 'approved' } });
    await expect(invoke('proposal.reject', { id: p._id })).rejects.toThrow(
      'This proposal was already decided.',
    );
    expect(bible.model.get('proposals', p._id)!.state).toBe('pending');
  });
});
