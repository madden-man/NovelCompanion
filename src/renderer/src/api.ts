import { plainCallError } from '../../shared/errors';
import type { Channel, Request, Response } from '../../shared/ipc';

/**
 * Main's errors arrive wrapped by Electron; keep only the message, in plain
 * words with what to do next (NF-3). Main maps them already; this catches
 * what the preload throws and anything raw that slipped through.
 */
export const plainError = plainCallError;

export function call<C extends Channel>(channel: C, request: Request<C>): Promise<Response<C>> {
  return window.api.invoke(channel, request);
}
