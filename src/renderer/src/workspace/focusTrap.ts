import { useEffect } from 'react';
import type { RefObject } from 'react';
import { trapTarget } from '../../../shared/domain/focus';

const FOCUSABLE =
  'a[href], summary, button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => !el.closest('[hidden]') && el.getClientRects().length > 0,
  );
}

/** Keep keyboard focus inside a modal dialog while it is open (NF-2). */
export function useFocusTrap(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const root = ref.current;
      if (e.key !== 'Tab' || !root) return;
      const items = focusables(root);
      const at = items.indexOf(document.activeElement as HTMLElement);
      const target = trapTarget(at, items.length, e.shiftKey);
      if (target === null) return;
      e.preventDefault();
      items[target]?.focus();
    };
    const onFocusIn = (e: FocusEvent) => {
      const root = ref.current;
      if (root && e.target instanceof Node && !root.contains(e.target))
        focusables(root)[0]?.focus();
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('focusin', onFocusIn);
    };
  }, [ref]);
}
