import { describe, expect, it } from 'vitest';
import { pinchView, toView, zoomAbout } from '../../src/renderer/src/workspace/tree/pinch';

/** A58 U4 (PH-33): the phone tree's pinch and zoom arithmetic. */
describe('PH-33 pinch and zoom on the phone tree', () => {
  const r = { left: 10, top: 100, width: 360, height: 480 };
  const v = { x: 0, y: 0, w: 720, h: 960 };

  it('a pinch keeps the point under its midpoint and scales by the change in spread', () => {
    const m = { x: 190, y: 340 };
    const under = toView(v, r, m);
    const next = pinchView(
      v,
      r,
      [
        { x: 160, y: 340 },
        { x: 220, y: 340 },
      ],
      [
        { x: 130, y: 340 },
        { x: 250, y: 340 },
      ],
      100,
      5000,
    );
    expect(next.w).toBeCloseTo(360);
    expect(next.h).toBeCloseTo(480);
    const after = toView(next, r, m);
    expect(after.x).toBeCloseTo(under.x);
    expect(after.y).toBeCloseTo(under.y);
  });

  it('a pinch that moves follows the midpoint, and stops at the limits', () => {
    const next = pinchView(
      v,
      r,
      [
        { x: 100, y: 200 },
        { x: 300, y: 200 },
      ],
      [
        { x: 195, y: 250 },
        { x: 205, y: 250 },
      ],
      100,
      1000,
    );
    expect(next.w).toBe(1000);
    const under = toView(v, r, { x: 200, y: 200 });
    const after = toView(next, r, { x: 200, y: 250 });
    expect(after.x).toBeCloseTo(under.x);
    expect(after.y).toBeCloseTo(under.y);
  });

  it('zoomAbout keeps its point and clamps the width', () => {
    const p = { x: 300, y: 400 };
    const z = zoomAbout(v, 0.5, p, 120, 40_000);
    expect(z.w).toBe(360);
    expect((p.x - z.x) / z.w).toBeCloseTo((p.x - v.x) / v.w);
    expect(zoomAbout(v, 0.01, p, 120, 40_000).w).toBe(120);
  });
});
