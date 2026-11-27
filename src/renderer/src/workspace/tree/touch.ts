import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, RefObject } from 'react';
import { pinchView } from './pinch';
import type { Pt, View } from './pinch';

/**
 * A58 U4 (PH-33): the family tree by touch, phone only. One finger pans, two
 * fingers pinch about their midpoint, and a hold on a person lifts them so the
 * drag that follows moves them. A drag that starts on a person without the
 * hold pans. The desk keeps its own mouse handlers in TreeView.
 */
export { pinchView, toView, zoomAbout } from './pinch';
export type { View } from './pinch';

/** How long a still finger rests on a person before they lift. */
export const HOLD_MS = 450;
/** A finger that moves this many screen pixels before the hold is a pan. */
export const SLOP_PX = 8;

type Gesture =
  | { kind: 'idle' }
  /** One finger down: a pan, or a press on a person that may become a lift. */
  | {
      kind: 'one';
      id: number;
      start: Pt;
      v: View;
      person: string | null;
      panning: boolean;
      timer: ReturnType<typeof setTimeout> | null;
    }
  /** A lifted person follows the finger. */
  | { kind: 'lift'; id: number; start: Pt; v: View; person: string; moved: boolean }
  | { kind: 'pinch'; ids: [number, number]; start: [Pt, Pt]; v: View };

export interface TreeTouch {
  onPointerDown: (e: ReactPointerEvent<SVGSVGElement>) => void;
  onPointerMove: (e: ReactPointerEvent<SVGSVGElement>) => void;
  onPointerUp: (e: ReactPointerEvent<SVGSVGElement>) => void;
  /** The person held up right now, drawn lifted. */
  lifted: string | null;
  /** True when the gesture that just ended panned, pinched or lifted, so its click is not a tap. */
  swallowClick: () => boolean;
}

