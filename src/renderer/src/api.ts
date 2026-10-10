import type { Channel, Request, Response } from '../../shared/ipc';

/** Main's errors arrive wrapped by Electron; keep only the plain message. */
export function plainError(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  return text.replace(/^Error invoking remote method '[^']*': (Error: )?/, '');
}

export function call<C extends Channel>(channel: C, request: Request<C>): Promise<Response<C>> {
  return window.api.invoke(channel, request);
}
