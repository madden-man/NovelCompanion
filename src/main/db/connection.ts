import { MongoClient } from 'mongodb';
import type { Collection, Db, Document, MongoClientOptions } from 'mongodb';
import { BRIDGE_DOWN, BRIDGE_UP, BRIDGE_WORLDS } from '../../shared/bridge';

/**
 * The app's own database (ARCH-8, A22, A56). Beside it the app touches only
 * the phone bridge's collections in `flowstate_bridge` (`BRIDGE_DATABASE_NAME`),
 * through a `BridgeDb` that can reach nothing else. Nothing in the app reads,
 * lists, creates, or writes any other database on the cluster.
 */
export const DATABASE_NAME = 'novel_companion';

/** A56 (ARCH-8): the one database the phone bridge lives in, shared with FlowState and Music Companion. */
export const BRIDGE_DATABASE_NAME = 'flowstate_bridge';

/** The bridge collections this app may touch: never `bridge_clips`, which is Music Companion's. */
export const BRIDGE_REACH = [BRIDGE_WORLDS, BRIDGE_DOWN, BRIDGE_UP] as const;
export type BridgeReach = (typeof BRIDGE_REACH)[number];

/**
 * A56 (ARCH-8): a handle on `flowstate_bridge` that reaches only the three
 * bridge collections this app uses. No `db()`, no `client`, no admin: a name
 * outside `BRIDGE_REACH` throws.
 */
export interface BridgeDb {
  readonly databaseName: string;
  collection<T extends Document>(name: BridgeReach): Collection<T>;
}

export function bridgeHandle(db: Db): BridgeDb {
  return {
    databaseName: db.databaseName,
    collection<T extends Document>(name: BridgeReach): Collection<T> {
      if (!(BRIDGE_REACH as readonly string[]).includes(name)) {
        throw new Error(`The bridge reaches only ${BRIDGE_REACH.join(', ')}, not ${String(name)}.`);
      }
      return db.collection<T>(name);
    },
  };
}

/**
 * The bridge database's name: `flowstate_bridge`, or under the end-to-end test
 * seam the spec file's database name with `_bridge` after it.
 */
export function bridgeDatabaseFor(database: string | null): string {
  return database === null ? BRIDGE_DATABASE_NAME : `${database.slice(0, 50)}_bridge`;
}

/** An open connection: the client, the app's own database and the bridge handle. */
export interface Store {
  readonly client: MongoClient;
  readonly db: Db;
  readonly bridge: BridgeDb;
  close(): Promise<void>;
}

/**
 * Connect to a MongoDB deployment and select `novel_companion`. The caller
 * closes it. `database` is only ever the test seam's name (`testDatabaseName()`
 * in src/main/secrets.ts), which gives each end-to-end spec file its own
 * database on one shared local test server.
 */
export async function connect(
  uri: string,
  options: MongoClientOptions = {},
  database: string | null = null,
): Promise<Store> {
  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 8000,
    appName: 'novel-companion',
    ...options,
  });
  try {
    await client.connect();
  } catch (e) {
    // A failed connect can leave monitors and sockets open; release them.
    await client.close().catch(() => undefined);
    throw e;
  }
  return {
    client,
    db: client.db(database ?? DATABASE_NAME),
    bridge: bridgeHandle(client.db(bridgeDatabaseFor(database))),
    close: () => client.close(),
  };
}
