# Novel Companion

A desktop story bible for writing a novel. Electron, TypeScript, React, and MongoDB. `SPEC.md` says what the app does; `docs/ARCHITECTURE.md` says how it is built.

## Before you run it

- **MongoDB connection string.** Paste it on the first screen (it shows a MongoDB connection box whenever nothing is stored) or later under Settings. The app keeps it in the macOS keychain under the service `novel-companion-mongodb` and the account `novel-companion`, never in a file. `docs/RUN-ON-ANOTHER-MAC.md` covers a second Mac.

- **Installing the app.** `npm run install:app` builds, signs with the local "Novel Companion Local" certificate (make it once with `sh scripts/make-signing-identity.sh`) and installs into /Applications. With that certificate the keychain asks to allow access once, not after every rebuild.
- **Rebuilt on every push.** Pushing `main` from this Mac rebuilds and installs the app in the background (`.githooks/pre-push` runs `scripts/auto-install.sh`; `npm install` turns the hook on). It builds the pushed commit in its own checkout under `~/Library/Caches/novel-companion-build`, so unpushed edits never reach the app. If the app is open it is not closed: a notification asks you to quit, and it reopens with the new build. Log: `~/Library/Logs/Novel Companion/auto-install.log`. Push with `NC_AUTO_INSTALL=0` to skip. Pushes from anywhere else (another clone, a merge on GitHub) are picked up by a launchd agent that checks `origin/main` at login and every 10 minutes: turn it on once per Mac with `sh scripts/install-auto-update.sh` (`--remove` turns it off).

- **Running against a local database.** See "Local development" in `docs/ARCHITECTURE.md`: a local one-node replica set and `NOVEL_COMPANION_TEST_MONGODB_URI`. If `npm run dev` says "Electron uninstall", run `node node_modules/electron/install.js`.

- **Google Drive (optional).** The Desktop OAuth client for Google Cloud project `novel-companion-511219` is stored in the keychain (service `novel-companion-google`, account `oauth-client`). Connect in Settings; `docs/DRIVE-SETUP.md` has the setup and the real-flow checklist.

- **An Anthropic API key.** Claude features use the Claude Agent SDK with an API key (amendment A23). Paste it in the app under Settings; it is kept in the macOS keychain under the service `novel-companion-anthropic` and shown only masked. The SDK bundles its own Claude Code binary, so the installed CLI is not needed.

## Commands

| Command                      | What it does                                                                                                                                                                                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm install`                | Install the pinned dependencies.                                                                                                                                                                                                                                   |
| `npm run dev`                | Start the app with hot reload.                                                                                                                                                                                                                                     |
| `npm run build`              | Build main, preload, and renderer into `out/`.                                                                                                                                                                                                                     |
| `npm test`                   | Run lint, typecheck, unit, integration, and end-to-end tests in that order. Stops at the first failure.                                                                                                                                                            |
| `npm run lint`               | ESLint and a Prettier check over the repository, Markdown included.                                                                                                                                                                                                |
| `npm run typecheck`          | Type-check the main, web, and end-to-end projects.                                                                                                                                                                                                                 |
| `npm run format`             | Rewrite files with Prettier.                                                                                                                                                                                                                                       |
| `npm run test:unit`          | Unit tests only. No database.                                                                                                                                                                                                                                      |
| `npm run test:integration`   | Integration tests against one local MongoDB that the tests start themselves (on a RAM disk on macOS), with files on four workers.                                                                                                                                  |
| `npm run test:e2e`           | Drive the built app with Playwright: one local MongoDB for the run, a database per spec file, spec files on three workers (two below eight cores). Builds `out/` first only when the source is newer.                                                              |
| `npm run test:e2e:force`     | The same, always building first. One file: `npx playwright test tests/e2e/tree.spec.ts` (it does not build). The app runs hidden (no window, no dock icon); `NOVEL_COMPANION_E2E_SHOW=1` shows it.                                                                 |
| `npm run test:live`          | The on-demand Claude smoke test against the real API, with the key in the keychain. Skipped without one. Not part of `npm test`.                                                                                                                                   |
| `npm run package`            | Build an unsigned macOS `.dmg` into `release/`.                                                                                                                                                                                                                    |
| `npm run test:package-smoke` | Package the app, check the bundle and the mounted dmg (the Agent SDK binary and the keyring module unpacked from `app.asar`), and launch the packaged app on a local test database. Takes a few minutes. Not part of `npm test`.                                   |
| `npm run test:journey`       | Play a writer's whole session through the packaged app in `release/` (T-4), packaging it first when it is missing or older than the source. Writes a step-by-step report with a screenshot per step to `test-results/journey/report.html`. Not part of `npm test`. |
| `npm run fixtures:files`     | Rebuild the fixture workbook and Word document in `fixtures/files/`.                                                                                                                                                                                               |
| `npm run import:eastwinds`   | Import the East Winds material into the live `eastwinds` bible, with the keychain connection string. Add `-- --dry-run` to preview it.                                                                                                                             |

The dmg is `release/Novel Companion-<version>-arm64.dmg`, unsigned (A15): the first launch needs right-click, Open. It is arm64 only; an x64 build would need the x64 Agent SDK binary and keyring module installed beside the arm64 ones.

The packaged smoke test and the journey run the packaged app with `NOVEL_COMPANION_ALLOW_TEST_URI=1` and a local `NOVEL_COMPANION_TEST_MONGODB_URI`, the one documented exception a packaged build honours. With both set it keeps the Claude key and the Drive tokens in memory, takes its data folder from `NOVEL_COMPANION_USER_DATA`, and honours the recorded Claude, the fake Google, and the file pickers the test names, so a test run never reads the keychain, reaches Anthropic or Google, or writes to `~/Library/Application Support/Novel Companion`. Without both (or with a test address that is not local) a packaged build refuses every test switch; the proposal seam and the stop prompt switches are refused by every packaged build.

Tests never touch Atlas. Integration and end-to-end tests start a local MongoDB with `mongodb-memory-server`, which downloads a MongoDB binary the first time it runs.

## Layout

- `src/main/` main process: database, read model, search, IPC handlers, and `claude` (the Agent SDK runtime), `drive` (Google Drive), `import` (Excel and Word), `backup` (snapshots, restore, export), `session` (manuscript sources, brief PDF).
- `src/preload/` exposes `window.api` and nothing else.
- `src/renderer/` the React app.
- `src/shared/` zod schemas and the IPC contract.
- `fixtures/` the fixture novel from SPEC section 7, hand-written expected answers, and import files.
- `tests/` unit, integration, end-to-end, and live tests.
