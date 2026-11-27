import { z } from 'zod';

/**
 * A58 P4: the channels the phone's web build needs, spread into the one IPC
 * contract in `ipc.ts` and marked in `ipcPhone.ts`.
 */

/** PH-9: what changed in an open bible, as the change events carry it. */
const Change = z.strictObject({
  collection: z.string(),
  id: z.string(),
  op: z.enum(['create', 'update', 'softDelete', 'restore']),
});

/** PH-15: the phone key as Settings shows it. Never the whole key. */
const PhoneKeyStatus = z.strictObject({
  set: z.boolean(),
  /** The last four characters behind dots, or null when none is set. */
  masked: z.string().nullable(),
});
export type PhoneKeyStatus = z.infer<typeof PhoneKeyStatus>;

export const pwaContract = {
  /**
   * PH-5: the channels this client may use. The desktop answers every channel;
   * the hosted function answers the phone channels.
   */
  'app.capabilities': {
    request: z.strictObject({}),
    response: z.strictObject({ channels: z.array(z.string()) }),
  },
  /**
   * PH-9: the entries of the open bible stored since `since` (ISO time), so a
   * client that found `rev` moved elsewhere can redraw each in place. Lists,
   * the tree, story time and settings are not entries; the client asks them again.
   */
  'bible.changes': {
    request: z.strictObject({ since: z.iso.datetime() }),
    response: z.strictObject({
      bible: z.string().nullable(),
      at: z.iso.datetime(),
      changes: z.array(Change).max(20_000),
    }),
  },
  /** PH-15: whether the Mac holds a phone key, shown masked. */
  'phoneKey.status': { request: z.strictObject({}), response: PhoneKeyStatus },
  /** PH-15: store a new random phone key when none is set; one already set is kept. */
  'phoneKey.make': { request: z.strictObject({}), response: PhoneKeyStatus },
  /** PH-15: put the whole phone key on the clipboard, in main; the page never holds it. */
  'phoneKey.copy': {
    request: z.strictObject({}),
    response: z.strictObject({ ok: z.boolean() }),
  },
} as const;