export function useTreeTouch(opts: {
  svg: RefObject<SVGSVGElement | null>;
  view: View | null;
  setView: (v: View) => void;
  /** The narrowest and widest the view may be, in view units. */
  limits: () => { min: number; max: number };
  /** Whether a person may be lifted at all (not while read-only). */
  canLift: boolean;
  /** Where a person is drawn in the layout. */
  at: (id: string) => Pt | undefined;
  /** The lifted person is drawn here while the finger moves. */
  onDrag: (id: string, x: number, y: number) => void;
  /** The finger let go of a lifted person that moved: store the place. */
  onDrop: (id: string, x: number, y: number) => void;
  /** The lift ended without a move, or was cancelled. */
  onCancel: () => void;
}): TreeTouch {
  const g = useRef<Gesture>({ kind: 'idle' });
  const pts = useRef(new Map<number, Pt>());
  const swallow = useRef(false);
  const [lifted, setLifted] = useState<string | null>(null);
  const o = useRef(opts);
  useLayoutEffect(() => {
    o.current = opts;
  });

  const clear = () => {
    const cur = g.current;
    if (cur.kind === 'one' && cur.timer) clearTimeout(cur.timer);
  };
  useEffect(() => clear, []);

  const rect = () => o.current.svg.current?.getBoundingClientRect();
  const nodePos = (lift: { person: string; start: Pt; v: View }, c: Pt) => {
    const r = rect();
    const p = o.current.at(lift.person);
    if (!r || !p) return null;
    const k = lift.v.w / r.width;
    return {
      x: Math.round(p.x + (c.x - lift.start.x) * k),
      y: Math.round(p.y + (c.y - lift.start.y) * k),
    };
  };
  const endLift = () => {
    setLifted(null);
    o.current.onCancel();
  };
  /** Start a one-finger pan from where a finger is now. */
  const panFrom = (id: number, c: Pt, v: View) => {
    g.current = { kind: 'one', id, start: c, v, person: null, panning: true, timer: null };
  };

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    const view = o.current.view;
    if (!view) return;
    const c = { x: e.clientX, y: e.clientY };
    pts.current.set(e.pointerId, c);
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // A synthetic pointer cannot be captured; its events still reach the tree.
    }
    const cur = g.current;
    if (pts.current.size >= 2) {
      // A second finger: a pinch, whatever the first was doing.
      clear();
      if (cur.kind === 'lift') endLift();
      const ids = [...pts.current.keys()].slice(-2) as [number, number];
      const start = ids.map((i) => pts.current.get(i) as Pt) as [Pt, Pt];
      g.current = { kind: 'pinch', ids, start, v: view };
      swallow.current = true;
      return;
    }
    swallow.current = false;
    const el = e.target as Element;
    const node = el.closest('.tnode');
    const person =
      node && !el.closest('.tnode-toggle') && o.current.canLift
        ? node.getAttribute('data-person')
        : null;
    const next: Gesture = {
      kind: 'one',
      id: e.pointerId,
      start: c,
      v: view,
      person,
      panning: false,
      timer: null,
    };
    if (person) {
      next.timer = setTimeout(() => {
        const now = g.current;
        if (now !== next || now.panning) return;
        g.current = { kind: 'lift', id: now.id, start: now.start, v: now.v, person, moved: false };
        swallow.current = true;
        setLifted(person);
        const p = o.current.at(person);
        if (p) o.current.onDrag(person, p.x, p.y);
      }, HOLD_MS);
    }
    g.current = next;
  };

  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!pts.current.has(e.pointerId)) return;
    const c = { x: e.clientX, y: e.clientY };
    pts.current.set(e.pointerId, c);
    const cur = g.current;
    const r = rect();
    if (!r) return;
    if (cur.kind === 'pinch') {
      const now = cur.ids.map((i) => pts.current.get(i)) as [Pt | undefined, Pt | undefined];
      if (!now[0] || !now[1]) return;
      const { min, max } = o.current.limits();
      o.current.setView(pinchView(cur.v, r, cur.start, [now[0], now[1]], min, max));
      return;
    }
    if (cur.kind === 'lift') {
      if (e.pointerId !== cur.id) return;
      if (!cur.moved && Math.hypot(c.x - cur.start.x, c.y - cur.start.y) < SLOP_PX) return;
      cur.moved = true;
      const p = nodePos(cur, c);
      if (p) o.current.onDrag(cur.person, p.x, p.y);
      return;
    }
    if (cur.kind !== 'one' || e.pointerId !== cur.id) return;
    if (!cur.panning) {
      if (Math.hypot(c.x - cur.start.x, c.y - cur.start.y) < SLOP_PX) return;
      cur.panning = true;
      swallow.current = true;
      if (cur.timer) clearTimeout(cur.timer);
      cur.timer = null;
    }
    const k = cur.v.w / r.width;
    o.current.setView({
      ...cur.v,
      x: cur.v.x - (c.x - cur.start.x) * k,
      y: cur.v.y - (c.y - cur.start.y) * k,
    });
  };

  const onPointerUp = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!pts.current.has(e.pointerId)) return;
    const c = { x: e.clientX, y: e.clientY };
    pts.current.delete(e.pointerId);
    const cur = g.current;
    if (cur.kind === 'pinch') {
      // One finger left of a pinch carries on as a pan from where it is.
      const [rest] = [...pts.current.entries()];
      const view = o.current.view;
      if (rest && view) panFrom(rest[0], rest[1], view);
      else g.current = { kind: 'idle' };
      return;
    }
    if (cur.kind === 'lift' && e.pointerId === cur.id) {
      g.current = { kind: 'idle' };
      const p = cur.moved && e.type === 'pointerup' ? nodePos(cur, c) : null;
      setLifted(null);
      if (p) o.current.onDrop(cur.person, p.x, p.y);
      else o.current.onCancel();
      return;
    }
    if (cur.kind === 'one' && e.pointerId === cur.id) {
      if (cur.timer) clearTimeout(cur.timer);
      g.current = { kind: 'idle' };
    }
  };

  const swallowClick = useCallback(() => swallow.current, []);
  return { onPointerDown, onPointerMove, onPointerUp, lifted, swallowClick };
}
