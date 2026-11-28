import { useCallback, useEffect, useRef } from 'react';
import type { PointerEvent as ReactPointerEvent, TouchEvent as ReactTouchEvent } from 'react';

/** How long a finger rests before the thing under it lifts. */
export const HOLD_MS = 450;
/** A finger that travels this far before the hold ends is scrolling, not lifting. */
const SLOP_PX = 8;

export interface HoldHandlers<P> {
  /** The hold ended without the finger moving away: the thing lifts. False refuses it. */
  lift: (payload: P, x: number, y: number) => boolean;
  move: (x: number, y: number) => void;
  drop: (x: number, y: number) => void;
  cancel: () => void;
}

/**
 * A58 U2 (PH-35): hold to lift, then drag. A finger that rests for
 * `HOLD_MS` lifts what is under it; one that moves first is a scroll, left to
 * the page. Once lifted the page holds still until the finger comes up. A
 * mouse does the same with its button held. The tap that ends a lift is not a
 * click (`clickBlocked`).
 *
 *   const hold = useHold<LineRef>({ lift, move, drop, cancel });
 *   <div onTouchStart={(e) => hold.start(e, at)} onPointerDown={(e) => hold.start(e, at)}>
 */
export function useHold<P>(handlers: HoldHandlers<P>) {
  const h = useRef(handlers);
  useEffect(() => {
    h.current = handlers;
  });
  const stop = useRef<(() => void) | null>(null);
  const blockClick = useRef(false);

  useEffect(() => () => stop.current?.(), []);

  const start = useCallback((e: ReactTouchEvent | ReactPointerEvent, payload: P) => {
    if ((e.target as Element).closest?.('[data-no-hold]')) return;
    const touch = 'touches' in e;
    if (!touch && (e.pointerType === 'touch' || e.button !== 0)) return;
    if (touch && e.touches.length !== 1) {
      stop.current?.();
      return;
    }
    stop.current?.();
    const first = touch ? e.touches[0] : e;
    if (!first) return;
    const from = { x: first.clientX, y: first.clientY };
    let at = { ...from };
    let lifted = false;
    const timer = window.setTimeout(() => {
      lifted = h.current.lift(payload, at.x, at.y);
      if (!lifted) end();
      else navigator.vibrate?.(10);
    }, HOLD_MS);

    const moved = (x: number, y: number, ev: Event) => {
      at = { x, y };
      if (lifted) {
        if (ev.cancelable) ev.preventDefault();
        h.current.move(x, y);
      } else if (Math.hypot(x - from.x, y - from.y) > SLOP_PX) end();
    };
    const up = (x: number, y: number) => {
      const was = lifted;
      end();
      if (was) {
        blockClick.current = true;
        window.setTimeout(() => (blockClick.current = false), 400);
        h.current.drop(x, y);
      }
    };
    const onTouchMove = (ev: TouchEvent) => {
      const t = ev.touches[0];
      if (t) moved(t.clientX, t.clientY, ev);
    };
    const onTouchEnd = (ev: TouchEvent) => {
      const t = ev.changedTouches[0];
      up(t?.clientX ?? at.x, t?.clientY ?? at.y);
    };
    const onPointerMove = (ev: PointerEvent) => moved(ev.clientX, ev.clientY, ev);
    const onPointerUp = (ev: PointerEvent) => up(ev.clientX, ev.clientY);
    const onCancel = () => {
      const was = lifted;
      end();
      if (was) h.current.cancel();
    };
    const onMenu = (ev: Event) => {
      if (lifted) ev.preventDefault();
    };
    function end() {
      window.clearTimeout(timer);
      stop.current = null;
      lifted = false;
      if (touch) {
        window.removeEventListener('touchmove', onTouchMove);
        window.removeEventListener('touchend', onTouchEnd);
        window.removeEventListener('touchcancel', onCancel);
      } else {
        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('pointerup', onPointerUp);
        window.removeEventListener('pointercancel', onCancel);
      }
      window.removeEventListener('contextmenu', onMenu);
    }
    if (touch) {
      window.addEventListener('touchmove', onTouchMove, { passive: false });
      window.addEventListener('touchend', onTouchEnd);
      window.addEventListener('touchcancel', onCancel);
    } else {
      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', onPointerUp);
      window.addEventListener('pointercancel', onCancel);
    }
    window.addEventListener('contextmenu', onMenu);
    stop.current = () => {
      const was = lifted;
      end();
      if (was) h.current.cancel();
    };
  }, []);

  return {
    start,
    /** True for the click that a finished drag's lift would otherwise make. */
    clickBlocked: () => blockClick.current,
  };
}
