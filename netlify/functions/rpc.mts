import { freshenOpenBible } from '../../src/main/ipc/handlers';
import { createRpc } from '../../src/server/rpc';
// PH-21: written by the web build in the same Netlify build, so both answer with one id.
import buildInfo from '../../src/generated/build-id.json';

/**
 * A58: the hosted function (PH-1). Netlify Functions v2: one route, `/rpc`,
 * served by the same handler `scripts/serve-web.ts` mounts locally.
 */
const rpc = createRpc({
  env: process.env,
  // PH-7: the open bible is made fresh before each request.
  freshen: freshenOpenBible,
  buildId: buildInfo.id,
});

export default (request: Request): Promise<Response> => rpc(request);

export const config = { path: '/rpc' };
