import { availableParallelism } from 'node:os';
import { defineConfig } from '@playwright/test';

/**
 * The end-to-end run. tests/e2e/globalSetup.ts starts one local MongoDB
 * replica set for the whole run (a single-file run too) and each spec file
 * gets its own database on it (`fileDb()` in tests/e2e/helpers.ts). Spec files
 * run on parallel workers; the tests inside a file run in order, one at a time.
 */
export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '**/*.spec.ts',
  globalSetup: './tests/e2e/globalSetup.ts',
  timeout: 120_000,
  workers: availableParallelism() >= 8 ? 3 : 2,
  fullyParallel: false,
  reporter: 'list',
  forbidOnly: true,
});
