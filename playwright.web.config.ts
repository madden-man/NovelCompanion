import { defineConfig, devices } from '@playwright/test';

/**
 * A58 P4: the phone client (`npm run test:web`). tests/web/globalSetup.ts
 * builds `dist/web` and starts one local replica set; each spec file serves
 * the build and the function from `scripts/serve-web.ts` on its own database.
 * Layout and smoke run on WebKit with the iPhone 15 descriptor. One worker,
 * always (the shared Mac's rule).
 */
export default defineConfig({
  testDir: 'tests/web',
  testMatch: '**/*.spec.ts',
  globalSetup: './tests/web/globalSetup.ts',
  timeout: 120_000,
  workers: 1,
  fullyParallel: false,
  reporter: 'list',
  forbidOnly: true,
  use: { serviceWorkers: 'block' },
  projects: [
    { name: 'iphone', use: { ...devices['iPhone 15'], serviceWorkers: 'block' } },
    // A58 U2: real touch drags (CDP Input.dispatchTouchEvent) need Chromium; tests tagged @touch.
    {
      name: 'touch',
      grep: /@touch/,
      use: {
        ...devices['iPhone 15'],
        browserName: 'chromium',
        defaultBrowserType: 'chromium',
        serviceWorkers: 'block',
      },
    },
  ],
});
