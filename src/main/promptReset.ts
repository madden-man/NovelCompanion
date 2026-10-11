/** What the stop prompt tracking needs from a window's web contents. */
export interface NavigationSource {
  on(
    event: 'did-start-navigation',
    listener: (details: { isMainFrame: boolean; isSameDocument: boolean }) => void,
  ): unknown;
}

/**
 * SL-1: the stop prompt lives in the page. When the page reloads or navigates
 * to another document the prompt is gone, so main must stop treating it as
 * shown, or a later close would wait on a prompt nobody can see.
 */
export function resetOnNavigation(source: NavigationSource, reset: () => void): void {
  source.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) reset();
  });
}
