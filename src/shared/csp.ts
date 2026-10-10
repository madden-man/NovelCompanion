/**
 * The renderer's Content-Security-Policy (ARCH-1). The built app forbids every
 * remote script and every connection except to itself. Development only adds
 * what the local Vite dev server needs: its hot reload socket, the React
 * refresh preamble (an inline script), and its blob worker. Nothing remote is
 * allowed in either mode.
 */
export function contentSecurityPolicy(dev: boolean): string {
  return [
    "default-src 'self'",
    dev ? "script-src 'self' 'unsafe-inline'" : "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    dev ? "connect-src 'self' ws://localhost:*" : "connect-src 'self'",
    ...(dev ? ["worker-src 'self' blob:"] : []),
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-src 'none'",
  ].join('; ');
}
