import { ipcMain } from 'electron';
import { plainErrorMessage } from '../../shared/errors';
import { isChannel, wireChannel } from '../../shared/ipc';
import type { Channel } from '../../shared/ipc';
import { runHandler } from './validate';
import type { Handler, HandlerTable } from './validate';

/**
 * Register a handler for one channel of the contract. Both sides are
 * validated. The renderer receives only a plain message with what to do next
 * (NF-3), never a driver message, a zod path, a status code, or a stack.
 */
export function handle<C extends Channel>(channel: C, handler: Handler<C>): void {
  if (!isChannel(channel)) throw new Error(`Unknown channel: ${String(channel)}`);
  ipcMain.handle(wireChannel(channel), async (_event, payload: unknown, context: unknown) => {
    try {
      return await runHandler(channel, handler, payload, context);
    } catch (e) {
      throw new Error(plainErrorMessage(e), { cause: e });
    }
  });
}

/** A58: serve the whole handler table on `ipcMain`, each channel under its wire name. */
export function mountHandlers(table: HandlerTable): void {
  for (const [channel, handler] of table) handle(channel, handler);
}
