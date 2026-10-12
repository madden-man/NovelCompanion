import { CONNECTION_LOST_MESSAGE, READ_ONLY_REASON, isWriteChannel } from '../../shared/ipcApp';
import type { Channel } from '../../shared/ipc';
import { ReadOnlyError } from '../db/readOnly';
import type { Handler } from './validate';

/**
 * Driver errors that mean MongoDB cannot be reached, as opposed to a refused
 * or invalid write: no server to select, a dropped socket, a connection pool
 * closed or cleared, a wait for a connection or an operation that ran out of
 * time, or a client or server that was closed under the app. These are the
 * `name` values the mongodb driver (6.x) gives its error classes.
 */
const CONNECTION_ERRORS = new Set([
  'MongoNetworkError',
  'MongoNetworkTimeoutError',
  'MongoServerSelectionError',
  'MongoTopologyClosedError',
  'MongoNotConnectedError',
  'MongoExpiredSessionError',
  'MongoPoolClosedError',
  'MongoPoolClearedError',
  'PoolClearedOnNetworkError',
  'MongoServerClosedError',
  'MongoClientClosedError',
  'MongoOperationTimeoutError',
  'MongoWaitQueueTimeoutError',
]);

/** ARCH-6: true when the error, or anything it was caused by, is a lost connection. */
export function isConnectionError(e: unknown): boolean {
  for (let cur = e, depth = 0; cur && depth < 5; depth++) {
    if (cur instanceof Error && CONNECTION_ERRORS.has(cur.name)) return true;
    cur = cur instanceof Error ? cur.cause : undefined;
  }
  return false;
}

export interface OfflineGuard {
  /** True while a snapshot is open read-only. */
  readOnly(): boolean;
  /** MongoDB went away during this request. */
  lost(): void;
}

/**
 * ARCH-6: wrap a channel's handler. While a snapshot is open read-only, a
 * write channel is refused before it runs. A request that fails because
 * MongoDB went away reports that plainly, says nothing was saved, and marks
 * the connection lost so the window can offer to try again or open the
 * latest snapshot. Nothing is ever reported as saved when it was not: the
 * handler's own result is returned only when it finished.
 */
export function guardHandler<C extends Channel>(
  channel: C,
  handler: Handler<C>,
  guard: OfflineGuard,
): Handler<C> {
  const write = isWriteChannel(channel);
  return async (request) => {
    if (write && guard.readOnly()) throw new Error(READ_ONLY_REASON);
    try {
      return await handler(request);
    } catch (e) {
      if (e instanceof ReadOnlyError) throw new Error(READ_ONLY_REASON, { cause: e });
      if (isConnectionError(e)) {
        guard.lost();
        throw new Error(CONNECTION_LOST_MESSAGE, { cause: e });
      }
      throw e;
    }
  };
}
