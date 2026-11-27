/** PH-24: the shell's service worker, so the app opens with no connection. */
export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((e: unknown) => {
      console.error('Novel Companion service worker:', e);
    });
  });
}

/** PH-21: fetch the new service worker now, so the reload opens the new shell. */
export async function updateServiceWorker(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  const registration = await navigator.serviceWorker.getRegistration();
  await registration?.update();
}
