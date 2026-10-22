import { describe, expect, test } from 'vitest';
import {
  BRIEF_WRITTEN_NOTE,
  briefEdited,
  writtenRevisions,
} from '../../src/shared/domain/briefEdits';
import { briefRegenerateCommand } from '../../src/shared/undoCommands';
import type { Invoke } from '../../src/shared/undoCommands';

describe('IP-6 Regenerate knows an edited brief and is one undo step', () => {
  test('IP-6 the text is edited when it matches no text the app wrote', () => {
    const revs = [
      { _id: 'r4', op: 'update', note: null },
      { _id: 'r3', op: 'update', note: BRIEF_WRITTEN_NOTE },
      { _id: 'r2', op: 'update', note: null },
      { _id: 'r1', op: 'create', note: null },
    ];
    expect(writtenRevisions(revs).map((r) => r._id)).toEqual(['r3', 'r1']);
    expect(writtenRevisions(revs, 1).map((r) => r._id)).toEqual(['r3']);
    expect(briefEdited('# Brief\n', ['# Brief'])).toBe(false);
    expect(briefEdited('# Brief\r\n', ['# Brief\n'])).toBe(false);
    expect(briefEdited('# Brief, my words', ['# Brief'])).toBe(true);
    expect(briefEdited('# Old', ['# New', '# Old'])).toBe(false);
  });

  test('IP-6 undo puts the brief back as it was and redo writes the new one, unless the text changed since', async () => {
    let stored: Record<string, unknown> = { _id: 'B1', content: 'new', entryIds: ['E1'] };
    const writes: Record<string, unknown>[] = [];
    const invoke = (async (channel: string, req: { patch?: Record<string, unknown> }) => {
      if (channel === 'entry.get') return { entry: stored };
      if (channel === 'entry.update') {
        writes.push(req.patch ?? {});
        stored = { ...stored, ...req.patch };
        return { entry: stored, warnings: [] };
      }
      throw new Error(channel);
    }) as unknown as Invoke;
    const before = { _id: 'B1', content: 'mine', entryIds: ['E1', 'E5'], modifiedAt: 'x' };
    const after = { _id: 'B1', content: 'new', entryIds: ['E1'] };
    const step = briefRegenerateCommand(invoke, 'B1', 'Brief: The Letter', before, after);
    expect(step.label).toBe('Regenerated Brief: The Letter');
    const [undoOp] = step.undo;
    const [redoOp] = step.redo;
    if (undoOp?.kind !== 'run' || redoOp?.kind !== 'run') throw new Error('run ops expected');
    expect(await undoOp.check()).toBeNull();
    await undoOp.apply();
    expect(writes[0]).toEqual({ content: 'mine', entryIds: ['E1', 'E5'] });
    expect(stored.content).toBe('mine');
    expect(await redoOp.check()).toBeNull();
    await redoOp.apply();
    expect(stored.content).toBe('new');
    stored = { ...stored, content: 'typed since' };
    expect(await undoOp.check()).toBe('the text of Brief: The Letter changed since');
  });
});
