import { useEffect } from 'react';
import type { Appearance } from '../../shared/ipcApp';
import { call } from './api';

/**
 * ST-1: light, dark, or system, applied live through `data-theme` on the
 * root element. `system` leaves the colours to the system setting through
 * the `prefers-color-scheme` rules in theme.css.
 */
export function applyAppearance(appearance: Appearance): void {
  document.documentElement.setAttribute('data-theme', appearance);
}

/** Load the stored appearance once, when the app starts. */
export function useAppearance(): void {
  useEffect(() => {
    void call('appearance.get', {})
      .then((r) => applyAppearance(r.appearance))
      .catch(() => undefined);
  }, []);
}
