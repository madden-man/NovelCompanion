# Plan: Novel Companion on the phone (PWA)

2026-11-27. Plan only, nothing built. Read against origin/main 4115daf and the unmerged `a57-no-instructions` branch (86 commits ahead). This would be amendment **A58**.

## 1. The shape

The phone runs the same React renderer, built for the web and installed from Safari with Add to Home Screen. It talks to one small hosted function that runs the same handlers the Electron main process runs, against the same Atlas database. The desktop app keeps working exactly as it does now.

```
iPhone PWA                         Mac
same renderer, web build           Electron renderer
window.api = fetch transport       window.api = preload (unchanged)
        |  HTTPS, phone key                |  IPC
Netlify function "rpc"             Electron main
same handler table                 same handler table
        \                                  /
         Atlas novel_companion (one bible, two writers)
```

Why this works with little new code: the renderer already has no network and no secrets. Every screen goes through `window.api.invoke(channel, request)`, and every one of the 84 channels has a zod request and response schema in `src/shared/ipc.ts`. A second transport that implements the same `Api` type is all the renderer needs.

### The three ways to do it

| Option                               | What it is                                                         | Verdict                                                                                                                                |
| ------------------------------------ | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Hosted function** (recommended) | Netlify function runs the handlers; phone is a thin client         | Works anywhere, Mac can be asleep. Costs: a host seam, a freshness rule for two writers, no Claude panel on the phone at first         |
| B. The Mac serves the phone          | Electron main opens an HTTPS port, phone reaches it over Tailscale | One writer, Claude works whole. But dead whenever the Mac sleeps or the lid is shut, and Tailscale is not installed. Wrong for a phone |
| C. Local-first phone with sync       | Phone keeps its own copy (as FlowState does) and syncs             | Full offline writes, but it rebuilds the repository, the read model and conflict handling on the phone. Months, not weeks              |

The host seam built for A also gives B for free later (the same HTTP handler can be mounted inside Electron), so choosing A closes nothing.

### What it is not

FlowState stays the notebook: journal, councils, questions and songs, worn as a world, arriving through the bridge. The PWA is the bible itself: read it, fix a field, add a fact. The bridge is not touched.

## 2. Facts the plan rests on

- **The contract is the seam.** `src/preload/index.ts` is 36 lines: validate, `ipcRenderer.invoke`, validate. `src/renderer/src/api.ts` is 13.
- **Electron is imported in five main files only**: `index.ts`, `csp.ts`, `ipc/handle.ts`, `ipc/exportTree.ts`, `ipc/handlers.ts` (for `app.getPath`, `BrowserWindow` broadcast, `dialog`, `shell`, `nativeTheme`). The keychain is `secrets.ts` through `@napi-rs/keyring`.
- **Two writers are already safe per entry.** `Repository.update` reads the prior document from MongoDB, not the read model, and `writeChanges` replaces with a filter on `modifiedAt`; a miss throws "This entry changed somewhere else". A stale read model cannot overwrite a newer entry.
- **What is not safe yet is freshness.** Each process loads the read model and search index once on connect and updates them only from its own writes. The desktop would not see a phone edit until relaunch.
- **The bible is small.** The East Winds snapshot is 776 KB of JSON across 20 collections. A cold function can load all of it.
- **Handlers hold one open bible in module state** (`current` in `handlers.ts`). A function instance serves one request at a time, so this can stay, with an "open the asked bible, make it fresh" step in front of each request.
- **Claude runs through the Agent SDK**, which starts its bundled Claude Code binary. That cannot run in a function. `captureFast` goes the same way today.
- **The window already allows 360 px** and there are `@media` rules at 760, 600, 480 and 400, but no screen was designed for a thumb.
- **No CI in this repo.** `npm test` locally (about 4 minutes) is the check; pushing main reinstalls the desktop app.

## 3. Mechanism

### 3.1 Host seam

A `Host` interface carries everything Electron gives the handlers today: where user data lives (or nowhere), secrets, `broadcast(event, payload)`, file pick and save (or none), open external, theme. `registerHandlers` fills a plain `Map<Channel, Handler>`; `ipcMain` and the HTTP function are two adapters over it.

