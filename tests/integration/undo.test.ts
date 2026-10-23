import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createBible } from '../../src/main/db';
import type { Store } from '../../src/main/db';
import { openBibleSession } from '../../src/main/db/session';
import type { OpenBible } from '../../src/main/db/session';
import { contentOf } from '../../src/shared/domain/diff';
import {
  UndoManager,
  createCommand,
  deleteCommand,
  editCommand,
} from '../../src/shared/domain/undoRunner';
import { undoIO } from '../../src/shared/undoIO';
import {
  briefSettingsCommand,
  communityNoteCommand,
  communityRemoveCommand,
  listAddCommand,
  listRemoveCommand,
  romanizationCommand,
  treeMoveCommand,
  treeMoves,
} from '../../src/shared/undoCommands';
import type { EntryCollection } from '../../src/shared/schema';
import { freshSlug, localStore } from '../helpers/db';
import { ipcFor } from '../helpers/ipc';

let store: Store;
let bible: OpenBible;

beforeAll(async () => {
  store = await localStore();
  bible = await openBibleSession(store, (await createBible(store, freshSlug('undo'), 'Undo')).id);
});
afterAll(async () => {
  await store.close();
});

const person = (name: string, year: number) => ({
  title: name,
  names: { full: name },
  birth: { year },
});

/** The stored document as MongoDB holds it, without the timestamps every write changes. */
async function stored(c: EntryCollection, id: string) {
  const doc = await bible.handle.collection(c).findOne({ _id: id as never });
  if (!doc) return null;
  return { content: contentOf(doc as never), inTrash: Boolean(doc.deletedAt) };
}

describe('ED-3 undo and redo of tree edits through the IPC layer', () => {
  test('ED-3 creating a union and a parent link, changing both types, and deleting the union undo to the start and redo to the end', async () => {
    const invoke = ipcFor(() => bible);
    const undo = new UndoManager();
    const io = undoIO(invoke);
    const mother = await bible.repo.create('characters', person('Meiling Zhou', 1955));
    const father = await bible.repo.create('characters', person('Wei Zhou', 1953));
    const child = await bible.repo.create('characters', person('Lan Zhou', 1982));

    const { entry: union } = await invoke('entry.create', {
      collection: 'unions',
      data: {
        title: 'Meiling and Wei',
        partnerIds: [mother._id, father._id],
        type: 'married',
        startYear: 1979,
      },
    });
    undo.record(createCommand('unions', union._id, 'Meiling and Wei'));
    const { entry: link } = await invoke('entry.create', {
      collection: 'parentLinks',
      data: {
        title: 'Meiling parent of Lan',
        parentId: mother._id,
        childId: child._id,
        type: 'biological',
      },
    });
    undo.record(createCommand('parentLinks', link._id, 'Meiling parent of Lan'));
    const start = {
      union: await stored('unions', union._id),
      link: await stored('parentLinks', link._id),
    };

    const edit = async (c: EntryCollection, id: string, patch: Record<string, unknown>) => {
      const before = (await invoke('entry.get', { collection: c, id })).entry;
      const after = (await invoke('entry.update', { collection: c, id, patch })).entry;
      undo.record(editCommand('Changed Type', c, id, before, after));
    };
    await edit('unions', union._id, { type: 'partnered' });
    await edit('parentLinks', link._id, { type: 'adoptive' });
    await invoke('entry.delete', { collection: 'unions', id: union._id });
    undo.record(deleteCommand('unions', union._id, 'Meiling and Wei'));
    const end = {
      union: await stored('unions', union._id),
      link: await stored('parentLinks', link._id),
    };
    expect(end.union).toEqual(expect.objectContaining({ inTrash: true }));
    expect(end.union!.content.type).toBe('partnered');
    expect(end.link!.content.type).toBe('adoptive');

    for (let i = 0; i < 5; i++) expect((await undo.step('undo', io)).status).toBe('applied');
    expect((await undo.step('undo', io)).status).toBe('empty');
    // Back at the start: the edits are reverted and both creates are undone into the trash.
    expect(await stored('unions', union._id)).toEqual({ ...start.union, inTrash: true });
    expect(await stored('parentLinks', link._id)).toEqual({ ...start.link, inTrash: true });
    expect((await stored('unions', union._id))!.content.type).toBe('married');
    expect((await stored('parentLinks', link._id))!.content.type).toBe('biological');

    for (let i = 0; i < 5; i++) expect((await undo.step('redo', io)).status).toBe('applied');
    expect((await undo.step('redo', io)).status).toBe('empty');
    expect(await stored('unions', union._id)).toEqual(end.union);
    expect(await stored('parentLinks', link._id)).toEqual(end.link);
  });

  test('ED-3 an undo step whose field changed since is skipped, writes nothing, and leaves the stacks consistent', async () => {
    const invoke = ipcFor(() => bible);
    const undo = new UndoManager();
    const io = undoIO(invoke);
    const c = await bible.repo.create('characters', person('Ada Sullivan', 1990));
    const before = (await invoke('entry.get', { collection: 'characters', id: c._id })).entry;
    const after = (
      await invoke('entry.update', {
        collection: 'characters',
        id: c._id,
        patch: { backstory: 'Oakland' },
      })
    ).entry;
    undo.record(
      editCommand('Changed Backstory on Ada Sullivan', 'characters', c._id, before, after),
    );
    // Something else changes the same field after the step was recorded.
    await bible.repo.update('characters', c._id, { backstory: 'Fresno' });
    const r = await undo.step('undo', io);
    expect(r).toEqual(
      expect.objectContaining({ status: 'skipped', reason: 'Backstory on Ada Sullivan' }),
    );
    expect((await stored('characters', c._id))!.content.backstory).toBe('Fresno');
    expect(undo.stack.canUndo).toBe(false);
    expect(undo.stack.canRedo).toBe(false);
  });
});

