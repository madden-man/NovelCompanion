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
