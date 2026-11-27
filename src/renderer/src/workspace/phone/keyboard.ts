import { useEffect } from 'react';

/** Room kept between the field and the edge of what shows. */
const MARGIN = 12;
/** A visual viewport this much shorter than the window means the keyboard is up. */
const KEYBOARD_PX = 80;

type Viewport = Pick<
  VisualViewport,
  'height' | 'offsetTop' | 'addEventListener' | 'removeEventListener'
>;

/** A field that takes typing: an input, a select, a text area or a rich text box. */
export function isTypingField(el: Element | null): el is HTMLElement {
  if (!el || !(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  if (!(el instanceof HTMLInputElement)) return false;
  return !['button', 'checkbox', 'radio', 'range', 'submit', 'reset', 'color', 'file'].includes(
    el.type,
  );
}

/** Where the caret is in a rich text box, else the field's own box. */
function caretRect(el: HTMLElement): DOMRect {
  const box = el.getBoundingClientRect();
  if (!el.isContentEditable) return box;
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !el.contains(sel.anchorNode)) return box;
  const r = sel.getRangeAt(0).getBoundingClientRect();
  return r.height > 0 ? r : box;
}

/**
 * How far to scroll the page so the focused field shows between the top bar
 * and the foot of the visual viewport (the keyboard's top on iOS). Positive
 * scrolls down. A box taller than what shows keeps its caret line in view.
 */
export function scrollToShow(
  rect: { top: number; bottom: number },
  view: { top: number; bottom: number },
): number {
  const room = view.bottom - view.top;
  const bottom = rect.bottom - rect.top > room ? rect.top + room : rect.bottom;
  if (bottom > view.bottom) return bottom - view.bottom;
  if (rect.top < view.top) return rect.top - view.top;
  return 0;
}

/**
 * PH-32: the field being typed in stays above the on-screen keyboard. The
 * visual viewport shrinks when the iOS keyboard rises; on every change the
 * page scrolls so the focused field (or its caret) shows below the top bar
 * and above the keyboard. While the keyboard is up, `:root[data-keyboard]`
 * hides the bottom bar and `--ph-vv-top` keeps the fixed top bar on screen.
 */
export function attachKeyboard(win: Window = window, doc: Document = document): () => void {
  const vv: Viewport | null = win.visualViewport;
  const root = doc.documentElement;
  const topBar = () => doc.querySelector('.ph-top')?.getBoundingClientRect().height ?? 0;
  const keep = () => {
    const el = doc.activeElement;
    if (!isTypingField(el)) return;
    const height = vv?.height ?? win.innerHeight;
    const offset = vv?.offsetTop ?? 0;
    const dy = scrollToShow(caretRect(el), {
      top: offset + topBar() + MARGIN,
      bottom: offset + height - MARGIN,
    });
    if (dy !== 0) win.scrollBy({ top: dy, left: 0, behavior: 'instant' });
  };
  const update = () => {
    const height = vv?.height ?? win.innerHeight;
    const offset = vv?.offsetTop ?? 0;
    root.style.setProperty('--ph-vv-top', `${offset}px`);
    const keyboard = win.innerHeight - height - offset > KEYBOARD_PX;
    root.toggleAttribute('data-keyboard', keyboard && isTypingField(doc.activeElement));
    keep();
  };
  let timer: ReturnType<typeof setTimeout> | null = null;
  const later = () => {
    if (timer) clearTimeout(timer);
    // The keyboard slides up for about a third of a second.
    timer = setTimeout(update, 350);
    update();
  };
  const left = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(update, 50);
  };
  vv?.addEventListener('resize', update);
  vv?.addEventListener('scroll', update);
  win.addEventListener('resize', update);
  doc.addEventListener('focusin', later);
  doc.addEventListener('focusout', left);
  return () => {
    if (timer) clearTimeout(timer);
    vv?.removeEventListener('resize', update);
    vv?.removeEventListener('scroll', update);
    win.removeEventListener('resize', update);
    doc.removeEventListener('focusin', later);
    doc.removeEventListener('focusout', left);
    root.removeAttribute('data-keyboard');
    root.style.removeProperty('--ph-vv-top');
  };
}

export function useKeyboardHold(): void {
  useEffect(() => attachKeyboard(), []);
}
