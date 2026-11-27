import { useCallback, useEffect, useRef } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { isPhone } from '../../phone';

/**
 * A58 U3 (PH-35): hold to lift. On the phone a drag starts only after the
 * finger rests this long without moving, so a swipe that starts on a handle
 * or a marker still scrolls the page or the grid. Once lifted, the page holds
 * still until the finger comes up.
 *
 *   const hold = useHold();
 *   onPointerDown: if (hold.begin(ev, () => startDrag(ev))) return;  // a touch: wait
 *   onPointerMove: if (hold.waiting(ev)) return;                       // moved: a scroll
 *   onPointerUp / Cancel: hold.end(ev)
 */
export const HOLD_MS = 350;
/** A finger that moves this far before the hold is scrolling. */
export const SLOP_PX = 10;

let locks = 0;
let installed = false;

/**
 * One touchmove listener for the whole document, not passive, installed
 * before any touch starts (browsers decide at the touch's start whether a
 * listener may stop the scroll). It stops the scroll only while lifted.
 */
export function installHoldGuard(doc: Document = document): void {
  if (installed) return;
  installed = true;
  doc.addEventListener(
    'touchmove',
    (e) => {
      if (locks > 0 && e.cancelable) e.preventDefault();
    },
    { passive: false },
  );
}

/** Hold the page still while something is lifted; the returned function lets it go. */
export function lockScroll(): () => void {
  locks += 1;
  document.documentElement.setAttribute('data-lifted', '');
  let done = false;
  return () => {
    if (done) return;
    done = true;
    locks = Math.max(0, locks - 1);
    if (locks === 0) document.documentElement.removeAttribute('data-lifted');
  };
}

interface Pending {
  pointerId: number;
  x: number;
  y: number;
  timer: ReturnType<typeof setTimeout>;
}

export interface Hold {
  /**
   * A touch on the phone starts waiting and returns true; `onLift` runs once the finger has
   * rested. Anything else returns false and the caller starts its drag at once, as on the desk.
   */
  begin(
    ev: ReactPointerEvent<HTMLElement>,
    onLift: (at: { x: number; y: number }) => void,
  ): boolean;
  /** True while a press waits to lift; a move past the slop ends the wait (a scroll). */
  waiting(ev: ReactPointerEvent<HTMLElement>): boolean;
  /** The press ended: stop waiting and let the page go. True when this press had lifted. */
  end(ev?: ReactPointerEvent<HTMLElement>): boolean;
}

export function useHold(): Hold {
  const pending = useRef<Pending | null>(null);
  const release = useRef<(() => void) | null>(null);
  const clear = useCallback(() => {
    if (pending.current) clearTimeout(pending.current.timer);
    pending.current = null;
  }, []);
  useEffect(
    () => () => {
      clear();
      release.current?.();
    },
    [clear],
  );
  return {
    begin: (ev, onLift) => {
      if (!isPhone() || ev.pointerType !== 'touch') return false;
      clear();
      const el = ev.currentTarget;
      const p: Pending = {
        pointerId: ev.pointerId,
        x: ev.clientX,
        y: ev.clientY,
        timer: setTimeout(() => {
          pending.current = null;
          release.current?.();
          release.current = lockScroll();
          try {
            el.setPointerCapture(p.pointerId);
          } catch {
            // The finger came up as the hold ended.
          }
          navigator.vibrate?.(10);
          onLift({ x: p.x, y: p.y });
        }, HOLD_MS),
      };
      pending.current = p;
      return true;
    },
    waiting: (ev) => {
      const p = pending.current;
      if (!p || p.pointerId !== ev.pointerId) return false;
      if (Math.hypot(ev.clientX - p.x, ev.clientY - p.y) > SLOP_PX) clear();
      return true;
    },
    end: (ev) => {
      if (pending.current && (!ev || pending.current.pointerId === ev.pointerId)) clear();
      const lifted = release.current !== null;
      release.current?.();
      release.current = null;
      return lifted;
    },
  };
}
