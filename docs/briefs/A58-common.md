# A58 common brief: Novel Companion on the phone (PWA)

Tommy, 2026-11-27: "build the pwa novel companion". The plan is `docs/PLAN-PWA.md`; read all of it first, then `docs/ARCHITECTURE.md` (binding), then the code you own. Your package's row in section 4 of the plan and the mechanism sections it names are your brief; the coordinator's prompt adds what is specific to you.

Decided by Tommy: a hosted function (option A), the same `claude` Atlas user, no app lock (the pasted phone key is the only gate). The defaults in section 5 of the plan stand for everything else.

## Where the work happens

- Integration branch `a58-pwa` (worktree `.claude/worktrees/a58-int`), cut from `a57-no-instructions`, which is not merged to main yet. Each builder works in `.claude/worktrees/<branch>` on its own branch off `a58-pwa`. The coordinator creates the worktree and merges.
- Nothing reaches `main` and nothing is pushed: pushing main reinstalls Tommy's desktop app. No Netlify site, no Atlas, no keychain. Tests use the local memory replica set and the fixture novel only.

## Rules

1. The desktop app must behave exactly as before. Do not edit an existing test to make it pass unless your package changes that behaviour on purpose; say so in your report.
2. Touch only the files your package owns. A needed line in a shared file (`src/shared/ipc.ts`, `handlers.ts`, `Workspace.tsx`, `tests/e2e/helpers.ts`, `package.json`) is the fewest lines, not reformatted around, and listed in your report.
3. `src/shared/ipc.ts` is the contract: every channel keeps a zod request and response schema. Any change to a stored shape raises the schema version with a migration (empty if need be), per plan 3.6.
4. No instruction text on any screen (the A57 rule, `docs/briefs/A57-common.md` "The rule"). Copy is plain words, active voice, and never an em dash in any string, comment or doc.
5. New CSS goes in a file beside its component, theme tokens only, both themes.
6. Do not change `SPEC.md`, `PROGRESS.md` or `fixtures/expected/` unless your package is P0. List the criteria your work proves, by test name, in your report.
7. Running things on this shared Mac: `npm run typecheck`, `npx eslint <your files>`, `npx prettier --check <your files>`, `npm run test:unit`, then only the integration and e2e files you own or could have broken, one at a time, RAM disk off (`NC_TEST_RAM_DISK=0`). Never `npm test`, never two test runs at once in your worktree. If `mongod` dies with exit 137 or ECONNREFUSED, re-sign the cached binary (`codesign --force -s - ~/.cache/mongodb-binaries/mongod-*`) and run again; a start timeout under load is a rerun, not a failure.
   Machine rule (Tommy, 2026-11-27, 8 GB Mac shared by several sessions): every Playwright run uses `--workers=1`. At most seven browser or Electron e2e suites run at once across all sessions, through seven slots: `~/dev/.e2e-lock` and `~/dev/.e2e-lock-2` to `~/dev/.e2e-lock-7`. Try `mkdir` on each in turn and take the first that succeeds; write your shell's PID to `<slot>/owner`; `rm -rf` that slot when the run ends, pass or fail, and release it between suites when you chain several. All seven taken: do lint, typecheck or unit work and try again in a few minutes, never a tight loop. A slot whose owner PID is dead and whose directory is over 10 minutes old is stale and may be removed. Typecheck, lint and unit tests may overlap freely. An e2e timeout seen without a slot is suspect: rerun it under one before fixing anything.
8. New dependencies: pin exact versions, as `package.json` does, and name each in your report.
9. Git: commit on your own branch as you go, staging files by name (never `git add -A` or `git add .`; `node_modules` here is a copy that must stay untracked). Do not merge, rebase, push, or touch another worktree or the main checkout. Do not kill processes you did not start.
10. Report at the end: what you built, the commands you ran with their last lines, new and changed test names, lines changed in files you do not own, new dependencies, and anything not done with the reason. Report failures as failures.
