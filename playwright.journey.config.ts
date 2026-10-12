import { defineConfig } from '@playwright/test';

/**
 * T-4: the writer's journey through the whole app (`npm run test:journey`),
 * against the packaged app in release/. `scripts/ensure-package.ts` runs
 * `npm run package` first when there is no packaged app or the source is newer
 * than it. The packaged app honours the recorded Claude, the fake Google, and
 * the file pickers named by the test only under the one documented exception,
 * NOVEL_COMPANION_ALLOW_TEST_URI=1 with a local test database
 * (`testSeamsHonoured` in src/main/secrets.ts); without it, it refuses them all.
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
