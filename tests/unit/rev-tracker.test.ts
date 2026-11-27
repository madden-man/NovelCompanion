import { describe, expect, test } from 'vitest';
import { RevTracker } from '../../src/main/db/rev';

describe('PH-8 the rev a process has seen', () => {
  test('PH-8 its own writes settle, even when they finish out of order', () => {
    const t = new RevTracker();
    t.loadedAt(10);
    expect(t.settled(10)).toBe(true);
    t.wrote(12);
    expect(t.settled(12)).toBe(false);
    t.wrote(11);
    expect(t.settled(12)).toBe(true);
    expect(t.current).toBe(12);
  });

  test('PH-8 a number nobody here made is a move made elsewhere, and a reload catches up', () => {
    const t = new RevTracker();
    t.loadedAt(3);
    t.wrote(5);
    expect(t.settled(5)).toBe(false);
    expect(t.current).toBe(3);
    t.loadedAt(5);
    expect(t.settled(5)).toBe(true);
    // A write that finished before the reload read it changes nothing afterwards.
    t.wrote(4);
    expect(t.settled(5)).toBe(true);
  });
});
