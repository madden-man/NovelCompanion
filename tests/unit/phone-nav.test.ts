import { describe, expect, it } from 'vitest';
import { fromHash, rootState, toHash } from '../../src/renderer/src/workspace/phone/nav';
import { scrollToShow } from '../../src/renderer/src/workspace/phone/keyboard';

/** A58 U1 (PH-31, PH-32): the phone's places in the hash, and the keyboard hold's arithmetic. */
describe('phone places in the hash (PH-31)', () => {
  it('reads back what it writes, for every kind of page', () => {
    const s = rootState('people');
    s.stacks.people = [
      { kind: 'entry', collection: 'characters', id: 'H1' },
      { kind: 'screen', screen: 'tree', arg: 'H1' },
      { kind: 'screen', screen: 'backstory', arg2: '01JX' },
      { kind: 'section', collection: 'places' },
      { kind: 'new', collection: 'places' },
    ];
    const hash = toHash(s);
    expect(hash).toBe('#/people/e:characters:H1/s:tree:H1/s:backstory::01JX/l:places/n:places');
    expect(fromHash(hash)).toEqual(s);
  });

  it('keeps the tab with an empty stack, and falls back to People on anything else', () => {
    expect(fromHash('#/search')).toEqual(rootState('search'));
    expect(fromHash('')).toEqual(rootState('people'));
    expect(fromHash('#/nowhere/e:characters:H1')).toEqual(rootState('people'));
  });

  it('drops pages it cannot read', () => {
    const s = fromHash('#/outline/e:notACollection:X/s:nowhere/e:chapters:C1');
    expect(s.stacks.outline).toEqual([{ kind: 'entry', collection: 'chapters', id: 'C1' }]);
  });

  it('escapes IDs with separators in them', () => {
    const s = rootState('people');
    s.stacks.people = [{ kind: 'entry', collection: 'characters', id: 'a:b/c' }];
    expect(fromHash(toHash(s))).toEqual(s);
  });
});

describe('the field above the keyboard (PH-32)', () => {
  const view = { top: 60, bottom: 400 };
  it('leaves a field that shows where it is', () => {
    expect(scrollToShow({ top: 100, bottom: 140 }, view)).toBe(0);
  });
  it('scrolls down to a field under the keyboard', () => {
    expect(scrollToShow({ top: 500, bottom: 540 }, view)).toBe(140);
  });
  it('scrolls up to a field under the top bar', () => {
    expect(scrollToShow({ top: 20, bottom: 60 }, view)).toBe(-40);
  });
  it('shows the top of a box taller than the room', () => {
    expect(scrollToShow({ top: 300, bottom: 1000 }, view)).toBe(240);
  });
});
