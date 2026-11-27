/**
 * A58 U1: phone mode. The web build turns it on before the first render
 * (`src/web/main.tsx`); the desktop never does, so a narrow desktop window
 * looks and behaves as before. It never changes while the page lives, so
 * `usePhone()` is a plain read and safe in any component.
 *
 * Phone CSS is scoped under `:root[data-phone]`, which `setPhone` sets.
 */
let phone = false;

export function setPhone(on: boolean, root: HTMLElement = document.documentElement): void {
  phone = on;
  if (on) root.setAttribute('data-phone', '');
  else root.removeAttribute('data-phone');
}

/** True in the phone's web build. */
export function isPhone(): boolean {
  return phone;
}

/** True in the phone's web build; the hook form for components. */
export function usePhone(): boolean {
  return phone;
}
