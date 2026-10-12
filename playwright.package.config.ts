import { defineConfig } from '@playwright/test';

/** NF-4: the packaged smoke test, run by `npm run test:package-smoke` after `npm run package`. */
export default defineConfig({
  testDir: 'tests/package',
  testMatch: '**/*.spec.ts',
  timeout: 180_000,
  workers: 1,
  reporter: 'list',
  forbidOnly: true,
  outputDir: 'test-results/package',
});
