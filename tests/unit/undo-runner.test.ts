import { describe, expect, test } from 'vitest';
import {
  UndoManager,
  createCommand,
  editCommand,
  renameCommand,
  stepNotice,
} from '../../src/shared/domain/undoRunner';
import type { Op, UndoIO } from '../../src/shared/domain/undoRunner';

/** An in-memory bible for the undo logic: entries by ID and one list. */
function fakeIO() {
  const docs = new Map<string, Record<string, unknown>>();
  const labels = new Map<string, string>();
  const applied: Op[] = [];
  let fail = false;
  const io: UndoIO = {
    get: async (_c, id) => docs.get(id),
    listLabel: async (_l, id) => labels.get(id),
    apply: async (op) => {
      if (fail) throw new Error('The database is unreachable.');
      applied.push(op);
      if (op.kind === 'update') docs.set(op.id, { ...docs.get(op.id), ...op.patch });
      if (op.kind === 'delete') docs.set(op.id, { ...docs.get(op.id), deletedAt: 'now' });
      if (op.kind === 'restore') {
        const { deletedAt: _d, ...rest } = docs.get(op.id) ?? {};
        docs.set(op.id, rest);
      }
      if (op.kind === 'rename') labels.set(op.itemId, op.label);
    },
  };
  return { io, docs, labels, applied, setFail: (v: boolean) => (fail = v) };
}

describe('ED-3 undo steps check what they overwrite', () => {
  test('ED-3 a step applies when the fields still hold what it expects', async () => {
    const f = fakeIO();
    f.docs.set('A', { _id: 'A', title: 'Ada', backstory: 'Oakland' });
    const m = new UndoManager();
    m.record(
      editCommand(
        'Changed Backstory on Ada',
        'characters',
        'A',
        { backstory: '' },
        { backstory: 'Oakland' },
      ),
    );
    expect(await m.step('undo', f.io)).toEqual({
      status: 'applied',
      label: 'Changed Backstory on Ada',
    });
    expect(f.docs.get('A')!.backstory).toBe('');
    expect(await m.step('redo', f.io)).toEqual({
      status: 'applied',
      label: 'Changed Backstory on Ada',
    });
    expect(f.docs.get('A')!.backstory).toBe('Oakland');
  });

  test('ED-3 an undo whose field changed since is skipped, writes nothing, and is dropped from both stacks', async () => {
    const f = fakeIO();
    f.docs.set('A', { _id: 'A', title: 'Ada', backstory: 'Fresno' });
    const m = new UndoManager();
    m.record(createCommand('characters', 'A', 'Ada'));
    m.record(
      editCommand(
        'Changed Backstory on Ada',
        'characters',
        'A',
        { backstory: '' },
        { backstory: 'Oakland' },
      ),
    );
    const r = await m.step('undo', f.io);
    expect(r).toEqual({
      status: 'skipped',
      label: 'Changed Backstory on Ada',
      reason: 'Backstory on Ada',
    });
    expect(stepNotice('undo', r)).toBe(
      'Undo skipped: this field changed since that step, so nothing was overwritten (Backstory on Ada).',
    );
    expect(f.applied).toEqual([]);
    expect(f.docs.get('A')!.backstory).toBe('Fresno');
    expect(m.stack.canRedo).toBe(false);
    // The older step is still there and still works.
    expect(m.stack.history().undo.map((c) => c.label)).toEqual(['Created Ada']);
    expect((await m.step('undo', f.io)).status).toBe('applied');
  });

  test('ED-3 a redo whose field changed since is skipped the same way', async () => {
    const f = fakeIO();
    f.docs.set('A', { _id: 'A', title: 'Ada', backstory: 'Oakland' });
    const m = new UndoManager();
    m.record(
      editCommand(
        'Changed Backstory on Ada',
        'characters',
        'A',
        { backstory: '' },
        { backstory: 'Oakland' },
      ),
    );
    await m.step('undo', f.io);
    f.docs.set('A', { ...f.docs.get('A'), backstory: 'Reno' });
    const r = await m.step('redo', f.io);
    expect(r.status).toBe('skipped');
    expect(stepNotice('redo', r)).toMatch(/^Redo skipped: this field changed since/);
    expect(f.docs.get('A')!.backstory).toBe('Reno');
    expect(m.stack.canUndo).toBe(false);
    expect(m.stack.canRedo).toBe(false);
  });

  test('ED-3 trash steps and renames check their state too', async () => {
    const f = fakeIO();
    f.docs.set('A', { _id: 'A', title: 'Ada', deletedAt: 'then' });
    f.labels.set('married', 'Wed');
    const m = new UndoManager();
    m.record(renameCommand('Union types', 'unionTypes', 'married', 'Married', 'Joined'));
    m.record(createCommand('characters', 'A', 'Ada'));
    // Undoing the create would move it to the trash, but it is already there.
    expect(await m.step('undo', f.io)).toEqual(
      expect.objectContaining({ status: 'skipped', reason: 'Ada is already in the trash' }),
    );
    // The item was renamed again since, so the rename is not undone.
    expect(await m.step('undo', f.io)).toEqual(expect.objectContaining({ status: 'skipped' }));
    expect(f.labels.get('married')).toBe('Wed');
  });

  test('ED-3 a step that fails to write stays where it was', async () => {
    const f = fakeIO();
    f.docs.set('A', { _id: 'A', title: 'Ada', backstory: 'Oakland' });
    const m = new UndoManager();
    m.record(
      editCommand(
        'Changed Backstory on Ada',
        'characters',
        'A',
        { backstory: '' },
        { backstory: 'Oakland' },
      ),
    );
    f.setFail(true);
    const r = await m.step('undo', f.io);
    expect(r.status).toBe('failed');
    expect(stepNotice('undo', r)).toBe('Could not undo: The database is unreachable.');
    expect(m.stack.canUndo).toBe(true);
    expect(m.stack.canRedo).toBe(false);
  });
});
