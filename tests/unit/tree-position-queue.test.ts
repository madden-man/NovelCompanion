import { describe, expect, test } from 'vitest';
import { positionQueue } from '../../src/renderer/src/workspace/tree/positionQueue';

type Positions = Record<string, { x: number; y: number }>;

/**
 * The tree's position writes and reads, as TreeView runs them: each write builds on
 * the base the write before it left; a read sets the base only when the queue says so.
 */
function tree() {
  const q = positionQueue();
  let base: Positions = {};
  let db: Positions = {};
  let tail: Promise<unknown> = Promise.resolve();
  const reloads: number[] = [];
  const gates: (() => void)[] = [];
  const save = (move: Positions) => {
    q.enter();
    const next = tail.then(async () => {
      const positions = { ...base, ...move };
      // The write is held until the test lets it commit.
      await new Promise<void>((r) => gates.push(r));
      db = positions;
      base = positions;
    });
    tail = next.finally(() => {
      if (q.leave()) reloads.push(1);
    });
    return next;
  };
  /** A read asked for now, answered when the test says, with what MongoDB held when asked. */
  const read = () => {
    const ticket = q.ticket();
    const seen = db;
    return () => {
      const take = q.fresh(ticket);
      if (take === 'apply') base = seen;
      return take;
    };
  };
  const commit = async () => {
    while (gates.length === 0) await Promise.resolve();
    gates.shift()!();
    await tail.catch(() => undefined);
  };
  return { save, read, commit, db: () => db, reloads };
}

describe('A57 FT-11 a tree read never sets back the base of a queued position write', () => {
  test('A57 FT-11 a read taken before the second move commits does not drop it from the third', async () => {
    const t = tree();
    const first = t.save({ a: { x: 1, y: 0 } });
    await t.commit();
    await first;
    // A read is asked for after the first move, before the second is queued.
    const answer = t.read();
    const second = t.save({ b: { x: 2, y: 0 } });
    await t.commit();
    await second;
    // The stale read (it saw only the first move) answers now: it is set aside.
    expect(answer()).toBe('again');
    const third = t.save({ c: { x: 3, y: 0 } });
    await t.commit();
    await third;
    expect(Object.keys(t.db()).sort()).toEqual(['a', 'b', 'c']);
  });

  test('A57 FT-11 a read answered while writes are queued is read again once they are done', async () => {
    const t = tree();
    const first = t.save({ a: { x: 1, y: 0 } });
    const answer = t.read();
    expect(answer()).toBe('skip');
    await t.commit();
    await first;
    expect(t.reloads).toEqual([1]);
    // A read on an idle queue is taken.
    expect(t.read()()).toBe('apply');
  });
});
