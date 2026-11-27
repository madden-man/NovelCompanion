import { z } from 'zod';
import { PHONE_WAITS_MAX, WaitingInput, WaitingLineWire } from './phoneWaits';

/**
 * A58 U5 (PH-28): the sentences that wait for the desk. The phone keeps a
 * Route B or C sentence here instead of sending it to Claude; the desk's
 * From the notebook tray offers each as a card. Both clients use all three.
 */
const Lines = z.strictObject({ lines: z.array(WaitingLineWire) });

export const captureContract = {
  /** Every waiting sentence, with whether the desk has handled it. */
  'capture.waiting': {
    request: z.strictObject({}),
    response: Lines,
  },
  /** Keep sentences for the desk; with their IDs, undo and redo bring them back. */
  'capture.wait': {
    request: z.strictObject({ lines: z.array(WaitingInput).min(1).max(PHONE_WAITS_MAX) }),
    response: Lines,
  },
  /** Take sentences back before the desk handles them. */
  'capture.takeBack': {
    request: z.strictObject({
      ids: z.array(z.string().min(1).max(64)).min(1).max(PHONE_WAITS_MAX),
    }),
    response: Lines,
  },
} as const;
