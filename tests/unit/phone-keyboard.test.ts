import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { shouldKeep } from '../../src/renderer/src/workspace/phone/geometry';

/** keyboard.ts is DOM code, outside the node typecheck, so it is loaded by a path TypeScript does not follow. */
const KEYBOARD = '../../src/renderer/src/workspace/phone/keyboard';
type AttachKeyboard = (win: unknown, doc: unknown) => () => void;
let attachKeyboard: AttachKeyboard;

/** A58 U1 (PH-32): the keyboard hold scrolls to the field when it is needed, not on the writer's own scroll. */
describe('when the keyboard hold scrolls (PH-32)', () => {
  const field = {};
  it('scrolls for a new field, the keyboard coming up, or the keyboard changing height', () => {
    expect(shouldKeep(null, { field, keyboard: false, height: 852 })).toBe(true);
    expect(
      shouldKeep(
        { field: {}, keyboard: true, height: 500 },
        { field, keyboard: true, height: 500 },
      ),
    ).toBe(true);
    expect(
      shouldKeep({ field, keyboard: false, height: 852 }, { field, keyboard: true, height: 500 }),
    ).toBe(true);
    expect(
      shouldKeep({ field, keyboard: true, height: 500 }, { field, keyboard: true, height: 456 }),
    ).toBe(true);
  });
  it('leaves the page be on a scroll alone, and with nothing to type in', () => {
    expect(
      shouldKeep({ field, keyboard: true, height: 500 }, { field, keyboard: true, height: 500 }),
    ).toBe(false);
    expect(
      shouldKeep({ field, keyboard: false, height: 700 }, { field, keyboard: false, height: 852 }),
    ).toBe(false);
    expect(shouldKeep(null, { field: null, keyboard: true, height: 500 })).toBe(false);
  });
});

// The few DOM classes isTypingField reads, for node.
class FakeElement {
  isContentEditable = false;
  constructor(public rect: { top: number; bottom: number; height: number }) {}
  getBoundingClientRect() {
    return this.rect;
  }
}
class FakeInput extends FakeElement {
  type = 'text';
}

describe('the keyboard hold on a phone (PH-32)', () => {
  beforeAll(async () => {
    ({ attachKeyboard } = (await import(/* @vite-ignore */ KEYBOARD)) as {
      attachKeyboard: AttachKeyboard;
    });
    const g = globalThis as Record<string, unknown>;
    g.HTMLElement ??= FakeElement;
    g.HTMLInputElement ??= FakeInput;
    g.HTMLTextAreaElement ??= class extends FakeElement {};
    g.HTMLSelectElement ??= class extends FakeElement {};
  });
  afterEach(() => vi.useRealTimers());

  it('scrolls to the field when the keyboard rises, not when the writer scrolls up to reread', () => {
    vi.useFakeTimers();
    const vv = Object.assign(new EventTarget(), { height: 852, offsetTop: 0 });
    const scrollBy = vi.fn();
    const win = Object.assign(new EventTarget(), {
      innerHeight: 852,
      visualViewport: vv,
      scrollBy,
    });
    const input = new FakeInput({ top: 600, bottom: 640, height: 40 });
    const doc = Object.assign(new EventTarget(), {
      activeElement: input as unknown,
      querySelector: () => ({ getBoundingClientRect: () => ({ height: 52 }) }),
      documentElement: {
        style: { setProperty: () => {}, removeProperty: () => {} },
        toggleAttribute: () => {},
        removeAttribute: () => {},
      },
    });
    const detach = attachKeyboard(win, doc);
    doc.dispatchEvent(new Event('focusin'));
    vi.advanceTimersByTime(400);
    // The field shows over the whole window: nothing to do yet.
    expect(scrollBy).not.toHaveBeenCalled();
    // The keyboard rises over it: the page scrolls it into view.
    vv.height = 500;
    vv.dispatchEvent(new Event('resize'));
    expect(scrollBy).toHaveBeenCalledTimes(1);
    expect(scrollBy.mock.calls[0]?.[0]).toMatchObject({ top: 640 - (500 - 12) });
    // He scrolls up to reread; the field goes under the keyboard and stays there.
    input.rect = { top: 800, bottom: 840, height: 40 };
    vv.dispatchEvent(new Event('scroll'));
    vv.dispatchEvent(new Event('scroll'));
    expect(scrollBy).toHaveBeenCalledTimes(1);
    // Another field takes the focus: it is brought into view.
    doc.activeElement = new FakeInput({ top: 700, bottom: 740, height: 40 });
    doc.dispatchEvent(new Event('focusin'));
    expect(scrollBy).toHaveBeenCalledTimes(2);
    detach();
  });
});
