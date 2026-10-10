/**
 * Focus trapping for modal dialogs (NF-2). Tab from the last focusable
 * element wraps to the first, Shift+Tab from the first wraps to the last, and
 * focus that has escaped the dialog comes back in. Pure, so it is unit tested.
 */

/**
 * The index to move focus to for a Tab press, or null to let the browser
 * move focus normally. `current` is the focused element's index among the
 * dialog's focusable elements, or -1 when focus is outside the dialog.
 */
export function trapTarget(current: number, count: number, shift: boolean): number | null {
  if (count <= 0) return null;
  if (current < 0) return shift ? count - 1 : 0;
  if (shift && current === 0) return count - 1;
  if (!shift && current === count - 1) return 0;
  return null;
}