- `src/main/host/electron.ts`: today's behaviour, moved, nothing else changed.
- `src/server/`: the server host and `rpc(request: Request): Promise<Response>`, a plain Fetch handler. `netlify/functions/rpc.mts` wraps it; `scripts/serve-web.ts` mounts it on a local port for development and tests, with a queue so it also serves one request at a time.
- Files stay where they are under `src/main` (no rename against A57's 88 changed files). An eslint rule allows `electron` and `@napi-rs/keyring` imports only in the host files, and a bundle check fails if the function bundle holds `electron`, the keyring or the Agent SDK, or if the web bundle holds `mongodb`.

### 3.2 Which channels the phone gets

Every channel in the contract is marked `phone` or `desk`. A unit test walks the contract and fails on an unmarked channel, the way the write walk does, so a new channel is a decision, not a leak. The function refuses a `desk` channel in plain words; the renderer hides its control through a new `app.capabilities` answer.

Desk only at first: `connection.*` and the MongoDB string, `bible.create`, snapshots take and restore, `backup.*`, `tree.export`, the Word import, every Claude channel, `test.*` (never registered on the server at all).

### 3.3 Freshness: one number per bible

- A `rev` counter in the bible's `meta`, raised inside every write (the repository's `commit`, and the list, meta, proposal, outline and notebook paths). An integration test walks `WRITE_CHANNELS` and asserts each one moves it.
- **Function:** before each request, read `rev` (one small read); if it is not the number the instance loaded at, reload the read model and search index.
- **Desktop:** check `rev` on window focus and every 20 seconds while focused (the bridge service already runs on the same two triggers). If it moved and the desktop did not move it, reload and send the existing `bible.reloaded` event, which every view already hears. The reload also republishes the pocket, so FlowState follows a phone edit.
- **Phone:** check on `visibilitychange` and every 20 seconds while visible; a move fires `bible.reloaded` locally.
- To prove: typing in an open field survives a reload on both clients, and an undo whose entry moved elsewhere is refused in plain words without breaking the stack.

### 3.4 Events without a socket

`api.on` needs events. The server host collects what a request broadcasts and returns it in the envelope `{ result, events }`; the web transport hands them to its listeners, so the phone's own writes behave as on the desk. Changes from elsewhere come from the `rev` check. `app.closeRequested` becomes a flush on `visibilitychange: hidden` with a keepalive request (under the 64 KiB budget FlowState already works to).

### 3.5 The phone key

- The function holds `NC_MONGODB_URI` and `NC_PHONE_KEY` in the site's environment. No key set means 401 to everything, as the bridge does. Compared in constant time over digests; every answer `no-store`; `noindex`.
- The Mac shows the key in Settings with Copy. The phone's first screen is one field with Paste (Universal Clipboard carries it). It is kept in the installed app's own storage; changing the site's key signs the phone out.
- The key reaches only the allow-listed handlers through the one write path, never raw MongoDB. The static shell holds no data.
- ARCH-5 is amended: the string also lives in the function's environment. The function uses the existing all-databases `claude` user, the same string the Mac app and the bridge hold (Tommy, 2026-11-27).

### 3.6 Versions

- **The function never migrates.** A bible older than the function's schema answers "Open East Winds on the Mac once"; a newer one answers that the phone app is updating. Migrations stay on the desk, where the snapshot before them is taken.
- **Rule for builders:** any change to a stored shape raises the schema version, even with an empty migration, so a lagging side sees a version mismatch instead of a strict zod failure (the "Unrecognized keys" of 2026-10-11).
- **Deploy:** the Netlify site builds from GitHub on the same push to main that reinstalls the Mac app. Deploy previews and branch deploys are off (the Starter plan cannot scope variables, so a preview of unreviewed code would hold the real string). Build environment sets `ELECTRON_SKIP_BINARY_DOWNLOAD=1` and `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`.
- **A stale installed client:** every answer carries the server's build id; a different id makes the client fetch the new service worker and reload at the next moment with no unsaved field.

### 3.7 Snapshots

