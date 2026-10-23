import { bibleHandlers } from '../../src/main/ipc/bibleHandlers';
import type { BibleChannel } from '../../src/main/ipc/bibleHandlers';
import type { BackupDeps } from '../../src/main/ipc/backupHandlers';
import type { SessionDeps } from '../../src/main/ipc/sessionHandlers';
import { runHandler } from '../../src/main/ipc/validate';
import type { Handler } from '../../src/main/ipc/validate';
import type { OpenBible } from '../../src/main/db/session';
import type { Channel, Request, Response } from '../../src/shared/ipc';
import type { Invoke } from './t5';

/**
 * The IPC layer without Electron's transport: requests and responses pass
 * through the same zod contract the preload and main process use, so the
 * payloads round-trip as JSON exactly as they would over IPC.
 */
export function ipcFor(bible: () => OpenBible | null, deps: BackupDeps & SessionDeps = {}): Invoke {
  const handlers = bibleHandlers(bible, deps);
  return async <C extends Channel>(channel: C, request: Request<C>): Promise<Response<C>> => {
    const handler = handlers[channel as BibleChannel] as Handler<C> | undefined;
    if (!handler) throw new Error(`No bible handler for ${channel}`);
    const wire = JSON.parse(JSON.stringify(request)) as unknown;
    const response = await runHandler(channel, handler, wire);
    return JSON.parse(JSON.stringify(response)) as Response<C>;
  };
}
