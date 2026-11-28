import { useCallback, useEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react';

/** How long a finger rests on a grip before the row lifts. */
export const HOLD_MS = 350;
/** A finger that travels this far before the hold ends is a scroll, not a lift. */
const SLOP_PX = 8;

export interface Lifted {
  id: string;
  /** Where the row was, and where it would land, among the list's rows. */
  from: number;
  to: number;
  /** How far the finger has moved the row, for drawing it under the finger. */
  dy: number;
}

interface Press {
  id: string;
  index: number;
  pointerId: number;
  x: number;
  y: number;
  el: HTMLElement;
  /** The middle of every row of the list, top to bottom, read when the row lifts. */
  mids: number[];
  timer: ReturnType<typeof setTimeout> | null;
  lifted: boolean;
}

/**
 * A58 U6 (PH-35): hold-to-lift for a row's grip on the phone. A finger that
 * rests on the grip lifts the row; moving it then carries the row, and
 * letting go drops it where it is. A finger that moves before the hold ends
 * does nothing, so a scroll is never taken for a drag. `onDrop` gets the
 * row's new index in the list. The grip carries `touch-action: none` in CSS.
 */
export function useHoldLift(opts: {
  disabled?: boolean;
  onDrop: (id: string, to: number) => void;
}) {
  const [lifted, setLifted] = useState<Lifted | null>(null);
  const press = useRef<Press | null>(null);
  const dropRef = useRef(opts.onDrop);
  useEffect(() => {
    dropRef.current = opts.onDrop;
  });
  const clear = useCallback(() => {
    const p = press.current;
    if (p?.timer) clearTimeout(p.timer);
    press.current = null;
    setLifted(null);
  }, []);
  useEffect(() => clear, [clear]);

  const landing = (p: Press, y: number) => {
    // The rows other than the lifted one whose middles sit above the finger.
    let to = 0;
    p.mids.forEach((m, i) => {
      if (i !== p.index && m < y) to += 1;
    });
    return to;
  };

  const grip = (id: string, index: number) =>
    opts.disabled
      ? {}
      : {
          'data-hold-lift': '',
          onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
            if (e.pointerType === 'mouse' && e.button !== 0) return;
            clear();
            const el = e.currentTarget;
            const p: Press = {
              id,
              index,
              pointerId: e.pointerId,
              x: e.clientX,
              y: e.clientY,
              el,
              mids: [],
              timer: null,
              lifted: false,
            };
            p.timer = setTimeout(() => {
              p.timer = null;
              const rows = el.closest('ul, ol')?.children;
              p.mids = rows
                ? [...rows].map((r) => {
                    const b = r.getBoundingClientRect();
                    return b.top + b.height / 2;
                  })
                : [];
              p.lifted = true;
              try {
                el.setPointerCapture(p.pointerId);
              } catch {
                // The pointer went away meanwhile; the next move or release settles it.
              }
              navigator.vibrate?.(10);
              setLifted({ id, from: index, to: index, dy: 0 });
            }, HOLD_MS);
            press.current = p;
          },
          onPointerMove: (e: ReactPointerEvent<HTMLElement>) => {
            const p = press.current;
            if (!p || e.pointerId !== p.pointerId) return;
            if (!p.lifted) {
              if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > SLOP_PX) clear();
              return;
            }
            e.preventDefault();
            setLifted({ id: p.id, from: p.index, to: landing(p, e.clientY), dy: e.clientY - p.y });
          },
          onPointerUp: (e: ReactPointerEvent<HTMLElement>) => {
            const p = press.current;
            if (!p || e.pointerId !== p.pointerId) return;
            const to = p.lifted ? landing(p, e.clientY) : p.index;
            clear();
            if (to !== p.index) dropRef.current(p.id, to);
          },
          onPointerCancel: () => clear(),
          // The iOS hold menu would otherwise come up over the lifted row.
          onContextMenu: (e: ReactMouseEvent<HTMLElement>) => e.preventDefault(),
        };

  return { lifted, grip };
}
