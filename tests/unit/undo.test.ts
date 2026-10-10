import { describe, expect, test } from 'vitest';
import { UNDO_LIMIT, UndoStack } from '../../src/shared/domain/undo';
import type { Command } from '../../src/shared/domain/undo';
import { patchBetween } from '../../src/shared/domain/diff';

type Op = { set: number };
const cmd = (n: number): Command<Op> => ({
  label: `step ${n}`,
  undo: [{ set: n - 1 }],
  redo: [{ set: n }],
});

/** Replays commands against a number, as the renderer replays writes against the bible. */
function run(stack: UndoStack<Op>, state: { value: number }, kind: 'undo' | 'redo') {
  const c = kind === 'undo' ? stack.undo() : stack.redo();
  for (const op of c?.[kind] ?? []) state.value = op.set;
  return c;
}

describe('ED-3 undo and redo stacks', () => {
  test('ED-3 the stack keeps at least the last 50 changes', () => {
    expect(UNDO_LIMIT).toBeGreaterThanOrEqual(50);
    expect(() => new UndoStack<Op>(49)).toThrow(/at least 50/);
    const stack = new UndoStack<Op>();
    const state = { value: 0 };
    for (let n = 1; n <= 60; n++) {
      state.value = n;
      stack.push(cmd(n));
    }
    for (let i = 0; i < 60; i++) expect(run(stack, state, 'undo')).toBeDefined();
    expect(state.value).toBe(0);
    expect(stack.canUndo).toBe(false);
    for (let i = 0; i < 60; i++) run(stack, state, 'redo');
    expect(state.value).toBe(60);
  });

  test('ED-3 past the limit the oldest change is dropped, not the newest', () => {
    const stack = new UndoStack<Op>(50);
    for (let n = 1; n <= 55; n++) stack.push(cmd(n));
    const { undo } = stack.history();
    expect(undo).toHaveLength(50);
    expect(undo[0]!.label).toBe('step 55');
    expect(undo.at(-1)!.label).toBe('step 6');
  });

  test('ED-3 a new change after an undo clears the redo stack', () => {
    const stack = new UndoStack<Op>();
    const state = { value: 2 };
    stack.push(cmd(1));
    stack.push(cmd(2));
    run(stack, state, 'undo');
    expect(stack.canRedo).toBe(true);
    stack.push(cmd(9));
    expect(stack.canRedo).toBe(false);
    expect(stack.history().undo.map((c) => c.label)).toEqual(['step 9', 'step 1']);
  });

  test('ED-3 a failed undo or redo puts the command back where it was', () => {
    const stack = new UndoStack<Op>();
    stack.push(cmd(1));
    stack.undo();
    stack.revertUndo();
    expect(stack.canUndo).toBe(true);
    expect(stack.canRedo).toBe(false);
    stack.undo();
    stack.redo();
    stack.revertRedo();
    expect(stack.canRedo).toBe(true);
  });

  test('ED-3 undoing on an empty stack does nothing', () => {
    const stack = new UndoStack<Op>();
    expect(stack.undo()).toBeUndefined();
    expect(stack.redo()).toBeUndefined();
  });

  test('ED-3 a field edit becomes a forward and a backward patch of only the changed fields', () => {
    const before = {
      _id: 'A',
      modifiedAt: '1',
      title: 'Old',
      tags: ['x'],
      death: null,
      names: { full: 'A' },
    };
    const after = {
      _id: 'A',
      modifiedAt: '2',
      title: 'New',
      tags: ['x'],
      death: { year: 2040 },
      names: { full: 'A' },
    };
    expect(patchBetween(before, after)).toEqual({
      forward: { title: 'New', death: { year: 2040 } },
      backward: { title: 'Old', death: null },
    });
  });
});
