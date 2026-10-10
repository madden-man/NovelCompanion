import { MongoClient } from 'mongodb';
import type { Db, MongoClientOptions } from 'mongodb';

/**
 * The only database the app ever uses (ARCH-8, A22). Nothing in the app reads,
 * lists, creates, or writes any other database on the cluster.
 */
export const DATABASE_NAME = 'novel_companion';

/** An open connection: the client and the app's one database. */
export interface Store {
  readonly client: MongoClient;
  readonly db: Db;
  close(): Promise<void>;
}

/** Connect to a MongoDB deployment and select `novel_companion`. The caller closes it. */
export async function connect(uri: string, options: MongoClientOptions = {}): Promise<Store> {
  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 8000,
    appName: 'novel-companion',
    ...options,
  });
  await client.connect();
  return { client, db: client.db(DATABASE_NAME), close: () => client.close() };
}
