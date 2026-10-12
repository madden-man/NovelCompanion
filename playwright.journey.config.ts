import { defineConfig } from '@playwright/test';

/**
 * T-4: the writer's journey through the whole app (`npm run test:journey`).
 * It runs against the electron-vite build, not the packaged app: the journey
 * needs the recorded Claude, the fake Google, and the file pickers named by the
 * test, and a packaged build refuses every one of those test seams by design.
 */
export default defineConfig({
  testDir: 'tests/journey',
  testMatch: '**/*.spec.ts',
  timeout: 180_000,
  workers: 1,
  reporter: [['list'], ['./tests/journey/reporter.ts']],
  forbidOnly: true,
  outputDir: 'test-results/journey',
});
