import { createRpc } from '../../src/server/rpc';

/**
 * A58: the hosted function (PH-1). Netlify Functions v2: one route, `/rpc`,
 * served by the same handler `scripts/serve-web.ts` mounts locally.
 */
const rpc = createRpc({
  env: process.env,
  // A no-op until the coordinator wires P2's `freshenOpenBible` here at merge.
  freshen: async () => ({ moved: false }),
});

export default (request: Request): Promise<Response> => rpc(request);

export const config = { path: '/rpc' };
