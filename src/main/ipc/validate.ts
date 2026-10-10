import type { z } from 'zod';
import { parseRequest, parseResponse } from '../../shared/ipc';
import type { Channel, Response, contract } from '../../shared/ipc';

export type Handler<C extends Channel> = (
  request: z.output<(typeof contract)[C]['request']>,
) => Promise<Response<C>> | Response<C>;

/** Validate the request, run the handler, validate the response. */
export async function runHandler<C extends Channel>(
  channel: C,
  handler: Handler<C>,
  payload: unknown,
): Promise<Response<C>> {
  const request = parseRequest(channel, payload);
  const response = await handler(request);
  return parseResponse(channel, response);
}
