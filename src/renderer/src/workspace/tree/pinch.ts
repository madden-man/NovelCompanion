/**
 * A58 U4 (PH-33): the phone tree's pan and zoom arithmetic, pure, so unit
 * tests read it without a DOM.
 */
export type View = { x: number; y: number; w: number; h: number };
export type Pt = { x: number; y: number };
export type Rect = { left: number; top: number; width: number; height: number };

/** The view's width kept within `[min, max]`, scaled about the point `p` (view units). */
export function zoomAbout(v: View, factor: number, p: Pt, min: number, max: number): View {
  const w = Math.min(Math.max(v.w * factor, min), max);
  const k = w / v.w;
  return { x: p.x - (p.x - v.x) * k, y: p.y - (p.y - v.y) * k, w, h: v.h * k };
}

/** The view point under a screen point. */
export function toView(v: View, r: Rect, c: Pt): Pt {
  return { x: v.x + ((c.x - r.left) / r.width) * v.w, y: v.y + ((c.y - r.top) / r.height) * v.h };
}

/**
 * A pinch from `a0, b0` to `a1, b1` on a view that was `v0`: the width scales
 * by the change in the fingers' distance, within limits, and the point under
 * the first midpoint stays under the midpoint as it moves.
 */
export function pinchView(
  v0: View,
  r: Rect,
  start: [Pt, Pt],
  now: [Pt, Pt],
  min: number,
  max: number,
): View {
  const d0 = Math.max(1, Math.hypot(start[0].x - start[1].x, start[0].y - start[1].y));
  const d1 = Math.max(1, Math.hypot(now[0].x - now[1].x, now[0].y - now[1].y));
  const m0 = { x: (start[0].x + start[1].x) / 2, y: (start[0].y + start[1].y) / 2 };
  const m1 = { x: (now[0].x + now[1].x) / 2, y: (now[0].y + now[1].y) / 2 };
  const p = toView(v0, r, m0);
  const w = Math.min(Math.max((v0.w * d0) / d1, min), max);
  const h = (v0.h * w) / v0.w;
  return {
    x: p.x - ((m1.x - r.left) / r.width) * w,
    y: p.y - ((m1.y - r.top) / r.height) * h,
    w,
    h,
  };
}

/** Where a card or a label sits across the view's x axis, in view units. */
export type Span = { left: number; right: number };

/**
 * The widest view from `x0`, up to `maxW`, whose right edge cuts none of
 * `spans` in two: it ends `gap` past the last whole one. Null when no such
 * edge leaves at least half of `maxW`.
 */
export function wholeWidth(x0: number, maxW: number, spans: Span[], gap = 8): number | null {
  const whole = (c: number) => spans.every((s) => s.right + gap <= c || s.left >= c);
  if (whole(x0 + maxW)) return maxW;
  const cuts = spans
    .map((s) => s.right + gap)
    .filter((c) => c <= x0 + maxW && c - x0 >= maxW / 2)
    .sort((a, b) => b - a);
  for (const c of cuts) if (whole(c)) return c - x0;
  return null;
}

/** About how wide an end year label draws, in view units (11 px type, its halo included). */
export const labelSpan = (x: number, text: string): Span => {
  const w = text.length * 7 + 4;
  return { left: x - w / 2, right: x + w / 2 };
};
