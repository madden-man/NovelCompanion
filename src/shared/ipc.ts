import { z } from 'zod';
import { BibleName, BibleSlug } from './bible';

const BibleSummary = z.strictObject({ id: z.string().min(1), name: z.string().min(1) });

/**
 * The IPC contract (ARCHITECTURE rule 3). Every channel the renderer can call
 * has a zod request and response schema. The preload validates both sides,
 * and the main process validates both sides again.
 */
export const contract = {
  'app.ping': {
    request: z.strictObject({ message: z.string().min(1).max(200) }),
    response: z.strictObject({ message: z.string(), receivedAt: z.iso.datetime() }),
  },
  'bible.list': {
    request: z.strictObject({}),
    response: z.strictObject({
      connection: z.enum(['connected', 'unavailable']),
      /** A plain-language explanation when the connection is unavailable. */
      message: z.string().optional(),
      bibles: z.array(BibleSummary),
    }),
  },
  /** Register a new, empty bible (ARCH-8). It does not open it. */
  'bible.create': {
    request: z.strictObject({ slug: BibleSlug, name: BibleName }),
    response: z.strictObject({ bible: BibleSummary }),
  },
  /** Make a bible the current one; main loads its read model and search index. */
  'bible.open': {
    request: z.strictObject({ slug: BibleSlug }),
    response: z.strictObject({ bible: BibleSummary }),
  },
  'bible.current': {
    request: z.strictObject({}),
    response: z.strictObject({ bible: BibleSummary.nullable() }),
  },
  /** Open a link in the system browser. Only allowlisted hosts are opened. */
  'app.openExternal': {
    request: z.strictObject({ url: z.string().min(1).max(2000) }),
    response: z.union([
      z.strictObject({ ok: z.literal(true) }),
      z.strictObject({ ok: z.literal(false), message: z.string() }),
    ]),
  },
} as const;

export type Channel = keyof typeof contract;
export type Request<C extends Channel> = z.input<(typeof contract)[C]['request']>;
export type Response<C extends Channel> = z.output<(typeof contract)[C]['response']>;

export const CHANNELS = Object.keys(contract) as Channel[];

export function isChannel(name: unknown): name is Channel {
  return typeof name === 'string' && Object.hasOwn(contract, name);
}

/** Events the main process pushes to the renderer. */
export const events = {
  /** The list of bibles or the current bible changed. */
  'bibles.changed': z.strictObject({ current: BibleSummary.nullable() }),
  'bible.changed': z.strictObject({
    bible: z.string(),
    collection: z.string(),
    id: z.string(),
    op: z.enum(['create', 'update', 'softDelete', 'restore']),
  }),
} as const;

export type EventName = keyof typeof events;
export type EventPayload<E extends EventName> = z.output<(typeof events)[E]>;

export function isEventName(name: unknown): name is EventName {
  return typeof name === 'string' && Object.hasOwn(events, name);
}

/** IPC wire channel names are prefixed so nothing else can collide with them. */
export const wireChannel = (c: Channel): string => `nc:${c}`;
export const wireEvent = (e: EventName): string => `nc-event:${e}`;

export class IpcValidationError extends Error {
  override name = 'IpcValidationError';
}

export function parseRequest<C extends Channel>(channel: C, payload: unknown) {
  const result = contract[channel].request.safeParse(payload);
  if (!result.success) {
    throw new IpcValidationError(
      `The request for ${channel} is not valid: ${z.prettifyError(result.error)}`,
    );
  }
  return result.data as z.output<(typeof contract)[C]['request']>;
}

export function parseResponse<C extends Channel>(channel: C, payload: unknown): Response<C> {
  const result = contract[channel].response.safeParse(payload);
  if (!result.success) {
    throw new IpcValidationError(
      `The response for ${channel} is not valid: ${z.prettifyError(result.error)}`,
    );
  }
  return result.data as Response<C>;
}

/** The shape of `window.api`, the only thing the preload exposes. */
export interface Api {
  invoke<C extends Channel>(channel: C, request: Request<C>): Promise<Response<C>>;
  on<E extends EventName>(event: E, listener: (payload: EventPayload<E>) => void): () => void;
}
