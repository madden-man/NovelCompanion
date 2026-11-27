import { plainCallError } from '../../shared/errors';
import { isWriteChannel } from '../../shared/ipcApp';
import type { Channel, Request, Response } from '../../shared/ipc';

/**
 * Main's errors arrive wrapped by Electron; keep only the message, in plain
 * words with what to do next (NF-3). Main maps them already; this catches
 * what the preload throws and anything raw that slipped through.
 */
export const plainError = plainCallError;

/**
 * A57: the bible the mounted workspace was opened on, set by its `UndoProvider`.
 * Every write `call` sends carries it, and main refuses a write whose bible is
 * not the open one, so no write from this window lands in another bible.
 */
let workspaceBible: string | null = null;

/** Set by the workspace's provider on mount; cleared only by the one that set it. */
export function setWorkspaceBible(bible: string | null, from?: string): void {
  if (bible === null && from !== undefined && workspaceBible !== from) return;
  workspaceBible = bible;
}

/** Writes sent and not yet answered, so a bible switch can wait for them. */
const inflight = new Set<Promise<unknown>>();
/** Plain messages of writes that failed while a bible switch waited for them. */
let failures: string[] | null = null;

function track<T>(p: Promise<T>): Promise<T> {
  inflight.add(p);
  p.then(
    () => inflight.delete(p),
    (e: unknown) => {
      inflight.delete(p);
      failures?.push(plainError(e));
    },
  );
  return p;
}

/**
 * Wait until no write is in flight. Returns the plain message of each write
 * that failed meanwhile, so the caller can say what was not saved.
 */
export async function writesSettled(): Promise<string[]> {
  failures = [];
  try {
    while (inflight.size > 0) await Promise.allSettled([...inflight]);
    return failures;
  } finally {
    failures = null;
  }
}

/** A write made in the open workspace's bible; a read as it is. */
export function call<C extends Channel>(channel: C, request: Request<C>): Promise<Response<C>> {
  return callIn(workspaceBible, channel, request);
}

/**
 * A57: a write made in `bible`, the bible its workspace was opened on. A write
 * still pending when another bible opened is refused by main, never applied there.
 */
export function callIn<C extends Channel>(
  bible: string | null | undefined,
  channel: C,
  request: Request<C>,
): Promise<Response<C>> {
  if (!isWriteChannel(channel)) return window.api.invoke(channel, request);
  return track(window.api.invoke(channel, request, bible ? { bible } : undefined));
}
