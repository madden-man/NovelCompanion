import type { z } from 'zod';
import { isChannel, parseCallContext, parseRequest, parseResponse } from '../../shared/ipc';
import type { CallContext, Channel, Response, contract } from '../../shared/ipc';

export type Handler<C extends Channel> = (
  request: z.output<(typeof contract)[C]['request']>,
  context?: CallContext,
) => Promise<Response<C>> | Response<C>;

/** Validate the request and its context, run the handler, validate the response. */
export async function runHandler<C extends Channel>(
  channel: C,
  handler: Handler<C>,
  payload: unknown,
  context?: unknown,
): Promise<Response<C>> {
  const request = parseRequest(channel, payload);
  const response = await handler(request, parseCallContext(context));
  return parseResponse(channel, response);
}

/**
 * A58: every handler by its channel. `registerHandlers` fills one; the
 * Electron adapter (`mountHandlers` in `handle.ts`) serves it on `ipcMain`,
 * and an HTTP adapter can serve the same table through `runHandler`.
 */
export type HandlerTable = Map<Channel, Handler<Channel>>;

/** Put one channel's handler in the table. A channel outside the contract is a bug. */
export function setHandler<C extends Channel>(
  table: HandlerTable,
  channel: C,
  handler: Handler<C>,
): void {
  if (!isChannel(channel)) throw new Error(`Unknown channel: ${String(channel)}`);
  table.set(channel, handler as unknown as Handler<Channel>);
}
