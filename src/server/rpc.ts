import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { BibleSlug } from '../shared/bible';
import { plainErrorMessage } from '../shared/errors';
import { isChannel } from '../shared/ipc';
import type { Channel } from '../shared/ipc';
import { isWriteChannel } from '../shared/ipcApp';
import { DESK_ONLY_MESSAGE, isPhoneChannel } from '../shared/ipcPhone';
import { VersionMismatchError, assertSameVersion } from '../main/db/session';
import { openSession, registerHandlers } from '../main/ipc/handlers';
import { isConnectionError } from '../main/ipc/offline';
import { runHandler } from '../main/ipc/validate';
import type { HandlerTable } from '../main/ipc/validate';
import { serverHost } from './host';
import type { ServerEnv, WireEvent } from './host';
import { takeDailyPhoneSnapshot } from './phoneSnapshots';

/** PH-21: the header that carries the server's build id on every answer. */
export const BUILD_HEADER = 'X-NC-Build';

/** What the phone sends: the channel, its request and context, and the bible it is on. */
export const RpcBody = z.strictObject({
  channel: z.string().min(1),
  request: z.unknown(),
  context: z.unknown().optional(),
  /** The bible the phone's workspace is on; null on the bible chooser. */
  bible: BibleSlug.nullable(),
});
export type RpcBody = z.input<typeof RpcBody>;

/** The answer to a request that ran (PH-12). */
export interface RpcEnvelope {
  result: unknown;
  events: WireEvent[];
}

/** Why a request did not run. `error` is plain words for the screen (NF-3). */
export type RpcErrorCode =
  | 'key'
  | 'method'
  | 'invalid'
  | 'desk'
  | 'older'
  | 'newer'
  | 'snapshot'
  | 'unreachable'
  | 'refused';
export interface RpcError {
  error: string;
  code: RpcErrorCode;
}

const STATUS: Record<RpcErrorCode, number> = {
  key: 401,
  method: 405,
  invalid: 400,
  desk: 403,
  older: 409,
  newer: 409,
  snapshot: 503,
  unreachable: 503,
  refused: 422,
};

const KEY_REFUSED = 'The phone key was not accepted.';
const NOT_UNDERSTOOD = 'The app could not read this request, so nothing changed. Reload the app.';
const NO_SNAPSHOT =
  'The phone could not keep a copy of the bible for today, so nothing was saved. Try again.';

export interface RpcDeps {
  /** Read on every request, so a changed key takes effect at once (PH-17). */
  env: ServerEnv;
  /**
   * PH-7: bring the open bible up to date before a request, reloading the
   * read model and search index when its `rev` moved elsewhere. P2's
   * `freshenOpenBible` in `src/main/ipc/handlers.ts`.
   */
  freshen: () => Promise<{ moved: boolean }>;
  /** The clock for the daily phone snapshot (PH-23). */
  now?: () => Date;
}

export type Rpc = ((request: Request) => Promise<Response>) & {
  /** The channels this function serves: the phone channels, never `test.*` (PH-3). */
  readonly channels: readonly Channel[];
};

/**
 * PH-14: the phone key, compared in constant time over SHA-256 digests, so
 * neither its length nor its first wrong character shows in the timing. No
 * key set refuses every key.
 */
export function keyMatches(given: string | null, expected: string | undefined): boolean {
  const want = expected?.trim() ?? '';
  const digest = (s: string) => createHash('sha256').update(s, 'utf8').digest();
  const same = timingSafeEqual(digest(given ?? ''), digest(want));
  return same && want !== '' && given !== null;
}

/** The key from `Authorization: Bearer <key>`, or null. */
export function bearerKey(request: Request): string | null {
  const m = /^Bearer[ ]+(\S+)\s*$/.exec(request.headers.get('authorization') ?? '');
  return m?.[1] ?? null;
}

/**
 * A58: the hosted function's one route, a plain Fetch handler. It serves the
 * desktop's handler table to the phone, one request at a time: the key first
 * (PH-14), a desk channel refused before anything runs (PH-4), then the asked
 * bible opened unmigrated (PH-19) and made fresh (PH-7), today's phone
 * snapshot before the first write (PH-23), and the handler, whose events
 * come back in the envelope (PH-12). Every answer is `no-store`, `noindex`
 * and carries the build id (PH-21).
 *
 * The handler table keeps its open bible in module state, so make one per
 * process.
 */
export function createRpc(deps: RpcDeps): Rpc {
  const { host, events } = serverHost(deps.env);
  const table: HandlerTable = new Map(
    [...registerHandlers(host)].filter(([channel]) => isPhoneChannel(channel)),
  );
  const now = deps.now ?? (() => new Date());
  let tail: Promise<unknown> = Promise.resolve();

  const answer = (status: number, body: RpcEnvelope | RpcError, extra: Record<string, string> = {}) => {
    const headers = new Headers(extra);
    headers.set('Content-Type', 'application/json; charset=utf-8');
    headers.set('Cache-Control', 'no-store');
    headers.set('X-Robots-Tag', 'noindex');
    headers.set(BUILD_HEADER, deps.env.NC_BUILD_ID || deps.env.COMMIT_REF || 'dev');
    return new Response(JSON.stringify(body), { status, headers });
  };
  const fail = (code: RpcErrorCode, error: string, extra?: Record<string, string>) =>
    answer(STATUS[code], { error, code }, extra);

  const run = <C extends Channel>(channel: C, request: unknown, context?: unknown) =>
    runHandler(channel, table.get(channel) as never, request, context);

  async function serve(body: z.output<typeof RpcBody>): Promise<Response> {
    const channel = body.channel as Channel;
    try {
      if (body.bible !== null) {
        let open = (await run('bible.current', {})).bible;
        if (open?.id !== body.bible) open = (await run('bible.open', { slug: body.bible })).bible;
        // PH-19 on every request: the desk may have migrated the bible since it opened here.
        const session = openSession();
        if (session) await assertSameVersion(session.handle, open?.name ?? body.bible);
      }
      await deps.freshen();
      const session = openSession();
      if (session && isWriteChannel(channel)) {
        try {
          await takeDailyPhoneSnapshot(session.handle, now());
        } catch (e) {
          console.error('Novel Companion phone snapshot:', e);
          return fail('snapshot', NO_SNAPSHOT);
        }
      }
      events.begin();
      const result = await run(channel, body.request, body.context);
      return answer(200, { result, events: events.end() });
    } catch (e) {
      events.end();
      if (e instanceof VersionMismatchError) return fail(e.kind, e.message);
      return fail(isConnectionError(e) ? 'unreachable' : 'refused', plainErrorMessage(e));
    }
  }

  const rpc = async (request: Request): Promise<Response> => {
    if (!keyMatches(bearerKey(request), deps.env.NC_PHONE_KEY)) {
      return fail('key', KEY_REFUSED, { 'WWW-Authenticate': 'Bearer' });
    }
    if (request.method !== 'POST') return fail('method', NOT_UNDERSTOOD, { Allow: 'POST' });
    let body: z.output<typeof RpcBody>;
    try {
      body = RpcBody.parse(await request.json());
    } catch {
      return fail('invalid', NOT_UNDERSTOOD);
    }
    if (!isChannel(body.channel)) return fail('invalid', NOT_UNDERSTOOD);
    // PH-4: refused before the bible opens or anything is written.
    if (!table.has(body.channel)) return fail('desk', DESK_ONLY_MESSAGE);
    // PH-7: one request at a time, in the order they came.
    const next = tail.then(() => serve(body));
    tail = next.catch(() => undefined);
    return next;
  };
  return Object.assign(rpc, { channels: [...table.keys()] });
}
