import { PHONE_FRESHEN_MS } from './transport';
import type { WebTransport } from './transport';

type Doc = Pick<Document, 'visibilityState' | 'addEventListener'>;
type Win = Pick<Window, 'addEventListener' | 'setInterval' | 'clearInterval'>;

/**
 * A58 P4: the phone's moments. Visible: check the bible's `rev` at once and
 * every 20 seconds while it stays visible (PH-9). Hidden or leaving: flush
 * what the page holds with keepalive requests (PH-13). Offline and online:
 * the ARCH-6 banner follows (PH-24).
 */
export function attachLifecycle(
  transport: WebTransport,
  doc: Doc,
  win: Win,
  every = PHONE_FRESHEN_MS,
): void {
  let timer: ReturnType<Window['setInterval']> | null = null;
  const start = () => {
    timer ??= win.setInterval(() => void transport.checkFreshness(), every);
  };
  const stop = () => {
    if (timer !== null) win.clearInterval(timer);
    timer = null;
  };
  doc.addEventListener('visibilitychange', () => {
    if (doc.visibilityState === 'visible') {
      transport.shown();
      void transport.checkFreshness();
      start();
    } else {
      stop();
      transport.hidden();
    }
  });
  win.addEventListener('pagehide', () => {
    stop();
    transport.hidden();
  });
  win.addEventListener('offline', () => transport.offline());
  win.addEventListener('online', () => void transport.invoke('connection.retry', {}));
  if (doc.visibilityState === 'visible') start();
}
