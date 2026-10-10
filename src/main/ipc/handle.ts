import { ipcMain } from 'electron';
import { isChannel, wireChannel } from '../../shared/ipc';
import type { Channel } from '../../shared/ipc';
import { runHandler } from './validate';
import type { Handler } from './validate';

/**
 * Register a handler for one channel of the contract. Both sides are
 * validated. The renderer receives only the error message, never a stack.
 */
export function handle<C extends Channel>(channel: C, handler: Handler<C>): void {
  if (!isChannel(channel)) throw new Error(`Unknown channel: ${String(channel)}`);
  ipcMain.handle(wireChannel(channel), async (_event, payload: unknown) => {
    try {
      return await runHandler(channel, handler, payload);
    } catch (e) {
      throw new Error(e instanceof Error ? e.message : 'Something went wrong in the app.', {
        cause: e,
      });
    }
  });
}
