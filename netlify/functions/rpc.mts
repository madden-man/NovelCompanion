import { freshenOpenBible } from '../../src/main/ipc/handlers';
import { createRpc } from '../../src/server/rpc';

/**
 * A58: the hosted function (PH-1). Netlify Functions v2: one route, `/rpc`,
 * served by the same handler `scripts/serve-web.ts` mounts locally.
 */
const rpc = createRpc({
  env: process.env,
  // PH-7: the open bible is made fresh before each request.
  freshen: freshenOpenBible,
});

export default (request: Request): Promise<Response> => rpc(request);

export const config = { path: '/rpc' };
