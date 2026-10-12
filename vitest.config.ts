import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          environment: 'node',
          globalSetup: ['tests/helpers/mongoGlobalSetup.ts'],
          // The first run downloads a MongoDB binary.
          hookTimeout: 300_000,
          testTimeout: 60_000,
          // Files run on parallel workers against the one server; every test
          // uses its own fresh bible IDs, so files never meet.
          fileParallelism: true,
          maxWorkers: 4,
        },
      },
      {
        // T-3: the on-demand live Claude smoke test (`npm run test:live`), never part of `npm test`.
        test: {
          name: 'live',
          include: ['tests/live/**/*.test.ts'],
          environment: 'node',
          globalSetup: ['tests/helpers/mongoGlobalSetup.ts'],
          hookTimeout: 300_000,
          testTimeout: 300_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
