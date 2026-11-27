import type { z } from 'zod';
import { parseCallContext, parseRequest, parseResponse } from '../../shared/ipc';
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
