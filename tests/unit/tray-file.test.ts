import { describe, expect, test } from 'vitest';
import { fileTrayGroup } from '../../src/renderer/src/workspace/trayFile';
import { NO_MARKS } from '../../src/shared/domain/tray';
import type { UndoCommand } from '../../src/shared/domain/undoRunner';

/** A fake of the IPC that files entries and can refuse the tray mark. */
function fakeInvoke(opts: { markFails: boolean }) {
  const calls: string[] = [];
  let n = 0;
  const invoke = (async (channel: string, req: Record<string, unknown>) => {
    calls.push(channel);
    if (channel === 'entry.create') {
      n += 1;
      return { entry: { _id: `E${n}`, title: (req.data as { title: string }).title } };
    }
    if (channel === 'tray.mark') {
      if (opts.markFails) throw new Error('The database refused the change.');
      return { dismissed: [], filed: req.keys as string[], sent: [] };
    }
    throw new Error(`unexpected ${channel}`);
  }) as never;
  return { invoke, calls };
}

const fact = (key: string, title: string) => ({
  key,
  drafts: [{ op: 'create' as const, collection: 'culturalEntries' as const, data: { title } }],
});

describe('FN-3 File it records its undo step whatever happens to the mark', () => {
  test('FN-3 a mark that fails still leaves one undo step for the entries, and hides the filed facts so a second File it cannot duplicate them', async () => {
    const { invoke, calls } = fakeInvoke({ markFails: true });
    const recorded: UndoCommand[] = [];
    const r = await fileTrayGroup(
      invoke,
      [fact('K1:a#0', 'Yee haw'), fact('K2:b#0', 'Mooncakes')],
      NO_MARKS,
      (c) => recorded.push(c),
      () => undefined,
    );
    expect(calls.filter((c) => c === 'entry.create')).toHaveLength(2);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.undo.filter((o) => o.kind === 'delete')).toHaveLength(2);
    // The step comes before the mark, so it is there though the mark failed.
    expect(calls.indexOf('tray.mark')).toBeGreaterThan(calls.lastIndexOf('entry.create'));
    expect(r.markError).toMatch(/refused/);
    expect(r.marks.filed).toEqual(['K1:a#0', 'K2:b#0']);
  });

  test('FN-3 with the mark stored, the stored marks come back and there is no error', async () => {
    const { invoke } = fakeInvoke({ markFails: false });
    const recorded: UndoCommand[] = [];
    const r = await fileTrayGroup(
      invoke,
      [fact('K1:a#0', 'Yee haw')],
      NO_MARKS,
      (c) => recorded.push(c),
      () => undefined,
    );
    expect(recorded).toHaveLength(1);
    expect(r.markError).toBeNull();
    expect(r.marks.filed).toEqual(['K1:a#0']);
  });
});
