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
