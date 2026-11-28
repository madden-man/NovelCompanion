/** A58 U1 (PH-32): the keyboard hold's arithmetic, pure so it can be unit tested. */
/**
 * How far to scroll the page so the focused field shows between the top bar
 * and the foot of the visual viewport (the keyboard's top on iOS). Positive
 * scrolls down. A box taller than what shows keeps its caret line in view.
 */
export function scrollToShow(
  rect: { top: number; bottom: number },
  view: { top: number; bottom: number },
): number {
  const room = view.bottom - view.top;
  const bottom = rect.bottom - rect.top > room ? rect.top + room : rect.bottom;
  if (bottom > view.bottom) return bottom - view.bottom;
  if (rect.top < view.top) return rect.top - view.top;
  return 0;
}

/** What the keyboard hold saw last: the field typed in, whether the keyboard was up, how tall the view was. */
export interface KeepState {
  field: unknown;
  keyboard: boolean;
  height: number;
}

/**
 * Whether the keyboard hold scrolls the field into view: when the field is new,
 * the keyboard has just come up, or what shows changed height (the keyboard
 * rising or resizing, the phone turning). A scroll of the visual viewport alone
 * is the writer's own, to reread above, and is left be.
 */
export function shouldKeep(prev: KeepState | null, now: KeepState): boolean {
  if (now.field === null) return false;
  if (prev === null || prev.field !== now.field) return true;
  if (now.keyboard && !prev.keyboard) return true;
  return Math.abs(now.height - prev.height) > 1;
}