describe('ED-3 undo and redo of the writes that are not entries: tree positions, list items, and settings', () => {
  test('ED-3 FT-11 a move and a tidy of the tree undo to the start and redo to the end, and a move made since is left alone', async () => {
    const invoke = ipcFor(() => bible);
    const undo = new UndoManager();
    const io = undoIO(invoke);
    const grace = await bible.repo.create('characters', person('Grace Hale', 1970));
    const sam = await bible.repo.create('characters', person('Sam Hale', 1972));
    const names = new Map([
      [grace._id, 'Grace Hale'],
      [sam._id, 'Sam Hale'],
    ]);
    const nameOf = (id: string) => names.get(id) ?? id;
    const positions = async () => (await invoke('tree.get', {})).positions ?? {};
    const start = { [grace._id]: { x: 0, y: 0 }, [sam._id]: { x: 194, y: 0 } };
    await invoke('tree.savePositions', { positions: start });

    // A drag: Grace goes to a row below, loose.
    const moved = { x: 40, y: 132, loose: true };
    await invoke('tree.savePositions', { positions: { ...start, [grace._id]: moved } });
    undo.record(
      treeMoveCommand(
        'Moved Grace Hale',
        invoke,
        [{ id: grace._id, before: start[grace._id]!, after: moved }],
        nameOf,
      ),
    );
    // A tidy: everyone back on the first row, further apart.
    const tidy = { [grace._id]: { x: 0, y: 0 }, [sam._id]: { x: 400, y: 0 } };
    const before = await positions();
    await invoke('tree.savePositions', { positions: tidy });
    const moves = treeMoves(before, tidy);
    expect(moves.map((m) => m.id).sort()).toEqual([grace._id, sam._id].sort());
    undo.record(treeMoveCommand('Tidied the tree layout', invoke, moves, nameOf));

    expect((await undo.step('undo', io)).status).toBe('applied');
    expect(await positions()).toEqual({ ...start, [grace._id]: moved });
    expect(await undo.step('undo', io)).toEqual({ status: 'applied', label: 'Moved Grace Hale' });
    expect(await positions()).toEqual(start);
    expect((await undo.step('redo', io)).status).toBe('applied');
    expect(await positions()).toEqual({ ...start, [grace._id]: moved });
    expect((await undo.step('redo', io)).status).toBe('applied');
    expect(await positions()).toEqual(tidy);

    // Sam is moved by hand after the tidy: undoing the tidy would move him back, so it is skipped.
    await invoke('tree.savePositions', { positions: { ...tidy, [sam._id]: { x: 600, y: 132 } } });
    const r = await undo.step('undo', io);
    expect(r).toEqual(
      expect.objectContaining({ status: 'skipped', reason: 'Sam Hale was moved since' }),
    );
    expect(await positions()).toEqual({ ...tidy, [sam._id]: { x: 600, y: 132 } });
    // The tidy moved Grace too, so the step before it no longer finds her where it left her.
    expect(await undo.step('undo', io)).toEqual(
      expect.objectContaining({ status: 'skipped', reason: 'Grace Hale was moved since' }),
    );
    expect(await positions()).toEqual({ ...tidy, [sam._id]: { x: 600, y: 132 } });
    expect(undo.stack.canUndo).toBe(false);
  });

  test('ED-3 ED-8 adding and removing a list item undo and redo, and an item in use blocks the undo of its add', async () => {
    const invoke = ipcFor(() => bible);
    const undo = new UndoManager();
    const io = undoIO(invoke);
    const items = async () =>
      (await invoke('lists.get', {})).lists
        .find((l) => l._id === 'communities')!
        .items.map((i) => i.label);

    const { item } = await invoke('lists.addItem', {
      listId: 'communities',
      label: 'Portland',
      parentId: null,
    });
    undo.record(listAddCommand(invoke, 'Communities', 'communities', item));
    expect(await items()).toContain('Portland');
    expect(await undo.step('undo', io)).toEqual({
      status: 'applied',
      label: 'Added Portland to Communities',
    });
    expect(await items()).not.toContain('Portland');
    expect((await undo.step('redo', io)).status).toBe('applied');
    expect(await items()).toContain('Portland');

    const portland = (await invoke('lists.get', {})).lists
      .find((l) => l._id === 'communities')!
      .items.find((i) => i.label === 'Portland')!;
    await invoke('lists.removeItem', { listId: 'communities', itemId: portland.id });
    undo.record(listRemoveCommand(invoke, 'Communities', 'communities', portland));
    expect(await items()).not.toContain('Portland');
    expect(await undo.step('undo', io)).toEqual({
      status: 'applied',
      label: 'Removed Portland from Communities',
    });
    expect(await items()).toContain('Portland');
    expect((await undo.step('redo', io)).status).toBe('applied');
    expect(await items()).not.toContain('Portland');

    // An item added, then used by an entry: the undo of its add is refused by the write path and the step stays.
    const { item: oakland } = await invoke('lists.addItem', {
      listId: 'communities',
      label: 'Oakland',
      parentId: null,
    });
    undo.record(listAddCommand(invoke, 'Communities', 'communities', oakland));
    await bible.repo.create('culturalEntries', {
      title: 'Harvest dinner',
      communityId: oakland.id,
      startYear: null,
      endYear: null,
    });
    const r = await undo.step('undo', io);
    expect(r.status).toBe('failed');
    expect(r.status === 'failed' && r.error).toMatch(/1 entry uses Oakland/);
    expect(await items()).toContain('Oakland');
    expect(undo.stack.canUndo).toBe(true);
  });

  test('ED-3 GL-1 the romanization system for a language undoes and redoes, and a choice made since is left alone', async () => {
    const invoke = ipcFor(() => bible);
    const undo = new UndoManager();
    const io = undoIO(invoke);
    const systemOf = async () =>
      (await invoke('romanization.get', {})).languages.find((l) => l.id === 'cantonese')!
        .systemId ?? null;
    const from = await systemOf();
    await invoke('romanization.set', { languageId: 'cantonese', systemId: 'mandarin' });
    undo.record(romanizationCommand(invoke, 'Cantonese', 'cantonese', from, 'mandarin'));
    expect(await systemOf()).toBe('mandarin');
    expect(await undo.step('undo', io)).toEqual({
      status: 'applied',
      label: 'Changed the romanization system for Cantonese',
    });
    expect(await systemOf()).toBe(from);
    expect((await undo.step('redo', io)).status).toBe('applied');
    expect(await systemOf()).toBe('mandarin');
    await invoke('romanization.set', { languageId: 'cantonese', systemId: null });
    expect(await undo.step('undo', io)).toEqual(
      expect.objectContaining({
        status: 'skipped',
        reason: 'the romanization system for Cantonese changed since',
      }),
    );
    expect(await systemOf()).toBe(null);
  });

  test('ED-3 A42 removing a community with its lines undoes to the list and the lines, and redoes', async () => {
    const invoke = ipcFor(() => bible);
    const undo = new UndoManager();
    const io = undoIO(invoke);
    const { item } = await invoke('lists.addItem', {
      listId: 'communities',
      label: 'Jinan',
      parentId: null,
    });
    const lines: { id: string }[] = [];
    for (const title of ['Spring stream shrines', 'Night noodle stalls']) {
      const { entry } = await invoke('entry.create', {
        collection: 'culturalEntries',
        data: { title, communityId: item.id, startYear: 2040, endYear: 2049 },
      });
      lines.push({ id: entry._id });
    }
    const inList = async () =>
      (await invoke('lists.get', {})).lists
        .find((l) => l._id === 'communities')!
        .items.some((i) => i.id === item.id);
    const trashed = async () =>
      Promise.all(
        lines.map(async (l) => Boolean((await stored('culturalEntries', l.id))?.inTrash)),
      );
    // Renamed first, so the ID the lines hold no longer matches the label; undo must keep the ID.
    await invoke('lists.rename', {
      listId: 'communities',
      itemId: item.id,
      label: 'Jinan, Shandong',
    });
    const renamed = { ...item, label: 'Jinan, Shandong' };
    // The screen trashes the lines, then takes the item out, then records the step.
    for (const l of lines)
      await invoke('entry.delete', { collection: 'culturalEntries', id: l.id });
    await invoke('lists.removeItem', { listId: 'communities', itemId: item.id });
    undo.record(communityRemoveCommand(invoke, 'Communities', 'communities', renamed, lines));
    expect(await inList()).toBe(false);
    expect(await trashed()).toEqual([true, true]);
    expect(await undo.step('undo', io)).toEqual({
      status: 'applied',
      label: 'Removed Jinan, Shandong and its 2 lines',
    });
    expect(await inList()).toBe(true);
    expect(
      (await invoke('lists.get', {})).lists
        .find((l) => l._id === 'communities')!
        .items.find((i) => i.id === item.id)?.label,
    ).toBe('Jinan, Shandong');
    expect(await trashed()).toEqual([false, false]);
    expect((await undo.step('redo', io)).status).toBe('applied');
    expect(await inList()).toBe(false);
    expect(await trashed()).toEqual([true, true]);
    // A line restored by hand since: the undo would re-trash nothing, but the restore step cannot apply, so it is skipped.
    await invoke('entry.restore', { collection: 'culturalEntries', id: lines[0]!.id });
    expect((await undo.step('undo', io)).status).toBe('skipped');
  });

  test('ED-3 A41 a community description undoes and redoes, and a description written since is left alone', async () => {
    const invoke = ipcFor(() => bible);
    const undo = new UndoManager();
    const io = undoIO(invoke);
    const { item } = await invoke('lists.addItem', {
      listId: 'communities',
      label: 'San Francisco',
      parentId: null,
    });
    const note = async () => (await invoke('community.notes.get', {})).notes[item.id] ?? '';
    await invoke('community.notes.set', { communityId: item.id, text: 'Fog, hills, and rent.' });
    undo.record(
      communityNoteCommand(invoke, 'San Francisco', item.id, '', 'Fog, hills, and rent.'),
    );
    expect(await note()).toBe('Fog, hills, and rent.');
    expect(await undo.step('undo', io)).toEqual({
      status: 'applied',
      label: 'Changed the description of San Francisco',
    });
    expect(await note()).toBe('');
    expect((await undo.step('redo', io)).status).toBe('applied');
    expect(await note()).toBe('Fog, hills, and rent.');
    await invoke('community.notes.set', { communityId: item.id, text: 'Rewritten.' });
    expect(await undo.step('undo', io)).toEqual(
      expect.objectContaining({
        status: 'skipped',
        reason: 'the description of San Francisco changed since',
      }),
    );
    expect(await note()).toBe('Rewritten.');
    // A community that is not in the list cannot be described.
    await expect(
      invoke('community.notes.set', { communityId: 'nowhere', text: 'x' }),
    ).rejects.toThrow(/not in the Communities list/);
  });

  test('ED-3 SB-2 the brief settings undo and redo as one step per change', async () => {
    const invoke = ipcFor(() => bible);
    const undo = new UndoManager();
    const io = undoIO(invoke);
    const before = await invoke('brief.settings.get', {});
    const after = await invoke('brief.settings.set', { window: before.window + 2 });
    undo.record(briefSettingsCommand(invoke, before, after));
    expect(await undo.step('undo', io)).toEqual({
      status: 'applied',
      label: 'Changed the world events window',
    });
    expect(await invoke('brief.settings.get', {})).toEqual(before);
    expect((await undo.step('redo', io)).status).toBe('applied');
    expect(await invoke('brief.settings.get', {})).toEqual(after);
  });
});
