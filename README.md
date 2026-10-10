# Novel Companion

A desktop story bible for writing a novel. Electron, TypeScript, React, and MongoDB. `SPEC.md` says what the app does; `docs/ARCHITECTURE.md` says how it is built.

## Before you run it

- **MongoDB connection string in the keychain.** The app reads it from the macOS keychain under the service `novel-companion-mongodb` and the account `novel-companion`. It is never stored in a file. To add it:

  ```sh
  security add-generic-password -s novel-companion-mongodb -a novel-companion -w
  ```

  The command prompts for the value, so it does not land in your shell history.

- **Claude Code CLI, signed in.** Claude features (from milestone M6) use your Claude subscription through the installed Claude Code CLI. Check with `claude auth status`.

## Commands

| Command                    | What it does                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------------- |
| `npm install`              | Install the pinned dependencies.                                                                        |
| `npm run dev`              | Start the app with hot reload.                                                                          |
| `npm run build`            | Build main, preload, and renderer into `out/`.                                                          |
| `npm test`                 | Run lint, typecheck, unit, integration, and end-to-end tests in that order. Stops at the first failure. |
| `npm run test:unit`        | Unit tests only. No database.                                                                           |
| `npm run test:integration` | Integration tests against a local MongoDB that the tests start themselves.                              |
| `npm run test:e2e`         | Build the app and drive it with Playwright.                                                             |
| `npm run test:live`        | The on-demand Claude smoke test. A placeholder until M6. Not part of `npm test`.                        |
| `npm run package`          | Build an unsigned macOS `.dmg` into `release/`.                                                         |
| `npm run fixtures:files`   | Rebuild the fixture workbook and Word document in `fixtures/files/`.                                    |

Tests never touch Atlas. Integration and end-to-end tests start a local MongoDB with `mongodb-memory-server`, which downloads a MongoDB binary the first time it runs.

## Layout

- `src/main/` main process: database, read model, search, IPC handlers.
- `src/preload/` exposes `window.api` and nothing else.
- `src/renderer/` the React app.
- `src/shared/` zod schemas and the IPC contract.
- `fixtures/` the fixture novel from SPEC section 7, hand-written expected answers, and import files.
- `tests/` unit, integration, end-to-end, and live tests.
