import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { TestProject } from 'vitest/node';

/**
 * Starts one local MongoDB replica set for the integration suite. A replica
 * set is needed because the repository writes in transactions. Tests never
 * touch Atlas. Every test shares the one `novel_companion` database, as the
 * app does, and stays separate by using its own fresh bible IDs (slugs).
 */
export default async function setup(project: TestProject) {
  const server = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
    // Every test bible is its own set of collections and indexes, and WiredTiger
    // keeps a file handle open for each one it has touched. A full run makes
    // thousands, which exhausts this Mac's file table (ENFILE) and kills the
    // server part way through. Close idle handles quickly instead.
    instanceOpts: [
      {
        args: [
          '--wiredTigerEngineConfigString',
          'file_manager=(close_idle_time=2,close_scan_interval=1,close_handle_minimum=100)',
        ],
      },
    ],
  });
  project.provide('mongoUri', server.getUri());
  return async () => {
    await server.stop();
  };
}

declare module 'vitest' {
  export interface ProvidedContext {
    mongoUri: string;
  }
}
