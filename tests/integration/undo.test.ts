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
  status: 'canon' as const,
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
        status: 'canon',
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
        status: 'canon',
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
