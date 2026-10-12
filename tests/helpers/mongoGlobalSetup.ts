import type { TestProject } from 'vitest/node';
import { startTestMongo } from './testMongo';

/**
 * Starts one local MongoDB replica set for the integration suite
 * (`startTestMongo()`). Every test shares the one `novel_companion` database,
 * as the app does, and stays separate by using its own fresh bible IDs (slugs).
 */
export default async function setup(project: TestProject) {
  const server = await startTestMongo();
  project.provide('mongoUri', server.uri);
  return async () => {
    await server.stop();
  };
}

declare module 'vitest' {
  export interface ProvidedContext {
    mongoUri: string;
  }
}
