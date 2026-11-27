import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { useFocusTrap } from '../focusTrap';
import { usePhoneNav } from './nav';
import type { Sheet as SheetName } from './nav';

/** A drag down past this many pixels lets the sheet go. */
const DISMISS_PX = 80;

/**
 * A58 U1: the phone's bottom sheet. It rises from the foot over a dimmed
 * page, with a grab handle; a swipe down on the handle, a tap outside,
 * Escape or back (the sheet is a history entry, `usePhoneNav().openSheet`)
 * puts it away. Its content scrolls inside it, above the home indicator.
 *
 *   <PhoneSheet name="year" label="Story year">...</PhoneSheet>
 *
 * It shows while `usePhoneNav().sheet === name`.
 */
export function PhoneSheet(props: {
  name: SheetName;
  /** The dialog's accessible name; also its heading when `title` is set. */
  label: string;
  title?: boolean;
  children: ReactNode;
  testId?: string;
}) {
  const nav = usePhoneNav();
  if (nav.sheet !== props.name) return null;
  return <OpenSheet {...props} onClose={nav.closeSheet} />;
}

function OpenSheet(props: {
  label: string;
  title?: boolean;
  children: ReactNode;
  testId?: string;
  onClose: () => void;
}) {
  const { onClose } = props;
  const panel = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; y: number } | null>(null);
  const [dy, setDy] = useState(0);
  useFocusTrap(panel);

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    panel.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      onClose();
    };
    document.addEventListener('keydown', onKey);
    // The page under the sheet holds still.
    document.documentElement.setAttribute('data-sheet', '');
    return () => {
      document.removeEventListener('keydown', onKey);
      document.documentElement.removeAttribute('data-sheet');
      before?.focus?.({ preventScroll: true });
    };
  }, [onClose]);

  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    drag.current = { id: e.pointerId, y: e.clientY };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const move = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current?.id !== e.pointerId) return;
    setDy(Math.max(0, e.clientY - drag.current.y));
  };
  const up = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current?.id !== e.pointerId) return;
    const moved = e.clientY - drag.current.y;
    drag.current = null;
    setDy(0);
    if (moved > DISMISS_PX) onClose();
  };

  return (
    <div className="ph-sheet-layer">
      <div
        className="ph-sheet-scrim"
        data-testid="sheet-scrim"
        aria-hidden="true"
        onClick={onClose}
      />
      <div
        ref={panel}
        className="ph-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={props.label}
        tabIndex={-1}
        data-testid={props.testId}
        style={dy ? { transform: `translateY(${dy}px)`, transition: 'none' } : undefined}
      >
        <div
          className="ph-sheet-grab"
          data-testid="sheet-grab"
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
        >
          <span className="ph-sheet-handle" aria-hidden="true" />
          {props.title && <h2 className="ph-sheet-title">{props.label}</h2>}
        </div>
        <div className="ph-sheet-body">{props.children}</div>
      </div>
    </div>
  );
}
