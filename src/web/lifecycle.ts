import { PHONE_FRESHEN_MS } from './transport';
import type { WebTransport } from './transport';

type Doc = Pick<Document, 'visibilityState' | 'addEventListener' | 'activeElement'>;
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
  const hide = () => {
    stop();
    transport.keepalive();
    // An open field stores its typing when it is left, as on the desk; that write goes keepalive.
    const el = doc.activeElement as HTMLElement | null;
    if (el && typeof el.blur === 'function' && el !== (doc as Document).body) el.blur();
    transport.hidden();
  };
  doc.addEventListener('visibilitychange', () => {
    if (doc.visibilityState === 'visible') {
      transport.shown();
      void transport.checkFreshness();
      start();
    } else hide();
  });
  win.addEventListener('pagehide', hide);
  win.addEventListener('offline', () => transport.offline());
  win.addEventListener('online', () => void transport.invoke('connection.retry', {}));
  if (doc.visibilityState === 'visible') start();
}