The function has no disk and the free Atlas tier has no backups (the Nala's Minions wipe is the lesson). Before the first phone write of a day the function stores a full dump in `novel_companion.phone_snapshots`, keeping the last 14. Still one database (ARCH-8). The desktop's daily snapshots go on as now. Showing these on the Snapshots screen is a later package; until then a script restores one.

### 3.8 Offline

- First build: the shell is precached (vite-plugin-pwa, as FlowState), data needs a connection, and a lost connection shows the ARCH-6 banner. Nothing is ever shown as saved when it was not.
- Later package: the transport keeps the last answer of every read channel in IndexedDB. With no connection it serves those and reports `readOnly`, so every write control disables through the existing `useReadOnly`. Screens visited before are readable on a train. Offline writes are out of scope.

### 3.9 Claude and capture

- The Claude panel, proposals and alignment are desk only.
- The capture box works on the phone for Route A (the router is pure and files directly).
- A sentence that needs Claude: default is that it waits for the desk in the From the notebook tray. The pull's `planNotebook` trashes stored pages its rows no longer make, so these lines need their own source that the pull ignores. Later, `captureFast` could get a plain Messages API path that fits in a function; not in this plan.

### 3.10 The phone screens

The larger half of the work, and the part that needs your eye before building. Per the artifact rule it gets a walkthrough of real screens first (built from the real renderer at 390 px with the fixture novel), then packages. Starting proposal, from your M11 list:

- Top bar: bible name and story year; the year opens the dial as a sheet.
- Bottom bar: People, Outline, World, Search, and **+** for capture.
- An entry opens as a full page with back; `Editable` on tap, the field held above the keyboard (`visualViewport`), inputs at 16 px so iOS does not zoom.
- Family tree: pan and pinch. Backstory and world grids: sideways scroll with the first column held.
- Nothing lives behind hover, right click or a key alone; drags get a hold-to-lift. Undo is a button. No instruction text (the A57 rule).

## 4. Packages

Server packages are small and testable without a phone. Screen packages follow the walkthrough.

| #   | Package                                                                                                                  | Proves                                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| P0  | A58 in SPEC (criteria PH-1 onward, amended ARCH-1, 5, 6, A15), ARCHITECTURE section, the walkthrough of phone screens    | You have seen the screens before any are built                            |
| P1  | Host seam and handler table; Electron behaviour unchanged                                                                | Full existing suite green, no test edited                                 |
| P2  | `rev` and the desktop's reload on focus                                                                                  | Two repositories on one database see each other's writes                  |
| P3  | `rpc` handler, channel marking, phone key, server-side bible open and freshness, daily phone snapshot, local `serve-web` | Integration tests against the memory replica set                          |
| P4  | Web build: transport, manifest, service worker, connect screen, capabilities, build id                                   | Playwright phone project loads the fixture novel through the local server |
| P5  | Netlify site, environment, deploy rules, first round trip on the `tide-lines` bible, then East Winds                     | A field edited on the phone shows on the Mac on focus, and back           |
| U1  | Shell, People, entry page, Search                                                                                        | Read and edit a character one-handed                                      |
| U2  | Outline, chapter page, Relevant to Session                                                                               |                                                                           |
| U3  | Story year, year view, world events                                                                                      |                                                                           |
| U4  | Family tree by touch                                                                                                     | Drag and pinch specs use real touch events                                |
| U5  | Capture (**+**) and the waits-for-the-desk path                                                                          |                                                                           |
| U6  | Culture, glossary, places, lists, trash, undo                                                                            |                                                                           |
| L1  | Read-only offline                                                                                                        |                                                                           |

Order and rules:

- **After A57 merges.** It touches 88 source files including the write path; building beside it means resolving every screen twice.
- P1 then P2 and P3 side by side, then P4, P5. The U packages can run in parallel once U1's shell is in.
- Branches and draft PRs only until P5; pushing main reinstalls the app. P2 adds a meta document, so it carries a schema bump.
- Each package gets a fresh reviewer per criterion (SPEC section 9). Builders run their own files; the coordinator runs `npm test` once.
- Tests: layout and smoke on WebKit with an iPhone descriptor; touch drags on Chromium with CDP touches (the FlowState lesson); one spec runs the Electron app and the web client on the same test database.
- Only the iPhone can check: install and icon, storage surviving a week unopened, the keyboard, safe areas, the update reload, Universal Clipboard paste.

## 5. Yours to decide

Three are decided; the rest have a default the plan assumes.

1. **Hosted function (A), not the Mac as server.** Decided (Tommy, 2026-11-27): hosted function.
2. **What the phone is for first.** Default: read everything, edit fields, add facts; no Claude panel, no tree surgery beyond moving people.
3. **A sentence that needs Claude, caught on the phone.** Default: waits in the tray on the Mac.
4. **Atlas user for the function.** Decided (Tommy, 2026-11-27): the same `claude` user the bridge uses.
5. **A lock on the app.** Decided (Tommy, 2026-11-27): the app has no lock. No PIN, no Face ID gate; the phone key pasted once is the only gate.
6. **The function behind a migration.** If a push lands and the Mac app has not reopened the bible, the phone refuses until it does. Default: accept that. The other way is letting the function migrate, with its snapshot kept in the database.
7. **More than one bible on the phone.** Default: the chooser shows every bible, as the desk does.
8. **Site name.** Default: `novel-companion` on Netlify if free.
