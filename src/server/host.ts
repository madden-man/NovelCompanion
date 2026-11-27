import type { EventName } from '../shared/ipc';
import type { Host } from '../main/host/types';
import { MemoryMongoUriStore } from '../main/host/uri';

/** A58: what the hosted function reads from its environment (PH-14, PH-21). */
export interface ServerEnv {
  /** The Atlas connection string (ARCH-5 as amended by A58). */
  NC_MONGODB_URI?: string;
  /** The phone key; with none set every request is refused (PH-14). */
  NC_PHONE_KEY?: string;
  /** The build id every answer carries (PH-21); `COMMIT_REF` when unset, then `dev`. */
  NC_BUILD_ID?: string;
  COMMIT_REF?: string;
  [name: string]: string | undefined;
}

/** One event a request broadcast, as the envelope carries it (PH-12). */
export interface WireEvent {
  event: EventName;
  payload: unknown;
}

/** The events of the request in flight. The function serves one request at a time (PH-7). */
export interface EventSink {
  /** Start collecting for a new request; anything held from before is dropped. */
  begin(): void;
  /** Stop collecting and hand over what the request broadcast. */
  end(): WireEvent[];
}

/**
 * A58: the hosted function as a host. No disk, no dialogs, no Claude, no
 * system browser; the connection string comes from the environment, and an
 * event goes to the request in flight instead of a window. It counts as
 * packaged, so the test seams are honoured only under the documented allow
 * flag (`host/uri.ts`), which is how the tests reach the local replica set.
 */
export function serverHost(env: ServerEnv): { host: Host; events: EventSink } {
  let collecting: WireEvent[] | null = null;
  const host: Host = {
    userData: null,
    isPackaged: true,
    hosted: true,
    secrets: { mongoUris: () => new MemoryMongoUriStore(env.NC_MONGODB_URI?.trim() || null) },
    broadcast(event, payload) {
      collecting?.push({ event, payload });
    },
    dialogs: null,
    openExternal: null,
    setTheme: () => undefined,
    claude: null,
  };
  return {
    host,
    events: {
      begin() {
        collecting = [];
      },
      end() {
        const held = collecting ?? [];
        collecting = null;
        return held;
      },
    },
  };
}
