import { session } from 'electron';
import { contentSecurityPolicy } from '../shared/csp';

/** Send the policy as a response header on every renderer load (ARCH-1). */
export function applyContentSecurityPolicy(dev: boolean): void {
  const policy = contentSecurityPolicy(dev);
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [policy] },
    });
  });
}
