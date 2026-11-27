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
